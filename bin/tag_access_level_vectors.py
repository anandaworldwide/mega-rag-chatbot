#!/usr/bin/env python3

"""
Retroactively tag existing Pinecone vectors with access-level metadata.

This script scans the configured Pinecone index, finds vectors matching the
provided metadata filters, shows the number of matches plus a sample vector,
and asks for confirmation before updating `access_level`.

Usage:
    python bin/tag_access_level_vectors.py --site ananda \
        --access-level kriyaban \
        --vector-id-prefix "text||Ananda Library||db||6. Preparation for Kriya Yoga::"

    python bin/tag_access_level_vectors.py --site ananda \
        --access-level minister \
        --vector-id-prefix "text||Ananda Library||db||6. Preparation for Kriya Yoga::" \
        --author-contains "Yogananda" \
        --library-contains "Ananda Library"
"""

import argparse
import hashlib
import json
import os
import sys
import time
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from pinecone import Pinecone

from pyutil.env_utils import load_env
from pyutil.site_config_utils import get_required_access_level_for_key, load_site_config

DEFAULT_FETCH_BATCH_SIZE = 20
DEFAULT_LIST_BATCH_SIZE = 100
DEFAULT_SAMPLE_TEXT_CHARS = 240
DEFAULT_VERIFY_WAIT_SECONDS = 5


@dataclass(frozen=True)
class MatchCriteria:
    """Metadata filters used to find the vectors that should be updated."""

    vector_id_prefix: str | None = None
    title_contains: str | None = None
    source_contains: str | None = None
    filename_contains: str | None = None
    library_contains: str | None = None
    author_contains: str | None = None

    def has_filters(self) -> bool:
        """Return True when at least one filter has been provided."""
        return any(
            (
                self.vector_id_prefix,
                self.title_contains,
                self.source_contains,
                self.filename_contains,
                self.library_contains,
                self.author_contains,
            )
        )

    def matches_metadata(self, metadata: dict[str, Any]) -> bool:
        """Return True when metadata matches all specified filters."""
        if not self.has_filters():
            raise ValueError("At least one match filter is required.")

        return all(
            (
                self._matches_field(self.title_contains, metadata.get("title")),
                self._matches_field(
                    self.source_contains,
                    metadata.get("source", metadata.get("url")),
                ),
                self._matches_field(
                    self.filename_contains,
                    metadata.get("filename"),
                ),
                self._matches_field(
                    self.library_contains,
                    metadata.get("library"),
                ),
                self._matches_field(
                    self.author_contains,
                    metadata.get("author"),
                ),
            )
        )

    @staticmethod
    def _matches_field(expected_substring: str | None, actual_value: Any) -> bool:
        """Perform case-insensitive substring matching for one metadata field."""
        if not expected_substring:
            return True
        if actual_value is None:
            return False
        return expected_substring.lower() in str(actual_value).lower()

    def matches_vector(self, vector_id: str, metadata: dict[str, Any]) -> bool:
        """Return True when the vector ID and metadata satisfy all filters."""
        if not self.has_filters():
            raise ValueError("At least one match filter is required.")

        if self.vector_id_prefix and not vector_id.startswith(self.vector_id_prefix):
            return False

        return self.matches_metadata(metadata)


@dataclass(frozen=True)
class MatchedVector:
    """Serializable representation of a matching Pinecone vector."""

    vector_id: str
    metadata: dict[str, Any]

    @property
    def current_access_level(self) -> str:
        """Return the current access level, defaulting to public."""
        return str(self.metadata.get("access_level", "public"))

    @property
    def current_required_access_level(self) -> int:
        """Return the current numeric access level, defaulting to public."""
        try:
            return int(self.metadata.get("required_access_level", 0) or 0)
        except (TypeError, ValueError):
            return 0


def build_sample_vector_payload(
    matched_vector: MatchedVector, sample_text_chars: int = DEFAULT_SAMPLE_TEXT_CHARS
) -> dict[str, str]:
    """Build a small, readable sample payload for console output."""
    metadata = matched_vector.metadata
    text = str(metadata.get("text", ""))
    text_preview = text[:sample_text_chars]
    if len(text) > sample_text_chars:
        text_preview += "..."

    return {
        "vector_id": matched_vector.vector_id,
        "title": str(metadata.get("title", "")),
        "author": str(metadata.get("author", "")),
        "library": str(metadata.get("library", "")),
        "source": get_vector_source(matched_vector),
        "filename": str(metadata.get("filename", "")),
        "current_access_level": matched_vector.current_access_level,
        "current_required_access_level": str(
            matched_vector.current_required_access_level
        ),
        "text_preview": text_preview,
    }


