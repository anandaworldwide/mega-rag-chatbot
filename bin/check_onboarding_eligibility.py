#!/usr/bin/env python3
"""
Check production Firestore for users eligible for onboarding emails.

This script verifies the eligibility criteria used by the cron job and provides
detailed statistics about why users are or aren't eligible.

Usage:
    python bin/check_onboarding_eligibility.py --site ananda --env prod
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from typing import Any

from google.cloud import firestore
from google.cloud.firestore_v1.base_query import FieldFilter
from google.oauth2 import service_account

from pyutil.env_utils import load_env

# Onboarding email days (matches cron job)
ONBOARDING_DAYS = [0, 3, 7, 14]


def initialize_firestore(env_prefix: str):
    """Initialize Firestore client using service account credentials from environment.

    Args:
        env_prefix (str): Environment prefix ('dev' or 'prod')

    Returns:
        firestore.Client: Initialized Firestore client

    Raises:
        ValueError: If credentials are missing or invalid
        RuntimeError: If Firestore client initialization fails
    """
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


def timestamp_to_millis(timestamp: Any) -> int:
    """Convert Firestore timestamp to milliseconds."""
    if not timestamp:
        return 0
    # Python Firestore SDK returns datetime objects
    if isinstance(timestamp, datetime):
        return int(timestamp.timestamp() * 1000)
    # TypeScript-style Firestore timestamps
    if hasattr(timestamp, "toMillis"):
        return timestamp.toMillis()
    if hasattr(timestamp, "_seconds"):
        return timestamp._seconds * 1000
    return int(timestamp) * 1000 if isinstance(timestamp, int | float) else 0


def days_since(timestamp: Any) -> int:
    """Calculate days since a timestamp."""
    if not timestamp:
        return 0
    ts_millis = timestamp_to_millis(timestamp)
    now_millis = datetime.now(timezone.utc).timestamp() * 1000
    diff_ms = now_millis - ts_millis
    return max(0, int(diff_ms / (1000 * 60 * 60 * 24)))


def is_subscribed_to_onboarding(user_data: dict[str, Any]) -> bool:
    """Check if user is subscribed to onboarding emails (matches TypeScript logic)."""
    # Check new emailPreferences first
    email_prefs = user_data.get("emailPreferences", {})
    if "onboarding" in email_prefs:
        return email_prefs["onboarding"] is not False

    # Default: subscribed (new users get all categories ON by default)
    return True


def get_next_email_day(days_since_start: int, emails_sent: list[int]) -> int | None:
    """Determine which onboarding email should be sent (matches cron job logic)."""
    # Find the highest eligible email day that hasn't been sent yet
    # Iterate backwards to find the most recent one first
    for i in range(len(ONBOARDING_DAYS) - 1, -1, -1):
        day = ONBOARDING_DAYS[i]
        if days_since_start >= day and day not in emails_sent:
            return day
    return None


def _print_results(
    users: list[Any],
    eligible_users: list[dict[str, Any]],
    not_subscribed: list[dict[str, Any]],
    no_timestamp: list[dict[str, Any]],
    completed: list[dict[str, Any]],
    past_window: list[dict[str, Any]],
    no_email_needed: list[dict[str, Any]],
    other_reasons: list[dict[str, Any]],
    verbose: bool,
) -> None:
    """Print analysis results."""
    # Print summary statistics
    print("=" * 80)
    print("SUMMARY STATISTICS")
    print("=" * 80)
    print(f"\nTotal users matching initial query: {len(users)}")
    print(f"\n✅ Eligible for onboarding email: {len(eligible_users)}")
    print(f"❌ Not subscribed to onboarding: {len(not_subscribed)}")
    print(f"⏰ No timestamp (onboardingStartedAt/createdAt): {len(no_timestamp)}")
    print(f"✅ Onboarding completed: {len(completed)}")
    print(f"⏭️  Past onboarding window (>14 days): {len(past_window)}")
    print(f"⏸️  No email needed at this time: {len(no_email_needed)}")
    print(f"❓ Other reasons: {len(other_reasons)}")

    # Print eligible users
    if eligible_users:
        print("\n" + "=" * 80)
        print(f"ELIGIBLE USERS ({len(eligible_users)})")
        print("=" * 80)
        for analysis in eligible_users:
            print(f"\n📧 {analysis['email']}")
            print(f"   Days since start: {analysis['days_since_start']}")
            print(f"   Emails sent: {analysis['emails_sent']}")
            print(f"   Next email: Day {analysis['next_email_day']}")
            if verbose and analysis["onboarding_started_at"]:
                ts_str = str(analysis["onboarding_started_at"])
                print(f"   Onboarding started at: {ts_str}")

    # Print detailed breakdown if verbose
    if verbose:
        if not_subscribed:
            print("\n" + "=" * 80)
            print(f"NOT SUBSCRIBED ({len(not_subscribed)})")
            print("=" * 80)
            for analysis in not_subscribed[:10]:  # Limit to 10
                print(f"  - {analysis['email']}")

        if no_timestamp:
            print("\n" + "=" * 80)
            print(f"NO TIMESTAMP ({len(no_timestamp)})")
            print("=" * 80)
            for analysis in no_timestamp[:10]:  # Limit to 10
                print(f"  - {analysis['email']}")

        if completed:
            print("\n" + "=" * 80)
            print(f"COMPLETED ({len(completed)})")
            print("=" * 80)
            for analysis in completed[:10]:  # Limit to 10
                print(f"  - {analysis['email']}: {analysis['reasons'][0]}")

        if no_email_needed:
            print("\n" + "=" * 80)
            print(f"NO EMAIL NEEDED ({len(no_email_needed)})")
            print("=" * 80)
            for analysis in no_email_needed[:10]:  # Limit to 10
                print(f"  - {analysis['email']}: {analysis['reasons'][0]}")

    # Final verdict
    print("\n" + "=" * 80)
    print("VERDICT")
    print("=" * 80)
    if len(eligible_users) == 0:
        print(
            "\n✅ The cron job was CORRECT - no users are eligible for onboarding emails."
        )
    else:
        print(
            f"\n⚠️  The cron job was INCORRECT - {len(eligible_users)} user(s) are eligible for onboarding emails!"
        )
        print("\nEligible users:")
        for analysis in eligible_users:
            print(
                f"  - {analysis['email']} (should receive day {analysis['next_email_day']} email)"
            )

    print()


def categorize_analysis(analysis: dict[str, Any]) -> str:
    """Categorize an analysis result into a category name."""
    if analysis["eligible"]:
        return "eligible"
    if "Not subscribed" in str(analysis["reasons"]):
        return "not_subscribed"
    if "No onboardingStartedAt" in str(analysis["reasons"]):
        return "no_timestamp"
    if "completed" in str(analysis["reasons"]).lower():
        return "completed"
    if "Past onboarding window" in str(analysis["reasons"]):
        return "past_window"
    if "No email to send" in str(analysis["reasons"]):
        return "no_email_needed"
    return "other"


def analyze_user(
    user_email: str, user_data: dict[str, Any], doc_create_time: Any
) -> dict[str, Any]:
    """Analyze a single user's eligibility for onboarding emails."""
    analysis = {
        "email": user_email,
        "eligible": False,
        "reasons": [],
        "days_since_start": 0,
        "onboarding_started_at": None,
        "emails_sent": [],
        "next_email_day": None,
        "subscribed": False,
    }

    # Check subscription status
    analysis["subscribed"] = is_subscribed_to_onboarding(user_data)
    if not analysis["subscribed"]:
        analysis["reasons"].append("Not subscribed to onboarding emails")
        return analysis

    # Get onboarding start date
    onboarding_started_at = user_data.get("onboardingStartedAt")
    if not onboarding_started_at:
        # For users without onboardingStartedAt, use createdAt
        # This matches the cron job logic for existing users
        created_at = user_data.get("createdAt") or doc_create_time
        if created_at:
            analysis["onboarding_started_at"] = created_at
            days_since_creation = days_since(created_at)
            analysis["days_since_start"] = days_since_creation

            # Mark earlier emails as "sent" if user has been a member long enough
            # This prevents spamming users with retroactive emails (matches cron job logic)
            emails_to_mark_as_sent = []
            for day in ONBOARDING_DAYS:
                if days_since_creation > day:
                    emails_to_mark_as_sent.append(day)

            # Use the calculated emails (combining with any already marked)
            existing_emails_sent = user_data.get("onboardingEmailsSent", [])
            analysis["emails_sent"] = sorted(
                list(set(existing_emails_sent + emails_to_mark_as_sent))
            )
        else:
            analysis["reasons"].append("No onboardingStartedAt or createdAt timestamp")
            return analysis
    else:
        analysis["onboarding_started_at"] = onboarding_started_at
        analysis["days_since_start"] = days_since(onboarding_started_at)
        # Get emails already sent
        analysis["emails_sent"] = user_data.get("onboardingEmailsSent", [])

    # Check if onboarding should be marked as completed
    if analysis["days_since_start"] >= 14 and len(analysis["emails_sent"]) >= len(
        ONBOARDING_DAYS
    ):
        analysis["reasons"].append(
            f"Onboarding completed (day {analysis['days_since_start']}, all {len(ONBOARDING_DAYS)} emails sent)"
        )
        return analysis

    # Users past day 14 shouldn't receive emails (onboarding window has passed)
    if analysis["days_since_start"] > 14:
        analysis["reasons"].append(
            f"Past onboarding window (day {analysis['days_since_start']} > 14, emails sent: {analysis['emails_sent']})"
        )
        return analysis

    # Determine which email to send
    next_day = get_next_email_day(analysis["days_since_start"], analysis["emails_sent"])
    if next_day is None:
        analysis["reasons"].append(
            f"No email to send (day {analysis['days_since_start']}, emails sent: {analysis['emails_sent']})"
        )
        return analysis

    analysis["next_email_day"] = next_day
    analysis["eligible"] = True
    return analysis


