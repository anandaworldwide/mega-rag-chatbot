#!/usr/bin/env python3

"""
Clean a trailing "Month D, YYYY" from author metadata on live ananda.org vectors.

Listing, archive, and search pages lose the author. The byline on those pages
belongs to one teaser, not to the page. Article pages keep the author with the
date removed and the site's canonical name applied.

Uses PINECONE_INDEX_NAME. It does not read PINECONE_INGEST_INDEX_NAME except to
refuse to run when the two names are the same.

Dry-run is the default. Pass --apply to write.

Usage (from repo root):
    uv run python bin/strip_pinecone_byline_dates.py --site ananda-public
    uv run python bin/strip_pinecone_byline_dates.py --site ananda-public --apply
"""

import argparse
import logging
import os
import re
import sys
import time
from collections import defaultdict
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from dotenv import load_dotenv
from pinecone import Pinecone
from pinecone.exceptions import PineconeApiException

from data_ingestion.crawler.author_extraction import replacement_for_dated_author

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
            f"  uv run python bin/{Path(__file__).name} --site <site>\n"
            f"{venv_cmd}"
        )


_assert_project_python()

logger = logging.getLogger(__name__)

DEFAULT_DOMAIN = "ananda.org"
FETCH_BATCH_SIZE = 20
DEFAULT_FILTER_UPDATE_INTERVAL_SEC = 0.21
MAX_FILTER_UPDATE_RETRIES = 8
OMITTED_AUTHOR_LABEL = "(omit)"
_PAGE_OF_PAGES = re.compile(r"\bpage\s+\d+\s+of\s+\d+\b", re.IGNORECASE)
_AUTHOR_AT = re.compile(r",\s*author at\b", re.IGNORECASE)
_SEARCHED_FOR = re.compile(r"\byou searched for\b", re.IGNORECASE)
_AUTHOR_PATH = re.compile(r"(^|/)author(/|$)")
_PAGE_PATH = re.compile(r"(^|/)page/\d+(/|$)")
_SEARCH_PATH = re.compile(r"(^|/)search(/|$)")
# Page 1 of these archives has no "Page N of M" and no /page/ segment.
_LISTING_TITLE_PREFIXES = (
    "blogs and letters",
    "healing prayers blog",
    "questions and answers:",
)


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
    """Load environment variables from .env.[site_id]."""
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


def resolve_live_index_name(
    env: Mapping[str, str],
    index_name_override: str | None = None,
    allow_ingest_index: bool = False,
) -> str:
    """Return the live Pinecone index. Never falls back to the ingest index."""
    ingest_name = (env.get("PINECONE_INGEST_INDEX_NAME") or "").strip()
    if index_name_override and index_name_override.strip():
        index_name = index_name_override.strip()
    else:
        index_name = (env.get("PINECONE_INDEX_NAME") or "").strip()
        if not index_name:
            raise SystemExit(
                "PINECONE_INDEX_NAME is not set. This script updates the live index "
                "and does not use PINECONE_INGEST_INDEX_NAME."
            )

    if ingest_name and index_name == ingest_name and not allow_ingest_index:
        raise SystemExit(
            "Refusing to update "
            f"{index_name!r}: it matches PINECONE_INGEST_INDEX_NAME. "
            "Pass --allow-ingest-index only if that is intentional."
        )
    return index_name


def crawler_id_prefix(domain: str) -> str:
    """Vector ID prefix for website-crawler chunks of one domain."""
    normalized = domain.replace("www.", "").strip()
    return f"text||{normalized}||web||"


def author_library_filter(author: str, library: str) -> dict:
    """Exact author match limited to one library, so other corpora stay untouched."""
    return {
        "$and": [
            {"author": {"$eq": author}},
            {"library": {"$eq": library}},
        ]
    }


def display_author(author: str) -> str:
    return OMITTED_AUTHOR_LABEL if author == "" else author


def confirm_metadata_update(index_name: str, read_line=input) -> bool:
    """Ask until the operator types yes or no. Empty input asks again."""
    prompt = f"\nUpdate author metadata on {index_name}? Type yes or no: "
    while True:
        answer = read_line(prompt).strip().lower()
        if answer == "yes":
            return True
        if answer == "no":
            return False
        print("Type yes or no. Ctrl+C exits without writing.")


def _metadata_text(metadata: dict, key: str) -> str:
    value = metadata.get(key)
    if isinstance(value, str):
        return value
    return ""


def is_listing_page(title: str, url: str) -> bool:
    """Return True for archive, search, and pagination pages.

    A visible byline on those pages belongs to one teaser, not to the page.
    """
    normalized_title = re.sub(r"\s+", " ", title or "").strip()
    lowered = normalized_title.lower()
    if (
        _PAGE_OF_PAGES.search(lowered)
        or _AUTHOR_AT.search(lowered)
        or _SEARCHED_FOR.search(lowered)
    ):
        return True
    if any(lowered.startswith(prefix) for prefix in _LISTING_TITLE_PREFIXES):
        return True
    return _url_is_listing(url)


