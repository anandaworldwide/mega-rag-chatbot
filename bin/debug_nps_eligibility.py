#!/usr/bin/env python
"""
Debug script to check NPS survey eligibility for a specific user in development environment.
Usage: python bin/debug_nps_eligibility.py <email>
"""

import json
import os
import sys
from datetime import datetime, timezone

from google.cloud import firestore
from google.oauth2 import service_account

from pyutil.env_utils import load_env

# Constants (must match the cron job)
ACTIVITY_WINDOW_HOURS = 72  # 3 days
NPS_SURVEY_FREQUENCY_DAYS = 180
VERIFICATION_MIN_DAYS = 3

# Hardcoded for development
SITE_ID = "ananda"
ENV = "dev"


def initialize_firestore():
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


def hours_since(timestamp) -> float:
    """Calculate hours since a Firestore timestamp."""
    if timestamp is None:
        return float("inf")

    ts = timestamp.timestamp() if hasattr(timestamp, "timestamp") else timestamp

    now = datetime.now(timezone.utc).timestamp()
    return (now - ts) / 3600


def days_since(timestamp) -> float:
    """Calculate days since a Firestore timestamp."""
    if timestamp is None:
        return float("inf")

    ts = timestamp.timestamp() if hasattr(timestamp, "timestamp") else timestamp

    now = datetime.now(timezone.utc).timestamp()
    return (now - ts) / 86400


def format_timestamp(timestamp) -> str:
    """Format a Firestore timestamp for display."""
    if timestamp is None:
        return "NOT SET"

    if hasattr(timestamp, "isoformat"):
        return timestamp.isoformat()
    return str(timestamp)


def check_eligibility(email: str) -> None:
    """Check NPS survey eligibility for a user."""
    print(f"\n🔍 Checking NPS Survey Eligibility for: {email}\n")
    print("=" * 60)

    # Load environment variables
    load_env(SITE_ID)
    print(f"   Site: {SITE_ID}, Environment: {ENV}")

    # Initialize Firestore
    db = initialize_firestore()

    # Get user document
    collection_name = f"{ENV}_users"
    print(f"   Collection: {collection_name}\n")
    user_ref = db.collection(collection_name).document(email)
    user_doc = user_ref.get()

    if not user_doc.exists:
        print(f"❌ User document not found: {email}")
        sys.exit(1)

    data = user_doc.to_dict()
    if data is None:
        print(f"❌ User document exists but has no data: {email}")
        sys.exit(1)

    # Display raw field values
    print("\n📋 User Document Fields:")
    print(f"   inviteStatus: {data.get('inviteStatus', 'NOT SET')}")
    print(
        f"   emailPreferences.nps: {data.get('emailPreferences', {}).get('nps', 'NOT SET (defaults to true)')}"
    )
    print(f"   lastActivityAt: {format_timestamp(data.get('lastActivityAt'))}")
    print(
        f"   lastNpsSurveySentAt: {format_timestamp(data.get('lastNpsSurveySentAt'))}"
    )
    print(f"   verifiedAt: {format_timestamp(data.get('verifiedAt'))}")
    print(f"   pendingNpsSurveyKeys: {data.get('pendingNpsSurveyKeys', [])}")

    print("\n✅ Eligibility Checks:")
    print("-" * 60)

    all_passed = True

    # Check 1: inviteStatus
    invite_status = data.get("inviteStatus")
    check1_pass = invite_status == "accepted"
    print("\n1. inviteStatus === 'accepted'")
    print(f"   Result: {'✅ PASS' if check1_pass else '❌ FAIL'}")
    print(f"   Value: {invite_status or 'NOT SET'}")
    if not check1_pass:
        print("   ⚠️  User will not be in the query results (filtered at query level)")
        all_passed = False

    # Check 2: emailPreferences.nps
    email_prefs = data.get("emailPreferences", {})
    nps_pref = email_prefs.get("nps")
    check2_pass = nps_pref is not False
    print("\n2. emailPreferences.nps !== false")
    print(f"   Result: {'✅ PASS' if check2_pass else '❌ FAIL'}")
    print(
        f"   Value: {nps_pref if nps_pref is not None else 'NOT SET (defaults to true)'}"
    )
    if not check2_pass:
        print("   ⚠️  User explicitly unsubscribed from NPS emails")
        all_passed = False

    # Check 3: lastActivityAt within 24 hours
    last_activity = data.get("lastActivityAt")
    hours = hours_since(last_activity) if last_activity else float("inf")
    check3_pass = last_activity is not None and hours <= ACTIVITY_WINDOW_HOURS
    print(f"\n3. lastActivityAt exists AND within {ACTIVITY_WINDOW_HOURS} hours")
    print(f"   Result: {'✅ PASS' if check3_pass else '❌ FAIL'}")
    print(f"   Value: {format_timestamp(last_activity)}")
    print(
        f"   Hours since activity: {hours:.2f}"
        if last_activity
        else "   Hours since activity: N/A"
    )
    print(f"   Required: <= {ACTIVITY_WINDOW_HOURS} hours")
    if not check3_pass:
        print(f"   ⚠️  User not active in last {ACTIVITY_WINDOW_HOURS} hours")
        all_passed = False

    # Check 4: lastNpsSurveySentAt
    last_nps = data.get("lastNpsSurveySentAt")
    days_nps = days_since(last_nps) if last_nps else float("inf")
    check4_pass = last_nps is None or days_nps >= NPS_SURVEY_FREQUENCY_DAYS
    print(
        f"\n4. lastNpsSurveySentAt check (must be > {NPS_SURVEY_FREQUENCY_DAYS} days ago or not set)"
    )
    print(f"   Result: {'✅ PASS' if check4_pass else '❌ FAIL'}")
    if last_nps:
        print(f"   Value: {format_timestamp(last_nps)}")
        print(f"   Days since NPS sent: {days_nps:.2f}")
        print(f"   Required: >= {NPS_SURVEY_FREQUENCY_DAYS} days")
    else:
        print("   Value: NOT SET (passes automatically)")
    if not check4_pass:
        print("   ⚠️  NPS email sent too recently")
        all_passed = False

    # Check 5: verifiedAt (must be at least 3 days ago)
    verified_at = data.get("verifiedAt")
    days_verified = days_since(verified_at) if verified_at else float("inf")
    check5_pass = verified_at is not None and days_verified >= VERIFICATION_MIN_DAYS
    print(f"\n5. verifiedAt check (must be >= {VERIFICATION_MIN_DAYS} days ago)")
    print(f"   Result: {'✅ PASS' if check5_pass else '❌ FAIL'}")
    if verified_at:
        print(f"   Value: {format_timestamp(verified_at)}")
        print(f"   Days since verification: {days_verified:.2f}")
        print(f"   Required: >= {VERIFICATION_MIN_DAYS} days")
    else:
        print("   Value: NOT SET")
    if not check5_pass:
        print(
            f"   ⚠️  Account verified too recently (< {VERIFICATION_MIN_DAYS} days ago)"
        )
        all_passed = False

    # Final result
    print(f"\n{'=' * 60}")
    if all_passed:
        print("\n✅ USER IS ELIGIBLE FOR NPS SURVEY EMAIL")
        print("\nAll eligibility checks passed. User should receive email.")
    else:
        print("\n❌ USER IS NOT ELIGIBLE")
        print("\nOne or more checks failed. See details above.")
    print(f"\n{'=' * 60}\n")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python bin/debug_nps_eligibility.py <email>")
        sys.exit(1)

    check_eligibility(sys.argv[1])
