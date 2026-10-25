import logging
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

from pinecone import NotFoundException, Pinecone, PineconeException, ServerlessSpec
from urllib3.exceptions import MaxRetryError
from urllib3.exceptions import TimeoutError as Urllib3TimeoutError

from data_ingestion.utils.author_ingest_guard import apply_author_guard_to_vectors
from data_ingestion.utils.credential_errors import abort_on_credential_error
from data_ingestion.utils.pinecone_utils import generate_vector_id

logger = logging.getLogger(__name__)

_AUDIO_VIDEO_CONTENT_TYPES = frozenset({"audio", "video"})
_FILENAME_FETCH_BATCH_SIZE = 20
_FILENAME_FETCH_WORKERS = 8
_FILENAME_FETCH_RETRIES = 3
_FILENAME_FETCH_RETRY_DELAY_SECONDS = 0.2
_FILENAME_FETCH_TIMEOUT_SECONDS = 30.0
_FILENAME_FETCH_TIMEOUT_ENV = "PINECONE_FILENAME_FETCH_TIMEOUT_SECONDS"

"""
Pinecone Vector Database Integration Layer

Handles vector storage and retrieval for media content embeddings with distributed processing support.
Implements robust error handling and retry logic for cloud operations.

Architecture:
- Serverless Pinecone deployment on AWS
- Cosine similarity for vector matching
- Chunked batch processing for large datasets
- Atomic operations with rollback capability

Technical Specifications:
- Vector Dimension: from OPENAI_INGEST_EMBEDDINGS_DIMENSION environment variable
- Index Metric: Cosine Similarity
- Batch Size: 100 vectors per upsert
- Region: us-west-2 (AWS)

Rate Limits:
- Write: 100 vectors per batch
- Concurrent operations: Based on plan
- Retries: Exponential backoff
"""


def validate_and_prepare_chunks(chunks):
    """Validate chunks and prepare texts for embedding.

    Returns:
        tuple: (texts, valid_chunks) where texts is a list of validated text strings
               and valid_chunks is the list of chunk dictionaries that passed validation.
               Both lists are in the same order and have the same length.
    """
    texts = []
    valid_chunks = []

    for i, chunk in enumerate(chunks):
        if not isinstance(chunk, dict):
            logger.warning(f"Chunk {i} is not a dictionary, skipping: {type(chunk)}")
            continue

        if "text" not in chunk:
            logger.warning(f"Chunk {i} missing 'text' field, skipping")
            continue

        text = chunk["text"]

        # Validate text content
        if not isinstance(text, str):
            logger.warning(f"Chunk {i} text is not a string, skipping: {type(text)}")
            continue

        # Check for empty or whitespace-only text
        if not text or not text.strip():
            logger.warning(f"Chunk {i} has empty or whitespace-only text, skipping")
            continue

        # Check for extremely long text that might cause API issues
        if len(text) > 8000:  # OpenAI embeddings have token limits
            logger.warning(
                f"Chunk {i} text is very long ({len(text)} chars), truncating"
            )
            text = text[:8000]
            # Update the chunk's text with the truncated version
            chunk = {**chunk, "text": text}

        texts.append(text)
        valid_chunks.append(chunk)

    if not texts:
        raise ValueError("No valid text chunks found for embedding creation")

    logger.debug(
        f"create_embeddings: Processing {len(texts)} valid text chunks out of {len(chunks)} total"
    )

    return texts, valid_chunks


def call_openai_embeddings_api(texts, client):
    """Call OpenAI embeddings API and validate response."""
    model_name = os.getenv("OPENAI_INGEST_EMBEDDINGS_MODEL")
    if not model_name:
        raise ValueError("OPENAI_INGEST_EMBEDDINGS_MODEL environment variable not set")

    try:
        response = client.embeddings.create(input=texts, model=model_name)
        embeddings = [embedding.embedding for embedding in response.data]

        # Verify we got the expected number of embeddings
        if len(embeddings) != len(texts):
            logger.error(f"Expected {len(texts)} embeddings, got {len(embeddings)}")
            raise ValueError(
                f"Embedding count mismatch: expected {len(texts)}, got {len(embeddings)}"
            )

        logger.debug(f"Successfully created {len(embeddings)} embeddings")
        return embeddings

    except Exception as e:
        logger.error(f"OpenAI embeddings API error: {str(e)}")
        logger.error(f"Model: {model_name}")
        logger.error(f"Number of texts: {len(texts)}")
        logger.error(
            f"Text lengths: {[len(t) for t in texts[:5]]}"
        )  # Log first 5 text lengths
        if texts:
            logger.error(
                f"First text sample: {repr(texts[0][:100])}"
            )  # Log first 100 chars of first text
        raise


