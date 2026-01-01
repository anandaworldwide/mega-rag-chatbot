#!/usr/bin/env python3
"""
Update existing users in different states for re-engagement email testing.

⚠️  DEVELOPMENT ONLY - This script will NEVER run on production.

This script updates existing users in Firestore with various test configurations:
- Eligible (last activity 25 days ago, subscribed)
- Too recent (last activity 10 days ago)
- Too old (last activity 65 days ago)
- Opted out (reengagement: false)
- Already sent (campaign ID in array)
- Tests lastActivityAt vs lastLoginAt preference

Usage:
    python bin/create_test_reengagement_users.py --site ananda [--count 8]

    The script will automatically select existing users with inviteStatus='accepted'
    and update them with various test configurations.
"""

import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone

from google.cloud import firestore
from google.oauth2 import service_account

from pyutil.env_utils import load_env

CAMPAIGN_ID = "reengagement-21-nudge"
INACTIVITY_MIN_DAYS = 21
INACTIVITY_MAX_DAYS = 60


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


def create_timestamp_from_days_ago(days: int) -> datetime:
    """Create a Firestore timestamp from N days ago."""
    now = datetime.now(timezone.utc)
    delta = timedelta(days=days)
    return now - delta


def get_existing_users(db: firestore.Client, env: str, limit: int = 8):
    """Get existing users from Firestore for testing."""
    collection_name = f"{env}_users"

    # Query for accepted users (active users)
    users_ref = db.collection(collection_name)
    query = users_ref.where("inviteStatus", "==", "accepted").limit(limit)

    docs = query.stream()
    users = []
    for doc in docs:
        users.append(doc.id)  # Email is the document ID

    return users


