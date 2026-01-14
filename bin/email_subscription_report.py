#!/usr/bin/env python3
"""
Email subscription and engagement report for Firestore production.

This script generates a comprehensive report on email subscriptions including:
- Subscription/unsubscription counts per category
- Open rates, click rates, and click-through rates
- Send counts from tracking data

Categories: newsletters, onboarding, reengagement, specialDay, nps

Usage:
    python bin/email_subscription_report.py --site ananda --env prod
"""

import argparse
import json
import os
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any

from google.cloud import firestore
from google.cloud.firestore_v1.base_query import FieldFilter
from google.oauth2 import service_account

from pyutil.env_utils import load_env

# Email categories and their descriptions (matches TypeScript EmailCategory type)
EMAIL_CATEGORIES = {
    "newsletters": "Admin-sent newsletters",
    "onboarding": "Onboarding drip emails",
    "reengagement": "Re-engagement emails (21-60 day inactivity)",
    "specialDay": "Special occasion emails (holidays, events, etc.)",
    "nps": "NPS survey emails",
}

# Map campaign types from email tracking to email categories
CAMPAIGN_TO_CATEGORY = {
    "newsletter": "newsletters",
    "onboarding": "onboarding",
    "reengagement": "reengagement",
    "specialDay": "specialDay",
    "nps": "nps",
}


@dataclass
class EmailStats:
    """Container for email tracking statistics."""

    opens_by_category: dict[str, set[str]] = field(
        default_factory=lambda: defaultdict(set)
    )
    clicks_by_category: dict[str, set[str]] = field(
        default_factory=lambda: defaultdict(set)
    )
    sends_by_category: dict[str, int] = field(default_factory=lambda: defaultdict(int))
    onboarding_users_with_field: int = 0
    onboarding_users_with_tracking: int = 0


def initialize_firestore(env_prefix: str) -> firestore.Client:
    """Initialize Firestore client using service account credentials from environment."""
    credentials_json = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
    if not credentials_json:
        raise ValueError(
            "GOOGLE_APPLICATION_CREDENTIALS environment variable is not set or is empty"
        )

    try:
        credentials_dict = json.loads(credentials_json)
        credentials = service_account.Credentials.from_service_account_info(
            credentials_dict
        )
    except json.JSONDecodeError as e:
        raise ValueError(
            f"Error decoding JSON from GOOGLE_APPLICATION_CREDENTIALS: {e}"
        ) from e

    # Unset FIRESTORE_EMULATOR_HOST for production
    if "FIRESTORE_EMULATOR_HOST" in os.environ:
        del os.environ["FIRESTORE_EMULATOR_HOST"]

    try:
        return firestore.Client(credentials=credentials)
    except Exception as e:
        raise RuntimeError(f"Error initializing Firestore: {e}") from e


def is_unsubscribed_from_category(user_data: dict[str, Any], category: str) -> bool:
    """Check if user is unsubscribed from a specific email category."""
    email_prefs = user_data.get("emailPreferences", {})
    if category in email_prefs:
        return email_prefs[category] is False

    # Legacy fallback for newsletters
    return category == "newsletters" and user_data.get("newsletterSubscribed") is False


def count_unsubscribed_users_by_category(
    db: firestore.Client, env_prefix: str
) -> tuple[int, dict[str, int], dict[str, list[str]]]:
    """Count users who have unsubscribed from each email category."""
    collection_name = f"{env_prefix}_users"
    print(f"\n📊 Querying {collection_name} collection...")
    print("   Analyzing email subscription preferences for all categories\n")

    users_snapshot = db.collection(collection_name).stream()

    total_users = 0
    category_counts: dict[str, int] = defaultdict(int)
    category_emails: dict[str, list[str]] = defaultdict(list)

    for doc in users_snapshot:
        total_users += 1
        user_data = doc.to_dict()
        email = doc.id

        for category in EMAIL_CATEGORIES:
            if is_unsubscribed_from_category(user_data, category):
                category_counts[category] += 1
                category_emails[category].append(email)

    return total_users, dict(category_counts), dict(category_emails)


def get_newsletter_send_count(db: firestore.Client, env_prefix: str) -> int:
    """Query the newsletter queue to get accurate send counts."""
    newsletters_col = f"{env_prefix}_newsletters"
    total_sent = 0

    try:
        for newsletter_doc in db.collection(newsletters_col).stream():
            newsletter_data = newsletter_doc.to_dict()
            sent_count = newsletter_data.get("sentCount", 0)
            if sent_count:
                total_sent += sent_count
            else:
                # Fall back to querying queue items with status='sent'
                queue_query = newsletter_doc.reference.collection("queueItems").where(
                    filter=FieldFilter("status", "==", "sent")
                )
                total_sent += sum(1 for _ in queue_query.stream())
    except Exception as e:
        print(f"   ⚠️  Warning: Could not query newsletter collection: {e}")

    return total_sent


