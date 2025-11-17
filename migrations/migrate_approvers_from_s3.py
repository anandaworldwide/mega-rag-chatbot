#!/usr/bin/env python3
"""
Migration script to migrate approver data from S3 JSON files to Firestore user records.

This script:
1. Reads the approver configuration JSON file from S3
2. For each admin in the JSON, finds the user by UUID in Firestore
3. Updates their Firestore record with:
   - isApprover: true
   - approverRegion: region name from JSON
   - approverLocation: location from JSON

Usage:
    python migrations/migrate_approvers_from_s3.py --site <site_id> --env <dev|prod> [--dry-run]
"""

import argparse
import json
import os
import sys
from typing import Dict, List, Optional

import boto3
from botocore.exceptions import ClientError
from google.cloud import firestore
from google.oauth2 import service_account

# Add parent directory to path to import pyutil
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pyutil.env_utils import load_env


def initialize_firestore(env_prefix: str) -> firestore.Client:
    """Initialize Firestore client using service account credentials."""
    credentials_json = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
    if not credentials_json:
        raise ValueError("GOOGLE_APPLICATION_CREDENTIALS environment variable is not set or is empty")

    try:
        credentials_dict = json.loads(credentials_json)
        credentials = service_account.Credentials.from_service_account_info(credentials_dict)
    except json.JSONDecodeError as e:
        raise ValueError(f"Error decoding JSON from GOOGLE_APPLICATION_CREDENTIALS: {e}")

    # Unset FIRESTORE_EMULATOR_HOST for production
    if env_prefix == "prod" and "FIRESTORE_EMULATOR_HOST" in os.environ:
        del os.environ["FIRESTORE_EMULATOR_HOST"]

    try:
        return firestore.Client(credentials=credentials)
    except Exception as e:
        raise RuntimeError(f"Error initializing Firestore: {e}")


def get_s3_client():
    """Get S3 client using boto3."""
    return boto3.client(
        "s3",
        aws_access_key_id=os.getenv("AWS_ACCESS_KEY_ID"),
        aws_secret_access_key=os.getenv("AWS_SECRET_ACCESS_KEY"),
        region_name=os.getenv("AWS_REGION", "us-west-2"),
    )


def download_approvers_json_from_s3(s3_client, bucket_name: str, s3_key: str) -> Dict:
    """Download and parse the approvers JSON file from S3."""
    try:
        response = s3_client.get_object(Bucket=bucket_name, Key=s3_key)
        body_contents = response["Body"].read().decode("utf-8")
        return json.loads(body_contents)
    except ClientError as e:
        if e.response["Error"]["Code"] == "NoSuchKey":
            raise FileNotFoundError(f"Approvers JSON file not found at s3://{bucket_name}/{s3_key}")
        raise RuntimeError(f"Error downloading from S3: {e}") from e
    except json.JSONDecodeError as e:
        raise ValueError(f"Error parsing JSON from S3: {e}") from e


def find_user_by_uuid(db: firestore.Client, users_col: str, uuid: str) -> Optional[str]:
    """
    Find user email by UUID.
    
    Returns:
        Email address if found, None otherwise
    """
    # Try querying users collection directly
    users_query = db.collection(users_col).where("uuid", "==", uuid).limit(1)
    users = list(users_query.stream())
    
    if users:
        return users[0].id  # Email is the document ID
    
    # Try UUID index collection as fallback
    env_prefix = "dev_" if "dev" in users_col else "prod_"
    uuid_index_col = f"{env_prefix}uuid_index"
    uuid_doc = db.collection(uuid_index_col).document(uuid).get()
    
    if uuid_doc.exists:
        data = uuid_doc.to_dict()
        return data.get("email")
    
    return None