def update_test_users(db: firestore.Client, env: str, emails: list[str]):
    """Update existing users in Firestore with various test states (DEVELOPMENT ONLY)."""
    collection_name = f"{env}_users"
    now = datetime.now(timezone.utc)

    # Define test configurations - each email gets assigned a different state
    test_configs = [
        {
            "name": "Eligible (lastActivityAt)",
            "description": "Should receive email (25 days inactive via lastActivityAt)",
            "updates": {
                "emailPreferences": {
                    "reengagement": True,
                    "onboarding": True,
                    "newsletters": True,
                },
                "reengagementEmailsSent": [],
                "lastActivityAt": create_timestamp_from_days_ago(
                    25
                ),  # Within 21-60 day window
                "lastLoginAt": create_timestamp_from_days_ago(50),  # Older login
            },
        },
        {
            "name": "Too Recent",
            "description": "Should NOT receive (10 days inactive)",
            "updates": {
                "emailPreferences": {
                    "reengagement": True,
                    "onboarding": True,
                    "newsletters": True,
                },
                "reengagementEmailsSent": [],
                "lastActivityAt": create_timestamp_from_days_ago(
                    10
                ),  # Too recent (< 21 days)
            },
        },
        {
            "name": "Too Old",
            "description": "Should NOT receive (65 days inactive)",
            "updates": {
                "emailPreferences": {
                    "reengagement": True,
                    "onboarding": True,
                    "newsletters": True,
                },
                "reengagementEmailsSent": [],
                "lastActivityAt": create_timestamp_from_days_ago(
                    65
                ),  # Too old (> 60 days)
            },
        },
        {
            "name": "Opted Out",
            "description": "Should NOT receive (reengagement: false)",
            "updates": {
                "emailPreferences": {
                    "reengagement": False,  # Opted out
                    "onboarding": True,
                    "newsletters": True,
                },
                "reengagementEmailsSent": [],
                "lastActivityAt": create_timestamp_from_days_ago(
                    25
                ),  # Would be eligible if subscribed
            },
        },
        {
            "name": "Already Sent",
            "description": "Should NOT receive (campaign already sent)",
            "updates": {
                "emailPreferences": {
                    "reengagement": True,
                    "onboarding": True,
                    "newsletters": True,
                },
                "reengagementEmailsSent": [CAMPAIGN_ID],  # Already sent this campaign
                "lastReengagementSentAt": create_timestamp_from_days_ago(5),
                "lastActivityAt": create_timestamp_from_days_ago(
                    25
                ),  # Would be eligible if not already sent
            },
        },
        {
            "name": "Fallback to lastLoginAt",
            "description": "Should receive email (uses lastLoginAt fallback, 25 days)",
            "updates": {
                "emailPreferences": {
                    "reengagement": True,
                    "onboarding": True,
                    "newsletters": True,
                },
                "reengagementEmailsSent": [],
                # No lastActivityAt - should fall back to lastLoginAt
                "lastLoginAt": create_timestamp_from_days_ago(25),
            },
        },
        {
            "name": "Exact Minimum (21 days)",
            "description": "Should receive email (exactly 21 days)",
            "updates": {
                "emailPreferences": {
                    "reengagement": True,
                    "onboarding": True,
                    "newsletters": True,
                },
                "reengagementEmailsSent": [],
                "lastActivityAt": create_timestamp_from_days_ago(
                    21
                ),  # Exactly at minimum threshold
            },
        },
        {
            "name": "Exact Maximum (60 days)",
            "description": "Should receive email (exactly 60 days)",
            "updates": {
                "emailPreferences": {
                    "reengagement": True,
                    "onboarding": True,
                    "newsletters": True,
                },
                "reengagementEmailsSent": [],
                "lastActivityAt": create_timestamp_from_days_ago(
                    60
                ),  # Exactly at maximum threshold
            },
        },
    ]

    if len(emails) < len(test_configs):
        print(
            f"⚠️  Warning: Only {len(emails)} email(s) provided, but {len(test_configs)} test configurations available."
        )
        print(
            f"   Will update {len(emails)} user(s) with first {len(emails)} configuration(s).\n"
        )

    print(
        f"\n📝 Updating {len(emails)} existing user(s) in {collection_name} collection...\n"
    )

    updated_count = 0
    skipped_count = 0

    for i, email in enumerate(emails):
        if i >= len(test_configs):
            print(f"⚠️  No more test configurations available for {email} - skipping")
            skipped_count += 1
            continue

        config = test_configs[i]
        doc_ref = db.collection(collection_name).document(email)

        # Check if user exists
        existing_doc = doc_ref.get()
        if not existing_doc.exists:
            print(f"❌ User {email} does not exist - skipping")
            skipped_count += 1
            continue

        # Get existing data to preserve fields we don't want to overwrite
        existing_data = existing_doc.to_dict() or {}
        if existing_data.get("inviteStatus") != "accepted":
            print(
                f"⚠️  User {email} has inviteStatus '{existing_data.get('inviteStatus')}' (not 'accepted') - updating anyway"
            )

        # Merge updates with existing data (preserve other fields)
        updates = config["updates"].copy()
        updates["updatedAt"] = now

        # Update the user document
        doc_ref.update(updates)
        updated_count += 1

        print(f"✅ Updated: {email}")
        print(f"   - Configuration: {config['name']}")
        print(f"   - {config['description']}")
        if "lastActivityAt" in updates:
            print(f"   - lastActivityAt: {updates['lastActivityAt']}")
        if "lastLoginAt" in updates:
            print(f"   - lastLoginAt: {updates['lastLoginAt']}")
        print(
            f"   - Re-engagement subscribed: {updates.get('emailPreferences', {}).get('reengagement')}"
        )
        print(
            f"   - Already sent: {CAMPAIGN_ID in updates.get('reengagementEmailsSent', [])}"
        )
        print()

    print("=" * 80)
    print("SUMMARY")
    print("=" * 80)
    print(f"\nUpdated: {updated_count} user(s)")
    print(f"Skipped: {skipped_count} user(s)")
    print("\nTest configurations applied:")
    for i, config in enumerate(test_configs[: len(emails)]):
        if i < len(emails):
            print(f"  {i + 1}. {emails[i]}: {config['name']} - {config['description']}")
    print("\nRun the cron job to verify these users are processed correctly.")
    print()