def create_embeddings(chunks, client):
    """
    Generates embeddings for text chunks using OpenAI's API.

    Batch Processing:
    - Processes all chunks in single API call
    - Maintains chunk order for vector mapping
    - Returns embeddings and corresponding valid chunks

    Rate Limits: Determined by OpenAI API quotas

    Returns:
        tuple: (embeddings, valid_chunks) where embeddings is a list of vector embeddings
               and valid_chunks is the list of chunk dictionaries that were successfully
               processed. Both lists are in the same order and have the same length.
               Callers should use valid_chunks (not the original chunks) when storing
               to ensure proper alignment between chunks and embeddings.
    """
    texts, valid_chunks = validate_and_prepare_chunks(chunks)
    embeddings = call_openai_embeddings_api(texts, client)
    return embeddings, valid_chunks


def load_pinecone(index_name=None):
    """
    Initializes or connects to Pinecone index with error handling.

    Index Creation Strategy:
    - Attempts creation first (idempotent)
    - Falls back to existing index
    - Validates index parameters

    Error Handling:
    409: Index exists (normal operation)
    500: Infrastructure issues
    Others: Configuration problems
    """
    if not index_name:
        index_name = os.getenv("PINECONE_INGEST_INDEX_NAME")

    if not index_name:
        raise ValueError("PINECONE_INGEST_INDEX_NAME environment variable not set")

    api_key = os.getenv("PINECONE_API_KEY")
    if not api_key:
        raise ValueError("PINECONE_API_KEY environment variable not set")

    pc = Pinecone(api_key=api_key)
    try:
        dimension_str = os.getenv("OPENAI_INGEST_EMBEDDINGS_DIMENSION")
        if not dimension_str:
            raise ValueError(
                "OPENAI_INGEST_EMBEDDINGS_DIMENSION environment variable not set"
            )
        # Get cloud and region from environment variables
        cloud = os.getenv("PINECONE_CLOUD", "aws")
        region = os.getenv("PINECONE_REGION", "us-west-2")

        pc.create_index(
            index_name,
            dimension=int(dimension_str),
            metric="cosine",
            spec=ServerlessSpec(cloud=cloud, region=region),
        )
    except PineconeException as e:
        error_str = str(e).lower()
        if "409" in error_str or "already exists" in error_str:
            logger.info(
                f"Index {index_name} already exists. Proceeding with existing index."
            )
        elif "500" in error_str or "internal server" in error_str:
            logger.error("Internal Server Error. Please try again later.")
        else:
            logger.error(f"Unexpected error: {e}")
            raise
    return pc.Index(index_name)


def _vectors_from_fetch(fetched) -> dict:
    """Return the vectors map from a Pinecone fetch result."""
    if fetched is None:
        return {}
    if hasattr(fetched, "vectors"):
        return fetched.vectors or {}
    if isinstance(fetched, dict):
        return fetched.get("vectors") or {}
    return {}


def _metadata_from_vector(vector) -> dict:
    """Return metadata from a fetched Pinecone vector."""
    if vector is None:
        return {}
    if hasattr(vector, "metadata"):
        return vector.metadata or {}
    if isinstance(vector, dict):
        return vector.get("metadata") or {}
    return {}


def _http_status(exc: BaseException) -> int | None:
    """Return the HTTP status code from the error, if it has one."""
    status = getattr(exc, "status", None)
    if status is None:
        status = getattr(exc, "status_code", None)
    if isinstance(status, int):
        return status
    return None


def _is_rate_limit_error(exc: BaseException) -> bool:
    """Return True when the error has HTTP status 429.

    Do not match the text "429" in the error message.
    """
    return _http_status(exc) == 429


def _is_timeout_error(exc: BaseException) -> bool:
    """Return True when the error is a request timeout.

    pinecone 8.1.0 uses urllib3. A timeout raises urllib3 TimeoutError.
    That class is not a Python TimeoutError. MaxRetryError can wrap it.
    """
    if isinstance(exc, TimeoutError):
        return True
    if isinstance(exc, Urllib3TimeoutError):
        return True
    if isinstance(exc, MaxRetryError):
        reason = getattr(exc, "reason", None)
        if isinstance(reason, TimeoutError | Urllib3TimeoutError):
            return True
    return False


def _is_retryable_fetch_error(exc: BaseException) -> bool:
    """Return True when the fetch error should use the retry budget."""
    return _is_rate_limit_error(exc) or _is_timeout_error(exc)


