#! /usr/bin/env python3

"""
Script to standardize author names in Pinecone metadata.

This script finds and replaces various alternative forms of an author's name with a canonical version.
It's particularly useful for cleaning up inconsistencies in author names across a document collection.

The script loads author mappings from web/site-config/author_mappings.json based on the site ID.
Each site can have its own set of author name mappings.

Required Environment Variables (in .env.[site]):
    PINECONE_API_KEY: Your Pinecone API key
    PINECONE_ENVIRONMENT: Your Pinecone environment
    PINECONE_INDEX_NAME: Default index name (can be overridden with --index-name)

Usage (from repo root):
    uv sync
    uv run python bin/clean_pinecone_authors.py --site ananda-public --dry-run
    uv run python bin/clean_pinecone_authors.py --site ananda-public
    uv run python bin/clean_pinecone_authors.py --site ananda-public --sample-size 3
"""

import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[1]


def _assert_project_python() -> None:
    """Fail fast when run under pyenv/system Python instead of the uv-managed 3.11 venv."""
    if sys.version_info[:2] != (3, 11):
        venv_python = _REPO_ROOT / ".venv" / "bin" / "python"
        venv_cmd = (
            f"  {venv_python} bin/{Path(__file__).name} ...\n"
            if venv_python.is_file()
            else ""
        )
        raise SystemExit(
            "This script requires the project Python 3.11 environment.\n"
            f"Current interpreter: {sys.executable} ({sys.version.split()[0]})\n\n"
            "If a pyenv virtualenv is active, run `deactivate` first, then from repo root:\n"
            "  uv sync\n"
            f"  uv run python bin/{Path(__file__).name} --site <site> --dry-run\n"
            f"{venv_cmd}"
        )


_assert_project_python()

import argparse
import json
import logging
import os
import time
from collections import defaultdict

from data_ingestion.utils.author_normalization import resolve_author_mappings_path
from dotenv import load_dotenv
from pinecone import Pinecone
from pinecone.exceptions import PineconeApiException

logger = logging.getLogger(__name__)

# Pinecone serverless limit: 5 filter-based metadata updates per second per namespace.
DEFAULT_FILTER_UPDATE_INTERVAL_SEC = 0.21
MAX_FILTER_UPDATE_RETRIES = 8


class FilterUpdateRateLimiter:
    """Paces filter-based index.update calls to stay under Pinecone rate limits."""

    def __init__(self, min_interval_sec: float = DEFAULT_FILTER_UPDATE_INTERVAL_SEC):
        self.min_interval_sec = min_interval_sec
        self._last_call_at = 0.0

    def wait(self) -> None:
        if self.min_interval_sec <= 0:
            return
        now = time.monotonic()
        elapsed = now - self._last_call_at
        if elapsed < self.min_interval_sec:
            time.sleep(self.min_interval_sec - elapsed)
        self._last_call_at = time.monotonic()


def _filter_update(index, rate_limiter: FilterUpdateRateLimiter, **kwargs):
    """Call index.update with pacing and retry on HTTP 429."""
    for attempt in range(MAX_FILTER_UPDATE_RETRIES):
        rate_limiter.wait()
        try:
            return index.update(**kwargs)
        except PineconeApiException as exc:
            if exc.status != 429:
                raise
            if attempt == MAX_FILTER_UPDATE_RETRIES - 1:
                raise
            backoff = min(30.0, 1.0 * (2**attempt))
            logger.warning(
                "Pinecone filter update rate limited (429); retrying in %.1fs (attempt %d/%d)",
                backoff,
                attempt + 1,
                MAX_FILTER_UPDATE_RETRIES,
            )
            time.sleep(backoff)
    raise RuntimeError("Unreachable: filter update retry loop exhausted")


def load_env(site_id: str) -> None:
    """
    Load environment variables from a site-specific .env file.
    Searches up to 3 directories up from current directory.

    Args:
        site_id: Identifier for the site (e.g., 'ananda', 'crystal')

    Raises:
        FileNotFoundError: If no .env.[site_id] file is found
    """
    current_dir = os.getcwd()

    for _ in range(4):
        env_path = os.path.join(current_dir, f".env.{site_id}")
        if os.path.exists(env_path):
            load_dotenv(env_path)
            print(f"Loaded environment from: {env_path}")
            return
        current_dir = os.path.dirname(current_dir)

    raise FileNotFoundError(
        f"Environment file .env.{site_id} not found in the current directory or up to three levels up"
    )


