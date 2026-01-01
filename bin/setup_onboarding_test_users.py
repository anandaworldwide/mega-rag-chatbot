#!/usr/bin/env python3
"""
Set up test users for onboarding email system development testing.

This script selects 6 existing non-admin users from Firestore and updates their
settings to be test users with different onboarding states.

Usage:
    python setup_onboarding_test_users.py --site ananda
"""

import argparse
import json
import os
import random
import sys
from datetime import datetime, timedelta, timezone

from dotenv import load_dotenv
from google.cloud import firestore
from google.oauth2 import service_account


def load_env(site_id: str) -> None:
    """
    Load environment variables from a site-specific .env file.
    Searches up to 3 directories up from current directory.

    Args:
        site_id: Identifier for the site (e.g., 'ananda', 'crystal')

    Raises:
        FileNotFoundError: If no .env.[site_id] file is found
    """
    current_dir = os.getcwd()

    for _ in range(4):
        env_path = os.path.join(current_dir, f".env.{site_id}")
        if os.path.exists(env_path):
            load_dotenv(env_path)
            print(f"Loaded environment from: {env_path}")
            return
        current_dir = os.path.dirname(current_dir)

    raise FileNotFoundError(
        f"Environment file .env.{site_id} not found in the current directory or up to three levels up"
    )


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


def get_eligible_users(db, env_prefix: str):
    """Get all non-admin users from the users collection.

    Args:
        db: Firestore client
        env_prefix: Environment prefix ('dev' or 'prod')
    """
    try:
        collection_name = f"{env_prefix}_users"
        users_ref = db.collection(collection_name)
        all_users = users_ref.stream()

        eligible_users = []
        for user_doc in all_users:
            user_data = user_doc.to_dict()
            email = user_doc.id

            # Skip admins and superusers
            role = user_data.get("role", "").lower()
            if role in ["admin", "superuser"]:
                continue

            # Only include users with accepted invite status
            invite_status = user_data.get("inviteStatus", "")
            if invite_status != "accepted":
                continue

            eligible_users.append({"email": email, "data": user_data})

        return eligible_users
    except Exception as e:
        print(f"❌ Failed to query users: {e}")
        sys.exit(1)


def update_test_users(db, selected_users, env_prefix: str):
    """Update selected users with test onboarding configurations.

    Args:
        db: Firestore client
        selected_users: List of selected user dictionaries
        env_prefix: Environment prefix ('dev' or 'prod')
    """

    # Define test configurations
    # Note: onboardingCompleted must be explicitly set to False because Firestore's
    # "!= true" query only returns documents where the field EXISTS
    test_configs = [
        {
            "updates": {
                "emailPreferences": {"newsletters": True, "onboarding": True},
                "inviteStatus": "accepted",
                "onboardingCompleted": False,
            },
            "set_timestamp": False,
            "set_created_at": True,
            "created_at_days_ago": 0,  # Brand new user - triggers day 0 email
            "remove_fields": ["onboardingStartedAt", "onboardingEmailsSent"],
            "description": "New user (no onboarding started) - will trigger day 0",
        },
        {
            "updates": {
                "emailPreferences": {"newsletters": True, "onboarding": True},
                "inviteStatus": "accepted",
                "onboardingCompleted": False,
                "onboardingEmailsSent": [0],
            },
            "set_timestamp": True,
            "days_ago": 3,  # Set onboardingStartedAt to 3 days ago
            "remove_fields": [],
            "description": "Day 0 sent, ready for day 3",
        },
        {
            "updates": {
                "emailPreferences": {"newsletters": True, "onboarding": False},
                "inviteStatus": "accepted",
                "onboardingCompleted": False,
                "onboardingEmailsSent": [0, 3],
            },
            "set_timestamp": True,
            "days_ago": 7,  # Set onboardingStartedAt to 7 days ago (would be due for day 7)
            "remove_fields": [],
            "description": "Opted out of onboarding emails (would be due for day 7)",
        },
        {
            "updates": {
                "emailPreferences": {"newsletters": True, "onboarding": True},
                "inviteStatus": "accepted",
                "onboardingCompleted": False,
                "onboardingEmailsSent": [0, 3],  # Day 0 & 3 sent
            },
            "set_timestamp": True,
            "days_ago": 7,  # Set onboardingStartedAt to 7 days ago
            "remove_fields": [],
            "description": "Day 0 & 3 sent, ready for day 7",
        },
        {
            "updates": {
                "emailPreferences": {"newsletters": True, "onboarding": True},
                "inviteStatus": "accepted",
                "onboardingCompleted": False,
                "onboardingEmailsSent": [0, 3, 7],  # Day 0, 3 & 7 sent
            },
            "set_timestamp": True,
            "days_ago": 14,  # Set onboardingStartedAt to 14 days ago
            "remove_fields": [],
            "description": "Day 0, 3 & 7 sent, ready for day 14",
        },
        {
            "updates": {
                "emailPreferences": {"newsletters": True, "onboarding": True},
                "inviteStatus": "accepted",
                "onboardingCompleted": False,
            },
            "set_timestamp": False,
            "set_created_at": True,
            "created_at_days_ago": 7,  # User has been a member for 7 days
            "remove_fields": ["onboardingStartedAt", "onboardingEmailsSent"],
            "description": "Existing user (7 days old) - feature rollout test (should skip day 0 & 3, get day 7 immediately)",
        },
    ]

    updated_users = []

    for i, user in enumerate(selected_users):
        email = user["email"]
        config = test_configs[i]

        try:
            collection_name = f"{env_prefix}_users"
            doc_ref = db.collection(collection_name).document(email)

            # Get current data to show what changed
            current_doc = doc_ref.get()
            current_data = current_doc.to_dict() if current_doc.exists else {}

            # Prepare updates
            updates = config["updates"].copy()

            # Handle onboardingStartedAt timestamp (set to specified days ago if needed)
            if config.get("set_timestamp"):
                days_ago = config.get("days_ago", 3)
                timestamp_date = datetime.now(timezone.utc) - timedelta(days=days_ago)
                # Firestore accepts Python datetime objects directly
                updates["onboardingStartedAt"] = timestamp_date

            # Handle createdAt timestamp (for existing user simulation)
            if config.get("set_created_at"):
                days_ago = config.get("created_at_days_ago", 6)
                created_at_date = datetime.now(timezone.utc) - timedelta(days=days_ago)
                updates["createdAt"] = created_at_date

            # Apply updates
            doc_ref.update(updates)

            # Remove fields that shouldn't be present
            for field in config["remove_fields"]:
                doc_ref.update({field: firestore.DELETE_FIELD})

            user_info = {
                "email": email,
                "description": config["description"],
                "updates": updates,
                "removed_fields": config["remove_fields"],
                "days_ago": config.get("days_ago"),
                "previous_data": {
                    "emailPreferences": current_data.get("emailPreferences", {}),
                    "onboardingStartedAt": current_data.get("onboardingStartedAt"),
                    "onboardingEmailsSent": current_data.get(
                        "onboardingEmailsSent", []
                    ),
                },
            }
            # Add createdAt info if set
            if config.get("set_created_at"):
                user_info["updates"]["_created_at_days_ago"] = config.get(
                    "created_at_days_ago"
                )

            updated_users.append(user_info)

        except Exception as e:
            print(f"❌ Failed to update {email}: {e}")
            print()

    return updated_users


