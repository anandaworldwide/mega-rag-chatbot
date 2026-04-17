#!/usr/bin/env python3
"""
Daily crawler operations report.

Generates a daily report of crawler health including:
- Queue status (pending, processing, completed, failed)
- URLs processed in last 24 hours
- Last successful crawl time
- Optional CloudWatch log errors (last 24 hours) when AWS credentials and log group are available

Usage:
    python -m crawler.daily_report --site ananda-public
"""

import argparse
import logging
import os
import re
import sqlite3
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

# Import from crawler submodules (support both module and direct execution)
try:
    from .config import _is_running_in_cloud
except ImportError:
    from config import _is_running_in_cloud  # type: ignore[import-not-found]

# Import email utilities
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from pyutil.email_ops import send_ops_alert_sync
from pyutil.email_ops import get_site_shortname

# Optional AWS imports
try:
    import boto3
    from botocore.exceptions import BotoCoreError, ClientError

    AWS_AVAILABLE = True
except ImportError:
    AWS_AVAILABLE = False
    boto3 = None  # type: ignore[assignment]
    BotoCoreError = Exception  # type: ignore[assignment, misc]
    ClientError = Exception  # type: ignore[assignment, misc]

logger = logging.getLogger(__name__)

# Pacific timezone for report display
PACIFIC_TZ = ZoneInfo("America/Los_Angeles")

SQLITE_NORMALIZED_NEXT_CRAWL = "datetime(replace(substr(next_crawl,1,19),'T',' '))"
SQLITE_NORMALIZED_RETRY_AFTER = "datetime(replace(substr(retry_after,1,19),'T',' '))"


def format_timestamp_pacific(timestamp_str: str | None) -> str:
    """Convert a timestamp string to Pacific time format.

    Args:
        timestamp_str: Timestamp string in ISO format or SQLite format (YYYY-MM-DD HH:MM:SS)

    Returns:
        Formatted timestamp string in Pacific time, or original if parsing fails
    """
    if not timestamp_str:
        return "Never (or database error)"

    try:
        # Parse the timestamp - handle both ISO format and SQLite format
        if "T" in timestamp_str:
            # ISO format: 2026-01-20T00:22:25.883577
            dt = datetime.fromisoformat(timestamp_str.replace("Z", "+00:00"))
        else:
            # SQLite format: 2026-01-20 00:22:25
            dt = datetime.strptime(timestamp_str, "%Y-%m-%d %H:%M:%S")

        # If naive datetime, assume UTC
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=ZoneInfo("UTC"))

        # Convert to Pacific time
        pacific_dt = dt.astimezone(PACIFIC_TZ)

        month_name = pacific_dt.strftime("%B")
        day = pacific_dt.day
        hour_12 = pacific_dt.hour % 12 or 12
        minute = pacific_dt.strftime("%M")
        am_pm = pacific_dt.strftime("%p")
        tz_abbr = pacific_dt.strftime("%Z")

        return f"{month_name} {day}, {hour_12}:{minute} {am_pm} {tz_abbr}."
    except (ValueError, TypeError) as e:
        logger.warning(f"Could not parse timestamp '{timestamp_str}': {e}")
        return timestamp_str


def get_database_path(site_id: str) -> Path:
    """Get the path to the crawler database for the given site."""
    # Support DATA_DIR environment variable for EFS mounts (cloud deployment)
    data_dir = os.getenv("DATA_DIR")
    if data_dir:
        db_dir = Path(data_dir) / "db"
    else:
        # Local development
        script_dir = Path(__file__).resolve().parent
        db_dir = script_dir / "db"

    db_path = db_dir / f"crawler_queue_{site_id}.db"
    return db_path


def query_queue_stats(db_path: Path) -> dict[str, Any]:
    """Query SQLite database for queue statistics."""
    stats = {
        "pending": 0,
        "processing": 0,
        "visited": 0,
        "failed": 0,
        "deleted": 0,
        "total": 0,
        "ready_to_process": 0,  # URLs ready to crawl right now
    }

    if not db_path.exists():
        logger.warning(f"Database file not found: {db_path}")
        return stats

    try:
        conn = sqlite3.connect(str(db_path))
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()

        # Get counts by status
        cursor.execute(
            """
            SELECT status, COUNT(*) as count 
            FROM crawl_queue 
            GROUP BY status
            """
        )
        for row in cursor.fetchall():
            status = row["status"]
            count = row["count"]
            if status in stats:
                stats[status] = count
            stats["total"] += count

        # Count URLs ready to process right now:
        # - pending URLs with no retry delay (or retry delay expired)
        # - visited URLs that are due for re-crawl
        cursor.execute(
            f"""
            SELECT COUNT(*) as count
            FROM crawl_queue 
            WHERE (
                (status = 'pending' AND (retry_after IS NULL OR {SQLITE_NORMALIZED_RETRY_AFTER} <= datetime('now'))) 
                OR 
                (status = 'visited' AND {SQLITE_NORMALIZED_NEXT_CRAWL} <= datetime('now'))
            )
            """
        )
        result = cursor.fetchone()
        if result:
            stats["ready_to_process"] = result["count"]

        conn.close()
    except Exception as e:
        logger.error(f"Error querying database: {e}")
        return stats

    return stats


