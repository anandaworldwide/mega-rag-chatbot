#!/usr/bin/env python

"""
Vector Database Statistics Generator

This script analyzes a Pinecone vector database to generate statistics about stored vectors,
specifically counting occurrences of metadata fields (author, library, type). It uses
systematic enumeration via index.list() with batching and fetch() to avoid vector space clustering bias.

Optimized for speed with batched ID collection (100 IDs per API call) and
efficient metadata fetching (100 vectors per API call).

Usage:
    python bin/vector_db_stats.py --site <site_id> [--prefix <id_prefix>] [--use-non-ingest|-n]
    python bin/vector_db_stats.py --site <site_id> --env <dev|prod> --write-firestore
    python bin/vector_db_stats.py --site <site_id> --list-unknown-authors

Example:
    python bin/vector_db_stats.py --site ananda
    python bin/vector_db_stats.py --site ananda --prefix "text||Crystal Clarity||"
    python bin/vector_db_stats.py --site ananda --use-non-ingest
    python bin/vector_db_stats.py --site ananda --env prod --write-firestore
    python bin/vector_db_stats.py --site ananda --list-unknown-authors

Unknown authors:
    Count a missing, empty, or blank author as "Unknown author".
    --list-unknown-authors reads Pinecone and prints the source documents.
    That command does not write to Pinecone or Firestore.

Firestore Integration:
    Use --write-firestore flag to write stats directly to Firestore for UI consumption.
    Stats are written to the 'libraryStats' collection with site ID as document ID.
    The --env flag (dev or prod) determines which Firestore environment to write to.

Weekly Cron Setup:
    To automatically update stats weekly, add to crontab (run weekly on Sundays at 2 AM):

    # Ananda site - prod
    0 2 * * 0 cd /path/to/mega-rag-chatbot && python bin/vector_db_stats.py --site ananda --env prod --write-firestore >> /var/log/library_stats_ananda_prod.log 2>&1

    # Ananda site - dev
    30 2 * * 0 cd /path/to/mega-rag-chatbot && python bin/vector_db_stats.py --site ananda --env dev --write-firestore >> /var/log/library_stats_ananda_dev.log 2>&1

    # Ananda-public site - prod
    0 3 * * 0 cd /path/to/mega-rag-chatbot && python bin/vector_db_stats.py --site ananda-public --env prod --write-firestore >> /var/log/library_stats_ananda_public_prod.log 2>&1

    # Ananda-public site - dev
    30 3 * * 0 cd /path/to/mega-rag-chatbot && python bin/vector_db_stats.py --site ananda-public --env dev --write-firestore >> /var/log/library_stats_ananda_public_dev.log 2>&1

    Note: Stagger jobs by 30 minutes to avoid overloading the system.
    Note: Replace /path/to/mega-rag-chatbot with your actual project path.
"""

import argparse
import csv
import json
import os
import sys
import time
from collections import Counter
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import firebase_admin
from firebase_admin import credentials, firestore
from pinecone import Pinecone
from tqdm import tqdm

# Ensure the repo root is importable when this script is run by file path
# (Python puts bin/ on sys.path[0], not the repo root, so `pyutil` would be missing).
_REPO_ROOT = Path(__file__).resolve().parents[1]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from pyutil.env_utils import load_env  # noqa: E402

# Firestore map keys must be non-empty strings. One label holds every blank author.
UNKNOWN_AUTHOR = "Unknown author"
UNKNOWN_LIBRARY = "Unknown library"
UNKNOWN_TYPE = "Unknown type"
_FIRESTORE_MAP_FIELDS = ("authors", "libraries", "mediaTypes")


def firestore_map_key(value, fallback):
    """Return a non-empty string key. A blank value uses fallback."""
    if isinstance(value, str) and value.strip():
        return value
    return fallback


def author_value_is_unknown(metadata):
    """Return True when the chunk has no usable author string."""
    if not metadata or "author" not in metadata:
        return True
    value = metadata.get("author")
    return not isinstance(value, str) or not value.strip()


def unknown_author_warning_line(chunk_count):
    """Build the one warning line for chunks that have no author."""
    return (
        f"Warning: {chunk_count:,} chunks have no author. "
        f'The script counts them as "{UNKNOWN_AUTHOR}".'
    )


