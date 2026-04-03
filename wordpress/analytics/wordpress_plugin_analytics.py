#!/usr/bin/env python3
"""
WordPress Plugin Analytics - Google Analytics API Integration

This script analyzes how the WordPress plugin is being used in production by querying
Google Analytics data for specific chatbot events tracked by the plugin.

Key Metrics Analyzed:
1. Popup engagement rates (open/close events)
2. Search promotion effectiveness (50% scroll trigger conversion)
3. User interaction patterns and session behavior
4. Feature usage statistics

Author: Michael Olivier
Date: September 2025
"""

import argparse
import json
import logging
import os
import sys
from datetime import datetime, timedelta
from typing import Any

# Third-party imports
try:
    import matplotlib.pyplot as plt
    import pandas as pd
    import seaborn as sns
    from google.analytics.data_v1beta import BetaAnalyticsDataClient
    from google.analytics.data_v1beta.types import (
        DateRange,
        Dimension,
        Filter,
        FilterExpression,
        Metric,
        RunReportRequest,
    )
    from google.oauth2.service_account import Credentials
except ImportError as e:
    print(f"Missing required dependency: {e}")
    print("Please sync the UV environment first:")
    print(
        "uv sync --locked --package "
        "mega-rag-chatbot-wordpress-analytics --no-default-groups"
    )
    sys.exit(1)

# Configure logging
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)