def _check_specific_user(db: Any, env: str, email: str) -> None:
    """Look up a specific user and display all relevant onboarding fields."""
    collection_name = f"{env}_users"
    print(f"\n🔍 Looking up user: {email}")
    print(f"   Collection: {collection_name}\n")

    doc_ref = db.collection(collection_name).document(email)
    doc = doc_ref.get()

    if not doc.exists:
        print(f"❌ User '{email}' NOT FOUND in {collection_name}")
        print("\n   Possible reasons:")
        print("   - Email address is incorrect")
        print("   - User hasn't completed signup/activation yet")
        print("   - User is in a different environment (dev vs prod)")
        return

    user_data = doc.to_dict()
    if not user_data:
        print(f"❌ User '{email}' exists but has no data")
        return

    print("=" * 80)
    print("USER RECORD")
    print("=" * 80)

    # Show all relevant fields
    invite_status = user_data.get("inviteStatus")
    onboarding_completed = user_data.get("onboardingCompleted")
    onboarding_started_at = user_data.get("onboardingStartedAt")
    onboarding_emails_sent = user_data.get("onboardingEmailsSent", [])
    created_at = user_data.get("createdAt")
    email_prefs = user_data.get("emailPreferences", {})
    role = user_data.get("role")

    print(f"\n📧 Email: {email}")
    print(f"   Role: {role}")
    print("\n🔑 Query Criteria Fields:")
    print(f"   inviteStatus: {invite_status!r}")
    print(f"   onboardingCompleted: {onboarding_completed!r}")

    print("\n📅 Timing Fields:")
    print(f"   createdAt: {created_at}")
    print(f"   onboardingStartedAt: {onboarding_started_at}")
    if created_at:
        print(f"   Days since createdAt: {days_since(created_at)}")
    if onboarding_started_at:
        print(f"   Days since onboardingStartedAt: {days_since(onboarding_started_at)}")

    print("\n📬 Email Tracking:")
    print(f"   onboardingEmailsSent: {onboarding_emails_sent}")
    print(f"   emailPreferences: {email_prefs}")

    # Determine eligibility
    print("\n" + "=" * 80)
    print("ELIGIBILITY ANALYSIS")
    print("=" * 80)

    issues = []

    # Check query criteria
    if invite_status != "accepted":
        issues.append(f"❌ inviteStatus is '{invite_status}' (needs to be 'accepted')")
    else:
        print("✅ inviteStatus == 'accepted'")

    if onboarding_completed is True:
        issues.append("❌ onboardingCompleted is True (already completed)")
    else:
        print("✅ onboardingCompleted != True")

    # Check subscription
    if not is_subscribed_to_onboarding(user_data):
        issues.append("❌ User not subscribed to onboarding emails")
    else:
        print("✅ Subscribed to onboarding emails")

    # Check timing and determine next email
    if not issues:
        analysis = analyze_user(email, user_data, doc.create_time)
        if analysis["eligible"]:
            print(f"✅ Eligible for day {analysis['next_email_day']} email")
            print(f"   Days since start: {analysis['days_since_start']}")
            print(f"   Emails sent: {analysis['emails_sent']}")
        else:
            for reason in analysis["reasons"]:
                issues.append(f"❌ {reason}")

    if issues:
        print("\n🚫 NOT ELIGIBLE - Issues found:")
        for issue in issues:
            print(f"   {issue}")
    else:
        print("\n✅ USER IS ELIGIBLE for onboarding emails!")

    print()


