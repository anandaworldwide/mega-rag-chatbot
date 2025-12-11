"""
Pinecone utilities for data ingestion operations.

This module provides comprehensive Pinecone client management, index operations,
and vector manipulation functions for use across different ingestion pipelines
(PDF, HTML/web content, SQL database, audio/video).

Key features:
- Unified Pinecone client initialization with environment validation
- Index creation and configuration with both sync and async support
- Unified vector clearing operations for different content types
- Batch vector operations with retry logic
- Consistent vector ID generation across all ingestion methods
- Comprehensive error handling and logging
"""

import asyncio
import logging
import os
import re
import sys
import time
from collections.abc import Callable
from typing import Any

from pinecone import Pinecone, ServerlessSpec
from pinecone.exceptions import PineconeException

from .document_hash import generate_document_hash

logger = logging.getLogger(__name__)


def get_pinecone_client() -> Pinecone:
    """
    Initialize and return the Pinecone client.

    Validates that the required API key is available and creates a client instance.

    Returns:
        Pinecone: Configured Pinecone client instance

    Raises:
        ValueError: If PINECONE_API_KEY environment variable is not set
    """
    api_key = os.environ.get("PINECONE_API_KEY")
    if not api_key:
        raise ValueError("PINECONE_API_KEY environment variable not set")

    logger.debug("Initializing Pinecone client")
    return Pinecone(api_key=api_key)


def get_pinecone_ingest_index_name() -> str:
    """
    Get the Pinecone index name for ingestion operations.

    Returns:
        str: The index name from environment variable

    Raises:
        ValueError: If PINECONE_INGEST_INDEX_NAME environment variable is not set
    """
    index_name = os.environ.get("PINECONE_INGEST_INDEX_NAME")
    if not index_name:
        raise ValueError("PINECONE_INGEST_INDEX_NAME environment variable not set")

    return index_name


def validate_pinecone_config() -> dict[str, str]:
    """
    Validate that all required Pinecone configuration is available.

    Returns:
        Dict[str, str]: Dictionary of validated configuration values

    Raises:
        ValueError: If any required configuration is missing
    """
    required_vars = {
        "PINECONE_API_KEY": os.environ.get("PINECONE_API_KEY"),
        "PINECONE_INGEST_INDEX_NAME": os.environ.get("PINECONE_INGEST_INDEX_NAME"),
        "OPENAI_INGEST_EMBEDDINGS_DIMENSION": os.environ.get(
            "OPENAI_INGEST_EMBEDDINGS_DIMENSION"
        ),
        "PINECONE_CLOUD": os.environ.get("PINECONE_CLOUD"),
        "PINECONE_REGION": os.environ.get("PINECONE_REGION"),
    }

    missing_vars = [var for var, value in required_vars.items() if not value]
    if missing_vars:
        raise ValueError(
            f"Missing required environment variables: {', '.join(missing_vars)}"
        )

    # After validation, all values are guaranteed to be strings
    validated_vars: dict[str, str] = {
        k: v for k, v in required_vars.items() if v is not None
    }

    # Validate dimension is a valid integer
    try:
        dimension = int(validated_vars["OPENAI_INGEST_EMBEDDINGS_DIMENSION"])
        if dimension <= 0:
            raise ValueError(
                "OPENAI_INGEST_EMBEDDINGS_DIMENSION must be a positive integer"
            )
        validated_vars["OPENAI_INGEST_EMBEDDINGS_DIMENSION"] = str(dimension)
    except ValueError as e:
        if "invalid literal" in str(e):
            raise ValueError(
                "OPENAI_INGEST_EMBEDDINGS_DIMENSION must be a valid integer"
            ) from e
        raise

    return validated_vars