def _filename_fetch_timeout_seconds() -> float:
    """Return the Pinecone fetch timeout in seconds.

    The default is 30 seconds. Set PINECONE_FILENAME_FETCH_TIMEOUT_SECONDS
    to a positive number to override it.
    """
    raw = os.getenv(_FILENAME_FETCH_TIMEOUT_ENV)
    if raw is None or not raw.strip():
        return _FILENAME_FETCH_TIMEOUT_SECONDS
    try:
        value = float(raw)
    except ValueError:
        return _FILENAME_FETCH_TIMEOUT_SECONDS
    if value <= 0:
        return _FILENAME_FETCH_TIMEOUT_SECONDS
    return value


def _fetch_vectors_batch(pinecone_index, batch: list[str]) -> dict:
    """Fetch one batch of raw vector ids.

    pinecone 8.1.0 fetch takes _request_timeout. A number is the total
    request timeout. The default client value is None, so a stuck
    connection can wait forever. Pass a timeout so that case raises.
    """
    fetched = pinecone_index.fetch(
        ids=batch,
        _request_timeout=_filename_fetch_timeout_seconds(),
    )
    return _vectors_from_fetch(fetched)


def _fetch_vectors_batch_with_retry(pinecone_index, batch: list[str]) -> dict:
    """Fetch one batch. Retry a fixed number of times on timeout or HTTP 429."""
    last_error: BaseException | None = None
    for attempt in range(_FILENAME_FETCH_RETRIES):
        try:
            return _fetch_vectors_batch(pinecone_index, batch)
        except Exception as exc:
            last_error = exc
            if _is_retryable_fetch_error(exc) and attempt < _FILENAME_FETCH_RETRIES - 1:
                time.sleep(_FILENAME_FETCH_RETRY_DELAY_SECONDS * (attempt + 1))
                continue
            raise
    raise last_error


def fetch_stored_vector_metadata(pinecone_index, vector_ids: list[str]) -> dict:
    """Fetch metadata for many raw ids. Return a map of id to metadata.

    A fetch error raises so the queue item can run again.
    """
    if not vector_ids:
        return {}
    batches = [
        vector_ids[start : start + _FILENAME_FETCH_BATCH_SIZE]
        for start in range(0, len(vector_ids), _FILENAME_FETCH_BATCH_SIZE)
    ]
    batch_vectors: list[dict] = [{} for _ in batches]
    workers = min(_FILENAME_FETCH_WORKERS, len(batches))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        future_map = {
            pool.submit(_fetch_vectors_batch_with_retry, pinecone_index, batch): index
            for index, batch in enumerate(batches)
        }
        for future in as_completed(future_map):
            batch_vectors[future_map[future]] = future.result()
    found: dict[str, dict] = {}
    for batch, vectors in zip(batches, batch_vectors, strict=True):
        for vector_id in batch:
            vector = vectors.get(vector_id)
            if vector is None:
                continue
            found[vector_id] = _metadata_from_vector(vector)
    return found


def apply_filename_conflict_guard(
    vectors,
    pinecone_index,
    content_type,
    *,
    allow_filename_change=False,
):
    """Drop audio or video vectors that would replace a different stored filename.

    Text and PDF ingest keep the current write. The allow flag turns
    the guard off. A conflict skips that chunk only.
    """
    if allow_filename_change or content_type not in _AUDIO_VIDEO_CONTENT_TYPES:
        return vectors

    vector_ids = [vector["id"] for vector in vectors]
    stored_by_id = fetch_stored_vector_metadata(pinecone_index, vector_ids)
    kept = []
    for vector in vectors:
        vector_id = vector["id"]
        if vector_id not in stored_by_id:
            kept.append(vector)
            continue
        stored_filename = stored_by_id[vector_id].get("filename")
        new_filename = (vector.get("metadata") or {}).get("filename")
        if stored_filename and stored_filename != new_filename:
            logger.warning(
                "Skip audio vector write. Stored filename differs. "
                "id=%s stored=%s new=%s. Pass --allow-filename-change to write "
                "this change.",
                vector_id,
                stored_filename,
                new_filename,
            )
            continue
        kept.append(vector)
    return kept


def _apply_guard_and_count_skips(
    vectors, pinecone_index, content_type, allow_filename_change
):
    """Apply the filename guard and log how many chunks were skipped."""
    chunk_count = len(vectors)
    kept = apply_filename_conflict_guard(
        vectors,
        pinecone_index,
        content_type,
        allow_filename_change=allow_filename_change,
    )
    skipped_count = chunk_count - len(kept)
    if skipped_count:
        logger.info("%s of %s chunks skipped", skipped_count, chunk_count)
    return kept, skipped_count