def get_pinecone_client() -> Pinecone:
    """Initialize and return Pinecone client using environment variables."""
    return Pinecone(api_key=os.getenv("PINECONE_API_KEY"))


def get_index(pc: Pinecone, index_name: str | None = None):
    """
    Get Pinecone index instance.

    Args:
        pc: Pinecone client instance
        index_name: Optional override for index name from environment

    Returns:
        pinecone.Index: The Pinecone index instance
    """
    if index_name is None:
        index_name = os.getenv("PINECONE_INDEX_NAME")
        if index_name is None:
            raise ValueError("PINECONE_INDEX_NAME environment variable is not set")
    return pc.Index(index_name)


def load_author_mappings(site_id: str) -> dict[str, list[str]]:
    """
    Load author mappings for a specific site from web/site-config/author_mappings.json.

    Groups variants by their canonical name for processing.

    Args:
        site_id: Site identifier (e.g., 'ananda', 'crystal', 'jairam')

    Returns:
        Dictionary mapping canonical names to lists of variant names
        Example: {"Swami Kriyananda": ["Swami Kriyanananda", "Nayaswami Kriyananda", ...]}
    """
    config_path = resolve_author_mappings_path()

    try:
        with open(config_path, encoding="utf-8") as f:
            all_mappings = json.load(f)

        if site_id not in all_mappings:
            logger.error(f"Author mappings not found for site '{site_id}'")
            print(f"Error: Author mappings not found for site '{site_id}'")
            print(f"Available sites: {list(all_mappings.keys())}")
            return {}

        # Group variants by canonical name
        site_mappings = all_mappings[site_id]
        canonical_to_variants: dict[str, list[str]] = defaultdict(list)

        for variant, canonical in site_mappings.items():
            # Only include mappings where variant != canonical (actual corrections)
            if variant != canonical:
                canonical_to_variants[canonical].append(variant)

        return dict(canonical_to_variants)

    except FileNotFoundError:
        logger.error(f"Author mappings file not found at {config_path}")
        print(f"Error: Author mappings file not found at {config_path}")
        return {}
    except json.JSONDecodeError as e:
        logger.error(f"Invalid JSON in author mappings file: {e}")
        print(f"Error: Invalid JSON in author mappings file: {e}")
        return {}
    except Exception as e:
        logger.error(f"Could not load author mappings for {site_id}: {e}")
        print(f"Error: Could not load author mappings for {site_id}: {e}")
        return {}


def _author_eq_filter(author_name: str) -> dict[str, dict[str, str]]:
    return {"author": {"$eq": author_name}}


def _embedding_dimension() -> int:
    return int(os.getenv("OPENAI_EMBEDDINGS_DIMENSION", "3072"))


def _dummy_query_vector() -> list[float]:
    return [0.0] * _embedding_dimension()


def _query_author_vector_ids(index, author_name: str, top_k: int) -> list[str]:
    """Return vector IDs whose metadata author exactly matches author_name."""
    query_response = index.query(
        vector=_dummy_query_vector(),
        top_k=top_k,
        filter=_author_eq_filter(author_name),
        include_metadata=False,
        include_values=False,
    )
    return [match.id for match in query_response.matches]


def _count_vectors_by_author(
    index, author_name: str, rate_limiter: FilterUpdateRateLimiter
) -> int:
    """Return how many vectors match an exact author metadata value."""
    response = _filter_update(
        index,
        rate_limiter,
        filter=_author_eq_filter(author_name),
        set_metadata={"author": author_name},
        dry_run=True,
    )
    return int(getattr(response, "matched_records", 0) or 0)


def _bulk_replace_author_metadata(
    index,
    alt_name: str,
    canonical_name: str,
    rate_limiter: FilterUpdateRateLimiter,
) -> int:
    """
    Replace author metadata for all vectors matching alt_name.

    Uses Pinecone filter-based bulk update (up to 100,000 records per request).
    """
    updated_total = 0

    while True:
        response = _filter_update(
            index,
            rate_limiter,
            filter=_author_eq_filter(alt_name),
            set_metadata={"author": canonical_name},
        )
        matched = int(getattr(response, "matched_records", 0) or 0)
        if matched == 0:
            break
        updated_total += matched

    return updated_total