def create_pinecone_index_if_not_exists(
    pinecone: Pinecone,
    index_name: str,
    dry_run: bool = False,
    wait_for_ready: bool = True,
    timeout: int = 300,
) -> None:
    """
    Creates a Pinecone index if it doesn't already exist (synchronous version).

    Args:
        pinecone: Pinecone client instance
        index_name: Name of the index to create
        dry_run: If True, asks for confirmation before creating index
        wait_for_ready: If True, waits for index to be ready before returning
        timeout: Maximum time to wait for index creation (seconds)

    Raises:
        ValueError: If required environment variables are not set
        SystemExit: On critical errors during index creation
    """
    try:
        index_desc = pinecone.describe_index(index_name)
    except PineconeException as e:
        if "404" in str(e) or "not found" in str(e).lower():
            pass  # Index not found, proceed to create
        else:
            print(f"Error checking Pinecone index: {e}")
            sys.exit(1)
    except Exception as e:
        print(f"Unexpected error checking Pinecone index: {e}")
        sys.exit(1)
    else:
        print(f"Index {index_name} already exists")
        return

    # Index doesn't exist, handle creation
    if dry_run:
        confirm = input(
            f"Dry run: Index '{index_name}' does not exist. Create it? (Y/n): "
        )
        if confirm.lower() in ["n", "no"]:
            print("Index creation declined. Cannot proceed without an existing index.")
            sys.exit(1)

    print(f"Index '{index_name}' does not exist. Creating...")

    try:
        config = validate_pinecone_config()

        spec = ServerlessSpec(
            cloud=config["PINECONE_CLOUD"], region=config["PINECONE_REGION"]
        )

        pinecone.create_index(
            name=index_name,
            dimension=int(config["OPENAI_INGEST_EMBEDDINGS_DIMENSION"]),
            metric="cosine",
            spec=spec,
        )

        if wait_for_ready:
            print(
                f"Waiting for index '{index_name}' to be ready (timeout: {timeout}s)..."
            )
            start_time = time.time()

            while time.time() - start_time < timeout:
                try:
                    index_desc = pinecone.describe_index(index_name)
                    if index_desc.status.get("ready", False):
                        break
                except Exception:
                    pass
                time.sleep(5)
            else:
                print(f"Timeout waiting for index '{index_name}' to become ready.")
                sys.exit(1)

        print(f"Index '{index_name}' created successfully.")

    except Exception as e:
        print(f"Error creating Pinecone index '{index_name}': {e}")
        sys.exit(1)


async def create_pinecone_index_if_not_exists_async(
    pinecone: Pinecone, index_name: str, wait_for_ready: bool = True, timeout: int = 300
) -> None:
    """
    Creates a Pinecone index if it doesn't already exist (asynchronous version).

    Args:
        pinecone: Pinecone client instance
        index_name: Name of the index to create
        wait_for_ready: If True, waits for index to be ready before returning
        timeout: Maximum time to wait for index creation (seconds)

    Raises:
        ValueError: If required environment variables are not set
        SystemExit: On critical errors during index creation
    """
    try:
        index_desc = await asyncio.to_thread(pinecone.describe_index, index_name)
    except PineconeException as e:
        if "404" in str(e) or "not found" in str(e).lower():
            pass  # Index not found, proceed to create
        else:
            print(f"Error checking Pinecone index: {e}")
            sys.exit(1)
    except Exception as e:
        print(f"Unexpected error checking Pinecone index: {e}")
        sys.exit(1)
    else:
        print(f"Index {index_name} already exists")
        return

    print(f"Index {index_name} does not exist. Creating...")

    try:
        config = validate_pinecone_config()

        spec = ServerlessSpec(
            cloud=config["PINECONE_CLOUD"], region=config["PINECONE_REGION"]
        )

        await asyncio.to_thread(
            pinecone.create_index,
            name=index_name,
            dimension=int(config["OPENAI_INGEST_EMBEDDINGS_DIMENSION"]),
            metric="cosine",
            spec=spec,
        )

        if wait_for_ready:
            print(
                f"Waiting for index '{index_name}' to be ready (timeout: {timeout}s)..."
            )
            start_time = time.time()

            while time.time() - start_time < timeout:
                try:
                    index_desc = await asyncio.to_thread(
                        pinecone.describe_index, index_name
                    )
                    if index_desc.status.get("ready", False):
                        break
                except Exception:
                    pass
                await asyncio.sleep(5)
            else:
                print(f"Timeout waiting for index '{index_name}' to become ready.")
                sys.exit(1)

        print(f"Index '{index_name}' created successfully.")

    except Exception as e:
        print(f"Error creating Pinecone index '{index_name}': {e}")
        sys.exit(1)


