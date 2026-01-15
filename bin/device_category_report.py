#!/usr/bin/env python3
"""
Google Analytics Device Category Report

Queries Google Analytics 4 for device category breakdown (mobile vs desktop vs tablet).
"""

import argparse
import json
import logging
import os
import sys
from datetime import datetime, timedelta
from typing import Any

try:
    from google.analytics.data_v1beta import BetaAnalyticsDataClient
    from google.analytics.data_v1beta.types import (
        DateRange,
        Dimension,
        Metric,
        RunReportRequest,
    )
    from google.oauth2 import service_account

    from pyutil.env_utils import load_env
except ImportError as e:
    print(f"Missing required dependency: {e}")
    print("Please install required packages:")
    print("pip install google-analytics-data")
    sys.exit(1)

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)


def get_device_category_report(
    property_id: str, credentials_dict: dict[str, Any], days_back: int = 30
) -> dict[str, Any]:
    """
    Get device category breakdown from Google Analytics.

    Args:
        property_id: Google Analytics 4 property ID
        credentials_dict: Service account credentials dictionary (from JSON)
        days_back: Number of days to analyze

    Returns:
        Dictionary with device category statistics
    """
    # Initialize client using credentials dictionary
    credentials = service_account.Credentials.from_service_account_info(
        credentials_dict
    )
    client = BetaAnalyticsDataClient(credentials=credentials)

    # Set date range
    end_date = datetime.now()
    start_date = end_date - timedelta(days=days_back)
    date_range = DateRange(
        start_date=start_date.strftime("%Y-%m-%d"),
        end_date=end_date.strftime("%Y-%m-%d"),
    )

    # Build request for device category breakdown
    request = RunReportRequest(
        property=f"properties/{property_id}",
        dimensions=[Dimension(name="deviceCategory")],
        metrics=[
            Metric(name="activeUsers"),
            Metric(name="sessions"),
            Metric(name="screenPageViews"),
        ],
        date_ranges=[date_range],
    )

    # Run the report
    logger.info("Querying Google Analytics for device category data...")
    response = client.run_report(request)

    # Process results
    device_data = {}
    total_users = 0
    total_sessions = 0
    total_page_views = 0

    for row in response.rows:
        device_category = row.dimension_values[0].value
        users = int(row.metric_values[0].value)
        sessions = int(row.metric_values[1].value)
        page_views = int(row.metric_values[2].value)

        device_data[device_category] = {
            "users": users,
            "sessions": sessions,
            "page_views": page_views,
        }

        total_users += users
        total_sessions += sessions
        total_page_views += page_views

    # Calculate percentages
    device_percentages = {}
    for device, data in device_data.items():
        user_pct = (data["users"] / total_users * 100) if total_users > 0 else 0
        session_pct = (
            (data["sessions"] / total_sessions * 100) if total_sessions > 0 else 0
        )
        page_view_pct = (
            (data["page_views"] / total_page_views * 100) if total_page_views > 0 else 0
        )

        device_percentages[device] = {
            "users": round(user_pct, 2),
            "sessions": round(session_pct, 2),
            "page_views": round(page_view_pct, 2),
        }

    return {
        "report_metadata": {
            "generated_at": datetime.now().isoformat(),
            "analysis_period_days": days_back,
            "start_date": start_date.strftime("%Y-%m-%d"),
            "end_date": end_date.strftime("%Y-%m-%d"),
            "property_id": property_id,
        },
        "totals": {
            "users": total_users,
            "sessions": total_sessions,
            "page_views": total_page_views,
        },
        "device_data": device_data,
        "device_percentages": device_percentages,
    }