def main():
    parser = argparse.ArgumentParser(
        description="Update existing users for re-engagement email testing (DEVELOPMENT ONLY)"
    )
    parser.add_argument(
        "--site",
        required=True,
        help="Site identifier (e.g., 'ananda', 'jairam')",
    )
    parser.add_argument(
        "--count",
        type=int,
        default=8,
        help="Number of users to update (default: 8, max: 8)",
    )

    args = parser.parse_args()

    if args.count < 1:
        print("❌ Error: --count must be at least 1", file=sys.stderr)
        sys.exit(1)

    if args.count > 8:
        print(
            f"⚠️  Warning: --count {args.count} exceeds maximum of 8 test configurations.",
            file=sys.stderr,
        )
        print("   Will use 8 users instead.", file=sys.stderr)
        args.count = 8

    # HARDCODE: This script is for development only
    ENV = "dev"

    # Safety check: Prevent accidental production runs
    # Check if GOOGLE_APPLICATION_CREDENTIALS points to production
    credentials_json = os.getenv("GOOGLE_APPLICATION_CREDENTIALS", "")
    if credentials_json:
        try:
            credentials_dict = json.loads(credentials_json)
            project_id = credentials_dict.get("project_id", "").lower()

            # Block if project ID suggests production
            if "prod" in project_id or "production" in project_id:
                print("=" * 80, file=sys.stderr)
                print("❌ SAFETY CHECK FAILED", file=sys.stderr)
                print("=" * 80, file=sys.stderr)
                print("\nThis script is for DEVELOPMENT ONLY.", file=sys.stderr)
                print(
                    f"Detected production-like project ID: {project_id}",
                    file=sys.stderr,
                )
                print(
                    "\nTo prevent accidental data corruption, this script will not run.",
                    file=sys.stderr,
                )
                print(
                    "If you really need to run this, modify the script to remove this check.",
                    file=sys.stderr,
                )
                sys.exit(1)
        except (json.JSONDecodeError, KeyError):
            # If we can't parse credentials, allow but warn
            print(
                "⚠️  Warning: Could not verify project ID from credentials",
                file=sys.stderr,
            )
            print("   Proceeding with caution...", file=sys.stderr)

    print("=" * 80)
    print("⚠️  DEVELOPMENT MODE ONLY")
    print("=" * 80)
    print(f"\nThis script will update existing users in the '{ENV}' environment.")
    print("It is designed for development/testing purposes only.\n")

    # Load environment
    try:
        load_env(args.site)
    except FileNotFoundError as e:
        print(f"❌ {e}", file=sys.stderr)
        sys.exit(1)

    # Initialize Firestore
    try:
        db = initialize_firestore(ENV)
    except Exception as e:
        print(f"❌ Failed to initialize Firestore: {e}", file=sys.stderr)
        sys.exit(1)

    # Get existing users
    try:
        existing_users = get_existing_users(db, ENV, limit=args.count)
    except Exception as e:
        print(f"❌ Failed to query existing users: {e}", file=sys.stderr)
        sys.exit(1)

    if len(existing_users) == 0:
        print("❌ No users found with inviteStatus='accepted'", file=sys.stderr)
        print("   Cannot update test users.", file=sys.stderr)
        sys.exit(1)

    if len(existing_users) < args.count:
        print(
            f"⚠️  Warning: Only {len(existing_users)} user(s) found, but {args.count} requested.",
            file=sys.stderr,
        )
        print(f"   Will update {len(existing_users)} user(s).\n", file=sys.stderr)

    emails = existing_users[: args.count]
    print(f"Selected {len(emails)} user(s) to update:")
    for i, email in enumerate(emails, 1):
        print(f"  {i}. {email}")
    print()

    try:
        update_test_users(db, ENV, emails)
    except Exception as e:
        print(f"❌ Error updating test users: {e}", file=sys.stderr)
        import traceback

        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