def main():
    """Main execution function."""
    parser = argparse.ArgumentParser(
        description="Set up test users for onboarding email system development testing"
    )
    parser.add_argument(
        "--site",
        required=True,
        help="Site ID for environment variables (e.g., 'ananda', 'crystal')",
    )
    args = parser.parse_args()

    # Hard-wired to development environment
    env_prefix = "dev"

    print("📧 Onboarding Email Test User Setup\n")

    # Load environment variables
    try:
        load_env(args.site)
    except FileNotFoundError as e:
        print(f"❌ {e}")
        sys.exit(1)

    # Initialize Firestore
    try:
        db = initialize_firestore(env_prefix)
    except (ValueError, RuntimeError) as e:
        print(f"❌ {e}")
        sys.exit(1)

    # Get eligible users
    collection_name = f"{env_prefix}_users"
    print(
        f"🔍 Finding eligible users (non-admin, accepted invite status) in '{collection_name}'..."
    )
    eligible_users = get_eligible_users(db, env_prefix)
    print(f"   Found {len(eligible_users)} eligible users\n")

    if len(eligible_users) < 6:
        print(
            f"❌ Not enough eligible users found. Need at least 6, found {len(eligible_users)}"
        )
        sys.exit(1)

    # Randomly select 6 users
    selected_users = random.sample(eligible_users, 6)
    print("🎲 Randomly selected 6 users:")
    for user in selected_users:
        print(f"   • {user['email']}")
    print()

    # Update users with test configurations
    print("🚀 Updating users with test configurations...\n")
    updated_users = update_test_users(db, selected_users, env_prefix)

    # Print summary
    print("✅ Updated Users:\n")
    for user in updated_users:
        print(f"📧 {user['email']}")
        print(f"   {user['description']}")
        print(
            f"   Previous onboarding: {user['previous_data']['emailPreferences'].get('onboarding', 'Not set')}"
        )
        print(
            f"   New onboarding: {user['updates']['emailPreferences'].get('onboarding')}"
        )
        if user.get("days_ago") is not None:
            print(f"   Onboarding started: {user['days_ago']} days ago")
        if user["updates"].get("_created_at_days_ago"):
            created_at_days = user["updates"]["_created_at_days_ago"]
            print(
                f"   Account created: {created_at_days} days ago (simulating existing user)"
            )
            print(
                "   Expected behavior: Day 0 & 3 will be skipped, day 7 will be sent when reached"
            )
        if "onboardingEmailsSent" in user["updates"]:
            print(f"   Emails sent: {user['updates']['onboardingEmailsSent']}")
        if user["removed_fields"]:
            print(f"   Removed fields: {', '.join(user['removed_fields'])}")
        print()

    print("🎯 Summary:")
    print(f"   Updated {len(updated_users)} users in '{collection_name}' collection")
    print("\n💡 Next Steps:")
    print(
        "   1. Run the cron job: curl -X POST http://localhost:3000/api/cron/processOnboardingEmails \\"
    )
    print(
        "      -H 'User-Agent: vercel-cron/1.0' -H 'Authorization: Bearer $CRON_SECRET'"
    )
    print("   2. Check your email for onboarding messages")
    print("   3. Test different user states by modifying their documents")


if __name__ == "__main__":
    main()