class WordPressPluginAnalytics:
    """
    Analyzes WordPress plugin usage through Google Analytics data.

    This class provides comprehensive analysis of chatbot plugin usage including:
    - Popup engagement metrics
    - Search promotion effectiveness
    - User interaction patterns
    - Feature usage statistics
    """

    # Event names tracked by the WordPress plugin
    CHATBOT_EVENTS = {
        "popup_open": "chatbot_vivek_popup_open",
        "popup_close": "chatbot_vivek_popup_close",
        "question_submit": "chatbot_vivek_question_submit",
        "fullpage_click": "chatbot_vivek_fullpage_click",
        "contact_human": "chatbot_vivek_contact_human",
        "language_click": "chatbot_vivek_language_click",
        "nps_submit": "chatbot_vivek_nps_submit",
        "nps_dismiss": "chatbot_vivek_nps_dismiss",
        "clear_history": "chatbot_vivek_clear_history",
        "source_link_click": "chatbot_vivek_source_link_click",
        "ask_experts_click": "chatbot_vivek_ask_experts_link_click",
        "suggestion_click": "chatbot_vivek_suggestion_click",
    }

    def __init__(self, property_id: str, credentials_path: str):
        """
        Initialize the analytics client.

        Args:
            property_id: Google Analytics 4 property ID
            credentials_path: Path to Google service account credentials JSON
        """
        self.property_id = property_id
        self.credentials_path = credentials_path
        self.client = None
        self._initialize_client()

    def _initialize_client(self) -> None:
        """Initialize the Google Analytics Data API client."""
        try:
            if not os.path.exists(self.credentials_path):
                raise FileNotFoundError(
                    f"Credentials file not found: {self.credentials_path}"
                )

            credentials = Credentials.from_service_account_file(self.credentials_path)
            self.client = BetaAnalyticsDataClient(credentials=credentials)
            logger.info("Successfully initialized Google Analytics client")

        except Exception as e:
            logger.error(f"Failed to initialize Google Analytics client: {e}")
            raise

    def get_date_range(self, days_back: int = 30) -> DateRange:
        """
        Create a date range for the analysis.

        Args:
            days_back: Number of days to look back from today

        Returns:
            DateRange object for the specified period
        """
        end_date = datetime.now()
        start_date = end_date - timedelta(days=days_back)

        return DateRange(
            start_date=start_date.strftime("%Y-%m-%d"),
            end_date=end_date.strftime("%Y-%m-%d"),
        )

    def run_report(
        self,
        dimensions: list[str],
        metrics: list[str],
        date_range: DateRange,
        event_filter: str | None = None,
        limit: int = 10000,
    ) -> pd.DataFrame:
        """
        Run a Google Analytics report and return results as DataFrame.

        Args:
            dimensions: List of dimension names
            metrics: List of metric names
            date_range: Date range for the report
            event_filter: Optional event name filter
            limit: Maximum number of rows to return

        Returns:
            DataFrame with report results
        """
        try:
            # Build dimensions and metrics
            dimension_objects = [Dimension(name=dim) for dim in dimensions]
            metric_objects = [Metric(name=metric) for metric in metrics]

            # Build request
            request = RunReportRequest(
                property=f"properties/{self.property_id}",
                dimensions=dimension_objects,
                metrics=metric_objects,
                date_ranges=[date_range],
                limit=limit,
            )

            # Add event filter if specified
            if event_filter:
                request.dimension_filter = FilterExpression(
                    filter=Filter(
                        field_name="eventName",
                        string_filter=Filter.StringFilter(
                            match_type=Filter.StringFilter.MatchType.EXACT,
                            value=event_filter,
                        ),
                    )
                )

            # Run the report
            response = self.client.run_report(request)

            # Convert to DataFrame
            data = []
            for row in response.rows:
                row_data = {}

                # Add dimensions
                for i, dim_value in enumerate(row.dimension_values):
                    row_data[dimensions[i]] = dim_value.value

                # Add metrics
                for i, metric_value in enumerate(row.metric_values):
                    row_data[metrics[i]] = float(metric_value.value)

                data.append(row_data)

            df = pd.DataFrame(data)
            logger.info(f"Retrieved {len(df)} rows from Google Analytics")
            return df

        except Exception as e:
            logger.error(f"Failed to run report: {e}")
            raise

    def analyze_popup_engagement(self, days_back: int = 30) -> dict[str, Any]:
        """
        Analyze popup engagement metrics.

        This analyzes:
        - Popup open rates vs page views
        - User engagement with the popup
        - Session duration after popup interaction

        Args:
            days_back: Number of days to analyze

        Returns:
            Dictionary with engagement metrics
        """
        logger.info("Analyzing popup engagement metrics...")

        date_range = self.get_date_range(days_back)

        # Get popup open events
        popup_opens = self.run_report(
            dimensions=["date", "eventName", "customEvent:method"],
            metrics=["eventCount", "eventCountPerUser"],
            date_range=date_range,
            event_filter=self.CHATBOT_EVENTS["popup_open"],
        )

        # Get popup close events
        popup_closes = self.run_report(
            dimensions=["date", "eventName", "customEvent:method"],
            metrics=["eventCount", "eventCountPerUser"],
            date_range=date_range,
            event_filter=self.CHATBOT_EVENTS["popup_close"],
        )

        # Get page views for comparison
        page_views = self.run_report(
            dimensions=["date"],
            metrics=["screenPageViews", "activeUsers"],
            date_range=date_range,
        )

        # Calculate engagement metrics
        total_popup_opens = (
            popup_opens["eventCount"].sum() if not popup_opens.empty else 0
        )
        total_popup_closes = (
            popup_closes["eventCount"].sum() if not popup_closes.empty else 0
        )
        total_page_views = (
            page_views["screenPageViews"].sum() if not page_views.empty else 0
        )
        total_users = page_views["activeUsers"].sum() if not page_views.empty else 0

        # Calculate engagement rates
        popup_open_rate = (
            (total_popup_opens / total_page_views * 100) if total_page_views > 0 else 0
        )
        popup_close_rate = (
            (total_popup_closes / total_popup_opens * 100)
            if total_popup_opens > 0
            else 0
        )
        user_engagement_rate = (
            (total_popup_opens / total_users * 100) if total_users > 0 else 0
        )

        # Analyze open methods
        open_methods = {}
        if not popup_opens.empty:
            method_counts = popup_opens.groupby("customEvent:method")[
                "eventCount"
            ].sum()
            total_opens = method_counts.sum()
            open_methods = {
                method: {
                    "count": int(count),
                    "percentage": (count / total_opens * 100) if total_opens > 0 else 0,
                }
                for method, count in method_counts.items()
            }

        # Analyze close methods
        close_methods = {}
        if not popup_closes.empty:
            method_counts = popup_closes.groupby("customEvent:method")[
                "eventCount"
            ].sum()
            total_closes = method_counts.sum()
            close_methods = {
                method: {
                    "count": int(count),
                    "percentage": (count / total_closes * 100)
                    if total_closes > 0
                    else 0,
                }
                for method, count in method_counts.items()
            }

        return {
            "summary": {
                "total_page_views": int(total_page_views),
                "total_users": int(total_users),
                "total_popup_opens": int(total_popup_opens),
                "total_popup_closes": int(total_popup_closes),
                "popup_open_rate_percent": round(popup_open_rate, 2),
                "popup_close_rate_percent": round(popup_close_rate, 2),
                "user_engagement_rate_percent": round(user_engagement_rate, 2),
            },
            "open_methods": open_methods,
            "close_methods": close_methods,
            "daily_trends": {
                "popup_opens": popup_opens.groupby("date")["eventCount"].sum().to_dict()
                if not popup_opens.empty
                else {},
                "page_views": page_views.set_index("date")["screenPageViews"].to_dict()
                if not page_views.empty
                else {},
            },
        }

    def analyze_search_promotion(self, days_back: int = 30) -> dict[str, Any]:
        """
        Analyze search promotion effectiveness.

        This analyzes the search bubble that appears when users scroll 50% down
        search results pages, promoting the chatbot as an alternative.

        Args:
            days_back: Number of days to analyze

        Returns:
            Dictionary with search promotion metrics
        """
        logger.info("Analyzing search promotion effectiveness...")

        date_range = self.get_date_range(days_back)

        # Get search page views (pages with /search in URL or search parameters)
        search_pages = self.run_report(
            dimensions=["date", "pagePath"],
            metrics=["screenPageViews", "activeUsers", "averageSessionDuration"],
            date_range=date_range,
        )

        # Filter for search pages
        if not search_pages.empty:
            search_pages = search_pages[
                search_pages["pagePath"].str.contains(
                    "/search|search=", case=False, na=False
                )
            ]

        # Get popup opens from search pages
        # Note: This requires custom dimension tracking in GA4 to identify source page
        search_popup_opens = self.run_report(
            dimensions=["date", "eventName", "customEvent:method"],
            metrics=["eventCount", "eventCountPerUser"],
            date_range=date_range,
            event_filter=self.CHATBOT_EVENTS["popup_open"],
        )

        # Get question submissions to measure conversion
        question_submissions = self.run_report(
            dimensions=["date", "eventName"],
            metrics=["eventCount", "eventCountPerUser"],
            date_range=date_range,
            event_filter=self.CHATBOT_EVENTS["question_submit"],
        )

        # Calculate search promotion metrics
        total_search_views = (
            search_pages["screenPageViews"].sum() if not search_pages.empty else 0
        )
        total_search_users = (
            search_pages["activeUsers"].sum() if not search_pages.empty else 0
        )

        # Estimate search-originated popup opens (this is approximate without custom tracking)
        bubble_click_opens = 0
        if not search_popup_opens.empty:
            bubble_clicks = search_popup_opens[
                search_popup_opens["customEvent:method"] == "bubble_click"
            ]
            bubble_click_opens = bubble_clicks["eventCount"].sum()

        total_questions = (
            question_submissions["eventCount"].sum()
            if not question_submissions.empty
            else 0
        )

        # Calculate conversion rates
        search_to_popup_rate = (
            (bubble_click_opens / total_search_views * 100)
            if total_search_views > 0
            else 0
        )
        popup_to_question_rate = (
            (total_questions / bubble_click_opens * 100)
            if bubble_click_opens > 0
            else 0
        )
        search_to_question_rate = (
            (total_questions / total_search_views * 100)
            if total_search_views > 0
            else 0
        )

        return {
            "summary": {
                "total_search_page_views": int(total_search_views),
                "total_search_users": int(total_search_users),
                "estimated_search_popup_opens": int(bubble_click_opens),
                "total_questions_submitted": int(total_questions),
                "search_to_popup_conversion_percent": round(search_to_popup_rate, 2),
                "popup_to_question_conversion_percent": round(
                    popup_to_question_rate, 2
                ),
                "overall_search_to_question_percent": round(search_to_question_rate, 2),
                "search_to_question_conversion_percent": round(search_to_question_rate, 2),
            },
            "daily_trends": {
                "search_views": search_pages.groupby("date")["screenPageViews"]
                .sum()
                .to_dict()
                if not search_pages.empty
                else {},
                "questions": question_submissions.groupby("date")["eventCount"]
                .sum()
                .to_dict()
                if not question_submissions.empty
                else {},
            },
            "top_search_pages": search_pages.nlargest(10, "screenPageViews")[
                ["pagePath", "screenPageViews"]
            ].to_dict("records")
            if not search_pages.empty
            else [],
        }

    def analyze_feature_usage(self, days_back: int = 30) -> dict[str, Any]:
        """
        Analyze usage frequency of different chatbot features.

        Args:
            days_back: Number of days to analyze

        Returns:
            Dictionary with feature usage statistics
        """
        logger.info("Analyzing feature usage patterns...")

        date_range = self.get_date_range(days_back)

        feature_stats = {}

        # Analyze each tracked event
        for feature_name, event_name in self.CHATBOT_EVENTS.items():
            try:
                feature_data = self.run_report(
                    dimensions=["date", "eventName"],
                    metrics=["eventCount", "eventCountPerUser", "totalUsers"],
                    date_range=date_range,
                    event_filter=event_name,
                )

                if not feature_data.empty:
                    total_events = feature_data["eventCount"].sum()
                    total_users = feature_data["totalUsers"].sum()
                    avg_events_per_user = (
                        total_events / total_users if total_users > 0 else 0
                    )

                    feature_stats[feature_name] = {
                        "total_events": int(total_events),
                        "total_users": int(total_users),
                        "events_per_user": round(avg_events_per_user, 2),
                        "daily_average": round(total_events / days_back, 2),
                    }
                else:
                    feature_stats[feature_name] = {
                        "total_events": 0,
                        "total_users": 0,
                        "events_per_user": 0,
                        "daily_average": 0,
                    }

            except Exception as e:
                logger.warning(f"Could not analyze feature {feature_name}: {e}")
                feature_stats[feature_name] = {
                    "total_events": 0,
                    "total_users": 0,
                    "events_per_user": 0,
                    "daily_average": 0,
                    "error": str(e),
                }

        # Calculate feature popularity ranking
        feature_ranking = sorted(
            [(name, stats["total_events"]) for name, stats in feature_stats.items()],
            key=lambda x: x[1],
            reverse=True,
        )

        # Calculate suggestion click rate
        suggestion_clicks = feature_stats.get("suggestion_click", {}).get("total_events", 0)
        total_questions = feature_stats.get("question_submit", {}).get("total_events", 0)
        suggestion_click_rate = (
            (suggestion_clicks / total_questions * 100) if total_questions > 0 else 0
        )

        return {
            "feature_statistics": feature_stats,
            "feature_ranking": [
                {"feature": name, "total_events": count}
                for name, count in feature_ranking
            ],
            "most_popular_feature": feature_ranking[0][0] if feature_ranking else None,
            "least_popular_feature": feature_ranking[-1][0]
            if feature_ranking
            else None,
            "suggestion_click_rate_percent": round(suggestion_click_rate, 2),
        }

    def generate_comprehensive_report(
        self, days_back: int = 30, output_file: str | None = None
    ) -> dict[str, Any]:
        """
        Generate a comprehensive analytics report.

        Args:
            days_back: Number of days to analyze
            output_file: Optional file path to save the report

        Returns:
            Complete analytics report dictionary
        """
        logger.info(f"Generating comprehensive report for the last {days_back} days...")

        report = {
            "report_metadata": {
                "generated_at": datetime.now().isoformat(),
                "analysis_period_days": days_back,
                "start_date": (datetime.now() - timedelta(days=days_back)).strftime(
                    "%Y-%m-%d"
                ),
                "end_date": datetime.now().strftime("%Y-%m-%d"),
                "property_id": self.property_id,
            },
            "popup_engagement": self.analyze_popup_engagement(days_back),
            "search_promotion": self.analyze_search_promotion(days_back),
            "feature_usage": self.analyze_feature_usage(days_back),
        }

        # Add insights and recommendations
        report["insights"] = self._generate_insights(report)

        # Save to file if requested
        if output_file:
            try:
                with open(output_file, "w") as f:
                    json.dump(report, f, indent=2, default=str)
                logger.info(f"Report saved to {output_file}")
            except Exception as e:
                logger.error(f"Failed to save report to {output_file}: {e}")

        return report

    def _generate_insights(self, report: dict[str, Any]) -> dict[str, list[str]]:
        """
        Generate insights and recommendations based on the analytics data.

        Args:
            report: The analytics report data

        Returns:
            Dictionary with insights and recommendations
        """
        insights = {"key_findings": [], "recommendations": [], "performance_alerts": []}

        # Popup engagement insights
        popup_data = report["popup_engagement"]["summary"]
        if popup_data["popup_open_rate_percent"] > 5:
            insights["key_findings"].append(
                f"High popup engagement: {popup_data['popup_open_rate_percent']:.1f}% of page views result in popup opens"
            )
        elif popup_data["popup_open_rate_percent"] < 1:
            insights["performance_alerts"].append(
                f"Low popup engagement: Only {popup_data['popup_open_rate_percent']:.1f}% of page views result in popup opens"
            )
            insights["recommendations"].append(
                "Consider improving popup visibility or adjusting trigger conditions"
            )

        # Search promotion insights
        search_data = report["search_promotion"]["summary"]
        search_to_question_rate = search_data.get("search_to_question_conversion_percent", 0)
        if search_to_question_rate > 2:
            insights["key_findings"].append(
                f"Effective search promotion: {search_to_question_rate:.1f}% of search page visits convert to questions"
            )
        elif search_to_question_rate < 0.5:
            insights["performance_alerts"].append(
                f"Low search conversion: Only {search_to_question_rate:.1f}% of search visits convert to questions"
            )
            insights["recommendations"].append(
                "Review search bubble messaging and positioning for better conversion"
            )

        # Feature usage insights
        feature_data = report["feature_usage"]
        most_popular = feature_data.get("most_popular_feature")
        if most_popular:
            insights["key_findings"].append(f"Most popular feature: {most_popular}")

        # Check for underutilized features
        underutilized = [
            name
            for name, stats in feature_data["feature_statistics"].items()
            if stats["total_events"] < 10 and name not in ["nps_submit", "nps_dismiss"]
        ]
        if underutilized:
            insights["recommendations"].append(
                f"Consider promoting underutilized features: {', '.join(underutilized)}"
            )

        return insights

    def create_visualizations(
        self, report: dict[str, Any], output_dir: str = "analytics_charts"
    ) -> None:
        """
        Create visualization charts from the analytics report.

        Args:
            report: The analytics report data
            output_dir: Directory to save chart images
        """
        logger.info("Creating visualization charts...")

        # Create output directory
        os.makedirs(output_dir, exist_ok=True)

        # Set style
        plt.style.use("seaborn-v0_8")
        sns.set_palette("husl")

        # 1. Popup engagement chart
        self._create_popup_engagement_chart(report, output_dir)

        # 2. Feature usage chart
        self._create_feature_usage_chart(report, output_dir)

        # 3. Daily trends chart
        self._create_daily_trends_chart(report, output_dir)

        logger.info(f"Charts saved to {output_dir}/")

    def _create_popup_engagement_chart(
        self, report: dict[str, Any], output_dir: str
    ) -> None:
        """Create popup engagement visualization."""
        fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(15, 6))

        # Engagement rates
        popup_data = report["popup_engagement"]["summary"]
        rates = [
            popup_data["popup_open_rate_percent"],
            popup_data["user_engagement_rate_percent"],
        ]
        labels = [
            "Popup Open Rate\n(% of page views)",
            "User Engagement Rate\n(% of users)",
        ]

        ax1.bar(labels, rates, color=["#3498db", "#e74c3c"])
        ax1.set_ylabel("Percentage (%)")
        ax1.set_title("Popup Engagement Rates")
        ax1.set_ylim(0, max(rates) * 1.2 if rates else 1)

        # Add value labels on bars
        for i, v in enumerate(rates):
            ax1.text(i, v + max(rates) * 0.02, f"{v:.1f}%", ha="center", va="bottom")

        # Open methods pie chart
        open_methods = report["popup_engagement"]["open_methods"]
        if open_methods:
            methods = list(open_methods.keys())
            counts = [data["count"] for data in open_methods.values()]

            ax2.pie(counts, labels=methods, autopct="%1.1f%%", startangle=90)
            ax2.set_title("Popup Open Methods")
        else:
            ax2.text(
                0.5,
                0.5,
                "No data available",
                ha="center",
                va="center",
                transform=ax2.transAxes,
            )
            ax2.set_title("Popup Open Methods")

        plt.tight_layout()
        plt.savefig(f"{output_dir}/popup_engagement.png", dpi=300, bbox_inches="tight")
        plt.close()

    def _create_feature_usage_chart(
        self, report: dict[str, Any], output_dir: str
    ) -> None:
        """Create feature usage visualization."""
        feature_ranking = report["feature_usage"]["feature_ranking"]

        if not feature_ranking:
            return

        # Top 10 features
        top_features = feature_ranking[:10]
        features = [item["feature"].replace("_", " ").title() for item in top_features]
        counts = [item["total_events"] for item in top_features]

        plt.figure(figsize=(12, 8))
        bars = plt.barh(features, counts)
        plt.xlabel("Total Events")
        plt.title("Feature Usage Frequency (Top 10)")
        plt.gca().invert_yaxis()

        # Add value labels on bars
        for i, (bar, count) in enumerate(zip(bars, counts, strict=False)):
            plt.text(
                bar.get_width() + max(counts) * 0.01,
                bar.get_y() + bar.get_height() / 2,
                f"{count:,}",
                ha="left",
                va="center",
            )

        plt.tight_layout()
        plt.savefig(f"{output_dir}/feature_usage.png", dpi=300, bbox_inches="tight")
        plt.close()

    def _create_daily_trends_chart(
        self, report: dict[str, Any], output_dir: str
    ) -> None:
        """Create daily trends visualization."""
        popup_trends = report["popup_engagement"]["daily_trends"]["popup_opens"]
        search_trends = report["search_promotion"]["daily_trends"]["search_views"]

        if not popup_trends and not search_trends:
            return

        fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(12, 10))

        # Popup opens trend
        if popup_trends:
            dates = list(popup_trends.keys())
            opens = list(popup_trends.values())

            ax1.plot(dates, opens, marker="o", linewidth=2, markersize=4)
            ax1.set_title("Daily Popup Opens Trend")
            ax1.set_ylabel("Popup Opens")
            ax1.tick_params(axis="x", rotation=45)
            ax1.grid(True, alpha=0.3)

        # Search views trend
        if search_trends:
            dates = list(search_trends.keys())
            views = list(search_trends.values())

            ax2.plot(
                dates, views, marker="s", linewidth=2, markersize=4, color="orange"
            )
            ax2.set_title("Daily Search Page Views Trend")
            ax2.set_ylabel("Search Page Views")
            ax2.tick_params(axis="x", rotation=45)
            ax2.grid(True, alpha=0.3)

        plt.tight_layout()
        plt.savefig(f"{output_dir}/daily_trends.png", dpi=300, bbox_inches="tight")
        plt.close()