def query_recent_activity(db_path: Path, hours: int = 24) -> dict[str, Any]:
    """Query database for URLs processed in the last N hours."""
    activity = {
        "urls_processed": 0,
        "last_crawl_time": None,
    }

    if not db_path.exists():
        return activity

    try:
        conn = sqlite3.connect(str(db_path))
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()

        # Calculate cutoff time
        cutoff_time = datetime.now() - timedelta(hours=hours)
        cutoff_str = cutoff_time.strftime("%Y-%m-%d %H:%M:%S")

        # Count URLs processed (visited) in last 24 hours
        cursor.execute(
            """
            SELECT COUNT(*) as count
            FROM crawl_queue
            WHERE status = 'visited'
            AND last_crawl >= ?
            """,
            (cutoff_str,),
        )
        result = cursor.fetchone()
        if result:
            activity["urls_processed"] = result["count"]

        # Get most recent successful crawl time
        cursor.execute(
            """
            SELECT MAX(last_crawl) as last_crawl
            FROM crawl_queue
            WHERE status = 'visited'
            AND last_crawl IS NOT NULL
            """
        )
        result = cursor.fetchone()
        if result and result["last_crawl"]:
            activity["last_crawl_time"] = result["last_crawl"]

        conn.close()
    except Exception as e:
        logger.error(f"Error querying recent activity: {e}")

    return activity


# Regex pattern to match "404" as a whole word (compiled once at module level)
_404_PATTERN = re.compile(r"\b404\b")