def get_vector_source(matched_vector: MatchedVector) -> str:
    """Return the source identifier used for grouping match counts."""
    metadata = matched_vector.metadata
    source = metadata.get("source", metadata.get("url", ""))
    source_value = str(source).strip()
    return source_value or "(no source)"


def summarize_sources(matches: list[MatchedVector]) -> list[tuple[str, int]]:
    """Return source counts sorted by descending frequency, then source value."""
    source_counts = Counter(get_vector_source(match) for match in matches)
    return sorted(
        source_counts.items(),
        key=lambda source_count: (-source_count[1], source_count[0]),
    )


def get_update_candidates(
    matches: list[MatchedVector],
    target_access_level: str,
    target_required_access_level: int | None = None,
) -> list[MatchedVector]:
    """Return only the matches that still need an access level update."""
    return [
        match
        for match in matches
        if match.current_access_level != target_access_level
        or (
            target_required_access_level is not None
            and match.current_required_access_level != target_required_access_level
        )
    ]


class AccessLevelVectorTagger:
    """Encapsulates scanning, previewing, and updating Pinecone vectors."""

    def __init__(
        self,
        index: Any,
        index_name: str,
        criteria: MatchCriteria,
        target_access_level: str,
        target_required_access_level: int | None,
        fetch_batch_size: int,
        list_batch_size: int,
        use_id_cache: bool,
        refresh_id_cache: bool,
    ) -> None:
        self.index = index
        self.index_name = index_name
        self.criteria = criteria
        self.target_access_level = target_access_level
        self.target_required_access_level = target_required_access_level
        self.fetch_batch_size = fetch_batch_size
        self.list_batch_size = list_batch_size
        self.use_id_cache = use_id_cache
        self.refresh_id_cache = refresh_id_cache

    def _get_cache_dir(self) -> Path:
        """Return the cache directory used for listed vector IDs."""
        return (
            Path(__file__).resolve().parents[1] / ".cache" / "tag_access_level_vectors"
        )

    def _get_id_cache_path(self) -> Path:
        """Return the cache file path for the current index/prefix combination."""
        prefix_part = self.criteria.vector_id_prefix or "__all__"
        prefix_hash = hashlib.sha256(prefix_part.encode("utf-8")).hexdigest()[:12]
        safe_index_name = "".join(
            character if character.isalnum() or character in ("-", "_") else "_"
            for character in self.index_name
        )
        filename = f"{safe_index_name}-{prefix_hash}.json"
        return self._get_cache_dir() / filename

    def _load_cached_ids(self) -> list[str] | None:
        """Load cached vector IDs if available and enabled."""
        if not self.use_id_cache or self.refresh_id_cache:
            return None

        cache_path = self._get_id_cache_path()
        if not cache_path.exists():
            return None

        try:
            with cache_path.open(encoding="utf-8") as cache_file:
                payload = json.load(cache_file)
        except (json.JSONDecodeError, OSError):
            return None

        cached_ids = payload.get("vector_ids")
        if not isinstance(cached_ids, list):
            return None

        print(f"Loaded {len(cached_ids)} cached vector ID(s) from {cache_path}")
        return [str(vector_id) for vector_id in cached_ids]

    def _write_cached_ids(self, vector_ids: list[str]) -> None:
        """Persist listed vector IDs for faster repeated debug runs."""
        if not self.use_id_cache:
            return

        cache_path = self._get_id_cache_path()
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "cached_at": int(time.time()),
            "vector_id_prefix": self.criteria.vector_id_prefix,
            "vector_count": len(vector_ids),
            "vector_ids": vector_ids,
        }
        with cache_path.open("w", encoding="utf-8") as cache_file:
            json.dump(payload, cache_file)

        print(f"Cached {len(vector_ids)} vector ID(s) to {cache_path}")

    def _collect_candidate_ids(self) -> list[str]:
        """List candidate vector IDs, using a local cache when possible."""
        cached_ids = self._load_cached_ids()
        if cached_ids is not None:
            return cached_ids

        print("Listing vector IDs...", end="", flush=True)
        all_ids: list[str] = []
        list_kwargs: dict[str, Any] = {"limit": self.list_batch_size}
        if self.criteria.vector_id_prefix:
            list_kwargs["prefix"] = self.criteria.vector_id_prefix

        for id_batch in self.index.list(**list_kwargs):
            all_ids.extend(id_batch)
            print(f"\rListing vector IDs... {len(all_ids)}", end="", flush=True)
        print(f"\rListed {len(all_ids)} vector IDs. Fetching metadata...")

        self._write_cached_ids(all_ids)
        return all_ids

    def find_matches(self) -> list[MatchedVector]:
        """Scan the index and return vectors whose metadata matches the criteria."""
        stats = self.index.describe_index_stats()
        total_vectors = getattr(stats, "total_vector_count", "unknown")
        print(f"Pinecone total vectors: {total_vectors}")
        all_ids = self._collect_candidate_ids()

        matches: list[MatchedVector] = []
        scanned = 0
        start_time = time.time()
        total_batches = (
            len(all_ids) + self.fetch_batch_size - 1
        ) // self.fetch_batch_size

        for batch_number, start_index in enumerate(
            range(0, len(all_ids), self.fetch_batch_size), start=1
        ):
            batch_ids = all_ids[start_index : start_index + self.fetch_batch_size]
            fetch_response = self.index.fetch(ids=batch_ids)

            for vector_id, vector in fetch_response.vectors.items():
                scanned += 1
                metadata = dict(vector.metadata) if vector.metadata else {}
                if self.criteria.matches_vector(vector_id, metadata):
                    matches.append(
                        MatchedVector(vector_id=vector_id, metadata=metadata)
                    )

            elapsed_seconds = max(time.time() - start_time, 0.001)
            rate = scanned / elapsed_seconds
            remaining = len(all_ids) - scanned
            eta_seconds = int(remaining / rate) if rate > 0 else 0
            eta_minutes = eta_seconds // 60
            eta_remainder_seconds = eta_seconds % 60
            progress_pct = (
                (batch_number / total_batches) * 100 if total_batches else 100
            )

            print(
                f"  [{progress_pct:5.1f}%] {scanned:,}/{len(all_ids):,} vectors | "
                f"{len(matches)} match(es) | "
                f"{rate:.0f} vec/s | "
                f"ETA {eta_minutes}m{eta_remainder_seconds:02d}s   ",
                end="\r",
                flush=True,
            )

        elapsed_seconds = time.time() - start_time
        print(
            f"\nFinished scanning {scanned:,} vectors in {elapsed_seconds:.1f}s. "
            f"Matches found: {len(matches)}"
        )
        return matches

    def update_matches(self, matches: list[MatchedVector]) -> list[MatchedVector]:
        """Update matching vectors to the target access level."""
        update_candidates = get_update_candidates(
            matches, self.target_access_level, self.target_required_access_level
        )
        if not update_candidates:
            print(
                f"All matching vectors already have "
                f"access_level='{self.target_access_level}'."
            )
            return []

        print(
            f"Updating {len(update_candidates)} vector(s) "
            f"to access_level='{self.target_access_level}' "
            f"and required_access_level={self.target_required_access_level}..."
        )

        for index, match in enumerate(update_candidates, start=1):
            metadata_update = {"access_level": self.target_access_level}
            if self.target_required_access_level is not None:
                metadata_update["required_access_level"] = self.target_required_access_level

            self.index.update(
                id=match.vector_id,
                set_metadata=metadata_update,
            )
            print(
                f"  Updated {index}/{len(update_candidates)}: {match.vector_id}",
                end="\r",
                flush=True,
            )

        print("\nUpdate complete.")
        return update_candidates


