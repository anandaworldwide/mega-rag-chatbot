#!/usr/bin/env python3

"""
Patch Pinecone Vector Text - Fix typos/misspellings in vector metadata.

Fetches a vector by ID, performs a find-and-replace on the 'text' metadata field,
shows a diff, and updates the vector in Pinecone after confirmation.

Usage:
    python bin/patch_pinecone_text.py --site ananda \
        --vector-id 'video||Ananda Youtube||video||How the Masculine and Feminine Energies Help Keep ||Swami Kriyananda||45f28d61||3' \
        --find "Rajashijanakaranda" \
        --replace "Rajarsi Janakananda"
"""

import argparse
import os
import sys
import time

from pinecone import Pinecone

from pyutil.env_utils import load_env


def patch_vector(index, vector_id: str, find: str, replace: str) -> None:
    """Fetch a vector, replace text in metadata, show diff, and update."""

    # Fetch the vector
    print(f"\nFetching vector: {vector_id}")
    response = index.fetch(ids=[vector_id])

    if vector_id not in response.vectors:
        print("Error: Vector ID not found in index.")
        print(f"  Searched for: {vector_id!r}")
        available = list(response.vectors.keys())
        if available:
            print(f"  Got back: {available}")
        sys.exit(1)

    vector = response.vectors[vector_id]
    metadata = dict(vector.metadata) if vector.metadata else {}
    text = str(metadata.get("text", ""))

    if not text:
        print("Error: Vector has no 'text' metadata field.")
        sys.exit(1)

    # Check if the find string exists
    occurrences = text.count(find)
    if occurrences == 0:
        print(f"Error: '{find}' not found in vector text.")
        print(f"  Text preview: {text[:300]}...")
        sys.exit(1)

    # Perform replacement
    new_text = text.replace(find, replace)

    # Show diff
    print(f"\nVector ID: {vector_id}")
    print(f"Title:     {metadata.get('title', 'N/A')}")
    print(f"Author:    {metadata.get('author', 'N/A')}")
    print(f"Source:    {metadata.get('source', metadata.get('url', 'N/A'))}")
    print(f"\nOccurrences of '{find}': {occurrences}")
    print(f"\n{'=' * 60}")
    print("BEFORE:")
    print(f"{'=' * 60}")

    # Show context around each occurrence
    search_pos = 0
    for _ in range(occurrences):
        idx = text.find(find, search_pos)
        start = max(0, idx - 80)
        end = min(len(text), idx + len(find) + 80)
        snippet = text[start:end]
        prefix = "..." if start > 0 else ""
        suffix = "..." if end < len(text) else ""
        print(f"  {prefix}{snippet}{suffix}")
        search_pos = idx + len(find)

    print(f"\n{'=' * 60}")
    print("AFTER:")
    print(f"{'=' * 60}")

    search_pos = 0
    for _ in range(occurrences):
        idx = new_text.find(replace, search_pos)
        start = max(0, idx - 80)
        end = min(len(new_text), idx + len(replace) + 80)
        snippet = new_text[start:end]
        prefix = "..." if start > 0 else ""
        suffix = "..." if end < len(new_text) else ""
        print(f"  {prefix}{snippet}{suffix}")
        search_pos = idx + len(replace)

    print()

    # Confirm
    confirmation = input("Apply this change? (yes/No): ").strip().lower()
    if confirmation not in ("yes", "y"):
        print("Aborted.")
        sys.exit(0)

    # Update the vector metadata
    metadata["text"] = new_text
    index.update(id=vector_id, set_metadata={"text": new_text})

    print("\nUpdated vector metadata successfully.")

    _verify_update(index, vector_id, find, replace)


def _verify_update(index, vector_id: str, find: str, replace: str) -> None:
    """Wait for Pinecone eventual consistency and verify the update."""
    print("Verifying (waiting 5s for consistency)...")
    time.sleep(5)
    verify_response = index.fetch(ids=[vector_id])
    if vector_id not in verify_response.vectors:
        print("Warning: Could not re-fetch vector for verification.")
        return

    verified_text = str(
        verify_response.vectors[vector_id].metadata.get("text", "")
    )
    if replace in verified_text and find not in verified_text:
        print("Verification passed: replacement confirmed.")
    elif replace in verified_text:
        print(
            f"Verification partial: '{replace}' found but "
            f"'{find}' still present (may have other occurrences)."
        )
    else:
        print(
            "Warning: Verification could not confirm the change "
            "(eventual consistency - check again shortly)."
        )


def main():
    parser = argparse.ArgumentParser(
        description="Patch text in a Pinecone vector's metadata (find and replace).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Example:
  python bin/patch_pinecone_text.py --site ananda \\
      --vector-id 'video||Ananda Youtube||video||Title||Author||hash||3' \\
      --find "misspelling" \\
      --replace "correct spelling"
        """,
    )
    parser.add_argument(
        "--site", required=True, help="Site ID for environment variables"
    )
    parser.add_argument(
        "--vector-id", required=True, help="Pinecone vector ID to patch"
    )
    parser.add_argument(
        "--find", required=True, help="Text to find in the vector's text metadata"
    )
    parser.add_argument(
        "--replace", required=True, help="Replacement text"
    )

    args = parser.parse_args()

    # Load environment
    load_env(args.site)

    api_key = os.getenv("PINECONE_API_KEY")
    index_name = os.getenv(
        "PINECONE_INDEX_NAME",
        os.getenv("PINECONE_INGEST_INDEX_NAME", "mega-rag-chatbot"),
    )

    if not api_key:
        print("Error: PINECONE_API_KEY not set.")
        sys.exit(1)

    pc = Pinecone(api_key=api_key)
    index = pc.Index(index_name)

    print(f"Pinecone index: {index_name}")
    patch_vector(index, args.vector_id, args.find, args.replace)


if __name__ == "__main__":
    main()
