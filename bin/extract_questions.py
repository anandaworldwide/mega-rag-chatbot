#!/usr/bin/env python3
"""
Extract sample questions from Firestore for use in onboarding email templates.

This script queries the chatLogs collection to extract real user questions
that can be used as examples in onboarding emails.

Usage:
    python bin/extract_questions.py --site <site_id> [options]

Examples:
    # Extract 10 questions from dev environment
    python bin/extract_questions.py --site ananda --env dev

    # Extract 20 questions from last 30 days, minimum 15 characters
    python bin/extract_questions.py --site ananda --env prod --limit 20 --days-back 30 --min-length 15

    # Save output to file
    python bin/extract_questions.py --site ananda --env prod --output questions.json
"""

import argparse
import json
import os
import sys
from datetime import datetime, timedelta

from google.cloud import firestore
from google.oauth2 import service_account

from pyutil.env_utils import load_env


def initialize_firestore(env_prefix):
    """Initialize Firestore client with credentials from environment."""
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


def get_collection_name(env_prefix):
    """Get the collection name based on environment prefix."""
    return f"{env_prefix}_chatLogs"


def extract_questions(db, env_prefix, limit=10, days_back=90, min_length=10):
    """
    Extract questions from Firestore.

    Args:
        db: Firestore client
        env_prefix: Environment prefix (dev/prod)
        limit: Maximum number of questions to return
        days_back: How many days back to query
        min_length: Minimum question length in characters

    Returns:
        List of question strings
    """
    collection_name = get_collection_name(env_prefix)
    collection_ref = db.collection(collection_name)

    # Calculate cutoff date
    cutoff_date = datetime.utcnow() - timedelta(days=days_back)

    # Query recent questions
    query = (
        collection_ref.where("timestamp", ">=", cutoff_date)
        .order_by("timestamp", direction=firestore.Query.DESCENDING)
        .limit(limit * 3)  # Get more than needed to filter
    )

    questions = []
    seen_questions = set()  # Deduplicate by question text

    try:
        docs = query.stream()
        for doc in docs:
            data = doc.to_dict()
            question_text = data.get("question", "").strip()

            # Filter criteria
            if len(question_text) < min_length:
                continue

            # Skip duplicates (case-insensitive)
            question_lower = question_text.lower()
            if question_lower in seen_questions:
                continue

            seen_questions.add(question_lower)

            questions.append(question_text)

            if len(questions) >= limit:
                break

    except Exception as e:
        print(f"Error querying Firestore: {e}", file=sys.stderr)
        return []

    return questions


def main():
    parser = argparse.ArgumentParser(
        description="Extract sample questions from Firestore for onboarding emails"
    )
    parser.add_argument(
        "--site",
        required=True,
        help="Site ID for environment variables",
    )
    parser.add_argument(
        "-e",
        "--env",
        type=str,
        choices=["dev", "prod"],
        default="dev",
        help="Environment (dev or prod)",
    )
    parser.add_argument(
        "-l",
        "--limit",
        type=int,
        default=10,
        help="Maximum number of questions to extract (default: 10)",
    )
    parser.add_argument(
        "-d",
        "--days-back",
        type=int,
        default=90,
        help="How many days back to query (default: 90)",
    )
    parser.add_argument(
        "-m",
        "--min-length",
        type=int,
        default=10,
        help="Minimum question length in characters (default: 10)",
    )
    parser.add_argument(
        "-o",
        "--output",
        type=str,
        help="Output file path (default: stdout)",
    )

    args = parser.parse_args()

    # Load environment variables
    load_env(args.site)

    # Initialize Firestore
    try:
        db = initialize_firestore(args.env)
    except Exception as e:
        print(f"Error initializing Firestore: {e}", file=sys.stderr)
        return 1

    # Extract questions
    questions = extract_questions(
        db,
        args.env,
        limit=args.limit,
        days_back=args.days_back,
        min_length=args.min_length,
    )

    # Output results as simple question list
    output_json = json.dumps(questions, indent=2)

    if args.output:
        with open(args.output, "w") as f:
            f.write(output_json)
        print(f"Extracted {len(questions)} questions to {args.output}")
    else:
        print(output_json)

    return 0


if __name__ == "__main__":
    exit(main())
