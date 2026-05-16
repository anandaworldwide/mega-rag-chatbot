#!/usr/bin/env python3

"""
Search Chatbot Content - Investigate reported terms in answers and source documents.

Searches both Firestore chatLogs (answers) and Pinecone vectors (source content)
for a given term. Useful for tracing whether a problematic term came from ingested
source documents or was hallucinated by the LLM.

Usage:
    # Search both Firestore answers and Pinecone source documents
    python bin/search_chatbot_content.py --site ananda --term "Rajashijanakaranda" -e prod

    # Search only Firestore answers
    python bin/search_chatbot_content.py --site ananda --term "Rajashijanakaranda" -e prod --firestore-only

    # Search only Pinecone source documents
    python bin/search_chatbot_content.py --site ananda --term "Rajashijanakaranda" -e prod --pinecone-only

    # Case-sensitive search
    python bin/search_chatbot_content.py --site ananda --term "Rajashijanakaranda" -e prod --case-sensitive
"""

import argparse
import json
import os
import time
from datetime import datetime

from google.cloud import firestore
from google.oauth2 import service_account
from pinecone import Pinecone

from pyutil.env_utils import load_env

# ---------------------------------------------------------------------------
# Firestore helpers
# ---------------------------------------------------------------------------


def initialize_firestore():
    """Initialize Firestore client using service account credentials."""
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

    return firestore.Client(credentials=credentials)


def search_firestore(db, env_prefix: str, term: str, case_sensitive: bool) -> list:
    """Search Firestore chatLogs for documents containing the term.

    Streams all documents and filters server-side. This is necessary because
    Firestore has no full-text search capability.
    """
    collection_name = f"{env_prefix}_chatLogs"
    print(f"\nSearching Firestore collection: {collection_name}")
    print(f"Term: '{term}' (case-{'sensitive' if case_sensitive else 'insensitive'})")
    print("-" * 60)

    search_term = term if case_sensitive else term.lower()
    matches = []
    scanned = 0
    batch_size = 500
    last_doc = None
    start_time = time.time()

    while True:
        query = (
            db.collection(collection_name)
            .order_by("timestamp", direction=firestore.Query.DESCENDING)
            .limit(batch_size)
        )
        if last_doc:
            query = query.start_after(last_doc)

        docs = list(query.stream())
        if not docs:
            break

        for doc in docs:
            scanned += 1
            data = doc.to_dict()

            answer = data.get("answer", "") or ""
            question = data.get("question", "") or ""

            answer_check = answer if case_sensitive else answer.lower()
            question_check = question if case_sensitive else question.lower()

            found_in = []
            if search_term in answer_check:
                found_in.append("answer")
            if search_term in question_check:
                found_in.append("question")

            if found_in:
                timestamp = data.get("timestamp")
                ts_str = (
                    timestamp.strftime("%Y-%m-%d %H:%M:%S")
                    if isinstance(timestamp, datetime)
                    else str(timestamp)
                )

                matches.append(
                    {
                        "doc_id": doc.id,
                        "found_in": found_in,
                        "timestamp": ts_str,
                        "question": question[:200],
                        "answer_snippet": _extract_snippet(
                            answer, term, case_sensitive
                        ),
                        "conv_id": data.get("convId", "N/A"),
                        "uuid": data.get("uuid", "N/A"),
                        "collection": data.get("collection", "N/A"),
                        "model": data.get("model", "N/A"),
                        "sources_summary": _summarize_sources(data.get("sources")),
                    }
                )

        last_doc = docs[-1]

        # Progress update every batch
        elapsed = time.time() - start_time
        print(
            f"  Scanned {scanned} documents... "
            f"({len(matches)} matches found, {elapsed:.1f}s elapsed)",
            end="\r",
        )

    elapsed = time.time() - start_time
    print(f"\n  Done. Scanned {scanned} documents in {elapsed:.1f}s.")
    return matches


def _extract_snippet(
    text: str, term: str, case_sensitive: bool, context: int = 120
) -> str:
    """Extract a snippet of text around the search term."""
    search_text = text if case_sensitive else text.lower()
    search_term = term if case_sensitive else term.lower()

    idx = search_text.find(search_term)
    if idx == -1:
        return text[:250] + "..." if len(text) > 250 else text

    start = max(0, idx - context)
    end = min(len(text), idx + len(term) + context)

    snippet = text[start:end]
    if start > 0:
        snippet = "..." + snippet
    if end < len(text):
        snippet = snippet + "..."

    return snippet


def _summarize_sources(sources_raw) -> str:
    """Extract a brief summary of source documents from the sources field."""
    if not sources_raw:
        return "None"

    try:
        if isinstance(sources_raw, str):
            sources_list = json.loads(sources_raw)
        elif isinstance(sources_raw, list):
            sources_list = sources_raw
        else:
            return "Unknown format"

        titles = []
        for source in sources_list[:3]:
            metadata = source.get("metadata", {}) if isinstance(source, dict) else {}
            title = metadata.get("title", "")
            source_url = metadata.get("source", metadata.get("url", ""))
            if title:
                titles.append(title[:50])
            elif source_url:
                titles.append(source_url[:50])

        summary = "; ".join(titles)
        if len(sources_list) > 3:
            summary += f" (+{len(sources_list) - 3} more)"
        return summary or "No titles"

    except (json.JSONDecodeError, TypeError):
        return "Parse error"