def migrate_approvers(
    db: firestore.Client,
    approvers_data: Dict,
    env_prefix: str,
    dry_run: bool = False,
) -> Dict[str, int]:
    """
    Migrate approver data from JSON to Firestore.
    
    Returns:
        Dictionary with counts of successful updates, not found, and errors
    """
    users_col = f"{env_prefix}_users"
    stats = {"updated": 0, "not_found": 0, "errors": 0, "skipped": 0}
    
    if not approvers_data.get("regions"):
        print("Warning: No regions found in approvers data")
        return stats
    
    for region in approvers_data["regions"]:
        region_name = region.get("name", "Global")
        admins = region.get("admins", [])
        
        print(f"\nProcessing region: {region_name} ({len(admins)} admin(s))")
        
        for admin in admins:
            admin_name = admin.get("name", "Unknown")
            admin_uuid = admin.get("uuid", "")
            admin_location = admin.get("location", "")
            
            if not admin_uuid:
                print(f"  ⚠️  Skipping {admin_name}: No UUID provided")
                stats["skipped"] += 1
                continue
            
            # Find user by UUID
            user_email = find_user_by_uuid(db, users_col, admin_uuid)
            
            if not user_email:
                print(f"  ❌ {admin_name} (UUID: {admin_uuid}): User not found in Firestore")
                stats["not_found"] += 1
                continue
            
            # Get user document to check current state
            user_ref = db.collection(users_col).document(user_email)
            user_doc = user_ref.get()
            
            if not user_doc.exists:
                print(f"  ❌ {admin_name} ({user_email}): User document not found")
                stats["not_found"] += 1
                continue
            
            user_data = user_doc.to_dict()
            current_role = user_data.get("role", "user")
            
            # Only update admin/superuser roles
            if current_role not in ["admin", "superuser"]:
                print(
                    f"  ⚠️  {admin_name} ({user_email}): Skipping - role is '{current_role}' "
                    f"(must be admin or superuser)"
                )
                stats["skipped"] += 1
                continue
            
            # Prepare updates
            updates = {
                "isApprover": True,
                "approverRegion": region_name,
                "approverLocation": admin_location,
            }
            
            print(
                f"  {'[DRY RUN] ' if dry_run else ''}✓ {admin_name} ({user_email}): "
                f"Setting isApprover=true, region='{region_name}', location='{admin_location}'"
            )
            
            if not dry_run:
                try:
                    user_ref.update(updates)
                    stats["updated"] += 1
                except Exception as e:
                    print(f"  ❌ Error updating {user_email}: {e}")
                    stats["errors"] += 1
    
    return stats


def main():
    parser = argparse.ArgumentParser(
        description="Migrate approver data from S3 JSON to Firestore user records"
    )
    parser.add_argument(
        "--site",
        required=True,
        help="Site ID (e.g., 'ananda', 'crystal', 'jairam')",
    )
    parser.add_argument(
        "--env",
        type=str,
        choices=["dev", "prod"],
        required=True,
        help="Environment (dev or prod)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Perform a dry run without updating Firestore",
    )
    args = parser.parse_args()
    
    # Load environment variables
    print(f"Loading environment for site: {args.site}")
    load_env(args.site)
    
    # Initialize clients
    print(f"\nInitializing Firestore for {args.env} environment...")
    try:
        db = initialize_firestore(args.env)
    except Exception as e:
        print(f"❌ Error initializing Firestore: {e}")
        sys.exit(1)
    
    print("Initializing S3 client...")
    s3_client = get_s3_client()
    
    # Determine S3 key
    bucket_name = os.getenv("NEXT_PUBLIC_S3_BUCKET_NAME") or os.getenv("S3_BUCKET_NAME") or "ananda-chatbot"
    s3_env_prefix = "dev-" if args.env == "dev" else ""
    s3_key = f"site-config/admin-approvers/{s3_env_prefix}{args.site}-admin-approvers.json"
    
    print(f"\nDownloading approvers JSON from S3...")
    print(f"  Bucket: {bucket_name}")
    print(f"  Key: {s3_key}")
    
    try:
        approvers_data = download_approvers_json_from_s3(s3_client, bucket_name, s3_key)
        print(f"✓ Successfully downloaded JSON (lastUpdated: {approvers_data.get('lastUpdated', 'unknown')})")
    except Exception as e:
        print(f"❌ Error downloading from S3: {e}")
        sys.exit(1)
    
    # Migrate approvers
    print(f"\n{'[DRY RUN] ' if args.dry_run else ''}Migrating approvers to Firestore...")
    stats = migrate_approvers(db, approvers_data, args.env, dry_run=args.dry_run)
    
    # Print summary
    print("\n" + "=" * 60)
    print("Migration Summary:")
    print("=" * 60)
    print(f"  Updated:     {stats['updated']}")
    print(f"  Not Found:   {stats['not_found']}")
    print(f"  Skipped:     {stats['skipped']}")
    print(f"  Errors:      {stats['errors']}")
    print("=" * 60)
    
    if args.dry_run:
        print("\n⚠️  DRY RUN - No changes were made to Firestore")
        print("   Run without --dry-run to apply changes")
    else:
        print(f"\n✓ Migration complete! Updated {stats['updated']} user record(s)")


if __name__ == "__main__":
    main()

