#!/usr/bin/env python3
"""
Create test users in different states for re-engagement email testing.

⚠️  DEVELOPMENT ONLY - This script will NEVER run on production.

This script creates test users in Firestore with various configurations:
- Eligible (last login 25 days ago, subscribed)
- Too recent (last login 10 days ago)
- Too old (last login 45 days ago)
- Opted out (reengagement: false)
- Already sent (campaign ID in array)

Usage:
    python bin/create_test_reengagement_users.py --site ananda
"""

import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone

from google.cloud import firestore
from google.oauth2 import service_account

from pyutil.env_utils import load_env

CAMPAIGN_ID = "reengagement-21-30-nudge"
INACTIVITY_MIN_DAYS = 21
INACTIVITY_MAX_DAYS = 30


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


def create_test_users(db: firestore.Client, env: str, site: str):
    """Create test users in Firestore (DEVELOPMENT ONLY)."""
    """Create test users in various states for re-engagement email testing."""
    collection_name = f"{env}_users"
    now = datetime.now(timezone.utc)

    test_users = [
        {
            "email": f"reengagement-test-eligible@{site}.test",
            "firstName": "Eligible",
            "lastName": "User",
            "inviteStatus": "accepted",
            "emailPreferences": {
                "reengagement": True,
                "onboarding": True,
                "newsletters": True,
            },
            "reengagementEmailsSent": [],
            "lastLoginAt": create_timestamp_from_days_ago(
                25
            ),  # Within 21-30 day window
            "createdAt": create_timestamp_from_days_ago(100),
            "role": "user",
        },
        {
            "email": f"reengagement-test-too-recent@{site}.test",
            "firstName": "Too",
            "lastName": "Recent",
            "inviteStatus": "accepted",
            "emailPreferences": {
                "reengagement": True,
                "onboarding": True,
                "newsletters": True,
            },
            "reengagementEmailsSent": [],
            "lastLoginAt": create_timestamp_from_days_ago(10),  # Too recent (< 21 days)
            "createdAt": create_timestamp_from_days_ago(100),
            "role": "user",
        },
        {
            "email": f"reengagement-test-too-old@{site}.test",
            "firstName": "Too",
            "lastName": "Old",
            "inviteStatus": "accepted",
            "emailPreferences": {
                "reengagement": True,
                "onboarding": True,
                "newsletters": True,
            },
            "reengagementEmailsSent": [],
            "lastLoginAt": create_timestamp_from_days_ago(45),  # Too old (> 30 days)
            "createdAt": create_timestamp_from_days_ago(100),
            "role": "user",
        },
        {
            "email": f"reengagement-test-opted-out@{site}.test",
            "firstName": "Opted",
            "lastName": "Out",
            "inviteStatus": "accepted",
            "emailPreferences": {
                "reengagement": False,  # Opted out
                "onboarding": True,
                "newsletters": True,
            },
            "reengagementEmailsSent": [],
            "lastLoginAt": create_timestamp_from_days_ago(
                25
            ),  # Would be eligible if subscribed
            "createdAt": create_timestamp_from_days_ago(100),
            "role": "user",
        },
        {
            "email": f"reengagement-test-already-sent@{site}.test",
            "firstName": "Already",
            "lastName": "Sent",
            "inviteStatus": "accepted",
            "emailPreferences": {
                "reengagement": True,
                "onboarding": True,
                "newsletters": True,
            },
            "reengagementEmailsSent": [CAMPAIGN_ID],  # Already sent this campaign
            "lastReengagementSentAt": create_timestamp_from_days_ago(5),
            "lastLoginAt": create_timestamp_from_days_ago(
                25
            ),  # Would be eligible if not already sent
            "createdAt": create_timestamp_from_days_ago(100),
            "role": "user",
        },
        {
            "email": f"reengagement-test-exact-21@{site}.test",
            "firstName": "Exact",
            "lastName": "TwentyOne",
            "inviteStatus": "accepted",
            "emailPreferences": {
                "reengagement": True,
                "onboarding": True,
                "newsletters": True,
            },
            "reengagementEmailsSent": [],
            "lastLoginAt": create_timestamp_from_days_ago(
                21
            ),  # Exactly at minimum threshold
            "createdAt": create_timestamp_from_days_ago(100),
            "role": "user",
        },
        {
            "email": f"reengagement-test-exact-30@{site}.test",
            "firstName": "Exact",
            "lastName": "Thirty",
            "inviteStatus": "accepted",
            "emailPreferences": {
                "reengagement": True,
                "onboarding": True,
                "newsletters": True,
            },
            "reengagementEmailsSent": [],
            "lastLoginAt": create_timestamp_from_days_ago(
                30
            ),  # Exactly at maximum threshold
            "createdAt": create_timestamp_from_days_ago(100),
            "role": "user",
        },
    ]

    print(
        f"\n📝 Creating {len(test_users)} test users in {collection_name} collection...\n"
    )

    for user_data in test_users:
        email = user_data.pop("email")
        doc_ref = db.collection(collection_name).document(email)

        # Check if user already exists
        existing_doc = doc_ref.get()
        if existing_doc.exists:
            print(f"⚠️  User {email} already exists - skipping")
            continue

        # Add updatedAt timestamp
        user_data["updatedAt"] = now

        # Create the user document
        doc_ref.set(user_data)
        print(f"✅ Created: {email}")
        print(f"   - Name: {user_data.get('firstName')} {user_data.get('lastName')}")
        print(f"   - Last login: {user_data.get('lastLoginAt')}")
        print(
            f"   - Re-engagement subscribed: {user_data.get('emailPreferences', {}).get('reengagement')}"
        )
        print(
            f"   - Already sent: {CAMPAIGN_ID in user_data.get('reengagementEmailsSent', [])}"
        )
        print()

    print("=" * 80)
    print("SUMMARY")
    print("=" * 80)
    print("\nTest users created:")
    print("  ✅ reengagement-test-eligible - Should receive email (25 days inactive)")
    print("  ❌ reengagement-test-too-recent - Should NOT receive (10 days inactive)")
    print("  ❌ reengagement-test-too-old - Should NOT receive (45 days inactive)")
    print("  ❌ reengagement-test-opted-out - Should NOT receive (opted out)")
    print("  ❌ reengagement-test-already-sent - Should NOT receive (already sent)")
    print("  ✅ reengagement-test-exact-21 - Should receive email (exactly 21 days)")
    print("  ✅ reengagement-test-exact-30 - Should receive email (exactly 30 days)")
    print("\nRun the cron job to verify these users are processed correctly.")
    print()


def main():
    parser = argparse.ArgumentParser(
        description="Create test users for re-engagement email testing (DEVELOPMENT ONLY)"
    )
    parser.add_argument(
        "--site",
        required=True,
        help="Site identifier (e.g., 'ananda', 'jairam')",
    )

    args = parser.parse_args()

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
    print(f"\nThis script will create test users in the '{ENV}' environment.")
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

    try:
        create_test_users(db, ENV, args.site)
    except Exception as e:
        print(f"❌ Error creating test users: {e}", file=sys.stderr)
        import traceback

        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