def _metadata_text(metadata, key):
    value = metadata.get(key) if metadata else None
    if isinstance(value, str):
        return value.strip()
    return ""


def collect_vector_ids(index, id_prefix, vectors_to_process):
    """
    Collect vector IDs using systematic enumeration.
    """
    all_ids = []
    ids_collected = 0
    batch_size = 100
    api_calls_made = 0

    id_pbar = tqdm(total=vectors_to_process, desc="Collecting IDs")

    try:
        # Use Pinecone's automatic pagination - the generator handles pagination tokens internally
        if id_prefix:
            list_result = index.list(prefix=id_prefix, limit=batch_size)
        else:
            list_result = index.list(limit=batch_size)

        # Iterate over the generator - each iteration gives us a batch of IDs
        for batch_ids in list_result:
            api_calls_made += 1
            page_ids_count = len(batch_ids)

            # TODO: Why do we add these one by one? Can't we just add the whole batch?
            for vector_id in batch_ids:
                all_ids.append(vector_id)
                ids_collected += 1

                if ids_collected >= vectors_to_process:
                    break

            id_pbar.update(page_ids_count)

            if ids_collected >= vectors_to_process:
                break

        id_pbar.close()

    except Exception as e:
        id_pbar.close()
        print(f"Error during ID collection: {e}", flush=True)
        raise

    return all_ids, api_calls_made


def _add_library_document(library_documents, library_key, vector_id, metadata):
    if library_key not in library_documents:
        library_documents[library_key] = set()

    doc_id = extract_document_identifier(vector_id, metadata)
    if doc_id:
        library_documents[library_key].add(doc_id)


def process_vector_metadata(vector_id, vector_data, stats, library_documents):
    """Count one vector. Return 1 when the author is unknown."""
    metadata = vector_data.metadata or {}

    if author_value_is_unknown(metadata):
        stats["author"][UNKNOWN_AUTHOR] += 1
        unknown_author_chunks = 1
    else:
        stats["author"][metadata["author"]] += 1
        unknown_author_chunks = 0

    if "library" in metadata:
        raw_library = metadata.get("library")
        library_key = firestore_map_key(raw_library, UNKNOWN_LIBRARY)
        stats["library"][library_key] += 1
        # Keep the old rule: only a truthy library contributes a document id.
        if raw_library:
            _add_library_document(library_documents, library_key, vector_id, metadata)

    if "type" in metadata:
        type_key = firestore_map_key(metadata.get("type"), UNKNOWN_TYPE)
        stats["type"][type_key] += 1

    return unknown_author_chunks


def fetch_and_process_metadata(index, all_ids, stats, library_documents):
    """
    Fetch metadata in batches and process statistics.
    """
    fetch_batch_size = (
        20  # Reduced from 100 to avoid Request-URI Too Large errors with long IDs
    )
    total_processed = 0
    fetch_api_calls = 0

    fetch_pbar = tqdm(total=len(all_ids), desc="Fetching metadata")
    unknown_author_chunks = 0

    for i in range(0, len(all_ids), fetch_batch_size):
        batch_ids = all_ids[i : i + fetch_batch_size]
        batch_ids = [str(id_val) for id_val in batch_ids]

        try:
            fetch_result = index.fetch(ids=batch_ids)
            fetch_api_calls += 1

            for vector_id, vector_data in fetch_result.vectors.items():
                unknown_author_chunks += process_vector_metadata(
                    vector_id, vector_data, stats, library_documents
                )

            total_processed += len(batch_ids)
            fetch_pbar.update(len(batch_ids))

        except Exception as e:
            print(f"\nError fetching batch at position {i}: {e}")
            continue

    fetch_pbar.close()
    return total_processed, fetch_api_calls, unknown_author_chunks