def build_argument_parser() -> argparse.ArgumentParser:
    """Create the command-line interface definition."""
    parser = argparse.ArgumentParser(
        description="Tag existing Pinecone vectors with access-level metadata.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python bin/tag_access_level_vectors.py --site ananda \\
      --access-level kriyaban \\
      --vector-id-prefix "text||Ananda Library||db||6. Preparation for Kriya Yoga::"

  python bin/tag_access_level_vectors.py --site ananda \\
      --access-level minister \\
      --vector-id-prefix "text||Ananda Library||db||6. Preparation for Kriya Yoga::" \\
      --library-contains "Ananda Library" \\
      --author-contains "Yogananda"
        """,
    )
    parser.add_argument(
        "--site", required=True, help="Site ID for environment variables"
    )
    parser.add_argument(
        "--vector-id-prefix",
        help="Match only vectors whose IDs start with this exact prefix",
    )
    parser.add_argument(
        "--title-contains",
        help="Case-insensitive substring to match against metadata.title",
    )
    parser.add_argument(
        "--source-contains",
        help="Case-insensitive substring to match against metadata.source/url",
    )
    parser.add_argument(
        "--filename-contains",
        help="Case-insensitive substring to match against metadata.filename",
    )
    parser.add_argument(
        "--library-contains",
        help="Case-insensitive substring to match against metadata.library",
    )
    parser.add_argument(
        "--author-contains",
        help="Case-insensitive substring to match against metadata.author",
    )
    parser.add_argument(
        "--access-level",
        required=True,
        help="Access level to apply to matching vectors (for example: kriyaban)",
    )
    parser.add_argument(
        "--index-name",
        help="Optional Pinecone index override (defaults to env var value)",
    )
    parser.add_argument(
        "--fetch-batch-size",
        type=int,
        default=DEFAULT_FETCH_BATCH_SIZE,
        help=(
            "Number of vector IDs to fetch per batch. Keep this small because "
            "the project uses long vector IDs."
        ),
    )
    parser.add_argument(
        "--list-batch-size",
        type=int,
        default=DEFAULT_LIST_BATCH_SIZE,
        help="Number of vector IDs to request per Pinecone list() call",
    )
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Skip the yes/no confirmation prompt and apply updates immediately",
    )
    parser.add_argument(
        "--refresh-id-cache",
        action="store_true",
        help="Ignore any cached vector ID list and rebuild it from Pinecone",
    )
    parser.add_argument(
        "--no-id-cache",
        action="store_true",
        help="Disable local caching of listed vector IDs for this run",
    )
    return parser


def print_match_summary(
    matches: list[MatchedVector],
    target_access_level: str,
    target_required_access_level: int | None = None,
) -> None:
    """Print how many vectors matched and how many need updating."""
    update_candidates = get_update_candidates(
        matches, target_access_level, target_required_access_level
    )
    already_tagged = len(matches) - len(update_candidates)

    print("\nMatch summary")
    print(f"  Matching vectors: {len(matches)}")
    print(f"  Already {target_access_level}: {already_tagged}")
    print(f"  Will update: {len(update_candidates)}")


def print_sample_vector(matches: list[MatchedVector]) -> None:
    """Print a single sample vector from the match set."""
    if not matches:
        return

    sample_payload = build_sample_vector_payload(matches[0])
    print("\nSample matching vector:")
    print(json.dumps(sample_payload, indent=2, ensure_ascii=True))


def print_source_breakdown(matches: list[MatchedVector]) -> None:
    """Print how many matching vectors were seen for each source."""
    if not matches:
        return

    print("\nSource breakdown:")
    for source, count in summarize_sources(matches):
        print(f"  {count}: {source}")


def prompt_for_confirmation(
    update_count: int,
    target_access_level: str,
    target_required_access_level: int | None = None,
) -> bool:
    """Ask the user to confirm the metadata update."""
    numeric_suffix = (
        f" and required_access_level={target_required_access_level}"
        if target_required_access_level is not None
        else ""
    )
    confirmation = (
        input(
            f"\nUpdate {update_count} vector(s) to "
            f"access_level='{target_access_level}'{numeric_suffix}? (yes/No): "
        )
        .strip()
        .lower()
    )
    return confirmation in {"yes", "y"}


def verify_sample_update(
    index: Any,
    updated_vectors: list[MatchedVector],
    target_access_level: str,
    target_required_access_level: int | None = None,
) -> None:
    """Re-fetch one updated vector and verify the metadata change."""
    if not updated_vectors:
        return

    sample_vector = updated_vectors[0]
    print(
        f"Verifying sample update (waiting {DEFAULT_VERIFY_WAIT_SECONDS}s for "
        "eventual consistency)..."
    )
    time.sleep(DEFAULT_VERIFY_WAIT_SECONDS)

    verify_response = index.fetch(ids=[sample_vector.vector_id])
    verified_vector = verify_response.vectors.get(sample_vector.vector_id)
    if not verified_vector:
        print("Warning: Could not re-fetch a sample updated vector.")
        return

    verified_metadata = (
        dict(verified_vector.metadata) if verified_vector.metadata else {}
    )
    verified_access_level = str(verified_metadata.get("access_level", "public"))
    try:
        verified_required_access_level = int(
            verified_metadata.get("required_access_level", 0) or 0
        )
    except (TypeError, ValueError):
        verified_required_access_level = 0

    required_level_matches = (
        target_required_access_level is None
        or verified_required_access_level == target_required_access_level
    )
    if verified_access_level == target_access_level and required_level_matches:
        print(
            f"Verification passed: sample vector now has "
            f"access_level='{target_access_level}'"
            f" and required_access_level={verified_required_access_level}."
        )
        return

    print(
        "Warning: Verification could not confirm the update. "
        f"Expected '{target_access_level}'/{target_required_access_level}, "
        f"got '{verified_access_level}'/{verified_required_access_level}."
    )


def main() -> None:
    """Run the vector tagging workflow."""
    parser = build_argument_parser()
    args = parser.parse_args()

    criteria = MatchCriteria(
        vector_id_prefix=args.vector_id_prefix,
        title_contains=args.title_contains,
        source_contains=args.source_contains,
        filename_contains=args.filename_contains,
        library_contains=args.library_contains,
        author_contains=args.author_contains,
    )

    if not criteria.has_filters():
        parser.error(
            "At least one match filter is required. "
            "Use --vector-id-prefix, --title-contains, --source-contains, "
            "--filename-contains, --library-contains, or --author-contains."
        )

    if args.fetch_batch_size <= 0:
        parser.error("--fetch-batch-size must be a positive integer.")
    if args.list_batch_size <= 0:
        parser.error("--list-batch-size must be a positive integer.")

    load_env(args.site)
    site_config = load_site_config(args.site)
    target_required_access_level = get_required_access_level_for_key(
        args.access_level, site_config
    )

    api_key = os.getenv("PINECONE_API_KEY")
    index_name = args.index_name or os.getenv(
        "PINECONE_INDEX_NAME",
        os.getenv("PINECONE_INGEST_INDEX_NAME", "mega-rag-chatbot"),
    )

    if not api_key:
        print("Error: PINECONE_API_KEY not set.")
        sys.exit(1)

    print(f"Site: {args.site}")
    print(f"Pinecone index: {index_name}")
    print(f"Target access level: {args.access_level}")
    print(f"Target required access level: {target_required_access_level}")
    if args.vector_id_prefix:
        print(f"Vector ID prefix: {args.vector_id_prefix}")

    pc = Pinecone(api_key=api_key)
    index = pc.Index(index_name)

    tagger = AccessLevelVectorTagger(
        index=index,
        index_name=index_name,
        criteria=criteria,
        target_access_level=args.access_level,
        target_required_access_level=target_required_access_level,
        fetch_batch_size=args.fetch_batch_size,
        list_batch_size=args.list_batch_size,
        use_id_cache=not args.no_id_cache,
        refresh_id_cache=args.refresh_id_cache,
    )

    matches = tagger.find_matches()
    if not matches:
        print("No matching vectors found. Exiting without changes.")
        return

    print_match_summary(matches, args.access_level, target_required_access_level)
    print_sample_vector(matches)
    print_source_breakdown(matches)

    update_candidates = get_update_candidates(
        matches, args.access_level, target_required_access_level
    )
    if not update_candidates:
        return

    if not args.yes and not prompt_for_confirmation(
        len(update_candidates), args.access_level, target_required_access_level
    ):
        print("Aborted.")
        return

    updated_vectors = tagger.update_matches(matches)
    verify_sample_update(
        index, updated_vectors, args.access_level, target_required_access_level
    )


if __name__ == "__main__":
    main()