def process_user_send_counts(user_data: dict[str, Any], stats: EmailStats) -> None:
    """Process send count fields from a user document."""
    # Onboarding (NOTE: inflated for existing users when feature rolled out)
    onboarding_sent = user_data.get("onboardingEmailsSent", [])
    if isinstance(onboarding_sent, list) and len(onboarding_sent) > 0:
        stats.sends_by_category["onboarding"] += len(onboarding_sent)
        stats.onboarding_users_with_field += 1

    # Reengagement
    reengagement_sent = user_data.get("reengagementEmailsSent", [])
    if isinstance(reengagement_sent, list):
        stats.sends_by_category["reengagement"] += len(reengagement_sent)

    # SpecialDay
    special_day_sent = user_data.get("specialDayEmailsSent", [])
    if isinstance(special_day_sent, list):
        stats.sends_by_category["specialDay"] += len(special_day_sent)

    # NPS
    if user_data.get("lastNpsSurveySentAt"):
        stats.sends_by_category["nps"] += 1


def process_user_tracking_subcollections(
    user_ref: Any, email: str, stats: EmailStats
) -> bool:
    """Process email_opens and email_clicks subcollections for a user.

    Returns True if user has onboarding tracking data.
    """
    user_has_onboarding_tracking = False

    # Process email_opens
    try:
        for open_doc in user_ref.collection("email_opens").stream():
            open_data = open_doc.to_dict()
            campaign = open_data.get("campaign", "")
            category = CAMPAIGN_TO_CATEGORY.get(campaign)
            if category:
                stats.opens_by_category[category].add(email)
                if campaign == "onboarding":
                    user_has_onboarding_tracking = True
    except Exception:
        pass

    # Process email_clicks
    try:
        for click_doc in user_ref.collection("email_clicks").stream():
            click_data = click_doc.to_dict()
            campaign = click_data.get("campaign", "")
            category = CAMPAIGN_TO_CATEGORY.get(campaign)
            if category:
                stats.clicks_by_category[category].add(email)
                if campaign == "onboarding":
                    user_has_onboarding_tracking = True
    except Exception:
        pass

    return user_has_onboarding_tracking


def get_email_tracking_stats(db: firestore.Client, env_prefix: str) -> EmailStats:
    """Get email open, click, and send tracking statistics per category."""
    collection_name = f"{env_prefix}_users"
    print("   Analyzing email open, click, and send tracking data...")
    print("   (This may take a minute for large user bases)\n")

    stats = EmailStats()
    user_count = 0

    for doc in db.collection(collection_name).stream():
        user_count += 1
        if user_count % 50 == 0:
            print(f"   Processed {user_count} users...", end="\r", flush=True)

        email = doc.id
        user_data = doc.to_dict()

        process_user_send_counts(user_data, stats)

        has_onboarding_tracking = process_user_tracking_subcollections(
            doc.reference, email, stats
        )
        if has_onboarding_tracking:
            stats.onboarding_users_with_tracking += 1

    print(f"   Processed {user_count} users.                    ")

    # Query newsletter collection for accurate send counts
    print("   Querying newsletter collection for send counts...")
    stats.sends_by_category["newsletters"] = get_newsletter_send_count(db, env_prefix)

    return stats


def print_category_report(
    category: str,
    description: str,
    total_users: int,
    unsubscribed_count: int,
    unsubscribed_list: list[str],
    stats: EmailStats,
) -> None:
    """Print the report for a single email category."""
    subscribed_count = total_users - unsubscribed_count
    unique_opens = len(stats.opens_by_category.get(category, set()))
    unique_clicks = len(stats.clicks_by_category.get(category, set()))
    total_sends = stats.sends_by_category.get(category, 0)

    print("-" * 80)
    print(f"📧 {category.upper()}: {description}")
    print("-" * 80)
    print(f"   Unsubscribed: {unsubscribed_count}")

    if total_users > 0:
        percentage = (unsubscribed_count / total_users) * 100
        subscribed_percentage = (subscribed_count / total_users) * 100
        print(f"   Subscribed: {subscribed_count} ({subscribed_percentage:.2f}%)")
        print(f"   Unsubscribed percentage: {percentage:.2f}%")

    print("\n   📊 Engagement Metrics:")

    # Special handling per category
    if category == "onboarding":
        _print_onboarding_metrics(stats, total_sends)
    elif category == "newsletters":
        _print_newsletter_metrics(total_sends, unique_opens, unique_clicks)
    else:
        print(f"      Total emails sent: {total_sends}")

    print(f"      Unique opens: {unique_opens}")
    print(f"      Unique clicks: {unique_clicks}")

    # Print rates if applicable
    _print_engagement_rates(category, total_sends, unique_opens, unique_clicks)

    # Print unsubscribed emails
    if unsubscribed_count > 0:
        print(f"\n   Unsubscribed user emails ({unsubscribed_count}):")
        for email in sorted(unsubscribed_list):
            print(f"      - {email}")
    else:
        print("\n   ✅ All users are subscribed to this category")
    print()