def _query_users(db: Any, env: str, limit: int | None) -> list[Any]:
    """Query users matching initial criteria."""
    collection_name = f"{env}_users"
    print(f"\n📊 Querying {collection_name} collection...")
    print("   Criteria: inviteStatus == 'accepted' AND onboardingCompleted != true\n")

    # Query accepted users (Firestore Python SDK doesn't support != queries well)
    users_query = db.collection(collection_name).where(
        filter=FieldFilter("inviteStatus", "==", "accepted")
    )

    if limit:
        users_query = users_query.limit(limit)

    users_snapshot = users_query.stream()
    all_users = list(users_snapshot)

    # Filter in Python: onboardingCompleted != true (includes False, None, or missing field)
    users = []
    for doc in all_users:
        user_dict = doc.to_dict()
        if user_dict and user_dict.get("onboardingCompleted") is not True:
            users.append(doc)

    completed_count = len(all_users) - len(users)
    if completed_count > 0:
        print(
            f"   Filtered out {completed_count} user(s) with onboardingCompleted == true"
        )

    return users


def _analyze_users(users: list[Any]) -> dict[str, list[dict[str, Any]]]:
    """Analyze all users and categorize them."""
    categories: dict[str, list[dict[str, Any]]] = {
        "eligible": [],
        "not_subscribed": [],
        "no_timestamp": [],
        "completed": [],
        "past_window": [],
        "no_email_needed": [],
        "other": [],
    }

    for doc in users:
        user_email = doc.id
        user_data = doc.to_dict()
        if not user_data:
            continue
        doc_create_time = doc.create_time

        analysis = analyze_user(user_email, user_data, doc_create_time)
        category = categorize_analysis(analysis)
        categories[category].append(analysis)

    return categories


