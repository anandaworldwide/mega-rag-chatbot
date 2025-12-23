#!/usr/bin/env python3
"""
Pinecone Cleanup Script - Remove Old Vectors by Timestamp

This script uses the local SQLite crawler database to identify URLs that have been crawled,
then queries Pinecone for all vectors associated with each URL. For each URL, it finds the
latest crawl_timestamp and deletes all vectors with older timestamps.

This helps clean up duplicate vectors that may have accumulated from recrawls before the
automatic cleanup was implemented.

Usage:
    python bin/cleanup_old_pinecone_vectors.py --site ananda-public [--confirm]

Arguments:
    --site      [REQUIRED] Site identifier (e.g., ananda-public). Determines which
                database and environment file to use.
    --confirm   [OPTIONAL] Ask for confirmation before deleting vectors for each URL.
                If not set, deletions proceed automatically.

Example:
    # With confirmation prompts
    python bin/cleanup_old_pinecone_vectors.py --site ananda-public --confirm

    # Automatic deletion (no prompts)
    python bin/cleanup_old_pinecone_vectors.py --site ananda-public
"""

import argparse
import os
import sqlite3
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import dotenv
from pinecone import Pinecone

# Add parent directory to path for imports
sys.path.append(str(Path(__file__).parent.parent.parent))


def load_environment_for_site(site: str) -> None:
    """Load environment variables for the specified site."""
    project_root = Path(__file__).parent.parent.parent.parent
    env_path = project_root / f".env.{site}"

    if not env_path.exists():
        print(f"Error: Environment file {env_path} not found")
        sys.exit(1)

    dotenv.load_dotenv(env_path)
    print(f"Loaded environment from {env_path}")


def normalize_url(url: str) -> str:
    """Normalize URL for consistent matching (matches crawler logic)."""
    parsed = urlparse(url)
    # Strip www and fragments, but preserve query parameters
    normalized = parsed.netloc.replace("www.", "") + parsed.path.rstrip("/")
    if parsed.query:
        normalized += "?" + parsed.query
    return normalized.lower()


def get_database_path(site: str) -> Path:
    """Get the path to the SQLite database for the given site."""
    # Support DATA_DIR environment variable for EFS mounts (cloud deployment)
    data_dir = os.getenv("DATA_DIR")
    if data_dir:
        db_dir = Path(data_dir) / "db"
    else:
        # Local database location (parent directory from bin/)
        db_dir = Path(__file__).parent.parent / "db"

    db_file = db_dir / f"crawler_queue_{site}.db"
    return db_file


def get_urls_from_database(db_path: Path) -> list[str]:
    """Get all unique URLs from the crawl_queue table."""
    if not db_path.exists():
        print(f"Error: Database file not found: {db_path}")
        sys.exit(1)

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    try:
        cursor.execute("SELECT DISTINCT url FROM crawl_queue")
        rows = cursor.fetchall()
        urls = [row["url"] for row in rows]
        return urls
    finally:
        conn.close()


def get_vectors_for_url(
    pinecone_index: Any, normalized_url: str, vector_dimension: int
) -> list[dict[str, Any]]:
    """Query Pinecone for all vectors matching the given URL."""
    dummy_vector = [0.0] * vector_dimension

    try:
        # Query with metadata filter for the URL
        # Try both 'url' and 'source' fields since the metadata structure may vary
        query_response = pinecone_index.query(
            vector=dummy_vector,
            filter={"$or": [{"url": normalized_url}, {"source": normalized_url}]},
            top_k=1000,  # Get up to 1000 matching vectors
            include_metadata=True,
            include_values=False,  # We don't need the vector values
        )

        vectors = []
        for match in query_response.matches:
            metadata = match.metadata or {}
            vectors.append(
                {
                    "id": match.id,
                    "crawl_timestamp": metadata.get("crawl_timestamp"),
                    "metadata": metadata,
                }
            )

        return vectors
    except Exception as e:
        print(f"Error querying Pinecone for {normalized_url}: {e}")
        return []


def find_latest_timestamp(vectors: list[dict[str, Any]]) -> str | None:
    """Find the latest crawl_timestamp from a list of vectors."""
    timestamps = [
        v["crawl_timestamp"] for v in vectors if v["crawl_timestamp"] is not None
    ]

    if not timestamps:
        return None

    # Parse ISO format timestamps and find the latest
    parsed_timestamps = []
    for ts in timestamps:
        try:
            # Parse ISO format: "2025-09-16T19:33:11.558651"
            dt = datetime.fromisoformat(ts)
            parsed_timestamps.append((dt, ts))
        except (ValueError, TypeError):
            # Skip invalid timestamps
            continue

    if not parsed_timestamps:
        return None

    # Return the original string format of the latest timestamp
    latest_dt, latest_ts = max(parsed_timestamps, key=lambda x: x[0])
    return latest_ts