def clear_library_vectors(
    pinecone_index: Any,
    library_name: str,
    dry_run: bool = False,
    ask_confirmation: bool = True,
    progress_callback: Callable | None = None,
) -> bool:
    """
    Delete all vectors associated with a specific library (synchronous version).

    Unified function that works for both PDF and SQL ingestion patterns.
    Handles different Pinecone API response formats robustly.

    Args:
        pinecone_index: Pinecone index instance
        library_name: Name of the library to clear vectors for
        dry_run: If True, only lists vectors without deleting
        ask_confirmation: If True, asks for user confirmation before deletion
        progress_callback: Optional function to call for progress updates

    Returns:
        bool: True if operation completed successfully, False otherwise
    """
    if dry_run:
        print(f"Dry run: Skipping vector deletion for library '{library_name}'.")
        return True

    prefix = f"text||{library_name}||"
    print(f"Listing existing vectors with prefix '{prefix}'...")

    vector_ids = []
    total_listed = 0
    batch_limit = 100

    try:
        # Use the list() generator to get all vector IDs
        list_response_generator = pinecone_index.list(prefix=prefix, limit=batch_limit)

        for id_batch in list_response_generator:
            if isinstance(id_batch, list):
                vector_ids.extend(id_batch)
                total_listed += len(id_batch)

                if progress_callback:
                    progress_callback(total_listed, 0, "listing")

                # Progress update
                if total_listed > 0 and total_listed % 1000 == 0:
                    print(f"Listed {total_listed} vectors so far...")
            else:
                logger.warning(f"Unexpected vector info format: {type(id_batch)}")

        print(f"Found {len(vector_ids)} vectors for library '{library_name}'")

    except Exception as e:
        print(f"Error listing vectors for library '{library_name}': {e}")
        logger.exception("Vector listing error")
        return False

    if not vector_ids:
        print("No existing vectors found for this library.")
        return True

    # Ask for confirmation unless disabled
    if ask_confirmation:
        try:
            confirm = input(
                f"Delete ALL {len(vector_ids)} vectors for library '{library_name}'? This cannot be undone. (y/N): "
            )
            if confirm.lower() != "y":
                print("Deletion aborted by user.")
                return False
        except KeyboardInterrupt:
            print("\nDeletion aborted by user (Ctrl+C).")
            return False

    # Delete in batches
    print("Deleting vectors in batches...")
    delete_batch_size = 1000
    total_deleted = 0

    try:
        for i in range(0, len(vector_ids), delete_batch_size):
            batch_ids = vector_ids[i : i + delete_batch_size]
            pinecone_index.delete(ids=batch_ids)
            total_deleted += len(batch_ids)

            if progress_callback:
                progress_callback(len(vector_ids), total_deleted, "deleting")

            print(f"Deleted {total_deleted}/{len(vector_ids)} vectors...")

        print(
            f"Successfully deleted {total_deleted} vectors for library '{library_name}'"
        )
        return True

    except Exception as e:
        print(f"Error deleting vectors: {e}")
        logger.exception("Vector deletion error")
        return False


