#!/usr/bin/env python3
"""
Migration script to convert admin approver JSON files from email-based to UUID-based format.

This script reads an existing admin approver JSON file (with email addresses) and generates
a new file with UUIDs instead. It looks up UUIDs from Firestore user records by email.

Usage:
    python3 web/scripts/migrate-admin-approvers-to-uuid.py \\
        --site <site-name> \\
        --env <dev|prod> \\
        [--dry-run] \\
        <input-json-file>

Example:
    python3 web/scripts/migrate-admin-approvers-to-uuid.py \\
        --site ananda \\
        --env prod \\
        --dry-run \\
        ananda-admin-approvers.json
"""

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

# Add project root to path for imports
project_root = Path(__file__).parent.parent.parent
sys.path.insert(0, str(project_root))

from google.cloud import firestore
from google.oauth2 import service_account

from pyutil.env_utils import load_env


def initialize_firestore(env_prefix: str) -> firestore.Client:
    """Initialize Firestore client using service account credentials.

    Args:
        env_prefix: Environment prefix ('dev' or 'prod')

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


def lookup_uuid_by_email(
    db: firestore.Client, email: str, env_prefix: str
) -> Optional[str]:
    """Look up UUID for a user by their email address.

    Args:
        db: Firestore client
        email: Email address to look up
        env_prefix: Environment prefix ('dev' or 'prod')

    Returns:
        UUID string if found, None otherwise
    """
    email_lower = email.lower()
    users_collection = f"{env_prefix}_users"

    try:
        # Email is stored as document ID in users collection
        # Using collection: {env_prefix}_users (e.g., dev_users or prod_users)
        user_doc = db.collection(users_collection).document(email_lower).get()

        if user_doc.exists:
            user_data = user_doc.to_dict()
            uuid = user_data.get("uuid") if user_data else None

            if uuid and isinstance(uuid, str) and len(uuid) == 36:
                return uuid

        # Also try UUID index collection
        uuid_index_collection = f"{env_prefix}_uuid_index"

        # Query UUID index by email field
        uuid_query = (
            db.collection(uuid_index_collection)
            .where("email", "==", email_lower)
            .limit(1)
            .get()
        )

        if uuid_query and len(uuid_query) > 0:
            for doc in uuid_query:
                return doc.id  # UUID is the document ID in uuid_index collection

    except Exception as e:
        print(f"  ⚠️  Error looking up UUID for {email}: {e}", file=sys.stderr)

    return None


def migrate_admin_approvers_file(
    input_file: str,
    db: firestore.Client,
    env_prefix: str,
    dry_run: bool = False,
) -> Dict[str, Any]:
    """Migrate admin approver JSON file from email-based to UUID-based format.

    Args:
        input_file: Path to input JSON file (email-based)
        db: Firestore client
        env_prefix: Environment prefix ('dev' or 'prod')
        dry_run: If True, don't write output file

    Returns:
        Dictionary with migration statistics
    """
    # Read input file
    with open(input_file, "r", encoding="utf-8") as f:
        input_data = json.load(f)

    if not isinstance(input_data, dict) or "regions" not in input_data:
        raise ValueError("Invalid admin approvers JSON structure")

    stats = {
        "total_admins": 0,
        "found_uuids": 0,
        "missing_uuids": 0,
        "missing_emails": [],
    }

    # Process each region
    output_regions: List[Dict[str, Any]] = []

    for region in input_data["regions"]:
        region_name = region.get("name", "")
        admins = region.get("admins", [])

        output_admins: List[Dict[str, Any]] = []

        for admin in admins:
            stats["total_admins"] += 1
            admin_email = admin.get("email", "").lower()
            admin_name = admin.get("name", "")
            admin_location = admin.get("location", "")

            if not admin_email:
                print(
                    f"  ⚠️  Skipping admin '{admin_name}' - no email address",
                    file=sys.stderr,
                )
                stats["missing_emails"].append(admin_name)
                continue

            # Look up UUID
            uuid = lookup_uuid_by_email(db, admin_email, env_prefix)

            if uuid:
                output_admins.append(
                    {
                        "name": admin_name,
                        "uuid": uuid,
                        "location": admin_location,
                    }
                )
                stats["found_uuids"] += 1
                print(f"  ✅ {admin_name} ({admin_email}) → {uuid}")
            else:
                stats["missing_uuids"] += 1
                stats["missing_emails"].append(admin_email)
                print(
                    f"  ❌ Could not find UUID for {admin_name} ({admin_email})",
                    file=sys.stderr,
                )

        if output_admins:
            output_regions.append({"name": region_name, "admins": output_admins})

    # Create output data structure
    output_data = {
        "lastUpdated": input_data.get("lastUpdated", ""),
        "regions": output_regions,
    }

    # Write output file (unless dry run)
    if not dry_run:
        # If migration succeeded (no missing UUIDs), rename old file and write new file in place
        if stats["missing_uuids"] == 0:
            # Rename old file to add "-old" suffix before extension
            input_path = Path(input_file)
            old_backup_file = input_path.parent / f"{input_path.stem}-old{input_path.suffix}"
            
            import shutil
            shutil.move(input_file, str(old_backup_file))
            print(f"📦 Backed up original file to: {old_backup_file}")
            
            # Write new file with original filename
            with open(input_file, "w", encoding="utf-8") as f:
                json.dump(output_data, f, indent=2, ensure_ascii=False)
            print(f"✅ Migration complete! New UUID-based file written to: {input_file}")
        else:
            # If there are missing UUIDs, preserve original and don't write anything
            print(f"\n⚠️  Migration completed with missing UUIDs.")
            print("   Original file preserved. Fix missing UUIDs and run again.")
    else:
        if stats["missing_uuids"] == 0:
            input_path = Path(input_file)
            backup_path = input_path.parent / f"{input_path.stem}-old{input_path.suffix}"
            print(f"\n🔍 Dry run complete. Would write to: {input_file}")
            print(f"   Would backup original file to: {backup_path}")
        else:
            print(f"\n🔍 Dry run complete. Would preserve original file (missing UUIDs).")
        print("\nOutput preview:")
        print(json.dumps(output_data, indent=2, ensure_ascii=False))

    return stats


def main():
    parser = argparse.ArgumentParser(
        description="Migrate admin approver JSON files from email-based to UUID-based format",
        epilog="Example: python3 migrate-admin-approvers-to-uuid.py --site ananda --env prod ananda-admin-approvers.json",
    )
    parser.add_argument(
        "input_file",
        help="Path to input JSON file (email-based format)",
    )
    parser.add_argument(
        "--site",
        required=True,
        help="Site name (e.g., 'ananda', 'crystal', 'jairam')",
    )
    parser.add_argument(
        "--env",
        required=True,
        choices=["dev", "prod"],
        help="Environment (dev or prod)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Perform a dry run without writing output file",
    )

    args = parser.parse_args()

    # Load environment variables
    print(f"🔧 Loading environment for site: {args.site}, env: {args.env}")
    load_env(args.site)

    # Initialize Firestore
    print(f"🔧 Initializing Firestore for {args.env} environment...")
    try:
        db = initialize_firestore(args.env)
        print("✅ Firestore initialized successfully")
    except Exception as e:
        print(f"❌ Failed to initialize Firestore: {e}", file=sys.stderr)
        sys.exit(1)

    # Check input file exists
    if not os.path.exists(args.input_file):
        print(f"❌ Input file not found: {args.input_file}", file=sys.stderr)
        sys.exit(1)

    # Run migration
    print(f"\n📋 Starting migration...")
    print(f"   Input:  {args.input_file}")
    print(f"   Environment: {args.env}")
    print(f"   Database collections: {args.env}_users, {args.env}_uuid_index")
    if args.dry_run:
        print("   Mode:  DRY RUN (no file will be written)")

    try:
        stats = migrate_admin_approvers_file(
            args.input_file, db, args.env, args.dry_run
        )

        # Print summary
        print("\n📊 Migration Summary:")
        print(f"   Total admins processed: {stats['total_admins']}")
        print(f"   UUIDs found:           {stats['found_uuids']}")
        print(f"   UUIDs missing:         {stats['missing_uuids']}")

        if stats["missing_emails"]:
            print(f"\n⚠️  Admins with missing UUIDs:")
            for email in stats["missing_emails"]:
                print(f"      - {email}")

        if stats["missing_uuids"] > 0:
            print(
                "\n⚠️  Warning: Some admins could not be migrated. "
                "Please verify these users exist in Firestore and have UUIDs assigned."
            )
            print("   Original file preserved. Fix missing UUIDs and run again.")
            sys.exit(1)
        else:
            print("\n✅ All admins successfully migrated!")
            if not args.dry_run:
                print(f"   Original file backed up with '-old' suffix.")
                print(f"   New UUID-based file written in place of original.")

    except Exception as e:
        print(f"❌ Migration failed: {e}", file=sys.stderr)
        import traceback

        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()