def delete_old_vectors(
    pinecone_index: Any,
    vectors: list[dict[str, Any]],
    latest_timestamp: str,
    url: str,
    confirm: bool = False,
    min_age_days: int = 1,
) -> int:
    """Delete vectors with timestamps older than the latest by at least min_age_days.

    Args:
        pinecone_index: The Pinecone index to delete from.
        vectors: List of vectors with crawl_timestamp metadata.
        latest_timestamp: The latest crawl_timestamp found.
        url: The URL being processed (for logging).
        confirm: Whether to ask for confirmation before deleting.
        min_age_days: Minimum age in days for a vector to be considered "old".
                      Vectors within this many days of the latest are kept.
    """
    # Parse the latest timestamp
    try:
        latest_dt = datetime.fromisoformat(latest_timestamp)
    except (ValueError, TypeError):
        print(f"  Error parsing latest timestamp: {latest_timestamp}")
        return 0

    # Find vectors that are at least min_age_days older than the latest
    min_age = timedelta(days=min_age_days)

    old_vectors = []
    for v in vectors:
        ts = v["crawl_timestamp"]
        if ts is None:
            continue
        try:
            v_dt = datetime.fromisoformat(ts)
            # Only consider "old" if it's at least min_age_days before the latest
            if (latest_dt - v_dt) >= min_age:
                old_vectors.append(v)
        except (ValueError, TypeError):
            continue

    if not old_vectors:
        return 0

    old_vector_ids = [v["id"] for v in old_vectors]

    if confirm:
        print(f"\n  Found {len(old_vectors)} old vectors to delete:")
        for v in old_vectors[:5]:  # Show first 5
            print(f"    - ID: {v['id']}, Timestamp: {v['crawl_timestamp']}")
        if len(old_vectors) > 5:
            print(f"    ... and {len(old_vectors) - 5} more")

        response = input(
            f"  Delete {len(old_vectors)} old vectors for {url}? (yes/no): "
        )
        if response.lower() not in ["yes", "y"]:
            print("  Skipped.")
            return 0

    # Delete vectors in batches of 100 (Pinecone batch limit)
    deleted_count = 0
    for i in range(0, len(old_vector_ids), 100):
        batch = old_vector_ids[i : i + 100]
        try:
            pinecone_index.delete(ids=batch)
            deleted_count += len(batch)
        except Exception as e:
            print(f"  Error deleting batch: {e}")

    return deleted_count


def cleanup_pinecone_vectors(site: str, confirm: bool = False) -> None:
    """Main cleanup function."""
    print(f"🔍 Starting Pinecone cleanup for site: {site}")
    print("=" * 80)

    # Load environment
    load_environment_for_site(site)

    # Initialize Pinecone
    api_key = os.getenv("PINECONE_API_KEY")
    if not api_key:
        print("Error: PINECONE_API_KEY not found in environment")
        sys.exit(1)

    index_name = os.getenv("PINECONE_INGEST_INDEX_NAME") or os.getenv(
        "PINECONE_INDEX_NAME", "mega-rag-chatbot"
    )
    if not index_name:
        print("Error: PINECONE_INGEST_INDEX_NAME or PINECONE_INDEX_NAME not found")
        sys.exit(1)

    pc = Pinecone(api_key=api_key)
    index = pc.Index(index_name)

    vector_dimension = int(os.getenv("OPENAI_EMBEDDING_DIMENSION", 3072))

    # Get database path and URLs
    db_path = get_database_path(site)
    print(f"📊 Reading URLs from database: {db_path}")
    urls = get_urls_from_database(db_path)
    print(f"   Found {len(urls)} URLs in database")

    # Process each URL
    total_deleted = 0
    urls_processed = 0
    urls_with_duplicates = 0

    print(f"\n🔄 Processing {len(urls)} URLs...")
    print("=" * 80)

    for i, url in enumerate(urls, 1):
        normalized_url = normalize_url(url)
        print(f"\n[{i}/{len(urls)}] Processing: {url}")
        print(f"  Normalized: {normalized_url}")

        # Query Pinecone for all vectors for this URL
        vectors = get_vectors_for_url(index, normalized_url, vector_dimension)

        if not vectors:
            print("  No vectors found in Pinecone")
            continue

        print(f"  Found {len(vectors)} vectors in Pinecone")

        # Find latest timestamp
        latest_timestamp = find_latest_timestamp(vectors)

        if not latest_timestamp:
            print("  No valid crawl_timestamp found, skipping")
            continue

        print(f"  Latest crawl_timestamp: {latest_timestamp}")

        # Count vectors from different crawl sessions (at least 1 day apart)
        try:
            latest_dt = datetime.fromisoformat(latest_timestamp)
        except (ValueError, TypeError):
            print("  Error parsing latest timestamp, skipping")
            continue

        min_age = timedelta(days=1)
        latest_count = sum(
            1 for v in vectors if v["crawl_timestamp"] == latest_timestamp
        )
        old_count = 0
        for v in vectors:
            ts = v["crawl_timestamp"]
            if ts is None:
                continue
            try:
                v_dt = datetime.fromisoformat(ts)
                if (latest_dt - v_dt) >= min_age:
                    old_count += 1
            except (ValueError, TypeError):
                continue

        print(f"  Vectors with latest timestamp: {latest_count}")
        print(f"  Vectors from older crawls (>1 day): {old_count}")

        if old_count == 0:
            print("  No old vectors to delete (all within 1 day of latest)")
            continue

        urls_with_duplicates += 1

        # Delete old vectors
        deleted = delete_old_vectors(
            index, vectors, latest_timestamp, url, confirm=confirm
        )

        if deleted > 0:
            total_deleted += deleted
            print(f"  ✅ Deleted {deleted} old vectors")

        urls_processed += 1

    # Summary
    print("\n" + "=" * 80)
    print("📊 Cleanup Summary:")
    print(f"   URLs processed: {urls_processed}")
    print(f"   URLs with duplicates: {urls_with_duplicates}")
    print(f"   Total vectors deleted: {total_deleted}")
    print("=" * 80)


def main():
    parser = argparse.ArgumentParser(
        description="Clean up old Pinecone vectors based on crawl_timestamp",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--site",
        required=True,
        help="Site identifier (e.g., ananda-public). Determines database and environment.",
    )
    parser.add_argument(
        "--confirm",
        action="store_true",
        help="Ask for confirmation before deleting vectors for each URL.",
    )

    args = parser.parse_args()

    cleanup_pinecone_vectors(args.site, confirm=args.confirm)


if __name__ == "__main__":
    main()
