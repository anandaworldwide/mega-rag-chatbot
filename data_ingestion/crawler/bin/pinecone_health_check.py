#!/usr/bin/env python3
"""
Pinecone Crawler Health Check Script

This script performs comprehensive health checks on crawler data in the Pinecone index.
It filters to only analyze vectors created by the website crawler (identified by
crawl_timestamp metadata or vector IDs matching the crawler pattern).

Health checks identify:
- Stale crawler records (>30 days old)
- Missing crawl_timestamp metadata (legacy crawler records)
- Duplicate URLs with multiple crawl sessions
- Age distribution of crawler vectors
- Orphaned records (optional, slower)

Usage:
    python bin/pinecone_crawler_health_check.py --site ananda-public
    python bin/pinecone_crawler_health_check.py --site ananda-public --quick
    python bin/pinecone_crawler_health_check.py --site ananda-public --json
    python bin/pinecone_crawler_health_check.py --site ananda-public --sample 10000
"""

import argparse
import json
import os
import sqlite3
import sys
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import dotenv
from pinecone import Pinecone
from tqdm import tqdm

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
    data_dir = os.getenv("DATA_DIR")
    db_dir = Path(data_dir) / "db" if data_dir else Path(__file__).parent.parent / "db"
    return db_dir / f"crawler_queue_{site}.db"


def get_urls_from_database(db_path: Path) -> set[str]:
    """Get all unique normalized URLs from the crawl_queue table."""
    if not db_path.exists():
        return set()

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    try:
        cursor.execute("SELECT DISTINCT url FROM crawl_queue")
        rows = cursor.fetchall()
        urls = {normalize_url(row["url"]) for row in rows}
        return urls
    finally:
        conn.close()


def load_crawler_config(site: str) -> dict:
    """Load crawler configuration to get domain."""
    config_dir = Path(__file__).parent.parent / "crawler_config"
    config_file = config_dir / f"{site}-config.json"

    if not config_file.exists():
        print(f"Warning: Config file not found: {config_file}")
        return {}

    try:
        with open(config_file) as f:
            return json.load(f)
    except Exception as e:
        print(f"Warning: Could not load config: {e}")
        return {}


def scan_pinecone_vectors(
    index: Any,
    domain: str,
    sample_size: int | None = None,
) -> list[dict[str, Any]]:
    """Scan Pinecone index for crawler vectors using prefix filtering.

    Args:
        index: Pinecone index instance
        domain: Domain to filter by (e.g., 'ananda.org')
        sample_size: Optional limit on number of vectors to scan

    Returns:
        List of crawler vector metadata dicts
    """
    vectors = []
    all_ids = []

    # Build prefix for crawler vectors: text||{domain}||web||
    # Also check normalized domain (without www)
    normalized_domain = domain.replace("www.", "")
    prefix = f"text||{normalized_domain}||web||"

    print(f"Collecting crawler vector IDs from Pinecone with prefix: {prefix}")
    try:
        # Use list operation with prefix filter to get only crawler IDs
        list_pbar = tqdm(desc="Listing crawler vector IDs", unit=" batches")
        for batch_ids in index.list(prefix=prefix):
            all_ids.extend(batch_ids)
            list_pbar.update(1)
            list_pbar.set_postfix_str(f"Found {len(all_ids):,} IDs")
            if sample_size and len(all_ids) >= sample_size:
                all_ids = all_ids[:sample_size]
                break
        list_pbar.close()

        print(f"Found {len(all_ids):,} crawler vectors to scan")

        # Fetch vectors and metadata in batches
        # Use smaller batch size to avoid 414 Request-URI Too Large errors
        # Vector IDs can be very long, so 10 per batch is safer
        batch_size = 10
        for i in tqdm(range(0, len(all_ids), batch_size), desc="Fetching vectors"):
            batch_ids = all_ids[i : i + batch_size]
            try:
                fetch_response = index.fetch(ids=batch_ids)

                for vec_id in batch_ids:
                    if vec_id in fetch_response["vectors"]:
                        vector_data = fetch_response["vectors"][vec_id]
                        metadata = vector_data.get("metadata", {})

                        vectors.append(
                            {
                                "id": vec_id,
                                "crawl_timestamp": metadata.get("crawl_timestamp"),
                                "source": metadata.get("source") or metadata.get("url"),
                                "metadata": metadata,
                            }
                        )
            except Exception as e:
                print(f"Error fetching batch: {e}")
                continue

        print(f"Processed {len(vectors):,} crawler vectors")

    except Exception as e:
        print(f"Error scanning Pinecone: {e}")
        sys.exit(1)

    return vectors