def get_pinecone_stats(index_name, id_prefix=None, max_vectors=None):
    """
    Retrieves and aggregates statistics from Pinecone vectors using systematic enumeration.
    Uses index.list() + fetch() to avoid vector space clustering bias from query() approach.

    Args:
        index_name (str): Name of the Pinecone index to query
        id_prefix (str, optional): Filter vectors by ID prefix
        max_vectors (int, optional): Maximum number of vectors to process
    """
    pc = Pinecone(api_key=os.getenv("PINECONE_API_KEY"))
    index = pc.Index(index_name)

    stats = {"author": Counter(), "library": Counter(), "type": Counter()}

    library_documents = {}

    index_stats = index.describe_index_stats()
    total_vectors = index_stats.total_vector_count

    print(f"Index has {total_vectors:,} total vectors")

    vectors_to_process = min(max_vectors or total_vectors, total_vectors)
    print(f"Processing {vectors_to_process:,} vectors using systematic enumeration...")

    print("Phase 1: Collecting vector IDs...")
    id_collection_start = time.time()
    all_ids, api_calls_made = collect_vector_ids(index, id_prefix, vectors_to_process)
    id_collection_end = time.time()
    id_collection_time = id_collection_end - id_collection_start

    if not all_ids:
        print("No vectors found matching criteria")
        return stats, {}, 0

    print(
        f"Collected {len(all_ids):,} vector IDs in {id_collection_time:.1f}s using {api_calls_made} API calls"
    )
    print(
        f"Average: {len(all_ids) / api_calls_made:.0f} IDs per API call, {len(all_ids) / id_collection_time:.0f} IDs per second"
    )

    print("Phase 2: Fetching metadata...")
    metadata_fetch_start = time.time()
    total_processed, fetch_api_calls, unknown_author_chunks = (
        fetch_and_process_metadata(index, all_ids, stats, library_documents)
    )
    metadata_fetch_end = time.time()
    metadata_fetch_time = metadata_fetch_end - metadata_fetch_start
    print(
        f"Successfully processed metadata for {total_processed:,} vectors in {metadata_fetch_time:.1f}s using {fetch_api_calls} API calls"
    )

    if fetch_api_calls > 0 and metadata_fetch_time > 0:
        print(
            f"Average: {total_processed / fetch_api_calls:.0f} vectors per API call, {total_processed / metadata_fetch_time:.0f} vectors per second"
        )
    else:
        print("No successful metadata fetches - check for API errors above")

    library_doc_counts = {lib: len(docs) for lib, docs in library_documents.items()}

    return stats, library_doc_counts, unknown_author_chunks


def extract_document_identifier(vector_id, metadata):
    """
    Extract a unique document identifier from vector ID or metadata.

    Current vector ID format: {content_type}||{library}||{source_location}||{sanitized_title}||{sanitized_author}||{document_hash}||{chunk_index}

    Since document_hash is chunk-specific (includes chunk_text), we need to exclude both
    document_hash and chunk_index to get a proper document identifier.

    Args:
        vector_id: The vector ID string
        metadata: Vector metadata dict

    Returns:
        str: Unique document identifier
    """
    try:
        # Try to extract from vector ID first (most reliable)
        if "||" in vector_id:
            parts = vector_id.split("||")
            if len(parts) >= 7:
                # Use first 5 parts: {content_type}||{library}||{source_location}||{sanitized_title}||{sanitized_author}
                # Exclude both document_hash and chunk_index since document_hash is chunk-specific
                doc_id = "||".join(parts[:5])
                return doc_id
            elif len(parts) >= 6:
                # Fallback for older 6-part format: {type}||{library}||{source}||{title}||{author}||{chunk_index}
                doc_id = "||".join(parts[:-1])
                return doc_id

        # Fallback: try to construct from metadata
        if metadata:
            # Try to use file_hash if available (document-level hash)
            if "file_hash" in metadata:
                library = metadata.get("library", "unknown")
                return f"{library}||{metadata['file_hash']}"

            # Another fallback: use source + title combination
            source = metadata.get("source", "")
            title = metadata.get("title", "")
            if source or title:
                library = metadata.get("library", "unknown")
                return f"{library}||{source}||{title}"

        # Last resort: return the vector ID without chunk index if we can parse it
        if "_chunk_" in vector_id:
            return vector_id.split("_chunk_")[0]

        return None

    except (AttributeError, IndexError, KeyError):
        # Silently ignore parsing errors for document identification
        return None