def _process_cloudwatch_events(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Extract and filter error events from CloudWatch log events."""
    errors = []
    for event in events:
        timestamp_ms = event.get("timestamp", 0)
        # CloudWatch timestamps are in UTC
        timestamp_dt = datetime.fromtimestamp(timestamp_ms / 1000, tz=ZoneInfo("UTC"))
        # Convert to Pacific time for display
        pacific_dt = timestamp_dt.astimezone(PACIFIC_TZ)
        message = event.get("message", "").strip()

        # Skip 404 errors - they're expected in crawlers and not consequential
        # Check for "404" as a whole word using word boundaries
        if message and not _404_PATTERN.search(message):
            errors.append(
                {
                    "timestamp": pacific_dt.strftime("%Y-%m-%d %I:%M:%S %p %Z"),
                    "message": message,
                }
            )
    return errors


def _handle_cloudwatch_exception(e: Exception) -> bool:
    """Handle CloudWatch-specific exceptions. Returns True if handled."""
    if not AWS_AVAILABLE:
        return False

    try:
        from botocore.exceptions import (  # type: ignore[import-not-found]
            BotoCoreError,
            ClientError,
        )

        # Use modern union syntax for isinstance (Python 3.10+)
        if isinstance(e, BotoCoreError | ClientError):
            logger.error(f"AWS CloudWatch error: {e}")
            return True
    except ImportError:
        pass

    return False


def query_cloudwatch_errors(log_group: str, hours: int = 24) -> list[dict[str, Any]]:
    """Query CloudWatch Logs for ERROR level entries from last N hours."""
    errors = []

    if not AWS_AVAILABLE or boto3 is None:
        logger.warning("boto3 not available - cannot query CloudWatch")
        return errors

    try:
        assert boto3 is not None  # Type guard for linter
        logs_client = boto3.client(
            "logs",
            region_name=os.getenv("AWS_REGION", "us-west-1"),
            aws_access_key_id=os.getenv("AWS_ACCESS_KEY_ID"),
            aws_secret_access_key=os.getenv("AWS_SECRET_ACCESS_KEY"),
        )

        # Calculate start time (N hours ago)
        start_time = int((datetime.now() - timedelta(hours=hours)).timestamp() * 1000)
        end_time = int(datetime.now().timestamp() * 1000)

        # Query for ERROR level log entries
        # Filter pattern matches log lines containing "ERROR" (case-sensitive)
        # Our logs are formatted as "ERROR - message" so this will match ERROR level logs
        response = logs_client.filter_log_events(
            logGroupName=log_group,
            startTime=start_time,
            endTime=end_time,
            filterPattern="ERROR",  # Matches any log line containing "ERROR"
        )

        # Process initial batch of events
        errors.extend(_process_cloudwatch_events(response.get("events", [])))

        # Handle pagination if there are more results
        next_token = response.get("nextToken")
        while next_token:
            response = logs_client.filter_log_events(
                logGroupName=log_group,
                startTime=start_time,
                endTime=end_time,
                filterPattern="ERROR",
                nextToken=next_token,
            )
            errors.extend(_process_cloudwatch_events(response.get("events", [])))
            next_token = response.get("nextToken")

    except Exception as e:
        if not _handle_cloudwatch_exception(e):
            logger.error(f"Error querying CloudWatch: {e}")

    return errors


def format_report(
    site_id: str,
    queue_stats: dict[str, Any],
    activity: dict[str, Any],
) -> str:
    """Format the daily report email body."""
    report_lines = []

    # Health summary
    report_lines.append("=== Crawler Health Summary ===")
    processed_count = activity.get("urls_processed", 0)
    ready_to_process = queue_stats.get("ready_to_process", 0)

    # Determine overall health status
    # HEALTHY if either processed some URLs or nothing was ready to process.
    # NEEDS ATTENTION if URLs were ready but none were processed.
    if processed_count > 0 or ready_to_process == 0:
        status = "HEALTHY"
    elif processed_count == 0 and ready_to_process > 0:
        # URLs were ready but nothing was processed - crawler may be stuck
        status = "NEEDS ATTENTION"
    else:
        status = "UNKNOWN"

    report_lines.append(f"Status: {status}")

    # Convert last crawl time to Pacific
    last_crawl = activity.get("last_crawl_time")
    last_crawl_formatted = format_timestamp_pacific(last_crawl)
    report_lines.append(f"Last successful crawl: {last_crawl_formatted}")

    report_lines.append("")

    # Activity
    report_lines.append("=== Activity (Last 24h) ===")
    report_lines.append(f"- URLs processed: {processed_count}")
    report_lines.append("")

    # Queue status
    report_lines.append("=== Queue Status ===")
    report_lines.append(f"- Ready to process: {queue_stats.get('ready_to_process', 0)}")
    report_lines.append(f"- Pending: {queue_stats.get('pending', 0)}")
    report_lines.append(f"- Processing: {queue_stats.get('processing', 0)}")
    report_lines.append(f"- Completed: {queue_stats.get('visited', 0)}")
    report_lines.append(f"- Failed: {queue_stats.get('failed', 0)}")
    report_lines.append(f"- Deleted: {queue_stats.get('deleted', 0)}")
    report_lines.append("")

    return "\n".join(report_lines)


def generate_subject_line(site_id: str, ready: int, processed: int) -> str:
    """Generate email subject line with key metrics."""
    site_shortname = get_site_shortname(site_id)
    # Format subject with metrics: "[Vivek] Daily Crawler: 142 ready | 87 processed"
    # Note: We format with site prefix here, and email_ops.py will skip adding dev/prod prefix
    # since it detects the subject already starts with '['
    subject = (
        f"[{site_shortname}] Daily Crawler: "
        f"{ready} ready | {processed} processed"
    )
    return subject


def main():
    """Main entry point for daily report generation."""
    parser = argparse.ArgumentParser(
        description="Generate daily crawler operations report"
    )
    parser.add_argument(
        "--site",
        required=True,
        help="Site ID (e.g., ananda-public) - determines which database to check",
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Enable debug logging",
    )
    args = parser.parse_args()

    # Configure logging
    log_level = logging.DEBUG if args.debug else logging.INFO
    logging.basicConfig(
        level=log_level,
        format="%(asctime)s - %(levelname)s - %(message)s"
        if not _is_running_in_cloud()
        else "%(levelname)s - %(message)s",
        force=True,
    )

    site_id = args.site
    logger.info(f"Generating daily report for site: {site_id}")

    # Set SITE_ID environment variable for email formatting
    os.environ["SITE_ID"] = site_id

    # Get database path
    db_path = get_database_path(site_id)
    logger.info(f"Database path: {db_path}")

    # Query database for queue stats
    queue_stats = query_queue_stats(db_path)
    logger.info(f"Queue stats: {queue_stats}")

    # Query database for recent activity
    activity = query_recent_activity(db_path, hours=24)
    logger.info(f"Recent activity: {activity}")

    # Format report
    report_body = format_report(site_id, queue_stats, activity)

    # Generate subject line with key metrics
    # Use "ready_to_process" count instead of all pending
    ready_count = queue_stats.get("ready_to_process", 0)
    processed_count = activity.get("urls_processed", 0)
    subject = generate_subject_line(site_id, ready_count, processed_count)

    # Send email
    logger.info(f"Sending daily report email with subject: {subject}")

    success = send_ops_alert_sync(
        subject=subject,
        message=report_body,
        error_details=None,
    )

    if success:
        logger.info("Daily report sent successfully")
        return 0
    else:
        logger.error("Failed to send daily report")
        return 1


if __name__ == "__main__":
    sys.exit(main())