def main():
    """Main function to run the analytics analysis."""
    parser = argparse.ArgumentParser(
        description="Analyze WordPress plugin usage through Google Analytics",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Basic analysis using config.json (recommended)
  python wordpress_plugin_analytics.py --days 7

  # Override config.json values
  python wordpress_plugin_analytics.py --property-id 123456789 --credentials /path/to/credentials.json --days 7

  # Generate charts and save report
  python wordpress_plugin_analytics.py --days 7 --charts --output report.json

Setup Instructions:
  1. Create a Google Cloud Project and enable the Google Analytics Data API
  2. Create a service account and download the JSON credentials file
  3. Add the service account email to your Google Analytics property with Viewer permissions
  4. Install required packages: pip install google-analytics-data pandas matplotlib seaborn
  5. Copy config.json.example to config.json and update with your settings
        """,
    )

    # Optional arguments (can be overridden by config.json)
    parser.add_argument(
        "--property-id",
        help='Google Analytics 4 property ID (numeric ID, not the "G-" measurement ID)',
    )

    parser.add_argument(
        "--credentials",
        help="Path to Google service account credentials JSON file",
    )

    # Optional arguments
    parser.add_argument(
        "--days", type=int, default=30, help="Number of days to analyze (default: 30)"
    )

    parser.add_argument("--output", help="Output file path for the JSON report")

    parser.add_argument(
        "--charts", action="store_true", help="Generate visualization charts"
    )

    parser.add_argument(
        "--charts-dir",
        default="analytics_charts",
        help="Directory to save chart images (default: analytics_charts)",
    )

    parser.add_argument("--verbose", action="store_true", help="Enable verbose logging")

    args = parser.parse_args()

    # Set logging level
    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    # Load config.json if it exists and arguments are not provided
    config_file = "config.json"
    if os.path.exists(config_file):
        try:
            with open(config_file) as f:
                config = json.load(f)
            
            # Use config values if command line arguments not provided
            property_id = args.property_id or config.get("google_analytics", {}).get("property_id")
            credentials_path = args.credentials or config.get("google_analytics", {}).get("credentials_path")
            
            if not property_id:
                logger.error("Property ID not found in config.json or command line arguments")
                sys.exit(1)
            
            if not credentials_path:
                logger.error("Credentials path not found in config.json or command line arguments")
                sys.exit(1)
                
            logger.info(f"Using config from {config_file}")
            logger.info(f"Property ID: {property_id}")
            logger.info(f"Credentials: {credentials_path}")
            
        except Exception as e:
            logger.error(f"Error loading config.json: {e}")
            sys.exit(1)
    else:
        # Fall back to command line arguments only
        if not args.property_id or not args.credentials:
            logger.error("config.json not found and required arguments not provided")
            logger.error("Either create a config.json file or provide --property-id and --credentials")
            sys.exit(1)
        property_id = args.property_id
        credentials_path = args.credentials

    try:
        # Initialize analytics client
        analytics = WordPressPluginAnalytics(property_id, credentials_path)

        # Generate comprehensive report
        report = analytics.generate_comprehensive_report(
            days_back=args.days, output_file=args.output
        )

        # Print summary to console
        print("\n" + "=" * 80)
        print("WORDPRESS PLUGIN ANALYTICS REPORT")
        print("=" * 80)

        print(f"\nAnalysis Period: {args.days} days")
        print(f"Report Generated: {report['report_metadata']['generated_at']}")

        # Popup Engagement Summary
        popup_summary = report["popup_engagement"]["summary"]
        print("\n📊 POPUP ENGAGEMENT METRICS")
        print(f"   Total Page Views: {popup_summary['total_page_views']:,}")
        print(f"   Total Users: {popup_summary['total_users']:,}")
        print(f"   Popup Opens: {popup_summary['total_popup_opens']:,}")
        print(
            f"   Popup Open Rate: {popup_summary['popup_open_rate_percent']:.2f}% of page views"
        )
        print(
            f"   User Engagement Rate: {popup_summary['user_engagement_rate_percent']:.2f}% of users"
        )

        # Search Promotion Summary
        search_summary = report["search_promotion"]["summary"]
        print("\n🔍 SEARCH PROMOTION METRICS")
        print(f"   Search Page Views: {search_summary['total_search_page_views']:,}")
        print(f"   Search Users: {search_summary['total_search_users']:,}")
        print(
            f"   Questions from Search: {search_summary['total_questions_submitted']:,}"
        )
        print(
            f"   Search to Question Rate: {search_summary.get('overall_search_to_question_percent', 0):.2f}%"
        )

        # Feature Usage Summary
        feature_summary = report["feature_usage"]
        print("\n🎯 FEATURE USAGE SUMMARY")
        if feature_summary["most_popular_feature"]:
            print(f"   Most Popular Feature: {feature_summary['most_popular_feature']}")

        top_features = feature_summary["feature_ranking"][:5]
        print("   Top 5 Features:")
        for i, feature in enumerate(top_features, 1):
            print(f"     {i}. {feature['feature']}: {feature['total_events']:,} events")

        # Suggestion click rate
        suggestion_rate = feature_summary.get("suggestion_click_rate_percent", 0)
        print("\n💡 SUGGESTION ENGAGEMENT")
        print(f"   Suggestion Click Rate: {suggestion_rate:.2f}% of questions")

        # Insights
        insights = report["insights"]
        if insights["key_findings"]:
            print("\n💡 KEY FINDINGS")
            for finding in insights["key_findings"]:
                print(f"   • {finding}")

        if insights["recommendations"]:
            print("\n🎯 RECOMMENDATIONS")
            for rec in insights["recommendations"]:
                print(f"   • {rec}")

        if insights["performance_alerts"]:
            print("\n⚠️  PERFORMANCE ALERTS")
            for alert in insights["performance_alerts"]:
                print(f"   • {alert}")

        # Generate charts if requested
        if args.charts:
            analytics.create_visualizations(report, args.charts_dir)
            print(f"\n📈 Charts saved to {args.charts_dir}/")

        print("\n" + "=" * 80)
        print("Analysis complete!")

        if args.output:
            print(f"Detailed report saved to: {args.output}")

    except Exception as e:
        logger.error(f"Analysis failed: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