def _url_is_listing(url: str) -> bool:
    if not url:
        return False
    parsed = urlparse(url)
    path = parsed.path.lower()
    if (
        _AUTHOR_PATH.search(path)
        or _PAGE_PATH.search(path)
        or _SEARCH_PATH.search(path)
    ):
        return True
    return "s" in parse_qs(parsed.query)


def classify_dated_author(
    author: str, title: str, url: str, site_id: str
) -> tuple[str, str] | None:
    """Return (replacement, reason) when author has a trailing Month D, YYYY.

    Listing pages and site-wide bylines replace the author with "". Article
    pages keep the canonical name. Returns None when there is no trailing date.
    """
    canonical = replacement_for_dated_author(author, site_id)
    if canonical is None:
        return None
    if canonical == "":
        return "", "site-wide"
    if is_listing_page(title, url):
        return "", "listing"
    return canonical, "article"


@dataclass
class DatedAuthorPlan:
    author: str
    replacement: str
    reason: str
    vector_ids: list[str] = field(default_factory=list)
    sample_title: str = ""
    sample_url: str = ""
    use_filter: bool = True

    @property
    def count(self) -> int:
        return len(self.vector_ids)


def _record_dated_author(
    vector_id: str,
    vector,
    library: str,
    site_id: str,
    groups: dict[tuple[str, str, str], DatedAuthorPlan],
) -> None:
    metadata = dict(getattr(vector, "metadata", None) or {})
    if metadata.get("library") != library:
        return
    author = metadata.get("author")
    if not isinstance(author, str):
        return
    title = _metadata_text(metadata, "title")
    url = _metadata_text(metadata, "url") or _metadata_text(metadata, "source")
    classified = classify_dated_author(author, title, url, site_id)
    if classified is None:
        return
    replacement, reason = classified
    key = (author, replacement, reason)
    plan = groups.get(key)
    if plan is None:
        plan = DatedAuthorPlan(
            author=author,
            replacement=replacement,
            reason=reason,
            sample_title=title,
            sample_url=url,
        )
        groups[key] = plan
    plan.vector_ids.append(vector_id)


def _mark_filter_updates(plans: list[DatedAuthorPlan]) -> None:
    """Filter updates are safe only when one author string has one replacement."""
    by_author: dict[str, list[DatedAuthorPlan]] = defaultdict(list)
    for plan in plans:
        by_author[plan.author].append(plan)
    for author_plans in by_author.values():
        use_filter = len(author_plans) == 1
        for plan in author_plans:
            plan.use_filter = use_filter


def collect_dated_authors(
    index,
    prefix: str,
    library: str,
    site_id: str,
) -> tuple[list[DatedAuthorPlan], int]:
    """Scan crawler vectors and group dated authors by the write they need.

    Returns (plans, scanned vector count).
    """
    groups: dict[tuple[str, str, str], DatedAuthorPlan] = {}
    scanned = 0
    batch: list[str] = []

    def consume(ids: list[str]) -> None:
        nonlocal scanned
        if not ids:
            return
        response = index.fetch(ids=ids)
        vectors = getattr(response, "vectors", None) or {}
        scanned += len(ids)
        for vector_id, vector in vectors.items():
            _record_dated_author(vector_id, vector, library, site_id, groups)

    for id_batch in index.list(prefix=prefix):
        if isinstance(id_batch, str):
            batch.append(id_batch)
        else:
            batch.extend(id_batch)
        while len(batch) >= FETCH_BATCH_SIZE:
            consume(batch[:FETCH_BATCH_SIZE])
            batch = batch[FETCH_BATCH_SIZE:]
            if scanned and scanned % 2000 == 0:
                print(
                    f"  scanned {scanned:,} vectors, {len(groups):,} dated-author groups"
                )

    consume(batch)
    plans = sorted(groups.values(), key=lambda plan: (-plan.count, plan.author))
    _mark_filter_updates(plans)
    return plans, scanned


def _count_matching_vectors(index, author: str, library: str, rate_limiter) -> int:
    response = _filter_update(
        index,
        rate_limiter,
        filter=author_library_filter(author, library),
        set_metadata={"author": author},
        dry_run=True,
    )
    return int(getattr(response, "matched_records", 0) or 0)


def _bulk_replace_author(
    index,
    author: str,
    replacement: str,
    library: str,
    rate_limiter: FilterUpdateRateLimiter,
) -> int:
    updated_total = 0
    while True:
        response = _filter_update(
            index,
            rate_limiter,
            filter=author_library_filter(author, library),
            set_metadata={"author": replacement},
        )
        matched = int(getattr(response, "matched_records", 0) or 0)
        if matched == 0:
            break
        updated_total += matched
    return updated_total


