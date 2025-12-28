"""Page content processing, chunking, and Pinecone operations for the website crawler."""

import hashlib
import logging
import re
from typing import Any

# Optional imports (may not be available in all environments)
try:
    import openai
except ImportError:
    # Fallback for when openai is not available
    openai = None

# Import from crawler submodules (support both module and direct execution)
try:
    from .config import ContentHash, PageContent, PineconeCleanupError
except ImportError:
    from config import (  # type: ignore[import-not-found]
        ContentHash,
        PageContent,
        PineconeCleanupError,
    )


def sanitize_for_id(text: str) -> str:
    """Sanitize text for use in Pinecone vector IDs"""
    # Replace non-ASCII chars with ASCII equivalents
    text = text.replace("—", "-").replace("'", "'").replace('"', '"').replace('"', '"')
    # Remove any remaining non-ASCII chars
    text = "".join(c for c in text if ord(c) < 128)
    # Replace special chars with underscores, preserving spaces
    text = re.sub(r"[^a-zA-Z0-9\s-]", "_", text)
    return text


def create_chunks_from_page(page_content: PageContent, text_splitter) -> list[str]:
    """Create text chunks from page content using the provided text splitter."""

    # Combine title and content with a single newline so the title remains in the
    # same paragraph as the opening content, preventing header-only chunks.
    full_text = f"{page_content.title}\n{page_content.content}"

    # Use URL as document ID for metrics tracking
    document_id = page_content.url
    chunks = text_splitter.split_text(full_text, document_id=document_id)

    logging.debug(
        f"Created {len(chunks)} chunks from page using spaCy dynamic chunking"
    )
    return chunks


def upsert_to_pinecone(vectors: list[dict], index: Any, index_name: str):
    """Upsert vectors to Pinecone index."""
    if vectors:
        batch_size = 100  # Pinecone recommends batches of 100 or less
        total_vectors = len(vectors)
        logging.debug(
            f"Upserting {total_vectors} vectors to Pinecone index '{index_name}' in batches of {batch_size}..."
        )

        for i in range(0, total_vectors, batch_size):
            batch = vectors[i : i + batch_size]
            logging.debug(
                f"Upserting batch {i // batch_size + 1}/{(total_vectors + batch_size - 1) // batch_size} (size: {len(batch)})..."
            )
            try:
                index.upsert(vectors=batch)
                if i > 2:
                    print(".", end="", flush=True)
            except Exception as e:
                error_msg = str(e)
                logging.error(f"Error upserting batch starting at index {i}: {e}")

                # Check for vector ID sanitization errors that should be treated as temporary failures
                if (
                    "Vector ID must be ASCII" in error_msg
                    or "must be ASCII" in error_msg
                ):
                    logging.warning(
                        "Vector ID sanitization error detected - this should be fixed by updated sanitization logic"
                    )
                    raise Exception(f"Vector ID sanitization error: {error_msg}") from e

                # Log but continue for transient errors
                logging.warning(
                    f"Skipping batch {i // batch_size + 1} due to error, continuing with next batch..."
                )
        logging.info(f"Upsert of {total_vectors} vectors complete.")


def _update_pinecone_vectors(
    crawler,
    pinecone_index,
    index_name: str,
    url: str,
    chunks: list[str],
    title: str,
) -> None:
    """Clear old vectors and upsert new ones for a URL."""
    # Always clear old vectors before upserting new ones
    # This handles: recrawls with changed content, first crawls with stale data,
    # and any edge cases where Pinecone has old vectors for this URL
    deleted_count = crawler.remove_url_from_pinecone(pinecone_index, url)
    if deleted_count > 0:
        logging.info(f"Cleared {deleted_count} old vectors from Pinecone for: {url}")

    embeddings = crawler.create_embeddings(chunks, url, title)
    upsert_to_pinecone(embeddings, pinecone_index, index_name)
    logging.debug(f"Successfully processed and upserted: {url}")
    logging.debug(f"Created {len(chunks)} chunks, {len(embeddings)} embeddings.")


def _handle_no_content(url: str, crawler) -> tuple[int, int, bool]:
    """Handle case where no content was extracted. Returns (pages_inc, restart_inc, rate_limit)."""
    crawler._ensure_db_initialized()
    assert crawler.cursor is not None
    crawler.cursor.execute(
        "SELECT status, content_hash FROM crawl_queue WHERE url = ?",
        (crawler.normalize_url(url),),
    )
    result = crawler.cursor.fetchone()

    if result:
        status, content_hash = result[0], result[1]
        # Already successfully processed as non-HTML content
        if status == "visited" and content_hash in ["non_html", "non_html_content"]:
            logging.debug(f"Non-HTML content already processed: {url}")
            return 1, 1, False
        # Already marked as deleted (404) or failed - don't re-mark
        if status in ["deleted", "failed"]:
            logging.debug(f"URL already marked as {status}, skipping: {url}")
            return 0, 0, False

    # Genuine failure that hasn't been handled
    crawler.mark_url_status(url, "failed", f"No content extracted from {url}")
    return 0, 0, False