def main():
    parser = argparse.ArgumentParser(
        description="Check production Firestore for users eligible for onboarding emails"
    )
    parser.add_argument(
        "--site",
        required=True,
        help="Site identifier (e.g., 'ananda', 'crystal')",
    )
    parser.add_argument(
        "--env",
        required=True,
        choices=["dev", "prod"],
        help="Environment (dev or prod)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Limit number of users to analyze (for testing)",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Show detailed information for each user",
    )
    parser.add_argument(
        "--email",
        type=str,
        default=None,
        help="Check a specific user by email address",
    )

    args = parser.parse_args()

    # Load environment
    try:
        load_env(args.site)
    except FileNotFoundError as e:
        print(f"❌ {e}", file=sys.stderr)
        sys.exit(1)

    # Initialize Firestore
    try:
        db = initialize_firestore(args.env)
    except Exception as e:
        print(f"❌ Failed to initialize Firestore: {e}", file=sys.stderr)
        sys.exit(1)

    try:
        # If checking a specific user, look them up directly
        if args.email:
            _check_specific_user(db, args.env, args.email)
            return

        users = _query_users(db, args.env, args.limit)

        if not users:
            print("\n✅ No users match the initial query criteria.")
            print("   This matches what the cron job reported.")
            return

        print(f"\n📋 Found {len(users)} users matching initial criteria\n")

        categories = _analyze_users(users)

        _print_results(
            users,
            categories["eligible"],
            categories["not_subscribed"],
            categories["no_timestamp"],
            categories["completed"],
            categories["past_window"],
            categories["no_email_needed"],
            categories["other"],
            args.verbose,
        )

    except Exception as e:
        print(f"❌ Error querying Firestore: {e}", file=sys.stderr)
        import traceback

        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