def analyze_age_distribution(vectors: list[dict[str, Any]]) -> dict[str, Any]:
    """Analyze age distribution of vectors."""
    now = datetime.now()
    buckets = {
        "last_7_days": timedelta(days=7),
        "7_30_days": timedelta(days=30),
        "30_60_days": timedelta(days=60),
        "60_90_days": timedelta(days=90),
        "90_plus_days": None,  # Everything older
        "no_timestamp": None,
    }

    counts = {key: 0 for key in buckets}
    timestamps = []

    for vec in tqdm(vectors, desc="Analyzing age distribution", unit=" vectors"):
        ts = vec["crawl_timestamp"]
        if ts is None:
            counts["no_timestamp"] += 1
            continue

        try:
            dt = datetime.fromisoformat(ts)
            age = now - dt
            timestamps.append((dt, ts))

            if age <= buckets["last_7_days"]:
                counts["last_7_days"] += 1
            elif age <= buckets["7_30_days"]:
                counts["7_30_days"] += 1
            elif age <= buckets["30_60_days"]:
                counts["30_60_days"] += 1
            elif age <= buckets["60_90_days"]:
                counts["60_90_days"] += 1
            else:
                counts["90_plus_days"] += 1
        except (ValueError, TypeError):
            counts["no_timestamp"] += 1

    # Find oldest and newest timestamps
    oldest = None
    newest = None
    if timestamps:
        oldest_dt, oldest_ts = min(timestamps, key=lambda x: x[0])
        newest_dt, newest_ts = max(timestamps, key=lambda x: x[0])
        oldest = oldest_ts
        newest = newest_ts

    return {
        "counts": counts,
        "oldest": oldest,
        "newest": newest,
    }