async def clear_library_vectors_async(
    pinecone_index: Any,
    library_name: str,
    progress_callback: Callable | None = None,
) -> bool:
    """
    Delete all vectors associated with a specific library (asynchronous version).

    Args:
        pinecone_index: Pinecone index instance
        library_name: Name of the library to clear vectors for
        progress_callback: Optional function to call for progress updates

    Returns:
        bool: True if operation completed successfully, False otherwise
    """
    prefix = f"text||{library_name}||"
    print(f"Clearing existing {library_name} vectors from Pinecone...")

    try:
        pagination_token = None
        total_deleted = 0

        while True:
            # Get vector IDs using list API
            list_args = {"prefix": prefix}
            if pagination_token:
                list_args["pagination_token"] = pagination_token

            returned_from_list = await asyncio.to_thread(
                pinecone_index.list, **list_args
            )

            # Handle different response types from Pinecone API
            vector_ids_to_delete = []

            if hasattr(returned_from_list, "__next__"):  # Generator
                try:
                    while True:
                        page_response = next(returned_from_list)
                        if isinstance(page_response, list) and page_response:
                            vector_ids_to_delete.extend(
                                [
                                    vector.id if hasattr(vector, "id") else vector
                                    for vector in page_response
                                    if vector
                                ]
                            )
                except StopIteration:
                    pass
                pagination_token = None  # Generator exhausted

            elif isinstance(returned_from_list, list):
                vector_ids_to_delete = [
                    vector.id if hasattr(vector, "id") else vector
                    for vector in returned_from_list
                    if vector
                ]
                pagination_token = None  # Direct list, no pagination

            else:  # Response object
                response = returned_from_list
                if hasattr(response, "vectors") and response.vectors:
                    vector_ids_to_delete = [
                        vector.id if hasattr(vector, "id") else vector
                        for vector in response.vectors
                        if vector
                    ]

                pagination_token = (
                    response.pagination.next
                    if hasattr(response, "pagination")
                    and response.pagination
                    and response.pagination.next
                    else None
                )

            # Delete current batch
            if vector_ids_to_delete:
                await asyncio.to_thread(pinecone_index.delete, ids=vector_ids_to_delete)
                total_deleted += len(vector_ids_to_delete)

                if progress_callback:
                    progress_callback(None, total_deleted, "deleting")

                print(f"Deleted {total_deleted} vectors so far...")

            # Check if we're done
            if not pagination_token or not vector_ids_to_delete:
                break

        print(f"Cleared a total of {total_deleted} {library_name} vectors.")
        return True

    except Exception as e:
        print(f"Error clearing {library_name} vectors: {e}")
        logger.exception("Async vector clearing error")
        return False


def get_index_stats(pinecone_index: Any) -> dict[str, Any]:
    """
    Get comprehensive statistics about a Pinecone index.

    Args:
        pinecone_index: Pinecone index instance

    Returns:
        Dict[str, Any]: Index statistics including total vectors, namespaces, etc.
    """
    try:
        stats = pinecone_index.describe_index_stats()
        return {
            "total_vector_count": stats.total_vector_count,
            "dimension": stats.dimension,
            "index_fullness": stats.index_fullness,
            "namespaces": dict(stats.namespaces) if stats.namespaces else {},
        }
    except Exception as e:
        logger.error(f"Error getting index stats: {e}")
        return {}


def count_vectors_by_prefix(pinecone_index: Any, prefix: str) -> int:
    """
    Count vectors matching a specific prefix.

    Args:
        pinecone_index: Pinecone index instance
        prefix: Prefix to search for

    Returns:
        int: Number of vectors matching the prefix
    """
    try:
        count = 0
        list_response_generator = pinecone_index.list(prefix=prefix, limit=100)

        for id_batch in list_response_generator:
            if isinstance(id_batch, list):
                count += len(id_batch)

        return count
    except Exception as e:
        logger.error(f"Error counting vectors with prefix '{prefix}': {e}")
        return 0


def batch_upsert_vectors(
    pinecone_index: Any,
    vectors: list[dict[str, Any]],
    batch_size: int = 100,
    progress_callback: Callable | None = None,
) -> tuple[bool, int]:
    """
    Upsert vectors to Pinecone in batches with error handling.

    Args:
        pinecone_index: Pinecone index instance
        vectors: List of vector dictionaries with 'id', 'values', 'metadata'
        batch_size: Number of vectors to upsert per batch
        progress_callback: Optional function to call for progress updates

    Returns:
        Tuple[bool, int]: (success, number_of_vectors_upserted)
    """
    total_upserted = 0

    try:
        for i in range(0, len(vectors), batch_size):
            batch = vectors[i : i + batch_size]

            try:
                pinecone_index.upsert(vectors=batch)
                total_upserted += len(batch)

                if progress_callback:
                    progress_callback(len(vectors), total_upserted, "upserting")

                logger.debug(
                    f"Upserted batch {i // batch_size + 1}: {len(batch)} vectors"
                )

            except Exception as e:
                logger.error(f"Error upserting batch {i // batch_size + 1}: {e}")
                # Continue with next batch rather than failing completely
                continue

        logger.info(f"Successfully upserted {total_upserted}/{len(vectors)} vectors")
        return True, total_upserted

    except Exception as e:
        logger.error(f"Error in batch upsert operation: {e}")
        return False, total_upserted


