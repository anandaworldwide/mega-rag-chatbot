#!/usr/bin/env python3

"""
Find ananda.org listing-page vectors and delete them when asked.

The script uses the shared is_listing_page rule. It selects every listing
page. Author state does not matter.

Dry-run is the default. Dry-run prints vector counts and distinct URL
counts. The counts split into blank, teaser, and missing author.

--backup-path writes matched IDs and metadata to a local file. The file
must sit outside the repository. The file does not include chunk text.

--apply deletes the matched vectors. --apply refuses to run when a
completed backup file is missing.

Usage (from repo root):
    uv run python bin/delete_ananda_org_listing_vectors.py --site ananda
    uv run python bin/delete_ananda_org_listing_vectors.py --site ananda \\
        --backup-path /path/outside/repo/listing-backup.json
    uv run python bin/delete_ananda_org_listing_vectors.py --site ananda \\
        --backup-path /path/outside/repo/listing-backup.json --apply
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from collections import Counter
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

# Python puts bin/ on sys.path[0]. Add the repo root so data_ingestion imports.
_REPO_ROOT = Path(__file__).resolve().parents[1]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from pinecone import Pinecone  # noqa: E402

from data_ingestion.crawler.listing_page import is_listing_page  # noqa: E402
from data_ingestion.utils.author_ingest_guard import is_blank_author  # noqa: E402
from pyutil.env_utils import load_env  # noqa: E402


def _assert_project_python() -> None:
    """Fail fast when run under a Python other than the project 3.11 venv."""
    if sys.version_info[:2] != (3, 11):
        raise SystemExit(
            "This script requires the project Python 3.11 environment.\n"
            f"Current interpreter: {sys.executable} ({sys.version.split()[0]})\n"
            "From repo root run: uv run python bin/delete_ananda_org_listing_vectors.py ..."
        )


_assert_project_python()

logger = logging.getLogger(__name__)

DEFAULT_LIBRARY = "ananda.org"
DEFAULT_PREFIX = "text||ananda.org||web||"
FETCH_BATCH_SIZE = 100
DELETE_BATCH_SIZE = 100
AUTHOR_STATES = ("blank", "teaser", "missing")


@dataclass
class ListingMatch:
    vector_id: str
    url: str
    title: str
    author_state: str
    metadata: dict


@dataclass
class ListingScan:
    matches: list[ListingMatch] = field(default_factory=list)
    scanned: int = 0

    @property
    def vector_count(self) -> int:
        return len(self.matches)

    @property
    def urls(self) -> set[str]:
        return {match.url for match in self.matches if match.url}

    def counts_by_author_state(self) -> dict[str, dict[str, int]]:
        vectors = Counter(match.author_state for match in self.matches)
        urls_by_state: dict[str, set[str]] = {state: set() for state in AUTHOR_STATES}
        for match in self.matches:
            if match.url:
                urls_by_state[match.author_state].add(match.url)
        return {
            state: {
                "vectors": vectors[state],
                "urls": len(urls_by_state[state]),
            }
            for state in AUTHOR_STATES
        }


def classify_listing_author(metadata: dict) -> str:
    """Return blank, teaser, or missing for one listing vector."""
    if "author" not in metadata or metadata.get("author") is None:
        return "missing"
    author = metadata.get("author")
    if is_blank_author(author):
        return "blank"
    return "teaser"


def _metadata_text(metadata: dict, key: str) -> str:
    value = metadata.get(key)
    if isinstance(value, str):
        return value
    return ""


def metadata_without_text(metadata: dict) -> dict:
    """Copy metadata and drop chunk text. The repo is public."""
    cleaned = dict(metadata)
    cleaned.pop("text", None)
    return cleaned


def assert_backup_path_outside_repo(path: Path, repo_root: Path = _REPO_ROOT) -> None:
    """Refuse a backup path inside the git work tree."""
    resolved = path.expanduser().resolve()
    repo = repo_root.resolve()
    if resolved == repo or repo in resolved.parents:
        raise SystemExit(f"Backup path must be outside the repository: {resolved}")


def load_backup(path: Path) -> dict:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise SystemExit(f"Backup file not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise SystemExit(f"Backup file is not valid JSON: {path}") from exc
    if not isinstance(payload, dict) or not isinstance(payload.get("vectors"), list):
        raise SystemExit(f"Backup file has no vectors list: {path}")
    return payload


def backup_vector_ids(payload: dict) -> set[str]:
    ids: set[str] = set()
    for item in payload.get("vectors", []):
        if isinstance(item, dict) and isinstance(item.get("id"), str):
            ids.add(item["id"])
    return ids


def assert_backup_covers_matches(payload: dict, matches: list[ListingMatch]) -> None:
    """Refuse --apply when the backup does not hold every matched ID."""
    backup_ids = backup_vector_ids(payload)
    missing = [
        match.vector_id for match in matches if match.vector_id not in backup_ids
    ]
    if missing:
        raise SystemExit(
            "Backup is not complete. "
            f"{len(missing)} matched vector(s) are not in the backup. "
            "Run a dry-run with --backup-path first."
        )


def write_backup(path: Path, scan: ListingScan, index_name: str, library: str) -> None:
    assert_backup_path_outside_repo(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "index": index_name,
        "library": library,
        "created_at": datetime.now(UTC).isoformat(),
        "vector_count": scan.vector_count,
        "url_count": len(scan.urls),
        "author_breakdown": scan.counts_by_author_state(),
        "vectors": [
            {
                "id": match.vector_id,
                "author_state": match.author_state,
                "url": match.url,
                "title": match.title,
                "metadata": metadata_without_text(match.metadata),
            }
            for match in scan.matches
        ],
    }
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"Wrote backup: {path} ({scan.vector_count:,} vectors)", flush=True)


def fetch_metadata_only(index, ids: list[str]):
    """Fetch metadata without vector values or a hard dependency on that flag."""
    try:
        return index.fetch(ids=ids, include_values=False)
    except TypeError:
        return index.fetch(ids=ids)


def collect_listing_vectors(index, prefix: str, library: str) -> ListingScan:
    """List vectors and keep those that match is_listing_page."""
    scan = ListingScan()
    batch: list[str] = []

    def consume(ids: list[str]) -> None:
        if not ids:
            return
        response = fetch_metadata_only(index, ids)
        vectors = getattr(response, "vectors", None) or {}
        scan.scanned += len(ids)
        for vector_id, vector in vectors.items():
            metadata = metadata_without_text(
                dict(getattr(vector, "metadata", None) or {})
            )
            if metadata.get("library") != library:
                continue
            title = _metadata_text(metadata, "title")
            url = _metadata_text(metadata, "url") or _metadata_text(metadata, "source")
            if not is_listing_page(title, url):
                continue
            scan.matches.append(
                ListingMatch(
                    vector_id=vector_id,
                    url=url,
                    title=title,
                    author_state=classify_listing_author(metadata),
                    metadata=metadata,
                )
            )
        if scan.scanned and scan.scanned % 500 == 0:
            print(
                f"  scanned {scan.scanned:,} vectors, "
                f"{scan.vector_count:,} listing matches",
                flush=True,
            )

    for id_batch in index.list(prefix=prefix):
        if isinstance(id_batch, str):
            batch.append(id_batch)
        else:
            batch.extend(id_batch)
        while len(batch) >= FETCH_BATCH_SIZE:
            consume(batch[:FETCH_BATCH_SIZE])
            batch = batch[FETCH_BATCH_SIZE:]
    consume(batch)
    return scan


def print_scan_report(scan: ListingScan) -> None:
    breakdown = scan.counts_by_author_state()
    print("\nListing-page vectors (is_listing_page, any author state):", flush=True)
    print(f"  scanned:         {scan.scanned:,}", flush=True)
    print(f"  matched vectors: {scan.vector_count:,}", flush=True)
    print(f"  distinct URLs:   {len(scan.urls):,}", flush=True)
    print("  by author state:", flush=True)
    for state in AUTHOR_STATES:
        print(
            f"    {state:<8} vectors={breakdown[state]['vectors']:,}  "
            f"urls={breakdown[state]['urls']:,}",
            flush=True,
        )


def delete_matches(index, matches: list[ListingMatch]) -> int:
    deleted = 0
    ids = [match.vector_id for match in matches]
    for start in range(0, len(ids), DELETE_BATCH_SIZE):
        batch = ids[start : start + DELETE_BATCH_SIZE]
        index.delete(ids=batch)
        deleted += len(batch)
    return deleted


def resolve_index_name(env: dict[str, str]) -> str:
    name = (env.get("PINECONE_INDEX_NAME") or "").strip()
    if not name:
        name = (env.get("PINECONE_INGEST_INDEX_NAME") or "").strip()
    if not name:
        raise SystemExit(
            "PINECONE_INDEX_NAME or PINECONE_INGEST_INDEX_NAME is not set."
        )
    return name


def main() -> None:
    parser = argparse.ArgumentParser(
        description=("Delete ananda.org listing-page vectors. Dry-run is the default.")
    )
    parser.add_argument("--site", required=True, help="Site ID for .env.[site]")
    parser.add_argument(
        "--library",
        default=DEFAULT_LIBRARY,
        help=f"Library name (default: {DEFAULT_LIBRARY})",
    )
    parser.add_argument(
        "--prefix",
        default=DEFAULT_PREFIX,
        help=f"Vector ID prefix (default: {DEFAULT_PREFIX})",
    )
    parser.add_argument(
        "--backup-path",
        help="Write matched IDs and metadata to this file. Must be outside the repo.",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Delete matched vectors. Requires a completed --backup-path file.",
    )
    args = parser.parse_args()

    try:
        load_env(args.site)
    except FileNotFoundError:
        if not os.getenv("PINECONE_API_KEY"):
            raise
        print(
            f"No .env.{args.site} file found. Using process environment variables.",
            flush=True,
        )
    index_name = resolve_index_name(dict(os.environ))
    api_key = os.getenv("PINECONE_API_KEY")
    if not api_key:
        raise SystemExit("PINECONE_API_KEY is not set.")

    backup_path = Path(args.backup_path).expanduser() if args.backup_path else None
    if backup_path is not None:
        assert_backup_path_outside_repo(backup_path)

    print(f"Index: {index_name}", flush=True)
    print(f"Library: {args.library}", flush=True)
    print(f"ID prefix: {args.prefix}", flush=True)

    index = Pinecone(api_key=api_key).Index(index_name)
    print("\nScanning for listing-page vectors...", flush=True)
    scan = collect_listing_vectors(index, args.prefix, args.library)
    print_scan_report(scan)

    if backup_path is not None and not args.apply:
        write_backup(backup_path, scan, index_name, args.library)

    if not args.apply:
        print(
            "\nDry run. No vectors were deleted. Re-run with --apply to delete.",
            flush=True,
        )
        return

    if backup_path is None:
        raise SystemExit(
            "--apply refuses to run without --backup-path. "
            "Run a dry-run with --backup-path first."
        )
    if not backup_path.is_file():
        raise SystemExit(
            f"--apply refuses to run. Backup file does not exist: {backup_path}"
        )
    payload = load_backup(backup_path)
    assert_backup_covers_matches(payload, scan.matches)

    deleted = delete_matches(index, scan.matches)
    print(f"\nDeleted {deleted:,} listing-page vectors on {index_name}.")


if __name__ == "__main__":
    main()