def _print_plan(site_id: str, plans: list[DatedAuthorPlan]) -> None:
    print(f"\nDated authors on library vectors (site mappings: {site_id}):")
    print(
        f"{'Current author':<52} | {'Replacement':<28} | {'Why':<10} | {'Vectors':>8}"
    )
    print("-" * 108)
    if not plans:
        print("No dated authors found.")
        return
    for plan in plans:
        print(
            f"{plan.author:<52} | {display_author(plan.replacement):<28} | "
            f"{plan.reason:<10} | {plan.count:>8}"
        )
        if plan.sample_title:
            print(f"  title: {plan.sample_title}")
        if plan.sample_url:
            print(f"  url: {plan.sample_url}")
        if plan.vector_ids:
            print(f"  sample: {plan.vector_ids[0]}")


def _update_vector_ids(
    index,
    plan: DatedAuthorPlan,
    rate_limiter: FilterUpdateRateLimiter,
) -> int:
    for vector_id in plan.vector_ids:
        _filter_update(
            index,
            rate_limiter,
            id=vector_id,
            set_metadata={"author": plan.replacement},
        )
    return plan.count


def apply_plan(
    index,
    plans: list[DatedAuthorPlan],
    library: str,
    rate_limiter: FilterUpdateRateLimiter,
) -> int:
    updated = 0
    for plan in plans:
        if plan.use_filter:
            updated += _bulk_replace_author(
                index, plan.author, plan.replacement, library, rate_limiter
            )
            continue
        print(
            f"  {plan.author!r} is both a listing page and an article; "
            f"updating {plan.count} vector ids ({plan.reason})"
        )
        updated += _update_vector_ids(index, plan, rate_limiter)
    return updated


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Strip trailing byline dates from author metadata in the live Pinecone index."
        )
    )
    parser.add_argument(
        "--site",
        required=True,
        help="Site ID for .env.[site] and author mappings (ananda-public for ananda.org)",
    )
    parser.add_argument(
        "--domain",
        default=DEFAULT_DOMAIN,
        help=f"Crawler domain / library to clean (default: {DEFAULT_DOMAIN})",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Write metadata. Without this flag the script only reports matches.",
    )
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Skip the yes/no confirmation prompt when using --apply",
    )
    parser.add_argument(
        "--index-name",
        help="Override PINECONE_INDEX_NAME. Still refused when it equals the ingest index.",
    )
    parser.add_argument(
        "--allow-ingest-index",
        action="store_true",
        help="Allow the write when the chosen index equals PINECONE_INGEST_INDEX_NAME",
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

    load_env(args.site)
    index_name = resolve_live_index_name(
        os.environ,
        index_name_override=args.index_name,
        allow_ingest_index=args.allow_ingest_index,
    )
    ingest_name = (os.getenv("PINECONE_INGEST_INDEX_NAME") or "").strip() or "(unset)"
    library = args.domain.replace("www.", "").strip()
    prefix = crawler_id_prefix(library)

    print(f"Live index (PINECONE_INDEX_NAME): {index_name}")
    print(f"Ingest index (not used): {ingest_name}")
    print(f"Library filter: {library}")
    print(f"ID prefix: {prefix}")

    api_key = os.getenv("PINECONE_API_KEY")
    if not api_key:
        raise SystemExit("PINECONE_API_KEY is not set.")

    index = Pinecone(api_key=api_key).Index(index_name)
    print("\nScanning crawler vectors for dated authors...")
    plans, scanned = collect_dated_authors(index, prefix, library, args.site)
    dated_vectors = sum(plan.count for plan in plans)
    print(f"Scanned {scanned:,} vectors. Found {dated_vectors:,} with a trailing date.")
    _print_plan(args.site, plans)

    if not plans:
        return

    if not args.apply:
        print("\nDry run. No metadata was changed. Re-run with --apply to write.")
        return

    if not args.yes and not confirm_metadata_update(index_name):
        raise SystemExit("Aborted. No metadata was changed.")

    rate_limiter = FilterUpdateRateLimiter(min_interval_sec=args.update_interval)
    print("\nConfirming single-replacement authors with filter dry-run...")
    for plan in plans:
        if not plan.use_filter:
            continue
        matched = _count_matching_vectors(index, plan.author, library, rate_limiter)
        print(
            f"  {plan.author!r} -> {display_author(plan.replacement)!r}: "
            f"scan {plan.count}, filter {matched}"
        )
        if matched != plan.count:
            print("    filter count differs from the scan; updating vector ids only")
            plan.use_filter = False

    updated = apply_plan(index, plans, library, rate_limiter)
    print(f"\nUpdated {updated:,} vectors on {index_name}.")


if __name__ == "__main__":
    main()
