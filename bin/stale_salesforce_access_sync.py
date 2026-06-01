#!/usr/bin/env python3
"""
Mark recently synced Luca users as stale so Salesforce access refreshes on next visit.

Luca re-verifies Salesforce access when `lastSalesforceSyncAt` is missing or older than
three days. This script finds accepted users whose sync timestamp is newer than that
window and rewinds it to just over three days ago.

Usage:
    uv run python bin/stale_salesforce_access_sync.py --site ananda --env prod --dry-run
    uv run python bin/stale_salesforce_access_sync.py --site ananda --env prod
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone

from google.cloud import firestore
from google.oauth2 import service_account

from pyutil.env_utils import load_env

SALESFORCE_ACCESS_VERIFICATION_MAX_AGE_DAYS = 3
STALE_BUFFER = timedelta(hours=1)


def initialize_firestore() -> firestore.Client:
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
    except json.JSONDecodeError as exc:
        raise ValueError(
            f"Error decoding JSON from GOOGLE_APPLICATION_CREDENTIALS: {exc}"
        ) from exc

    if "FIRESTORE_EMULATOR_HOST" in os.environ:
        del os.environ["FIRESTORE_EMULATOR_HOST"]

    try:
        return firestore.Client(credentials=credentials)
    except Exception as exc:
        raise RuntimeError(f"Error initializing Firestore: {exc}") from exc


def to_datetime(value) -> datetime | None:
    """Convert a Firestore timestamp or datetime to an aware UTC datetime."""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if hasattr(value, "timestamp"):
        return datetime.fromtimestamp(value.timestamp(), tz=timezone.utc)
    return None


def is_recent_sync(last_sync_at, now: datetime) -> bool:
    """Return True when the user was synced within the stale-on-access window."""
    last_sync = to_datetime(last_sync_at)
    if last_sync is None:
        return False

    cutoff = now - timedelta(days=SALESFORCE_ACCESS_VERIFICATION_MAX_AGE_DAYS)
    return last_sync > cutoff


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Rewind recent Salesforce sync timestamps so users refresh access on next visit"
        )
    )
    parser.add_argument(
        "--site",
        required=True,
        help="Site ID for environment variables (e.g., 'ananda')",
    )
    parser.add_argument(
        "-e",
        "--env",
        choices=["dev", "prod"],
        default="prod",
        help="Firestore users collection environment (default: prod)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Preview changes without writing to Firestore",
    )
    args = parser.parse_args()

    load_env(args.site)
    db = initialize_firestore()

    collection_name = f"{args.env}_users"
    now = datetime.now(timezone.utc)
    stale_timestamp = now - timedelta(days=SALESFORCE_ACCESS_VERIFICATION_MAX_AGE_DAYS) - STALE_BUFFER

    print("Salesforce access stale-on-access refresh helper")
    print(f"  Site:       {args.site}")
    print(f"  Collection: {collection_name}")
    print(f"  Mode:       {'DRY RUN' if args.dry_run else 'APPLY'}")
    print(
        f"  Target sync time: {stale_timestamp.isoformat()} "
        f"(>{SALESFORCE_ACCESS_VERIFICATION_MAX_AGE_DAYS} days ago)"
    )
    print()

    users_ref = db.collection(collection_name)
    candidates: list[dict] = []
    skipped_no_sync = 0
    skipped_already_stale = 0
    skipped_not_accepted = 0

    for user_doc in users_ref.stream():
        user_data = user_doc.to_dict() or {}
        if user_data.get("inviteStatus") != "accepted":
            skipped_not_accepted += 1
            continue

        last_sync_at = user_data.get("lastSalesforceSyncAt")
        if last_sync_at is None:
            skipped_no_sync += 1
            continue

        if not is_recent_sync(last_sync_at, now):
            skipped_already_stale += 1
            continue

        candidates.append(
            {
                "email": user_doc.id,
                "previous_sync_at": to_datetime(last_sync_at),
                "salesforce_access_level": user_data.get("salesforceAccessLevel"),
                "salesforce_match_status": user_data.get("salesforceMatchStatus"),
            }
        )

    print(f"Accepted users already stale or never synced: {skipped_no_sync + skipped_already_stale}")
    print(f"  - never synced (already due on next visit): {skipped_no_sync}")
    print(f"  - already older than {SALESFORCE_ACCESS_VERIFICATION_MAX_AGE_DAYS} days: {skipped_already_stale}")
    print(f"Skipped non-accepted users: {skipped_not_accepted}")
    print(f"Users to rewind: {len(candidates)}")
    print()

    if not candidates:
        print("Nothing to do.")
        return

    for candidate in candidates:
        previous = candidate["previous_sync_at"]
        previous_label = previous.isoformat() if previous else "unknown"
        print(
            f"  {candidate['email']}: {previous_label} "
            f"(level={candidate['salesforce_access_level']}, "
            f"status={candidate['salesforce_match_status']})"
        )

    if args.dry_run:
        print()
        print("Dry run only. Re-run without --dry-run to update Firestore.")
        return

    print()
    batch = db.batch()
    batch_count = 0
    updated = 0

    for candidate in candidates:
        user_ref = users_ref.document(candidate["email"])
        batch.update(user_ref, {"lastSalesforceSyncAt": stale_timestamp})
        batch_count += 1
        updated += 1

        if batch_count >= 400:
            batch.commit()
            batch = db.batch()
            batch_count = 0

    if batch_count:
        batch.commit()

    print(f"Updated {updated} users in '{collection_name}'.")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)
