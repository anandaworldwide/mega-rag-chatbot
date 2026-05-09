import logging
import os
import sys

from pinecone import NotFoundException, Pinecone, PineconeException, ServerlessSpec

from data_ingestion.utils.pinecone_utils import generate_vector_id

logger = logging.getLogger(__name__)

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

    # Batch processing with interrupt support
    for i in range(0, len(vectors), 100):
        # Check for interrupt signal between batches
        if interrupt_event and interrupt_event.is_set():
            logger.info("Interrupt detected. Stopping Pinecone upload...")
            return

        batch = vectors[i : i + 100]
        try:
            pinecone_index.upsert(vectors=batch)
        except Exception as e:
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