def store_in_pinecone(
    pinecone_index,
    chunks,
    embeddings,
    author,
    library_name,
    title,
    content_type,  # 'audio' or 'video'
    source_identifier,  # URL for video, S3 key for audio
    interrupt_event=None,
    album=None,
    access_level="public",  # New parameter for access control
    required_access_level=0,
    allow_filename_change=False,
):
    """
    Stores vector embeddings with metadata in Pinecone.

    Vector ID Format: type||library||source_location||title||author||content_hash||chunk_index

    Args:
        pinecone_index: Pinecone index to store in
        chunks: List of chunk dictionaries with 'text', 'start', 'end'
        embeddings: List of vector embeddings
        author: Content creator
        library_name: Source library
        title: Content title
        content_type: 'audio' or 'video'
        source_identifier: URL for video, S3 key for audio
        interrupt_event: Optional event for graceful shutdown
        album: Optional album/grouping metadata
        access_level: Legacy access control level (e.g., 'public', 'kriyaban')
        required_access_level: Numeric access level required to retrieve the content

    Batch Processing:
    - 100 vectors per upsert
    - Atomic operations
    - Interruptible for long runs

    Error Handling:
    - 429: Rate limit exceeded
    - Others: Infrastructure issues
    """
    # Validate input
    if not chunks or not embeddings:
        raise PineconeException("No chunks to store")

    # Sanitization for vector ID components
    title = title.replace("'", "'") if title else "Unknown Title"

    # Determine source location from content type
    source_location = "video" if content_type == "video" else "audio"
    is_youtube_video = content_type == "video"

    vectors = []
    for i, (chunk, embedding) in enumerate(zip(chunks, embeddings, strict=False)):
        # Generate standardized vector ID using the shared utility
        chunk_id = generate_vector_id(
            library_name=library_name,
            title=title,
            chunk_index=i,
            source_location=source_location,
            source_identifier=source_identifier,
            content_type=content_type,
            author=author,
            chunk_text=chunk["text"],
        )

        # Duration calculation for content navigation
        duration = chunk["end"] - chunk["start"]

        # Core metadata for all content types
        metadata = {
            "text": chunk["text"],
            "start_time": chunk["start"],
            "end_time": chunk["end"],
            "duration": round(duration, 1),
            "library": library_name,
            "author": author,
            "type": "youtube" if is_youtube_video else "audio",
            "title": title,
            "access_level": access_level,  # Add access level metadata
            "required_access_level": int(required_access_level or 0),
        }

        # Optional metadata based on content type
        if album:
            metadata["album"] = album

        # Add content-type specific metadata
        if is_youtube_video:
            metadata["url"] = source_identifier
        else:
            # Extract relative path for audio files
            filename = source_identifier.split("public/audio/", 1)[-1]
            metadata["filename"] = filename

        vectors.append({"id": chunk_id, "values": embedding, "metadata": metadata})

    apply_author_guard_to_vectors(vectors)
    vectors, skipped_count = _apply_guard_and_count_skips(
        vectors, pinecone_index, content_type, allow_filename_change
    )
    if not vectors:
        logger.info("No audio vectors remain after the filename conflict check.")
        return skipped_count

    # Batch processing with interrupt support
    for i in range(0, len(vectors), 100):
        # Check for interrupt signal between batches
        if interrupt_event and interrupt_event.is_set():
            logger.info("Interrupt detected. Stopping Pinecone upload...")
            return skipped_count

        batch = vectors[i : i + 100]
        try:
            pinecone_index.upsert(vectors=batch)
        except Exception as e:
            abort_on_credential_error(e)
            error_message = str(e)
            if "429" in error_message and "Too Many Requests" in error_message:
                # Rate limit exceeded - likely monthly quota
                logger.error(f"Error in upserting vectors: {e}")
                logger.error(
                    "You may have reached your write unit limit for the current month. Exiting script."
                )
                sys.exit(1)
            else:
                # Other infrastructure or configuration issues
                logger.error(f"Error in upserting vectors: {e}")
                raise PineconeException(f"Failed to upsert vectors: {str(e)}") from e

    logger.info(f"Successfully stored {len(vectors)} vectors in Pinecone")
    return skipped_count


def clear_library_vectors(index, library_name):
    """
    Purges all vectors for a specific library.

    Safety Features:
    - Library-scoped deletion only
    - No cascade effects
    - Atomic operation

    Error Cases:
    - Missing index
    - Permission issues
    - Rate limiting
    """
    try:
        # Metadata-based filtering for targeted deletion
        index.delete(filter={"library": library_name})
        logger.info(
            f"Successfully cleared all vectors for library '{library_name}' from the index."
        )
    except NotFoundException:
        logger.warning(
            "The index or namespace you're trying to clear doesn't exist. Skipping clear operation."
        )
        raise
    except Exception as e:
        logger.error(f"An error occurred while trying to clear vectors: {str(e)}")
        raise