# --- Vector ID Generation ---


def generate_vector_id(
    library_name: str,
    title: str,
    chunk_index: int,
    source_location: str,
    source_identifier: str,
    content_type: str = "text",
    author: str | None = None,
    chunk_text: str | None = None,
) -> str:
    """
    Generate a consistent vector ID for Pinecone storage with content-based hashing.

    The hash is now based only on intrinsic content properties (title, author, content_type, chunk_text)
    to enable deduplication across different libraries and source locations.

    Args:
        library_name: Name of the library/collection
        title: Title of the source document/content
        chunk_index: Index of this chunk within the source
        source_location: Where the content came from (web, db, pdf, api, s3)
        source_identifier: Unique identifier for the source (URL, file path, permalink, etc.)
        content_type: What type of content (text, audio, video, pdf)
        author: Optional author for document hash generation
        chunk_text: The actual text content of the chunk (for content-based hashing)

    Returns:
        A unique vector ID following Pinecone requirements

    Format: {content_type}||{library}||{source_location}||{sanitized_title}||{author}||{document_hash}||{chunk_index}

    Note: The document_hash is now based on content properties only, not source/library information.
    """

    # Sanitize inputs: only remove null characters (the only character Pinecone prohibits)
    # and normalize whitespace, but preserve meaningful punctuation
    sanitized_library = _sanitize_text(library_name)
    sanitized_title = _sanitize_text(title)
    sanitized_author = _sanitize_text(author)[:20] if author else ""

    # Limit title length to avoid overly long IDs
    sanitized_title = sanitized_title[:50]

    # Generate content-based hash for deduplication across libraries/sources
    document_hash = generate_document_hash(
        title=title,
        author=author,
        content_type=content_type,
        chunk_text=chunk_text,
    )

    # Construct vector ID with new 7-part format (content_type first for compatibility)
    vector_id = f"{content_type}||{sanitized_library}||{source_location}||{sanitized_title}||{sanitized_author}||{document_hash}||{chunk_index}"

    return vector_id


def _sanitize_text(text: str) -> str:
    """
    Sanitize text for use in vector IDs.

    Removes characters that Pinecone prohibits:
    - Null characters (\x00)
    - Non-ASCII characters (Pinecone requires ASCII-only vector IDs)

    Normalizes whitespace but preserves all other ASCII characters including
    punctuation, special characters, etc.

    Args:
        text: Text to sanitize

    Returns:
        Sanitized text safe for Pinecone vector IDs
    """
    if not text:
        return ""

    # Normalize whitespace (collapse multiple spaces/tabs/newlines to single space)
    sanitized = re.sub(r"\s+", " ", text.strip())

    # Remove null characters
    sanitized = re.sub(r"\x00", "", sanitized)

    # Remove non-ASCII characters (Pinecone requires ASCII-only vector IDs)
    sanitized = "".join(char for char in sanitized if ord(char) < 128)

    return sanitized


def extract_metadata_from_vector_id(vector_id: str) -> dict:
    """
    Extract metadata from a vector ID created by generate_vector_id.

    Args:
        vector_id: Vector ID to parse

    Returns:
        Dictionary with extracted metadata
    """
    try:
        parts = vector_id.split("||")
        if len(parts) < 7:
            return {"error": "Invalid vector ID format"}

        content_type = parts[0]
        library_name = parts[1]
        source_location = parts[2]
        title = parts[3]
        source_id = parts[4] if parts[4] else None
        content_hash = parts[5]
        chunk_index_str = parts[6]

        try:
            chunk_index = int(chunk_index_str)
        except ValueError:
            chunk_index = 0

        return {
            "library_name": library_name,
            "source_location": source_location,
            "content_type": content_type,
            "title": title,
            "source_id": source_id,
            "content_hash": content_hash,
            "chunk_index": chunk_index,
        }
    except Exception as e:
        return {"error": f"Failed to parse vector ID: {str(e)}"}