def print_stats(stats, library_doc_counts, unknown_author_chunks=0):
    """
    Prints formatted statistics for each metadata category.

    Args:
        stats: Dictionary containing Counters for each metadata field
        library_doc_counts: Dictionary of library -> unique document count
        unknown_author_chunks: Chunks counted under "Unknown author"
    """
    if unknown_author_chunks:
        print(unknown_author_warning_line(unknown_author_chunks))

    for category, counter in stats.items():
        print(f"\n{category.upper()} STATS:")

        if category == "library":
            # Special handling for libraries - show both chunks and documents
            print(f"{'Library':<20} {'Chunks':<10} {'Documents':<10}")
            print("-" * 42)
            for library, chunk_count in counter.most_common():
                doc_count = library_doc_counts.get(library, 0)
                print(f"{library:<20} {chunk_count:<10,} {doc_count:<10,}")
        else:
            # For author and type, just show chunk counts
            for item, count in counter.most_common():
                print(f"  {item}: {count:,}")


def _initialize_firebase_admin(env: str) -> None:
    """Initialize Firebase Admin from GOOGLE_APPLICATION_CREDENTIALS (idempotent)."""
    if firebase_admin._apps:
        return

    print(f"\nInitializing Firebase Admin for {env} environment...")

    google_credentials_json = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
    if not google_credentials_json:
        raise ValueError(
            "GOOGLE_APPLICATION_CREDENTIALS environment variable is not set.\n"
            "This should contain the full JSON service account credentials."
        )

    try:
        service_account = json.loads(google_credentials_json)
    except json.JSONDecodeError as e:
        raise ValueError(
            f"Failed to parse GOOGLE_APPLICATION_CREDENTIALS as JSON: {e}\n"
            "Ensure the environment variable contains valid JSON."
        ) from e

    required_fields = ["type", "project_id", "private_key", "client_email"]
    missing_fields = [f for f in required_fields if f not in service_account]
    if missing_fields:
        raise ValueError(
            f"Service account JSON missing required fields: {', '.join(missing_fields)}"
        )

    cred = credentials.Certificate(service_account)
    firebase_admin.initialize_app(cred)
    print(
        f"✓ Firebase Admin initialized for project: {service_account.get('project_id')}"
    )


def verify_firestore_access(site: str, env: str) -> None:
    """
    Fail fast if Firestore credentials are invalid, BEFORE the long Pinecone scan.

    Performs a lightweight authenticated read to force an OAuth token exchange so a
    rotated/disabled service-account key surfaces immediately instead of after a
    multi-minute scan whose results would then be discarded.
    """
    print(f"\nVerifying Firestore credentials for {env} environment...")
    _initialize_firebase_admin(env)
    try:
        firestore.client().collection("libraryStats").document(site).get()
    except Exception as e:
        raise RuntimeError(
            "Failed to authenticate with Firestore using GOOGLE_APPLICATION_CREDENTIALS.\n"
            f"Underlying error: {e}\n\n"
            "A rotated or disabled service-account key reports "
            "'invalid_grant: Invalid JWT Signature'. Update the "
            "GOOGLE_APPLICATION_CREDENTIALS secret with a current key for this "
            "service account. See docs/secret-rotation.md."
        ) from e
    print("✓ Firestore credentials verified.")


def coerce_firestore_map(counter, fallback):
    """Merge counts onto non-empty string keys."""
    merged = {}
    for key, count in counter.items():
        safe_key = firestore_map_key(key, fallback)
        merged[safe_key] = merged.get(safe_key, 0) + count
    return merged


def validate_firestore_map_keys(payload):
    """Stop before a write when a map key is empty or not a string."""
    for map_name in _FIRESTORE_MAP_FIELDS:
        for key in payload[map_name]:
            if not isinstance(key, str) or not key.strip():
                raise ValueError(
                    f"The {map_name} map has an empty key. "
                    "The script did not write to Firestore."
                )


def build_stats_payload(stats, site):
    """Build the libraryStats document. Every map key is a non-empty string."""
    authors = coerce_firestore_map(stats["author"], UNKNOWN_AUTHOR)
    # whole_library is the total for the "All authors" choice.
    authors["whole_library"] = sum(stats["author"].values())
    payload = {
        "site": site,
        "libraries": coerce_firestore_map(stats["library"], UNKNOWN_LIBRARY),
        "mediaTypes": coerce_firestore_map(stats["type"], UNKNOWN_TYPE),
        "authors": authors,
        "calculatedAt": datetime.now(UTC),
        "lastUpdated": firestore.SERVER_TIMESTAMP,
    }
    validate_firestore_map_keys(payload)
    return payload