def print_firestore_results(matches: list, term: str) -> None:
    """Print Firestore search results."""
    print(f"\n{'=' * 60}")
    print(f"FIRESTORE RESULTS: {len(matches)} match(es) for '{term}'")
    print(f"{'=' * 60}")

    if not matches:
        print("  No matches found in chatbot answers.")
        return

    for i, match in enumerate(matches, 1):
        print(f"\n--- Match {i} ---")
        print(f"  Doc ID:     {match['doc_id']}")
        print(f"  Found in:   {', '.join(match['found_in'])}")
        print(f"  Timestamp:  {match['timestamp']}")
        print(f"  Conv ID:    {match['conv_id']}")
        print(f"  UUID:       {match['uuid']}")
        print(f"  Collection: {match['collection']}")
        print(f"  Model:      {match['model']}")
        print(f"  Question:   {match['question']}")
        print(f"  Sources:    {match['sources_summary']}")
        print(f"  Snippet:    {match['answer_snippet']}")


# ---------------------------------------------------------------------------
# Pinecone helpers
# ---------------------------------------------------------------------------


def search_pinecone(term: str, case_sensitive: bool) -> list:
    """Search Pinecone vectors for source documents containing the term.

    Lists all vector IDs, fetches them in batches, and checks the text metadata.
    Uses the default (empty) namespace since this project does not use namespaces.
    """
    api_key = os.getenv("PINECONE_API_KEY")
    index_name = os.getenv(
        "PINECONE_INDEX_NAME",
        os.getenv("PINECONE_INGEST_INDEX_NAME", "mega-rag-chatbot"),
    )

    if not api_key:
        print("Warning: PINECONE_API_KEY not set. Skipping Pinecone search.")
        return []

    pc = Pinecone(api_key=api_key)
    index = pc.Index(index_name)

    print(f"\nSearching Pinecone index: {index_name}")
    print(f"Term: '{term}' (case-{'sensitive' if case_sensitive else 'insensitive'})")
    print("-" * 60)

    # Get index stats
    stats = index.describe_index_stats()
    total_vectors = stats.total_vector_count
    print(f"  Total vectors in index: {total_vectors}")

    search_term = term if case_sensitive else term.lower()
    matches = []
    scanned = 0
    # Pinecone vector IDs in this project are long (7-part || delimited),
    # so we use a small batch size to avoid 414 Request-URI Too Large errors.
    fetch_batch_size = 20
    start_time = time.time()

    # Collect all vector IDs first
    print("  Listing vector IDs...", end="", flush=True)
    all_ids = []
    for id_batch in index.list():
        all_ids.extend(id_batch)
        print(f"\r  Listing vector IDs... {len(all_ids)}", end="", flush=True)
    print(f"\r  Listed {len(all_ids)} vector IDs. Fetching metadata...")

    total_batches = (len(all_ids) + fetch_batch_size - 1) // fetch_batch_size

    # Fetch in batches and search text metadata
    for batch_num, i in enumerate(range(0, len(all_ids), fetch_batch_size), start=1):
        batch_ids = all_ids[i : i + fetch_batch_size]
        fetch_response = index.fetch(ids=batch_ids)

        for vec_id, vector in fetch_response.vectors.items():
            scanned += 1
            metadata = vector.metadata or {}
            text = str(metadata.get("text", ""))

            text_check = text if case_sensitive else text.lower()

            if search_term in text_check:
                matches.append(
                    {
                        "vector_id": vec_id,
                        "title": str(metadata.get("title", "N/A")),
                        "author": str(metadata.get("author", "N/A")),
                        "source": str(
                            metadata.get("source", metadata.get("url", "N/A"))
                        ),
                        "type": str(
                            metadata.get("type", metadata.get("content_type", "N/A"))
                        ),
                        "library": str(metadata.get("library", "N/A")),
                        "access_level": str(metadata.get("access_level", "N/A")),
                        "snippet": _extract_snippet(
                            text, term, case_sensitive, context=150
                        ),
                    }
                )
                print(
                    f"  MATCH #{len(matches)}: {vec_id} | {metadata.get('title', 'N/A')} | lib={metadata.get('library', 'N/A')} | access={metadata.get('access_level', 'N/A')}",
                    flush=True,
                )

        elapsed = time.time() - start_time
        pct = (batch_num / total_batches) * 100
        rate = scanned / elapsed if elapsed > 0 else 0
        remaining = (len(all_ids) - scanned) / rate if rate > 0 else 0
        eta_min = int(remaining // 60)
        eta_sec = int(remaining % 60)

        print(
            f"  [{pct:5.1f}%] {scanned:,}/{len(all_ids):,} vectors | "
            f"{len(matches)} match(es) | "
            f"{rate:.0f} vec/s | "
            f"ETA {eta_min}m{eta_sec:02d}s   ",
            end="\r",
            flush=True,
        )

    elapsed = time.time() - start_time
    print(
        f"\n  Done. Scanned {scanned:,} vectors in {elapsed:.1f}s "
        f"({scanned / elapsed:.0f} vec/s)."
    )
    return matches


def print_pinecone_results(matches: list, term: str) -> None:
    """Print Pinecone search results."""
    print(f"\n{'=' * 60}")
    print(f"PINECONE RESULTS: {len(matches)} match(es) for '{term}'")
    print(f"{'=' * 60}")

    if not matches:
        print("  No matches found in source documents.")
        print(
            "  If the term appeared in an answer but not here, it was likely hallucinated."
        )
        return

    for i, match in enumerate(matches, 1):
        print(f"\n--- Source Match {i} ---")
        print(f"  Vector ID:    {match['vector_id']}")
        print(f"  Title:        {match['title']}")
        print(f"  Author:       {match['author']}")
        print(f"  Source:       {match['source']}")
        print(f"  Type:         {match['type']}")
        print(f"  Library:      {match['library']}")
        print(f"  Access Level: {match['access_level']}")
        print(f"  Snippet:      {match['snippet']}")


def _print_summary(
    firestore_matches: list,
    pinecone_matches: list,
    args: argparse.Namespace,
) -> None:
    """Print the final summary and verdict."""
    print(f"\n{'=' * 60}")
    print("SUMMARY")
    print(f"{'=' * 60}")

    if not args.pinecone_only:
        print(f"  Firestore answers:     {len(firestore_matches)} match(es)")
    if not args.firestore_only:
        print(f"  Pinecone source docs:  {len(pinecone_matches)} match(es)")

    if firestore_matches and not pinecone_matches and not args.firestore_only:
        print("\n  VERDICT: Term found in answers but NOT in source documents.")
        print("  This suggests the term was HALLUCINATED by the LLM.")
    elif not firestore_matches and pinecone_matches and not args.pinecone_only:
        print("\n  VERDICT: Term found in source documents but NOT in answers.")
        print("  The source content exists but hasn't appeared in user answers yet.")
    elif firestore_matches and pinecone_matches:
        print("\n  VERDICT: Term found in BOTH answers and source documents.")
        print("  The term came from ingested source content (not hallucinated).")
    elif not firestore_matches and not pinecone_matches:
        print("\n  VERDICT: Term not found in either answers or source documents.")
        print(
            "  The term may have been in a deleted answer, "
            "or the search term may be slightly different."
        )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(
        description="Search chatbot answers and source documents for a reported term.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python bin/search_chatbot_content.py --site ananda --term "Rajashijanakaranda" -e prod
  python bin/search_chatbot_content.py --site ananda --term "some term" -e prod --firestore-only
  python bin/search_chatbot_content.py --site ananda --term "some term" -e prod --pinecone-only
        """,
    )
    parser.add_argument(
        "--site", required=True, help="Site ID for environment variables"
    )
    parser.add_argument(
        "--term",
        required=True,
        help="Term to search for in answers and source documents",
    )
    parser.add_argument(
        "-e",
        "--env",
        choices=["dev", "prod"],
        default="prod",
        help="Environment (default: prod)",
    )
    parser.add_argument(
        "--case-sensitive",
        action="store_true",
        default=False,
        help="Perform case-sensitive search (default: case-insensitive)",
    )
    parser.add_argument(
        "--firestore-only",
        action="store_true",
        default=False,
        help="Only search Firestore chatLogs (skip Pinecone)",
    )
    parser.add_argument(
        "--pinecone-only",
        action="store_true",
        default=False,
        help="Only search Pinecone source documents (skip Firestore)",
    )

    args = parser.parse_args()

    if args.firestore_only and args.pinecone_only:
        parser.error("Cannot use both --firestore-only and --pinecone-only")

    # Load environment
    load_env(args.site)

    print("\nContent Search Tool")
    print(f"Site: {args.site} | Env: {args.env} | Term: '{args.term}'")
    print(f"{'=' * 60}")

    firestore_matches = []
    pinecone_matches = []

    # Search Firestore
    if not args.pinecone_only:
        try:
            db = initialize_firestore()
            firestore_matches = search_firestore(
                db, args.env, args.term, args.case_sensitive
            )
            print_firestore_results(firestore_matches, args.term)
        except Exception as e:
            print(f"\nError searching Firestore: {e}")

    # Search Pinecone
    if not args.firestore_only:
        try:
            pinecone_matches = search_pinecone(args.term, args.case_sensitive)
            print_pinecone_results(pinecone_matches, args.term)
        except Exception as e:
            print(f"\nError searching Pinecone: {e}")

    _print_summary(firestore_matches, pinecone_matches, args)


if __name__ == "__main__":
    main()