def find_duplicate_urls(vectors: list[dict[str, Any]]) -> dict[str, Any]:
    """Find URLs with vectors from multiple crawl sessions."""
    url_timestamps: dict[str, list[str]] = defaultdict(list)

    # First pass: group vectors by URL
    for vec in tqdm(vectors, desc="Grouping vectors by URL", unit=" vectors"):
        source = vec["source"]
        ts = vec["crawl_timestamp"]
        if source and ts:
            normalized = normalize_url(source)
            url_timestamps[normalized].append(ts)

    # Find URLs with timestamps > 1 day apart
    duplicate_urls = []
    min_age = timedelta(days=1)

    for url, timestamps in tqdm(
        url_timestamps.items(), desc="Finding duplicate URLs", unit=" URLs"
    ):
        if len(timestamps) < 2:
            continue

        # Parse and sort timestamps
        parsed_timestamps = []
        for ts in timestamps:
            try:
                dt = datetime.fromisoformat(ts)
                parsed_timestamps.append(dt)
            except (ValueError, TypeError):
                continue

        if len(parsed_timestamps) < 2:
            continue

        parsed_timestamps.sort()
        # Check if there's at least 1 day difference between oldest and newest
        if (parsed_timestamps[-1] - parsed_timestamps[0]) >= min_age:
            duplicate_urls.append(
                {
                    "url": url,
                    "sessions": len(set(timestamps)),
                    "vectors": len(timestamps),
                }
            )

    return {
        "urls_with_duplicates": len(duplicate_urls),
        "extra_vectors": sum(
            max(0, d["vectors"] - d["vectors"] // d["sessions"]) for d in duplicate_urls
        ),
        "sample": duplicate_urls[:10],
    }


def check_orphaned_records(
    vectors: list[dict[str, Any]], db_urls: set[str], sample_size: int = 1000
) -> dict[str, Any]:
    """Check for vectors that don't exist in the database (sampled)."""
    if not db_urls:
        return {"orphaned_count": 0, "sample_size": 0}

    # Sample vectors
    sample = vectors[:sample_size] if len(vectors) > sample_size else vectors
    orphaned = []

    for vec in tqdm(sample, desc="Checking orphaned records", unit=" vectors"):
        source = vec["source"]
        if source:
            normalized = normalize_url(source)
            if normalized not in db_urls:
                orphaned.append(normalized)

    return {
        "orphaned_count": len(orphaned),
        "sample_size": len(sample),
        "estimated_total": int(len(orphaned) * len(vectors) / len(sample))
        if sample
        else 0,
        "sample_urls": orphaned[:10],
    }


def format_bar_chart(value: int, max_value: int, width: int = 40) -> str:
    """Create a simple bar chart."""
    if max_value == 0:
        return " " * width
    bar_length = int((value / max_value) * width)
    return "█" * bar_length


def _print_json_report(
    site: str,
    total_vectors: int,
    total_urls: int,
    age_dist: dict[str, Any],
    stale_count: int,
    stale_percent: float,
    duplicates: dict[str, Any],
    orphaned: dict[str, Any] | None,
) -> None:
    """Print health report as JSON."""
    report = {
        "site": site,
        "summary": {
            "total_vectors": total_vectors,
            "total_urls": total_urls,
            "avg_vectors_per_url": total_vectors / total_urls if total_urls > 0 else 0,
            "oldest_crawl": age_dist["oldest"],
            "newest_crawl": age_dist["newest"],
        },
        "age_distribution": age_dist["counts"],
        "stale_records": {
            "count": stale_count,
            "percent": round(stale_percent, 2),
        },
        "duplicates": duplicates,
        "missing_timestamps": {
            "count": age_dist["counts"]["no_timestamp"],
            "percent": round(
                age_dist["counts"]["no_timestamp"] / total_vectors * 100
                if total_vectors > 0
                else 0,
                2,
            ),
        },
    }
    if orphaned:
        report["orphaned"] = orphaned

    print(json.dumps(report, indent=2))


def _print_summary_section(
    total_vectors: int, total_urls: int, age_dist: dict[str, Any]
) -> None:
    """Print summary section."""
    print("SUMMARY")
    print(f"  Total vectors: {total_vectors:,}")
    print(f"  Unique URLs: {total_urls:,}")
    if total_urls > 0:
        print(f"  Avg vectors/URL: {total_vectors / total_urls:.1f}")
    if age_dist["oldest"]:
        print(f"  Oldest crawl: {age_dist['oldest']}")
    if age_dist["newest"]:
        print(f"  Newest crawl: {age_dist['newest']}")


def _print_age_distribution_section(
    total_vectors: int, age_dist: dict[str, Any]
) -> None:
    """Print age distribution section."""
    print("\nAGE DISTRIBUTION")
    max_count = max(age_dist["counts"].values()) if age_dist["counts"].values() else 1
    labels = {
        "last_7_days": "Last 7 days",
        "7_30_days": "7-30 days",
        "30_60_days": "30-60 days",
        "60_90_days": "60-90 days",
        "90_plus_days": "90+ days",
        "no_timestamp": "No timestamp",
    }
    stale_keys = {"30_60_days", "60_90_days", "90_plus_days"}
    for key, label in labels.items():
        count = age_dist["counts"][key]
        percent = (count / total_vectors * 100) if total_vectors > 0 else 0
        bar = format_bar_chart(count, max_count)
        stale_marker = " [STALE]" if key in stale_keys else ""
        legacy_marker = " [LEGACY]" if key == "no_timestamp" else ""
        print(
            f"  {label:15}: {bar} {count:>8,} ({percent:5.1f}%){stale_marker}{legacy_marker}"
        )


def _print_text_report(
    site: str,
    total_vectors: int,
    total_urls: int,
    age_dist: dict[str, Any],
    stale_count: int,
    stale_percent: float,
    duplicates: dict[str, Any],
    orphaned: dict[str, Any] | None,
) -> None:
    """Print health report as formatted text."""
    print(f"\n{'=' * 80}")
    print(f"Pinecone Health Check Report - {site}")
    print(f"{'=' * 80}\n")

    _print_summary_section(total_vectors, total_urls, age_dist)
    _print_age_distribution_section(total_vectors, age_dist)

    print("\nSTALE RECORDS (>30 days)")
    print(f"  Count: {stale_count:,}")
    print(f"  Percent: {stale_percent:.1f}%")
    if stale_percent > 20:
        print("  WARNING: High percentage of stale records")

    print("\nDUPLICATE URLS")
    print(f"  URLs with multiple crawl sessions: {duplicates['urls_with_duplicates']}")
    print(f"  Extra vectors from duplicates: ~{duplicates['extra_vectors']}")
    if duplicates["sample"]:
        print("  Sample URLs with duplicates:")
        for dup in duplicates["sample"][:5]:
            print(
                f"    - {dup['url']} ({dup['sessions']} sessions, {dup['vectors']} vectors)"
            )

    print("\nMISSING TIMESTAMPS")
    missing_count = age_dist["counts"]["no_timestamp"]
    missing_percent = missing_count / total_vectors * 100 if total_vectors > 0 else 0
    print(
        f"  Vectors without crawl_timestamp: {missing_count:,} ({missing_percent:.1f}%)"
    )
    if missing_count > 0:
        print("  These are legacy records - consider recrawling")

    if orphaned:
        print("\nORPHANED RECORDS (sampled)")
        print(f"  Sample size: {orphaned['sample_size']:,}")
        print(f"  Orphaned in sample: {orphaned['orphaned_count']}")
        if orphaned["sample_size"] > 0:
            estimated = orphaned["estimated_total"]
            print(f"  Estimated total orphaned: ~{estimated:,}")
            if orphaned["sample_urls"]:
                print("  Sample orphaned URLs:")
                for url in orphaned["sample_urls"][:5]:
                    print(f"    - {url}")

    print(f"\n{'=' * 80}\n")


def print_health_report(
    site: str,
    vectors: list[dict[str, Any]],
    age_dist: dict[str, Any],
    duplicates: dict[str, Any],
    orphaned: dict[str, Any] | None,
    output_json: bool = False,
) -> None:
    """Print formatted health check report."""
    total_vectors = len(vectors)
    total_urls = len(set(v["source"] for v in vectors if v["source"]))

    # Calculate stale records (>30 days)
    stale_count = (
        age_dist["counts"]["30_60_days"]
        + age_dist["counts"]["60_90_days"]
        + age_dist["counts"]["90_plus_days"]
    )
    stale_percent = (stale_count / total_vectors * 100) if total_vectors > 0 else 0

    if output_json:
        _print_json_report(
            site,
            total_vectors,
            total_urls,
            age_dist,
            stale_count,
            stale_percent,
            duplicates,
            orphaned,
        )
    else:
        _print_text_report(
            site,
            total_vectors,
            total_urls,
            age_dist,
            stale_count,
            stale_percent,
            duplicates,
            orphaned,
        )


def main():
    parser = argparse.ArgumentParser(
        description="Pinecone health check - analyze vector age, duplicates, and more"
    )
    parser.add_argument(
        "--site",
        required=True,
        help="Site identifier (e.g., ananda-public). Determines environment and database.",
    )
    parser.add_argument(
        "--quick",
        action="store_true",
        help="Skip slow orphaned records check",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Output results as JSON",
    )
    parser.add_argument(
        "--sample",
        type=int,
        default=None,
        help="Limit analysis to first N vectors (default: process all vectors). Use --sample 10000 for testing.",
    )

    args = parser.parse_args()

    # Load environment
    load_environment_for_site(args.site)

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

    # Load crawler config to get domain
    crawler_config = load_crawler_config(args.site)
    domain = crawler_config.get("domain")
    if not domain:
        print(f"Error: No domain found in crawler config for site '{args.site}'")
        sys.exit(1)

    # Scan Pinecone vectors using prefix filtering
    print("\nScanning Pinecone index...")
    vectors = scan_pinecone_vectors(index, domain, sample_size=args.sample)

    if not vectors:
        print("No vectors found in Pinecone index")
        sys.exit(0)

    # Analyze age distribution
    print("\nAnalyzing age distribution...")
    age_dist = analyze_age_distribution(vectors)

    # Find duplicate URLs
    print("\nChecking for duplicate URLs...")
    duplicates = find_duplicate_urls(vectors)

    # Check orphaned records (optional)
    orphaned = None
    if not args.quick:
        print("\nChecking for orphaned records...")
        db_path = get_database_path(args.site)
        db_urls = get_urls_from_database(db_path)
        orphaned = check_orphaned_records(vectors, db_urls)

    # Print report
    print_health_report(
        args.site, vectors, age_dist, duplicates, orphaned, output_json=args.json
    )


if __name__ == "__main__":
    main()