@dataclass(frozen=True)
class UnknownAuthorDocument:
    """One source document whose chunks have no author."""

    title: str
    source: str
    url: str
    chunk_count: int


def group_unknown_author_documents(records):
    """Group unknown-author chunks by title, source, and url."""
    counts = Counter()
    for metadata in records:
        if not author_value_is_unknown(metadata):
            continue
        metadata = metadata or {}
        key = (
            _metadata_text(metadata, "title"),
            _metadata_text(metadata, "source"),
            _metadata_text(metadata, "url"),
        )
        counts[key] += 1

    groups = [
        UnknownAuthorDocument(title, source, url, count)
        for (title, source, url), count in counts.items()
    ]
    groups.sort(key=lambda item: (-item.chunk_count, item.title, item.source, item.url))
    return groups


def _display_field(value):
    return value if value else "(none)"


def print_unknown_author_documents(groups):
    """Print each source document, its chunk count, and the total."""
    total = sum(group.chunk_count for group in groups)
    print("Unknown author documents")
    print(f"{'Chunks':>8} | Title | Source | URL")
    for group in groups:
        print(
            f"{group.chunk_count:8} | {_display_field(group.title)} | "
            f"{_display_field(group.source)} | {_display_field(group.url)}"
        )
    print(f"Total chunks: {total:,}")


def write_unknown_authors_csv(path, groups):
    """Write the document list to a local CSV file. Do not write to a database."""
    with open(path, "w", newline="", encoding="utf-8") as csv_file:
        writer = csv.writer(csv_file)
        writer.writerow(["chunk_count", "title", "source", "url"])
        for group in groups:
            writer.writerow([group.chunk_count, group.title, group.source, group.url])


def _iter_fetched_metadata(index, all_ids):
    fetch_batch_size = 20
    for i in range(0, len(all_ids), fetch_batch_size):
        batch_ids = [str(id_val) for id_val in all_ids[i : i + fetch_batch_size]]
        try:
            fetch_result = index.fetch(ids=batch_ids)
        except Exception as e:
            print(f"\nError fetching batch at position {i}: {e}")
            continue
        vectors = getattr(fetch_result, "vectors", None) or {}
        for _vector_id, vector_data in vectors.items():
            yield getattr(vector_data, "metadata", None) or {}


def collect_unknown_author_documents(index, id_prefix, max_vectors):
    """Read vectors and group chunks that have no author. Do not write."""
    index_stats = index.describe_index_stats()
    total_vectors = index_stats.total_vector_count
    print(f"Index has {total_vectors:,} total vectors")
    vectors_to_process = min(max_vectors or total_vectors, total_vectors)
    print(f"Processing {vectors_to_process:,} vectors using systematic enumeration...")
    all_ids, _api_calls = collect_vector_ids(index, id_prefix, vectors_to_process)
    records = list(_iter_fetched_metadata(index, all_ids))
    return group_unknown_author_documents(records)


def write_stats_to_firestore(stats, site, env):
    """
    Write stats directly to Firestore.

    Args:
        stats: Dictionary containing Counters for each metadata field
        site: Site ID (e.g., 'ananda', 'ananda-public')
        env: Environment ('dev' or 'prod')
    """
    _initialize_firebase_admin(env)
    db = firestore.client()

    stats_data = build_stats_payload(stats, site)

    print(f"\nWriting stats to Firestore for site: {site}")
    print(f"  - Libraries: {len(stats_data['libraries'])} entries")
    print(f"  - Media types: {len(stats_data['mediaTypes'])} entries")
    print(f"  - Authors: {len(stats_data['authors'])} entries")

    # Write to Firestore
    doc_ref = db.collection("libraryStats").document(site)
    try:
        doc_ref.set(stats_data)
    except Exception as e:
        fallback_path = f"library_stats_{site}.json"
        with open(fallback_path, "w", encoding="utf-8") as fallback_file:
            json.dump(stats_data, fallback_file, indent=2, default=str)
        print(f"\n⚠️  Firestore write failed: {e}")
        print(f"   Stats saved locally to {fallback_path} so the scan is not lost.")
        raise

    print("\n✓ Successfully wrote stats to Firestore!")
    print(f"  Document path: libraryStats/{site}")
    print(f"  Environment: {env}")