def find_and_replace_authors(
    index,
    alternative_names: list[str],
    canonical_name: str,
    dry_run: bool = True,
    sample_size: int = 3,
    rate_limiter: FilterUpdateRateLimiter | None = None,
) -> dict[str, int]:
    """
    Find and replace author names in Pinecone metadata.

    Args:
        index: Pinecone index instance
        alternative_names: List of alternative author names to search for
        canonical_name: The standardized name to replace alternatives with
        dry_run: If True, only count matches without making changes
        sample_size: Number of sample vectors to show in dry-run output

    Returns:
        Dict mapping each alternative name to the number of matches found

    Note:
        Uses Pinecone filter-based bulk update for writes (up to 100k vectors per
        request). Discovery for dry-run counts also uses filter dry_run so results
        are not capped like metadata queries. Filter updates are paced to Pinecone's
        5 requests/second limit for metadata updates.
    """
    stats = {name: 0 for name in alternative_names}
    limiter = rate_limiter or FilterUpdateRateLimiter()

    for alt_name in alternative_names:
        if dry_run:
            match_count = _count_vectors_by_author(index, alt_name, limiter)
            stats[alt_name] = match_count
            if match_count == 0:
                continue

            sample_ids = _query_author_vector_ids(
                index, alt_name, top_k=max(sample_size, 1)
            )
            if sample_ids:
                sample_response = index.fetch(ids=sample_ids[:sample_size])
                print(f"\nSample changes for '{alt_name}':")
                for vector_id, vector in sample_response.vectors.items():
                    metadata = dict(vector.metadata or {})
                    print(f"  ID: {vector_id}")
                    print(f"  Current metadata author: {metadata.get('author')}")
                    updated = {**metadata, "author": canonical_name}
                    print(f"  Would change author to: {updated.get('author')}\n")
                if match_count > sample_size:
                    print(f"  ... and {match_count - sample_size} more similar changes")
            continue

        stats[alt_name] = _bulk_replace_author_metadata(
            index, alt_name, canonical_name, limiter
        )

    return stats


def main():
    """
    Main entry point. Handles argument parsing and orchestrates the cleanup process.

    Command-line Arguments:
        --site: Site ID for loading environment variables and author mappings
        --dry-run: Flag to run without making changes
        --index-name: Optional override for Pinecone index name
    """
    parser = argparse.ArgumentParser(
        description="Clean up author names in Pinecone metadata"
    )
    parser.add_argument(
        "--site",
        required=True,
        help="Site ID for environment variables and author mappings",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Perform a dry run without making changes",
    )
    parser.add_argument("--index-name", help="Override the index name from env file")
    parser.add_argument(
        "--sample-size",
        type=int,
        default=3,
        help="Number of sample vectors to show during dry run (default: 3)",
    )
    parser.add_argument(
        "--update-interval",
        type=float,
        default=DEFAULT_FILTER_UPDATE_INTERVAL_SEC,
        help=(
            "Minimum seconds between Pinecone filter metadata updates "
            f"(default: {DEFAULT_FILTER_UPDATE_INTERVAL_SEC}, limit is 5/sec)"
        ),
    )

    args = parser.parse_args()

    # Setup: Load environment and author mappings
    load_env(args.site)

    # Load author mappings from site-specific config
    canonical_to_variants = load_author_mappings(args.site)

    if not canonical_to_variants:
        print("No author mappings found. Exiting.")
        return

    # Initialize Pinecone with new API
    pc = get_pinecone_client()
    index = get_index(pc, args.index_name)
    rate_limiter = FilterUpdateRateLimiter(min_interval_sec=args.update_interval)

    # Process each canonical name and its variants
    all_stats: dict[str, int] = {}

    print(f"\nProcessing author mappings for site '{args.site}':")
    print(f"Found {len(canonical_to_variants)} canonical author(s) with variants\n")

    for canonical_name, variants in canonical_to_variants.items():
        print(f"\n{'=' * 70}")
        print(f"Canonical: {canonical_name}")
        print(f"Variants: {', '.join(variants)}")
        print(f"{'=' * 70}")

        stats = find_and_replace_authors(
            index,
            variants,
            canonical_name,
            dry_run=args.dry_run,
            sample_size=args.sample_size,
            rate_limiter=rate_limiter,
        )

        # Merge stats
        all_stats.update(stats)

    # Display summary results
    print("\n" + "=" * 70)
    print("Summary Results:")
    print("=" * 70)
    print(f"{'Author Name':<50} | {'Count':>10}")
    print("-" * 62)

    if all_stats:
        for name, count in sorted(all_stats.items(), key=lambda x: x[1], reverse=True):
            print(f"{name:<50} | {count:>10}")
    else:
        print("No matching vectors found.")

    if args.dry_run:
        print("\nThis was a dry run. No changes were made.")
        print("To make actual changes, run without --dry-run")
    else:
        print("\nCleanup completed!")


if __name__ == "__main__":
    main()
