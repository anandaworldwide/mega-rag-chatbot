#!/usr/bin/env python3
"""
Script to check how many pages with different priorities are due for re-crawling.
This helps understand the current state of the crawl queue.

Usage:
    python bin/check_priority_due.py --site ananda-public
"""

import argparse
import sqlite3
import sys
from datetime import datetime
from pathlib import Path


def parse_arguments():
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(
        description="Check how many pages with different priorities are due for re-crawling"
    )
    parser.add_argument(
        "--site",
        required=True,
        help="Site ID (e.g., ananda-public) - determines which database to check",
    )
    return parser.parse_args()


def get_database_path(site_id: str) -> Path:
    """Get the path to the crawler database for the given site."""
    script_dir = Path(__file__).resolve().parent.parent
    db_dir = script_dir / "db"
    return db_dir / f"crawler_queue_{site_id}.db"


def check_priority_due_counts(site_id: str):
    """Check how many pages with different priorities are due for re-crawling."""
    db_path = get_database_path(site_id)

    if not db_path.exists():
        print(f"❌ Database file not found: {db_path}")
        print(
            f"   Make sure you've run the crawler for site '{site_id}' at least once."
        )
        return

    try:
        conn = sqlite3.connect(str(db_path))
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()

        print(f"📊 Checking crawl queue status for site: {site_id}")
        print(f"🗄️  Database: {db_path}")
        print(f"🕐 Current time: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        print()

        # Check overall queue stats
        cursor.execute("""
            SELECT 
                status,
                COUNT(*) as count,
                AVG(priority) as avg_priority
            FROM crawl_queue 
            GROUP BY status
            ORDER BY count DESC
        """)

        print("📈 Overall Queue Statistics:")
        print("=" * 50)
        total_urls = 0
        for row in cursor.fetchall():
            status, count, avg_priority = row
            total_urls += count
            print(f"  {status:>12}: {count:>6} URLs (avg priority: {avg_priority:.1f})")
        print(f"  {'TOTAL':>12}: {total_urls:>6} URLs")
        print()

        # Check priority distribution
        cursor.execute("""
            SELECT 
                priority,
                COUNT(*) as count,
                status
            FROM crawl_queue 
            GROUP BY priority, status
            ORDER BY priority DESC, status
        """)

        print("🎯 Priority Distribution by Status:")
        print("=" * 50)
        priority_data = {}
        for row in cursor.fetchall():
            priority, count, status = row
            if priority not in priority_data:
                priority_data[priority] = {}
            priority_data[priority][status] = count

        for priority in sorted(priority_data.keys(), reverse=True):
            statuses = priority_data[priority]
            total_for_priority = sum(statuses.values())
            print(f"  Priority {priority:>2}: {total_for_priority:>6} total")
            for status, count in sorted(statuses.items()):
                print(f"    {status:>12}: {count:>6} URLs")
        print()

        # Check what's due for re-crawling RIGHT NOW
        cursor.execute("""
            SELECT 
                priority,
                COUNT(*) as count
            FROM crawl_queue 
            WHERE (
                (status = 'pending' AND (retry_after IS NULL OR retry_after <= datetime('now'))) 
                OR 
                (status = 'visited' AND next_crawl <= datetime('now'))
            )
            AND (next_crawl IS NULL OR next_crawl <= datetime('now'))
            GROUP BY priority
            ORDER BY priority DESC
        """)

        print("🚀 URLs Due for Processing RIGHT NOW:")
        print("=" * 50)
        due_results = cursor.fetchall()
        total_due = 0

        if due_results:
            for row in due_results:
                priority, count = row
                total_due += count
                print(f"  Priority {priority:>2}: {count:>6} URLs ready to crawl")
            print(f"  {'TOTAL':>12}: {total_due:>6} URLs ready to crawl")
        else:
            print("  No URLs are currently due for processing")
        print()

        # Specifically check priority 0 and 10 details
        for check_priority in [10, 0]:
            cursor.execute(
                """
                SELECT 
                    status,
                    COUNT(*) as count,
                    MIN(next_crawl) as earliest_next_crawl,
                    MAX(next_crawl) as latest_next_crawl
                FROM crawl_queue 
                WHERE priority = ?
                GROUP BY status
                ORDER BY status
            """,
                (check_priority,),
            )

            print(f"🔍 Detailed Priority {check_priority} Analysis:")
            print("=" * 50)
            priority_results = cursor.fetchall()

            if priority_results:
                for row in priority_results:
                    status, count, earliest, latest = row
                    print(f"  {status:>12}: {count:>6} URLs")
                    if earliest:
                        print(f"    Earliest next_crawl: {earliest}")
                    if latest and latest != earliest:
                        print(f"    Latest next_crawl:   {latest}")

                # Check how many are due now
                cursor.execute(
                    """
                    SELECT COUNT(*) FROM crawl_queue 
                    WHERE priority = ?
                    AND (
                        (status = 'pending' AND (retry_after IS NULL OR retry_after <= datetime('now'))) 
                        OR 
                        (status = 'visited' AND next_crawl <= datetime('now'))
                    )
                    AND (next_crawl IS NULL OR next_crawl <= datetime('now'))
                """,
                    (check_priority,),
                )

                due_now = cursor.fetchone()[0]
                print(f"  {'DUE NOW':>12}: {due_now:>6} URLs ready to crawl")
            else:
                print(f"  No URLs found with priority {check_priority}")
            print()

        # Check recent activity
        cursor.execute("""
            SELECT 
                COUNT(*) as count,
                MAX(last_crawl) as most_recent_crawl
            FROM crawl_queue 
            WHERE last_crawl IS NOT NULL
            AND last_crawl > datetime('now', '-24 hours')
        """)

        recent_result = cursor.fetchone()
        if recent_result and recent_result[0] > 0:
            count, most_recent = recent_result
            print("📅 Recent Activity (last 24 hours):")
            print("=" * 50)
            print(f"  URLs crawled: {count}")
            print(f"  Most recent:  {most_recent}")
        else:
            print("📅 No crawling activity in the last 24 hours")

        conn.close()

    except sqlite3.Error as e:
        print(f"❌ Database error: {e}")
        sys.exit(1)
    except Exception as e:
        print(f"❌ Unexpected error: {e}")
        sys.exit(1)


def main():
    args = parse_arguments()
    check_priority_due_counts(args.site)


if __name__ == "__main__":
    main()