def _print_onboarding_metrics(stats: EmailStats, total_sends: int) -> None:
    """Print onboarding-specific metrics with context about inflated numbers."""
    print(f"      Users with onboarding field set: {stats.onboarding_users_with_field}")
    print(
        f"      Users with actual open/click tracking: {stats.onboarding_users_with_tracking}"
    )
    print(
        f"      Total entries in onboardingEmailsSent: {total_sends}"
        " (⚠️ inflated - includes retroactive marks)"
    )
    print("      Note: When onboarding rolled out, existing users had earlier days")
    print(
        "            marked as 'sent' to prevent retroactive spam, inflating this count."
    )


def _print_newsletter_metrics(
    total_sends: int, unique_opens: int, unique_clicks: int
) -> None:
    """Print newsletter-specific metrics with tracking availability note."""
    print(f"      Total emails sent: {total_sends}")
    if unique_opens == 0 and unique_clicks == 0 and total_sends > 0:
        print("      ⚠️  Note: Open/click tracking was not enabled for newsletters")
        print("            sent before January 13, 2026.")


def _print_engagement_rates(
    category: str, total_sends: int, unique_opens: int, unique_clicks: int
) -> None:
    """Print open rate, click rate, and CTR if data is available."""
    # Skip rate calculations for onboarding (inflated) and newsletters (no tracking)
    if category in ("onboarding", "newsletters"):
        if unique_opens > 0:
            ctr = (unique_clicks / unique_opens) * 100
            print(
                f"      Click-through rate (CTR): {ctr:.2f}% ({unique_clicks}/{unique_opens} opens)"
            )
        return

    if total_sends > 0:
        open_rate = (unique_opens / total_sends) * 100
        click_rate = (unique_clicks / total_sends) * 100
        print(
            f"      Open rate: {open_rate:.2f}% ({unique_opens}/{total_sends} emails sent)"
        )
        print(
            f"      Click rate: {click_rate:.2f}% ({unique_clicks}/{total_sends} emails sent)"
        )
    elif unique_opens > 0 or unique_clicks > 0:
        print("      ⚠️  Note: Tracking data found but no send count available")

    if unique_opens > 0:
        ctr = (unique_clicks / unique_opens) * 100
        print(
            f"      Click-through rate (CTR): {ctr:.2f}% ({unique_clicks}/{unique_opens} opens)"
        )
    elif unique_clicks > 0:
        print(
            f"      ⚠️  Note: {unique_clicks} clicks recorded but no opens"
            " (may indicate tracking pixel issues)"
        )


def print_summary(
    category_counts: dict[str, int], category_emails: dict[str, list[str]]
) -> None:
    """Print the overall summary section."""
    print("=" * 80)
    print("📊 SUMMARY")
    print("=" * 80)

    total_unsubscribed = sum(category_counts.values())
    print(f"Total unsubscriptions across all categories: {total_unsubscribed}")
    print()

    # Find users unsubscribed from multiple categories
    user_unsubscribe_map: dict[str, list[str]] = defaultdict(list)
    for category, emails in category_emails.items():
        for email in emails:
            user_unsubscribe_map[email].append(category)

    multi_unsubscribed = {
        email: cats for email, cats in user_unsubscribe_map.items() if len(cats) > 1
    }

    if multi_unsubscribed:
        print(
            f"Users unsubscribed from multiple categories ({len(multi_unsubscribed)}):"
        )
        for email, categories in sorted(multi_unsubscribed.items()):
            print(f"   - {email}: {', '.join(categories)}")
    else:
        print("✅ No users are unsubscribed from multiple categories")
    print()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Count users unsubscribed from email categories in Firestore"
    )
    parser.add_argument(
        "--site",
        type=str,
        required=True,
        help="Site name (e.g., 'ananda', 'crystal', 'jairam')",
    )
    parser.add_argument(
        "--env",
        type=str,
        required=True,
        choices=["dev", "prod"],
        help="Environment (dev or prod)",
    )

    args = parser.parse_args()

    print(f"🔧 Loading environment for site: {args.site}, env: {args.env}")
    load_env(args.site)

    try:
        db = initialize_firestore(args.env)
        print("✅ Firestore client initialized\n")
    except Exception as e:
        print(f"❌ Failed to initialize Firestore: {e}")
        sys.exit(1)

    try:
        total_users, category_counts, category_emails = (
            count_unsubscribed_users_by_category(db, args.env)
        )
    except Exception as e:
        print(f"❌ Failed to query users: {e}")
        sys.exit(1)

    try:
        stats = get_email_tracking_stats(db, args.env)
    except Exception as e:
        print(f"⚠️  Warning: Failed to query email tracking data: {e}")
        print("   Continuing without open/click rate data...\n")
        stats = EmailStats()

    # Print report header
    print("=" * 80)
    print("📈 EMAIL SUBSCRIPTION REPORT")
    print("=" * 80)
    print(f"Total users in {args.env}_users collection: {total_users}")
    print()

    # Print report for each category
    for category, description in EMAIL_CATEGORIES.items():
        print_category_report(
            category=category,
            description=description,
            total_users=total_users,
            unsubscribed_count=category_counts.get(category, 0),
            unsubscribed_list=category_emails.get(category, []),
            stats=stats,
        )

    print_summary(category_counts, category_emails)


if __name__ == "__main__":
    main()