def main():
    """Main function."""
    parser = argparse.ArgumentParser(
        description="Get device category breakdown from Google Analytics",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )

    parser.add_argument(
        "--site",
        required=True,
        help="Site ID for environment variables (e.g., ananda-public). Loads config from .env.[site]",
    )

    parser.add_argument(
        "-e",
        "--env",
        type=str,
        choices=["dev", "prod"],
        default="prod",
        help="Environment (dev or prod, default: prod)",
    )

    parser.add_argument(
        "--property-id",
        help='Google Analytics 4 property ID (numeric ID, not the "G-" measurement ID). Overrides environment variable.',
    )

    parser.add_argument(
        "--days",
        type=int,
        default=30,
        help="Number of days to analyze (default: 30)",
    )

    parser.add_argument(
        "--output",
        help="Optional output file path for JSON report",
    )

    parser.add_argument("--verbose", action="store_true", help="Enable verbose logging")

    args = parser.parse_args()

    # Load environment variables
    try:
        load_env(args.site)
    except FileNotFoundError as e:
        logger.error(f"Failed to load environment: {e}")
        sys.exit(1)

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    # Get property ID from environment or CLI args
    property_id = args.property_id or os.getenv("GOOGLE_ANALYTICS_PROPERTY_ID")

    if not property_id:
        logger.error(
            "Property ID not found. Set GOOGLE_ANALYTICS_PROPERTY_ID environment variable or use --property-id"
        )
        sys.exit(1)

    # Get credentials from GOOGLE_APPLICATION_CREDENTIALS (same as other Google services)
    credentials_json = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
    if not credentials_json:
        logger.error(
            "GOOGLE_APPLICATION_CREDENTIALS environment variable is not set or is empty"
        )
        sys.exit(1)

    try:
        credentials_dict = json.loads(credentials_json)
    except json.JSONDecodeError as e:
        logger.error(f"Error decoding JSON from GOOGLE_APPLICATION_CREDENTIALS: {e}")
        sys.exit(1)

    try:
        report = get_device_category_report(property_id, credentials_dict, args.days)

        # Print results
        print("\n" + "=" * 80)
        print("GOOGLE ANALYTICS DEVICE CATEGORY REPORT")
        print("=" * 80)
        print(f"\nAnalysis Period: {args.days} days")
        print(
            f"Date Range: {report['report_metadata']['start_date']} to {report['report_metadata']['end_date']}"
        )
        print(f"\nTotal Users: {report['totals']['users']:,}")
        print(f"Total Sessions: {report['totals']['sessions']:,}")
        print(f"Total Page Views: {report['totals']['page_views']:,}")

        print("\n" + "-" * 80)
        print("DEVICE CATEGORY BREAKDOWN")
        print("-" * 80)

        # Group mobile vs desktop
        mobile_users = 0
        desktop_users = 0
        tablet_users = 0
        mobile_sessions = 0
        desktop_sessions = 0
        tablet_sessions = 0

        for device, data in report["device_data"].items():
            device_lower = device.lower()
            if "mobile" in device_lower:
                mobile_users += data["users"]
                mobile_sessions += data["sessions"]
            elif "desktop" in device_lower:
                desktop_users += data["users"]
                desktop_sessions += data["sessions"]
            elif "tablet" in device_lower:
                tablet_users += data["users"]
                tablet_sessions += data["sessions"]

            pct = report["device_percentages"][device]
            print(f"\n{device.upper()}:")
            print(f"  Users: {data['users']:,} ({pct['users']:.2f}%)")
            print(f"  Sessions: {data['sessions']:,} ({pct['sessions']:.2f}%)")
            print(f"  Page Views: {data['page_views']:,} ({pct['page_views']:.2f}%)")

        # Summary: Mobile vs Desktop
        total_grouped_users = mobile_users + desktop_users + tablet_users

        print("\n" + "=" * 80)
        print("MOBILE vs DESKTOP SUMMARY")
        print("=" * 80)

        if total_grouped_users > 0:
            mobile_pct = (mobile_users / total_grouped_users) * 100
            desktop_pct = (desktop_users / total_grouped_users) * 100
            tablet_pct = (tablet_users / total_grouped_users) * 100

            print("\n📱 MOBILE:")
            print(f"   Users: {mobile_users:,} ({mobile_pct:.2f}%)")
            print(f"   Sessions: {mobile_sessions:,}")

            print("\n🖥️  DESKTOP:")
            print(f"   Users: {desktop_users:,} ({desktop_pct:.2f}%)")
            print(f"   Sessions: {desktop_sessions:,}")

            if tablet_users > 0:
                print("\n📱 TABLET:")
                print(f"   Users: {tablet_users:,} ({tablet_pct:.2f}%)")
                print(f"   Sessions: {tablet_sessions:,}")

            print("\n" + "-" * 80)
            print(f"Mobile: {mobile_pct:.2f}% | Desktop: {desktop_pct:.2f}%", end="")
            if tablet_users > 0:
                print(f" | Tablet: {tablet_pct:.2f}%")
            else:
                print()

        # Save to file if requested
        if args.output:
            with open(args.output, "w") as f:
                json.dump(report, f, indent=2, default=str)
            print(f"\n📄 Detailed report saved to: {args.output}")

        print("\n" + "=" * 80)

    except Exception as e:
        logger.error(f"Failed to generate report: {e}")
        if args.verbose:
            import traceback

            traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