def _is_rate_limit_error(e: Exception) -> bool:
    """Check if an exception is a rate limit error.

    Checks in order of reliability:
    1. OpenAI RateLimitError exception type
    2. HTTP status code 429
    3. String matching on error message (fallback)
    """
    # Try OpenAI RateLimitError first
    if openai is not None:
        try:
            from openai import RateLimitError

            if isinstance(e, RateLimitError):
                return True
        except ImportError:
            pass

    # Check for HTTP status code 429
    status_code = getattr(e, "status_code", None)
    if status_code == 429:
        return True

    # Fallback to string matching
    error_message = str(e).lower()
    return (
        "rate limit" in error_message
        or "rate_limit_exceeded" in error_message
        or "requests per day" in error_message
        or "429" in error_message
    )


def _handle_rate_limit_error(url: str, e: Exception, crawler) -> tuple[int, int, bool]:
    """Handle rate limit errors by marking URL for retry and setting exit flag."""
    logging.warning(f"OpenAI rate limit reached for {url}: {e}")
    logging.warning(
        "Stopping current crawl round and sleeping for 1 hour due to rate limit"
    )
    crawler.mark_url_status(
        url, "pending", f"Rate limit hit - will retry after sleep: {str(e)}"
    )
    crawler._rate_limit_exit = True
    return 0, 0, True  # Return rate_limit_hit flag


def _process_page_content(
    content,
    new_links: list,
    url: str,
    crawler,
    pinecone_index,
    index_name: str,
) -> tuple[int, int, bool]:
    """Process page content and return (pages_processed_increment, pages_since_restart_increment)."""
    if not content:
        return _handle_no_content(url, crawler)

    # Handle special cases (WordPress login redirects, etc.)
    if (
        hasattr(content, "metadata")
        and content.metadata.get("type") == "wp_login_redirect"
    ):
        # WordPress login redirect was already handled and marked as visited
        # Return small increment to avoid triggering browser restart (restart_inc == 0 and pages_inc == 0)
        logging.debug(
            f"Skipping content processing for WordPress login redirect: {url}"
        )
        return (
            0,
            1,
            False,
        )  # No pages processed, but increment restart counter to avoid browser restart

    try:
        chunks = create_chunks_from_page(content, crawler.text_splitter)
        if chunks:
            content_hash = hashlib.sha256(content.content.encode()).hexdigest()

            if crawler.should_process_content(url, content_hash):
                _update_pinecone_vectors(
                    crawler, pinecone_index, index_name, url, chunks, content.title
                )
            else:
                logging.info(
                    f"Content unchanged for {url}, skipping embeddings creation"
                )

            crawler.mark_url_status(url, "visited", content_hash=content_hash)
        else:
            crawler.mark_url_status(url, "visited", content_hash=ContentHash.NO_CONTENT)
            logging.warning(f"No content chunks created for {url}")

        crawler.reset_timeout_count(url)

        # Add new links to queue
        for link in new_links:
            if (
                crawler.is_valid_url(link)
                and not crawler.should_skip_url(link)
                and not crawler.is_url_in_database(link)
            ):
                crawler.add_url_to_queue(link)

        return (
            1,
            1,
            False,
        )  # Increment both counters for successful processing, no rate limit hit

    except PineconeCleanupError as e:
        # Pinecone cleanup failed (e.g., dimension mismatch) - mark for retry
        logging.warning(f"Pinecone cleanup failed for {url}, marking for retry: {e}")
        crawler.mark_url_status(
            url, "failed", f"Pinecone cleanup failed (will retry): {str(e)}"
        )
        # The "failed" status with this error message will trigger retry logic
        # because _handle_temporary_failure_retry checks for "pinecone" pattern
        return 0, 0, False

    except Exception as e:
        import traceback

        logging.debug(f"Exception type: {type(e).__name__}")

        if _is_rate_limit_error(e):
            return _handle_rate_limit_error(url, e, crawler)

        logging.error(f"Failed to process page content {url}: {e}")
        logging.error(traceback.format_exc())
        crawler.mark_url_status(
            url, "failed", f"Failed during content processing: {str(e)}"
        )
        return 0, 0, False
