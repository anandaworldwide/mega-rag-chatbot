#!/usr/bin/env python3

"""
Analyze hierarchical title prefixes in Pinecone metadata.

This phase-zero script enumerates Pinecone vectors, extracts `metadata.title`,
builds cumulative `::` prefixes, and reports:

- full-title counts
- prefix counts
- prefix family sizes
- ambiguous terminal segments (for examples like "Genesis")
- serialized size estimates for likely cache structures

It is intentionally read-only. The only optional write behavior is local
artifact output under the workspace for inspection.

Usage:
    python bin/analyze_title_prefix_catalog.py --site ananda
    python bin/analyze_title_prefix_catalog.py --site ananda --max-vectors 5000
    python bin/analyze_title_prefix_catalog.py --site ananda --write-artifacts
    python bin/analyze_title_prefix_catalog.py --site ananda --use-ingest-index
    python bin/analyze_title_prefix_catalog.py --site ananda --vector-id-prefix "text||Ananda Library||db||Bible::"
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import time
import unicodedata
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any

DEFAULT_LIST_BATCH_SIZE = 100
DEFAULT_FETCH_BATCH_SIZE = 20
DEFAULT_TOP_N = 20
DEFAULT_AMBIGUITY_LIMIT = 50

ARTICLE_PATTERN = re.compile(r"^(?:the|a|an)\s+", re.IGNORECASE)
WHITESPACE_PATTERN = re.compile(r"\s+")
NON_ALNUM_PATTERN = re.compile(r"[^a-z0-9]+")

# Must match web/src/app/api/chat/v1/route.ts master_swami author filter.
MASTER_SWAMI_AUTHORS = frozenset({"Paramhansa Yogananda", "Swami Kriyananda"})
CANONICAL_MEDIA_TYPES = frozenset({"text", "audio", "youtube"})


def normalize_media_type(raw: Any) -> str:
    """Map Pinecone metadata.type to chat filter values (text/audio/youtube)."""
    if raw is None or raw == "":
        return "text"
    value = str(raw).strip().lower()
    if value in CANONICAL_MEDIA_TYPES:
        return value
    if value == "video":
        return "youtube"
    return "text"


@dataclass(frozen=True)
class ScriptConfig:
    """Runtime configuration for the title prefix analysis."""

    site: str
    index_name: str
    vector_id_prefix: str | None
    max_vectors: int | None
    list_batch_size: int
    fetch_batch_size: int
    top_n: int
    ambiguity_limit: int
    write_artifacts: bool
    output_dir: Path | None
    sqlite_path: Path
    artifact_version: str
    estimated_total_vectors: int | None = None


def log(message: str) -> None:
    """Print a line immediately so long-running jobs show live progress."""
    print(message, flush=True)


def format_progress(
    label: str,
    completed: int,
    total: int | None,
    start_time: float,
    extra: str = "",
) -> str:
    """Format a human-readable progress line."""
    elapsed_seconds = max(time.time() - start_time, 0.001)
    rate = completed / elapsed_seconds
    total_part = f"/{total:,}" if total is not None else ""
    percent_part = f" ({(completed / total) * 100:.1f}%)" if total else ""
    extra_part = f" | {extra}" if extra else ""
    return (
        f"{label}: {completed:,}{total_part}{percent_part} | "
        f"{rate:,.0f}/s | elapsed {elapsed_seconds:.1f}s{extra_part}"
    )


def canonicalize_title(title: str) -> str:
    """Normalize raw title formatting while preserving displayed hierarchy."""
    levels = [level.strip() for level in title.split("::") if level.strip()]
    return ":: ".join(levels)


def split_title_levels(title: str) -> list[str]:
    """Split a hierarchical title into clean levels."""
    return [level.strip() for level in title.split("::") if level.strip()]


def build_cumulative_prefixes(title: str) -> list[str]:
    """Return cumulative hierarchical prefixes for a title."""
    levels = split_title_levels(title)
    prefixes: list[str] = []
    for level_index in range(len(levels)):
        prefixes.append(":: ".join(levels[: level_index + 1]))
    return prefixes


def normalize_segment(value: str) -> str:
    """Normalize one title segment for matching and ambiguity analysis."""
    ascii_value = (
        unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")
    )
    lowered = ascii_value.lower().strip()
    without_article = ARTICLE_PATTERN.sub("", lowered)
    cleaned = NON_ALNUM_PATTERN.sub(" ", without_article)
    normalized = WHITESPACE_PATTERN.sub(" ", cleaned).strip()
    return normalized


def normalize_title_for_matching(title: str) -> str:
    """Normalize a full hierarchical title while preserving level boundaries."""
    normalized_levels = [
        normalized_level
        for normalized_level in (
            normalize_segment(level) for level in split_title_levels(title)
        )
        if normalized_level
    ]
    return " :: ".join(normalized_levels)


def get_cache_dir() -> Path:
    """Return the local cache directory for output artifacts and temp state."""
    return Path(__file__).resolve().parents[1] / ".cache" / "title_prefix_catalog"


def get_pinecone_client() -> Any:
    """Initialize and return the Pinecone client."""
    try:
        from pinecone import Pinecone
    except ImportError as error:
        raise ImportError(
            "The 'pinecone' package is required to run this script in the current "
            "Python environment."
        ) from error

    api_key = os.environ.get("PINECONE_API_KEY")
    if not api_key:
        raise ValueError("PINECONE_API_KEY environment variable not set")
    return Pinecone(api_key=api_key)


def resolve_index_name(args: argparse.Namespace) -> str:
    """Resolve the Pinecone index name from args and environment."""
    if args.index_name:
        return args.index_name

    if args.use_ingest_index:
        index_name = os.environ.get("PINECONE_INGEST_INDEX_NAME")
        if not index_name:
            raise ValueError("PINECONE_INGEST_INDEX_NAME environment variable not set")
        return index_name

    index_name = os.environ.get("PINECONE_INDEX_NAME")
    if not index_name:
        raise ValueError("PINECONE_INDEX_NAME environment variable not set")
    return index_name


def resolve_sqlite_path(args: argparse.Namespace, output_dir: Path) -> Path:
    """Resolve the SQLite work database path for this run."""
    if args.sqlite_path:
        return Path(args.sqlite_path)

    if args.write_artifacts:
        return output_dir / "analysis.sqlite3"

    timestamp = int(time.time())
    return get_cache_dir() / "tmp" / f"{args.site}-{timestamp}.sqlite3"


def initialize_database(sqlite_path: Path) -> sqlite3.Connection:
    """Create a disk-backed SQLite database for memory-safe aggregation."""
    sqlite_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(sqlite_path)
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA synchronous=NORMAL")
    connection.execute("PRAGMA temp_store=FILE")
    connection.execute("PRAGMA foreign_keys=OFF")
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS full_titles (
            title TEXT PRIMARY KEY,
            vector_count INTEGER NOT NULL DEFAULT 0
        )
        """
    )
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS title_libraries (
            title TEXT NOT NULL,
            library TEXT NOT NULL,
            PRIMARY KEY (title, library)
        )
        """
    )
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS prefixes (
            prefix TEXT PRIMARY KEY,
            depth INTEGER NOT NULL,
            terminal_segment TEXT NOT NULL,
            vector_count INTEGER NOT NULL DEFAULT 0
        )
        """
    )
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS prefix_titles (
            prefix TEXT NOT NULL,
            title TEXT NOT NULL,
            PRIMARY KEY (prefix, title)
        )
        """
    )
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS prefix_libraries (
            prefix TEXT NOT NULL,
            library TEXT NOT NULL,
            PRIMARY KEY (prefix, library)
        )
        """
    )
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS normalized_prefix_lookup (
            normalized_prefix TEXT NOT NULL,
            prefix TEXT NOT NULL,
            PRIMARY KEY (normalized_prefix, prefix)
        )
        """
    )
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS terminal_segments (
            normalized_segment TEXT NOT NULL,
            prefix TEXT NOT NULL,
            PRIMARY KEY (normalized_segment, prefix)
        )
        """
    )
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS depth_counts (
            depth INTEGER PRIMARY KEY,
            vector_count INTEGER NOT NULL DEFAULT 0
        )
        """
    )
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS prefix_authors (
            prefix TEXT NOT NULL,
            author TEXT NOT NULL,
            PRIMARY KEY (prefix, author)
        )
        """
    )
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS prefix_media_types (
            prefix TEXT NOT NULL,
            media_type TEXT NOT NULL,
            PRIMARY KEY (prefix, media_type)
        )
        """
    )
    connection.commit()
    return connection


def upsert_batch_into_database(
    connection: sqlite3.Connection, rows: list[tuple[str, str, str, str]]
) -> None:
    """Aggregate one fetched metadata batch into SQLite.

    Each row is (title, library, author, media_type) where media_type is canonical text/audio/youtube.
    """
    if not rows:
        return

    title_counts: Counter[str] = Counter()
    depth_counts: Counter[int] = Counter()
    title_libraries: set[tuple[str, str]] = set()
    prefix_counts: Counter[str] = Counter()
    prefix_metadata: dict[str, tuple[int, str]] = {}
    prefix_titles: set[tuple[str, str]] = set()
    prefix_libraries: set[tuple[str, str]] = set()
    prefix_authors: set[tuple[str, str]] = set()
    prefix_media_types: set[tuple[str, str]] = set()
    normalized_prefixes: set[tuple[str, str]] = set()
    terminal_segments: set[tuple[str, str]] = set()

    for title, library, author, media_type in rows:
        title_counts[title] += 1
        if library:
            title_libraries.add((title, library))

        prefixes = build_cumulative_prefixes(title)
        depth_counts[len(prefixes)] += 1

        for prefix in prefixes:
            if prefix not in prefix_metadata:
                levels = split_title_levels(prefix)
                prefix_metadata[prefix] = (len(levels), levels[-1])

            prefix_counts[prefix] += 1
            prefix_titles.add((prefix, title))

            if library:
                prefix_libraries.add((prefix, library))

            author_stripped = author.strip()
            if author_stripped:
                prefix_authors.add((prefix, author_stripped))

            prefix_media_types.add((prefix, media_type))

            normalized_prefixes.add((normalize_title_for_matching(prefix), prefix))
            terminal_segments.add((normalize_segment(prefix_metadata[prefix][1]), prefix))

    with connection:
        connection.executemany(
            """
            INSERT INTO full_titles (title, vector_count)
            VALUES (?, ?)
            ON CONFLICT(title) DO UPDATE
            SET vector_count = full_titles.vector_count + excluded.vector_count
            """,
            list(title_counts.items()),
        )
        connection.executemany(
            "INSERT OR IGNORE INTO title_libraries (title, library) VALUES (?, ?)",
            list(title_libraries),
        )
        connection.executemany(
            """
            INSERT INTO prefixes (prefix, depth, terminal_segment, vector_count)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(prefix) DO UPDATE
            SET vector_count = prefixes.vector_count + excluded.vector_count
            """,
            [
                (prefix, depth, terminal_segment, prefix_counts[prefix])
                for prefix, (depth, terminal_segment) in prefix_metadata.items()
            ],
        )
        connection.executemany(
            "INSERT OR IGNORE INTO prefix_titles (prefix, title) VALUES (?, ?)",
            list(prefix_titles),
        )
        connection.executemany(
            "INSERT OR IGNORE INTO prefix_libraries (prefix, library) VALUES (?, ?)",
            list(prefix_libraries),
        )
        connection.executemany(
            "INSERT OR IGNORE INTO prefix_authors (prefix, author) VALUES (?, ?)",
            list(prefix_authors),
        )
        connection.executemany(
            "INSERT OR IGNORE INTO prefix_media_types (prefix, media_type) VALUES (?, ?)",
            list(prefix_media_types),
        )
        connection.executemany(
            """
            INSERT OR IGNORE INTO normalized_prefix_lookup (normalized_prefix, prefix)
            VALUES (?, ?)
            """,
            [
                (normalized_prefix, prefix)
                for normalized_prefix, prefix in normalized_prefixes
                if normalized_prefix
            ],
        )
        connection.executemany(
            """
            INSERT OR IGNORE INTO terminal_segments (normalized_segment, prefix)
            VALUES (?, ?)
            """,
            [
                (normalized_segment, prefix)
                for normalized_segment, prefix in terminal_segments
                if normalized_segment
            ],
        )
        connection.executemany(
            """
            INSERT INTO depth_counts (depth, vector_count)
            VALUES (?, ?)
            ON CONFLICT(depth) DO UPDATE
            SET vector_count = depth_counts.vector_count + excluded.vector_count
            """,
            list(depth_counts.items()),
        )


def stream_titles_to_database(
    index: Any, config: ScriptConfig, connection: sqlite3.Connection
) -> dict[str, int]:
    """Stream Pinecone IDs and metadata directly into SQLite-backed aggregates."""
    list_kwargs: dict[str, Any] = {"limit": config.list_batch_size}
    if config.vector_id_prefix:
        list_kwargs["prefix"] = config.vector_id_prefix

    progress_total = config.max_vectors
    if progress_total is None and config.vector_id_prefix is None:
        progress_total = config.estimated_total_vectors

    listed_vectors = 0
    titled_vectors = 0
    list_batch_count = 0
    fetch_batch_count = 0
    start_time = time.time()

    log("Streaming Pinecone IDs and metadata into SQLite...")
    for listed_batch in index.list(**list_kwargs):
        vector_ids = [str(vector_id) for vector_id in listed_batch]
        if not vector_ids:
            continue

        if config.max_vectors is not None:
            remaining = config.max_vectors - listed_vectors
            if remaining <= 0:
                break
            vector_ids = vector_ids[:remaining]

        list_batch_count += 1
        listed_vectors += len(vector_ids)

        if list_batch_count == 1 or list_batch_count % 10 == 0:
            log(
                format_progress(
                    "ID scan",
                    listed_vectors,
                    progress_total,
                    start_time,
                    extra=(
                        f"list_batches={list_batch_count}, "
                        f"title_rows={titled_vectors:,}"
                    ),
                )
            )

        for offset in range(0, len(vector_ids), config.fetch_batch_size):
            fetch_batch_count += 1
            fetch_ids = vector_ids[offset : offset + config.fetch_batch_size]
            try:
                fetch_response = index.fetch(ids=fetch_ids)
            except Exception as error:
                log(
                    f"Skipping fetch batch {fetch_batch_count} at vector {listed_vectors:,}: {error}"
                )
                continue

            batch_rows: list[tuple[str, str, str, str]] = []
            for vector_data in fetch_response.vectors.values():
                metadata = vector_data.metadata or {}
                raw_title = metadata.get("title")
                if raw_title is None:
                    continue

                title = canonicalize_title(str(raw_title))
                if not title:
                    continue

                library = str(metadata.get("library", "")).strip()
                author = str(metadata.get("author", "")).strip()
                media_type = normalize_media_type(metadata.get("type"))
                batch_rows.append((title, library, author, media_type))

            upsert_batch_into_database(connection, batch_rows)
            titled_vectors += len(batch_rows)

            if fetch_batch_count == 1 or fetch_batch_count % 50 == 0:
                log(
                    format_progress(
                        "Metadata fetch",
                        listed_vectors,
                        progress_total,
                        start_time,
                        extra=(
                            f"fetch_batches={fetch_batch_count}, "
                            f"title_rows={titled_vectors:,}"
                        ),
                    )
                )

        if config.max_vectors is not None and listed_vectors >= config.max_vectors:
            break

    log(
        f"Finished streaming {listed_vectors:,} vector ID(s); "
        f"found {titled_vectors:,} titled vector(s)"
    )
    return {
        "listedVectorCount": listed_vectors,
        "titledVectorCount": titled_vectors,
        "listBatchCount": list_batch_count,
        "fetchBatchCount": fetch_batch_count,
    }


def estimate_mapping_json_size(items: Any) -> int:
    """Estimate the JSON byte size of a mapping without loading it fully into memory."""
    total_bytes = 2
    first_item = True
    for key, value in items:
        if not first_item:
            total_bytes += 1
        total_bytes += len(json.dumps(key, ensure_ascii=False).encode("utf-8"))
        total_bytes += 1
        total_bytes += len(
            json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode(
                "utf-8"
            )
        )
        first_item = False
    return total_bytes


def iter_full_title_catalog_items(connection: sqlite3.Connection):
    """Yield full title catalog items as (key, value) tuples."""
    cursor = connection.execute(
        """
        SELECT ft.title, ft.vector_count, tl.library
        FROM full_titles ft
        LEFT JOIN title_libraries tl ON tl.title = ft.title
        ORDER BY ft.title, tl.library
        """
    )
    current_title: str | None = None
    current_vector_count = 0
    current_libraries: list[str] = []

    for title, vector_count, library in cursor:
        if current_title != title:
            if current_title is not None:
                yield current_title, {
                    "vectorCount": current_vector_count,
                    "libraries": current_libraries,
                }
            current_title = str(title)
            current_vector_count = int(vector_count)
            current_libraries = []

        if library is not None:
            current_libraries.append(str(library))

    if current_title is not None:
        yield current_title, {
            "vectorCount": current_vector_count,
            "libraries": current_libraries,
        }


def iter_prefix_catalog_items(connection: sqlite3.Connection):
    """Yield compact prefix catalog items as (key, value) tuples."""
    cursor = connection.execute(
        """
        SELECT
            p.prefix,
            p.depth,
            p.terminal_segment,
            p.vector_count,
            COALESCE(pt.full_title_count, 0),
            pl.library
        FROM prefixes p
        LEFT JOIN (
            SELECT prefix, COUNT(*) AS full_title_count
            FROM prefix_titles
            GROUP BY prefix
        ) pt ON pt.prefix = p.prefix
        LEFT JOIN prefix_libraries pl ON pl.prefix = p.prefix
        ORDER BY p.prefix, pl.library
        """
    )
    current_prefix: str | None = None
    current_depth = 0
    current_terminal_segment = ""
    current_vector_count = 0
    current_full_title_count = 0
    current_libraries: list[str] = []

    for (
        prefix,
        depth,
        terminal_segment,
        vector_count,
        full_title_count,
        library,
    ) in cursor:
        if current_prefix != prefix:
            if current_prefix is not None:
                yield current_prefix, {
                    "depth": current_depth,
                    "terminalSegment": current_terminal_segment,
                    "fullTitleCount": current_full_title_count,
                    "vectorCount": current_vector_count,
                    "libraries": current_libraries,
                }
            current_prefix = str(prefix)
            current_depth = int(depth)
            current_terminal_segment = str(terminal_segment)
            current_vector_count = int(vector_count)
            current_full_title_count = int(full_title_count)
            current_libraries = []

        if library is not None:
            current_libraries.append(str(library))

    if current_prefix is not None:
        yield current_prefix, {
            "depth": current_depth,
            "terminalSegment": current_terminal_segment,
            "fullTitleCount": current_full_title_count,
            "vectorCount": current_vector_count,
            "libraries": current_libraries,
        }


def iter_prefix_to_full_titles_items(connection: sqlite3.Connection):
    """Yield prefix -> full titles mapping items."""
    cursor = connection.execute(
        """
        SELECT prefix, title
        FROM prefix_titles
        ORDER BY prefix, title
        """
    )
    current_prefix: str | None = None
    current_titles: list[str] = []

    for prefix, title in cursor:
        if current_prefix != prefix:
            if current_prefix is not None:
                yield current_prefix, current_titles
            current_prefix = str(prefix)
            current_titles = []
        current_titles.append(str(title))

    if current_prefix is not None:
        yield current_prefix, current_titles


def iter_normalized_prefix_lookup_items(connection: sqlite3.Connection):
    """Yield normalized prefix lookup mapping items."""
    cursor = connection.execute(
        """
        SELECT normalized_prefix, prefix
        FROM normalized_prefix_lookup
        ORDER BY normalized_prefix, prefix
        """
    )
    current_normalized: str | None = None
    current_prefixes: list[str] = []

    for normalized_prefix, prefix in cursor:
        if current_normalized != normalized_prefix:
            if current_normalized is not None:
                yield current_normalized, current_prefixes
            current_normalized = str(normalized_prefix)
            current_prefixes = []
        current_prefixes.append(str(prefix))

    if current_normalized is not None:
        yield current_normalized, current_prefixes


def iter_ambiguous_terminal_segment_items(connection: sqlite3.Connection):
    """Yield normalized terminal segments that map to multiple prefixes."""
    cursor = connection.execute(
        """
        SELECT ts.normalized_segment, ts.prefix
        FROM terminal_segments ts
        INNER JOIN (
            SELECT normalized_segment
            FROM terminal_segments
            GROUP BY normalized_segment
            HAVING COUNT(*) > 1
        ) ambiguous ON ambiguous.normalized_segment = ts.normalized_segment
        ORDER BY ts.normalized_segment, ts.prefix
        """
    )
    current_segment: str | None = None
    current_prefixes: list[str] = []

    for normalized_segment, prefix in cursor:
        if current_segment != normalized_segment:
            if current_segment is not None:
                yield current_segment, current_prefixes
            current_segment = str(normalized_segment)
            current_prefixes = []
        current_prefixes.append(str(prefix))

    if current_segment is not None:
        yield current_segment, current_prefixes


def load_prefix_distinct_field_map(
    connection: sqlite3.Connection, table: str, value_column: str
) -> dict[str, list[str]]:
    """Load prefix -> sorted distinct string values.

    SQLite does not allow DISTINCT and ORDER BY together inside GROUP_CONCAT; use DISTINCT
    only and sort in Python.
    """
    # value_column is fixed by callers only; not user input.
    sql = f"SELECT prefix, GROUP_CONCAT(DISTINCT {value_column}) FROM {table} GROUP BY prefix"
    result: dict[str, list[str]] = {}
    for prefix, joined in connection.execute(sql):
        key = str(prefix)
        if joined:
            parts = [part for part in str(joined).split(",") if part]
            result[key] = sorted(set(parts))
        else:
            result[key] = []
    return result


def build_collections_with_vectors_for_prefix(authors: list[str]) -> list[str]:
    """Derive chat collection keys that can return vectors for this prefix."""
    collections: list[str] = []
    if any(author in MASTER_SWAMI_AUTHORS for author in authors):
        collections.append("master_swami")
    collections.append("whole_library")
    return collections


def iter_runtime_lookup_entries(connection: sqlite3.Connection):
    """Yield compact runtime lookup entries for autocomplete and matching."""
    library_map = load_prefix_distinct_field_map(connection, "prefix_libraries", "library")
    author_map = load_prefix_distinct_field_map(connection, "prefix_authors", "author")
    media_map = load_prefix_distinct_field_map(connection, "prefix_media_types", "media_type")

    cursor = connection.execute(
        """
        SELECT
            p.prefix,
            p.depth,
            p.terminal_segment,
            p.vector_count,
            COALESCE(pt.full_title_count, 0) AS full_title_count
        FROM prefixes p
        LEFT JOIN (
            SELECT prefix, COUNT(*) AS full_title_count
            FROM prefix_titles
            GROUP BY prefix
        ) pt ON pt.prefix = p.prefix
        ORDER BY p.prefix
        """
    )
    for prefix, depth, terminal_segment, vector_count, full_title_count in cursor:
        prefix_str = str(prefix)
        authors = author_map.get(prefix_str, [])
        media_types = media_map.get(prefix_str, [])
        if not media_types:
            media_types = ["text"]
        libraries = library_map.get(prefix_str, [])
        yield {
            "canonicalPrefix": prefix_str,
            "normalizedPrefix": normalize_title_for_matching(prefix_str),
            "normalizedSearchText": normalize_title_for_matching(prefix_str).replace(
                " :: ", " "
            ),
            "normalizedLevels": [
                normalize_segment(level) for level in split_title_levels(prefix_str)
            ],
            "depth": int(depth),
            "terminalSegment": str(terminal_segment),
            "normalizedTerminalSegment": normalize_segment(str(terminal_segment)),
            "fullTitleCount": int(full_title_count),
            "vectorCount": int(vector_count),
            "availability": {
                "libraries": libraries,
                "mediaTypes": media_types,
                "collectionsWithVectors": build_collections_with_vectors_for_prefix(authors),
            },
        }


def iter_runtime_expansion_entries(connection: sqlite3.Connection):
    """Yield canonical prefix -> full title expansion entries."""
    for canonical_prefix, full_titles in iter_prefix_to_full_titles_items(connection):
        yield canonical_prefix, full_titles


def query_scalar(
    connection: sqlite3.Connection, sql: str, parameters: tuple[Any, ...] = ()
) -> int | float:
    """Return the first column from the first row of a query, defaulting to zero."""
    row = connection.execute(sql, parameters).fetchone()
    if row is None or row[0] is None:
        return 0
    return row[0]


def build_summary(
    connection: sqlite3.Connection,
    scan_stats: dict[str, int],
    top_n: int,
    ambiguity_limit: int,
) -> dict[str, Any]:
    """Build a compact summary report from SQLite-backed aggregates."""
    depth_counts = {
        int(depth): int(vector_count)
        for depth, vector_count in connection.execute(
            "SELECT depth, vector_count FROM depth_counts ORDER BY depth"
        )
    }

    largest_prefixes = [
        {
            "prefix": prefix,
            "depth": int(depth),
            "fullTitleCount": int(full_title_count),
            "vectorCount": int(vector_count),
            "libraryCount": int(library_count),
        }
        for prefix, depth, vector_count, full_title_count, library_count in connection.execute(
            """
            SELECT
                p.prefix,
                p.depth,
                p.vector_count,
                COALESCE(pt.full_title_count, 0) AS full_title_count,
                COALESCE(pl.library_count, 0) AS library_count
            FROM prefixes p
            LEFT JOIN (
                SELECT prefix, COUNT(*) AS full_title_count
                FROM prefix_titles
                GROUP BY prefix
            ) pt ON pt.prefix = p.prefix
            LEFT JOIN (
                SELECT prefix, COUNT(*) AS library_count
                FROM prefix_libraries
                GROUP BY prefix
            ) pl ON pl.prefix = p.prefix
            ORDER BY full_title_count DESC, p.vector_count DESC, p.prefix
            LIMIT ?
            """,
            (top_n,),
        )
    ]

    largest_titles = [
        {
            "title": title,
            "vectorCount": int(vector_count),
            "libraryCount": int(library_count),
        }
        for title, vector_count, library_count in connection.execute(
            """
            SELECT
                ft.title,
                ft.vector_count,
                COALESCE(tl.library_count, 0) AS library_count
            FROM full_titles ft
            LEFT JOIN (
                SELECT title, COUNT(*) AS library_count
                FROM title_libraries
                GROUP BY title
            ) tl ON tl.title = ft.title
            ORDER BY ft.vector_count DESC, ft.title
            LIMIT ?
            """,
            (top_n,),
        )
    ]

    ambiguity_rows = connection.execute(
        """
        SELECT normalized_segment, COUNT(*) AS prefix_count
        FROM terminal_segments
        GROUP BY normalized_segment
        HAVING COUNT(*) > 1
        ORDER BY prefix_count DESC, normalized_segment
        LIMIT ?
        """,
        (ambiguity_limit,),
    ).fetchall()
    ambiguity_examples = []
    for normalized_segment, prefix_count in ambiguity_rows:
        sample_prefixes = [
            row[0]
            for row in connection.execute(
                """
                SELECT prefix
                FROM terminal_segments
                WHERE normalized_segment = ?
                ORDER BY prefix
                LIMIT 5
                """,
                (normalized_segment,),
            )
        ]
        ambiguity_examples.append(
            {
                "normalizedSegment": str(normalized_segment),
                "matchingPrefixCount": int(prefix_count),
                "samplePrefixes": sample_prefixes,
            }
        )

    payload_sizes = {
        "fullTitleCatalogBytes": estimate_mapping_json_size(
            iter_full_title_catalog_items(connection)
        ),
        "prefixCatalogBytes": estimate_mapping_json_size(
            iter_prefix_catalog_items(connection)
        ),
        "prefixToFullTitlesBytes": estimate_mapping_json_size(
            iter_prefix_to_full_titles_items(connection)
        ),
        "normalizedPrefixLookupBytes": estimate_mapping_json_size(
            iter_normalized_prefix_lookup_items(connection)
        ),
        "ambiguousTerminalSegmentsBytes": estimate_mapping_json_size(
            iter_ambiguous_terminal_segment_items(connection)
        ),
    }

    return {
        "listedVectorCount": scan_stats["listedVectorCount"],
        "totalVectorsWithTitles": scan_stats["titledVectorCount"],
        "uniqueFullTitles": int(
            query_scalar(connection, "SELECT COUNT(*) FROM full_titles")
        ),
        "uniquePrefixes": int(query_scalar(connection, "SELECT COUNT(*) FROM prefixes")),
        "uniqueNormalizedPrefixes": int(
            query_scalar(
                connection, "SELECT COUNT(DISTINCT normalized_prefix) FROM normalized_prefix_lookup"
            )
        ),
        "ambiguousTerminalSegmentCount": int(
            query_scalar(
                connection,
                """
                SELECT COUNT(*)
                FROM (
                    SELECT normalized_segment
                    FROM terminal_segments
                    GROUP BY normalized_segment
                    HAVING COUNT(*) > 1
                )
                """,
            )
        ),
        "maxHierarchyDepth": int(
            query_scalar(connection, "SELECT MAX(depth) FROM prefixes")
        ),
        "averageTitlesPerPrefix": round(
            float(
                query_scalar(
                    connection,
                    """
                    SELECT AVG(full_title_count)
                    FROM (
                        SELECT COUNT(*) AS full_title_count
                        FROM prefix_titles
                        GROUP BY prefix
                    )
                    """,
                )
            ),
            2,
        ),
        "depthCounts": depth_counts,
        "payloadSizes": payload_sizes,
        "largestPrefixes": largest_prefixes,
        "largestTitles": largest_titles,
        "ambiguityExamples": ambiguity_examples,
    }


def print_summary(summary: dict[str, Any]) -> None:
    """Print a readable human summary to stdout."""
    print("\nTITLE PREFIX CATALOG SUMMARY")
    print("-" * 80)
    print(f"Vectors scanned: {summary['listedVectorCount']:,}")
    print(f"Vectors with titles: {summary['totalVectorsWithTitles']:,}")
    print(f"Unique full titles: {summary['uniqueFullTitles']:,}")
    print(f"Unique cumulative prefixes: {summary['uniquePrefixes']:,}")
    print(f"Unique normalized prefixes: {summary['uniqueNormalizedPrefixes']:,}")
    print(
        f"Ambiguous terminal segments: {summary['ambiguousTerminalSegmentCount']:,}"
    )
    print(f"Max hierarchy depth: {summary['maxHierarchyDepth']}")
    print(f"Average titles per prefix: {summary['averageTitlesPerPrefix']}")

    print("\nDepth counts:")
    for depth, count in summary["depthCounts"].items():
        print(f"  Depth {depth}: {count:,}")

    print("\nPayload size estimates:")
    for payload_name, payload_size in summary["payloadSizes"].items():
        print(f"  {payload_name}: {payload_size:,} bytes")

    print("\nLargest prefix families:")
    for prefix_stats in summary["largestPrefixes"]:
        print(
            f"  {prefix_stats['fullTitleCount']:>6,} titles |"
            f" {prefix_stats['vectorCount']:>8,} vectors |"
            f" depth {prefix_stats['depth']} | {prefix_stats['prefix']}"
        )

    print("\nLargest full titles by vector count:")
    for title_stats in summary["largestTitles"]:
        print(
            f"  {title_stats['vectorCount']:>8,} vectors |"
            f" {title_stats['libraryCount']:>2} libraries | {title_stats['title']}"
        )

    print("\nAmbiguous terminal segment examples:")
    for ambiguity in summary["ambiguityExamples"]:
        sample_prefixes = "; ".join(ambiguity["samplePrefixes"])
        print(
            f"  {ambiguity['normalizedSegment']} -> "
            f"{ambiguity['matchingPrefixCount']} prefixes ({sample_prefixes})"
        )


def write_artifacts(
    output_dir: Path,
    config: ScriptConfig,
    summary: dict[str, Any],
    connection: sqlite3.Connection,
) -> None:
    """Write summary artifacts and runtime title-catalog payloads."""
    output_dir.mkdir(parents=True, exist_ok=True)
    version_dir = output_dir / config.artifact_version
    version_dir.mkdir(parents=True, exist_ok=True)

    summary_payload = {
        "generatedAtEpochSeconds": int(time.time()),
        "indexName": config.index_name,
        "vectorIdPrefix": config.vector_id_prefix,
        "maxVectors": config.max_vectors,
        "sqlitePath": str(config.sqlite_path),
        "summary": summary,
    }
    (output_dir / "summary.json").write_text(
        json.dumps(summary_payload, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    lookup_entries = list(iter_runtime_lookup_entries(connection))
    lookup_payload = {
        "site": config.site,
        "version": config.artifact_version,
        "generatedAtEpochSeconds": int(time.time()),
        "entryCount": len(lookup_entries),
        "entries": lookup_entries,
    }
    (version_dir / "lookup.json").write_text(
        json.dumps(lookup_payload, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    expansions_payload = {
        "version": config.artifact_version,
        "generatedAtEpochSeconds": int(time.time()),
        "expansionCount": int(query_scalar(connection, "SELECT COUNT(*) FROM prefixes")),
        "expansions": {
            canonical_prefix: full_titles
            for canonical_prefix, full_titles in iter_runtime_expansion_entries(connection)
        },
    }
    (version_dir / "expansions.json").write_text(
        json.dumps(expansions_payload, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    manifest_payload = {
        "site": config.site,
        "version": config.artifact_version,
        "generatedAtEpochSeconds": int(time.time()),
        "indexName": config.index_name,
        "lookupKey": f"{config.artifact_version}/lookup.json",
        "expansionsKey": f"{config.artifact_version}/expansions.json",
        "summary": {
            "uniquePrefixes": summary["uniquePrefixes"],
            "uniqueFullTitles": summary["uniqueFullTitles"],
            "uniqueNormalizedPrefixes": summary["uniqueNormalizedPrefixes"],
            "maxHierarchyDepth": summary["maxHierarchyDepth"],
        },
    }
    (output_dir / "manifest.json").write_text(
        json.dumps(manifest_payload, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    log(f"\nWrote summary artifact to {output_dir / 'summary.json'}")
    log(f"Wrote runtime lookup artifact to {version_dir / 'lookup.json'}")
    log(f"Wrote runtime expansions artifact to {version_dir / 'expansions.json'}")
    log(f"Wrote runtime manifest to {output_dir / 'manifest.json'}")
    log(f"Retained SQLite investigation database at {config.sqlite_path}")


def parse_args() -> argparse.Namespace:
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(
        description="Analyze hierarchical Pinecone title prefixes for source scoping."
    )
    parser.add_argument(
        "--site", required=True, help="Site ID for environment variables"
    )
    parser.add_argument(
        "--index-name",
        help="Optional explicit Pinecone index name override",
    )
    parser.add_argument(
        "--use-ingest-index",
        action="store_true",
        help="Use PINECONE_INGEST_INDEX_NAME instead of the runtime PINECONE_INDEX_NAME",
    )
    parser.add_argument(
        "--vector-id-prefix",
        "--prefix",
        dest="vector_id_prefix",
        help="Optional exact Pinecone vector ID prefix to restrict analysis",
    )
    parser.add_argument(
        "--max-vectors",
        type=int,
        help="Maximum number of vectors to process (default: all matching vectors)",
    )
    parser.add_argument(
        "--list-batch-size",
        type=int,
        default=DEFAULT_LIST_BATCH_SIZE,
        help="Number of vector IDs to request per Pinecone list() call",
    )
    parser.add_argument(
        "--fetch-batch-size",
        type=int,
        default=DEFAULT_FETCH_BATCH_SIZE,
        help="Number of vector IDs to fetch per Pinecone fetch() call",
    )
    parser.add_argument(
        "--top-n",
        type=int,
        default=DEFAULT_TOP_N,
        help="How many top examples to print in each summary section",
    )
    parser.add_argument(
        "--ambiguity-limit",
        type=int,
        default=DEFAULT_AMBIGUITY_LIMIT,
        help="How many ambiguous terminal segment examples to print",
    )
    parser.add_argument(
        "--write-artifacts",
        action="store_true",
        help="Write local JSON artifacts under .cache/title_prefix_catalog",
    )
    parser.add_argument(
        "--output-dir",
        help="Optional explicit artifact output directory (defaults under .cache/title_prefix_catalog)",
    )
    parser.add_argument(
        "--sqlite-path",
        help="Optional explicit SQLite database path for the investigation state",
    )
    parser.add_argument(
        "--artifact-version",
        help="Optional explicit artifact version for runtime payload output",
    )
    return parser.parse_args()


def main() -> None:
    """Run the title prefix catalog analysis."""
    args = parse_args()
    from pyutil.env_utils import load_env

    load_env(args.site)

    if args.max_vectors is not None and args.max_vectors <= 0:
        raise ValueError("--max-vectors must be a positive integer")

    if args.list_batch_size <= 0 or args.fetch_batch_size <= 0:
        raise ValueError("Batch sizes must be positive integers")

    index_name = resolve_index_name(args)
    output_dir = (
        Path(args.output_dir)
        if args.output_dir
        else get_cache_dir() / "reports" / args.site
    )
    sqlite_path = resolve_sqlite_path(args, output_dir)
    should_delete_sqlite = not args.write_artifacts and args.sqlite_path is None
    artifact_version = args.artifact_version or f"{args.site}-{int(time.time())}"
    config = ScriptConfig(
        site=args.site,
        index_name=index_name,
        vector_id_prefix=args.vector_id_prefix,
        max_vectors=args.max_vectors,
        list_batch_size=args.list_batch_size,
        fetch_batch_size=args.fetch_batch_size,
        top_n=args.top_n,
        ambiguity_limit=args.ambiguity_limit,
        write_artifacts=args.write_artifacts,
        output_dir=output_dir if args.write_artifacts else None,
        sqlite_path=sqlite_path,
        artifact_version=artifact_version,
    )

    log(f"Using Pinecone index: {config.index_name}")
    if config.vector_id_prefix:
        log(f"Restricting analysis to vector ID prefix: {config.vector_id_prefix}")
    if config.max_vectors:
        log(f"Limiting analysis to {config.max_vectors:,} vector(s)")

    script_start = time.time()
    log("Initializing Pinecone client...")
    pinecone = get_pinecone_client()
    log("Resolving Pinecone index host...")
    index = pinecone.Index(config.index_name)
    log("Fetching index statistics...")
    index_stats = index.describe_index_stats()
    estimated_total_vectors = int(getattr(index_stats, "total_vector_count", 0) or 0)
    log(f"Index reports {estimated_total_vectors:,} total vector(s)")
    config = ScriptConfig(
        site=args.site,
        index_name=config.index_name,
        vector_id_prefix=config.vector_id_prefix,
        max_vectors=config.max_vectors,
        list_batch_size=config.list_batch_size,
        fetch_batch_size=config.fetch_batch_size,
        top_n=config.top_n,
        ambiguity_limit=config.ambiguity_limit,
        write_artifacts=config.write_artifacts,
        output_dir=config.output_dir,
        sqlite_path=config.sqlite_path,
        artifact_version=config.artifact_version,
        estimated_total_vectors=estimated_total_vectors,
    )

    log(f"Using SQLite work database: {config.sqlite_path}")
    connection = initialize_database(config.sqlite_path)
    try:
        scan_stats = stream_titles_to_database(index, config, connection)
        log("Calculating summary statistics from SQLite...")
        summary = build_summary(
            connection, scan_stats, config.top_n, config.ambiguity_limit
        )
        print_summary(summary)

        if config.write_artifacts and config.output_dir is not None:
            write_artifacts(config.output_dir, config, summary, connection)
    finally:
        connection.close()
        if should_delete_sqlite and config.sqlite_path.exists():
            config.sqlite_path.unlink()
            log(f"Deleted temporary SQLite work database: {config.sqlite_path}")

    elapsed_seconds = time.time() - script_start
    print(f"\nCompleted in {elapsed_seconds:.1f}s")


if __name__ == "__main__":
    main()