def build_parser():
    parser = argparse.ArgumentParser(
        description="Count Pinecone vector metadata and write library stats."
    )
    parser.add_argument(
        "--site", required=True, help="Site ID for environment variables."
    )
    parser.add_argument("--prefix", help="Read only vector IDs that use this prefix.")
    parser.add_argument(
        "--use-non-ingest",
        "-n",
        action="store_true",
        help="Read PINECONE_INDEX_NAME instead of PINECONE_INGEST_INDEX_NAME.",
    )
    parser.add_argument(
        "--max-vectors",
        type=int,
        help="Stop after this many vectors. The default is all vectors.",
    )
    parser.add_argument(
        "--env",
        choices=["dev", "prod"],
        help="Choose the dev or prod Firestore database.",
    )
    parser.add_argument(
        "--write-firestore",
        action="store_true",
        help="Write the stats to Firestore. Require --env.",
    )
    parser.add_argument(
        "--list-unknown-authors",
        action="store_true",
        help=(
            "List source documents that have no author. "
            "Read Pinecone only. Do not write to Pinecone or Firestore."
        ),
    )
    parser.add_argument(
        "--unknown-authors-csv",
        metavar="PATH",
        help=(
            "Write the unknown-author document list to this CSV file. "
            "Use this option with --list-unknown-authors."
        ),
    )
    return parser


def resolve_index_name(use_non_ingest):
    """Return the Pinecone index name for this run."""
    if use_non_ingest:
        index_name = os.getenv("PINECONE_INDEX_NAME")
        if not index_name:
            raise ValueError("PINECONE_INDEX_NAME environment variable not set.")
        return index_name

    index_name = os.getenv("PINECONE_INGEST_INDEX_NAME")
    if not index_name:
        raise ValueError("PINECONE_INGEST_INDEX_NAME environment variable not set.")
    return index_name


def _open_index(index_name):
    return Pinecone(api_key=os.getenv("PINECONE_API_KEY")).Index(index_name)


def run_list_unknown_authors(args, index_name):
    """Print unknown-author documents. Do not write to Pinecone or Firestore."""
    index = _open_index(index_name)
    groups = collect_unknown_author_documents(index, args.prefix, args.max_vectors)
    print_unknown_author_documents(groups)
    if args.unknown_authors_csv:
        write_unknown_authors_csv(args.unknown_authors_csv, groups)
        print(f"Wrote {args.unknown_authors_csv}")


def run_stats(args, index_name):
    """Count metadata. Write to Firestore only when --write-firestore is set."""
    # Check credentials before the scan. A bad key then fails in seconds.
    if args.write_firestore:
        if not args.env:
            print("\nError: --env is required when using --write-firestore")
            print("Usage: --env [dev|prod] --write-firestore")
            raise SystemExit(1)
        verify_firestore_access(args.site, args.env)

    start_time = time.time()
    stats, library_doc_counts, unknown_author_chunks = get_pinecone_stats(
        index_name, args.prefix, args.max_vectors
    )
    end_time = time.time()

    print(f"\nCompleted in {end_time - start_time:.1f} seconds")
    print_stats(stats, library_doc_counts, unknown_author_chunks)

    if args.write_firestore:
        write_stats_to_firestore(stats, args.site, args.env)


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.unknown_authors_csv and not args.list_unknown_authors:
        parser.error("Use --unknown-authors-csv with --list-unknown-authors.")
    if args.list_unknown_authors and args.write_firestore:
        parser.error(
            "Do not use --write-firestore with --list-unknown-authors. "
            "This command is read-only."
        )

    load_env(args.site)
    index_name = resolve_index_name(args.use_non_ingest)
    print(f"Using Pinecone database: {index_name}")

    if args.list_unknown_authors:
        run_list_unknown_authors(args, index_name)
        return

    run_stats(args, index_name)


if __name__ == "__main__":
    main()
