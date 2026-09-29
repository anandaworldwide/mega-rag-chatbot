"""
Retry utilities for data ingestion operations.

This module provides robust retry logic with exponential backoff for API operations
commonly used in data ingestion pipelines (OpenAI embeddings, Pinecone operations, etc.).

Key features:
- Exponential backoff with configurable parameters
- Fatal error detection for non-retryable errors
- Comprehensive logging for debugging network issues
- Async operation support for modern data ingestion patterns
"""

import asyncio
import logging
import time
from collections.abc import Callable
from typing import Any

from data_ingestion.utils.credential_errors import abort_on_credential_error

logger = logging.getLogger(__name__)


async def retry_with_backoff(
    operation_func: Callable,
    max_retries: int = 3,
    base_delay: float = 1.0,
    max_delay: float = 60.0,
    backoff_factor: float = 2.0,
    operation_name: str = "operation",
    fatal_error_patterns: list[str] | None = None,
) -> Any:
    """
    Retry an async operation with exponential backoff.

    Args:
        operation_func: Async function to retry
        max_retries: Maximum number of retry attempts
        base_delay: Initial delay in seconds
        max_delay: Maximum delay between retries
        backoff_factor: Multiplier for delay on each retry
        operation_name: Name of operation for logging
        fatal_error_patterns: List of error patterns that should not be retried

    Returns:
        Result of the operation if successful

    Raises:
        Exception: Last exception if all retries fail

    Example:
        async def embedding_operation():
            return await asyncio.wait_for(
                asyncio.to_thread(embeddings.embed_query, text),
                timeout=30.0
            )

        result = await retry_with_backoff(
            embedding_operation,
            max_retries=3,
            operation_name="OpenAI embedding"
        )
    """
    if fatal_error_patterns is None:
        fatal_error_patterns = [
            "invalid api key",
            "authentication failed",
            "quota exceeded",
            "index not found",
            "dimension mismatch",
            "insufficient quota",
            "rate limit exceeded",
        ]

    last_exception = None

    for attempt in range(max_retries + 1):
        try:
            return await operation_func()
        except Exception as e:
            last_exception = e
            abort_on_credential_error(e)

            # Check if this is a fatal error that shouldn't be retried
            error_str = str(e).lower()
            if any(fatal_error in error_str for fatal_error in fatal_error_patterns):
                logger.error(f"{operation_name} failed with fatal error: {e}")
                raise e

            if attempt < max_retries:
                # Calculate delay with exponential backoff
                delay = min(base_delay * (backoff_factor**attempt), max_delay)
                logger.warning(
                    f"{operation_name} failed (attempt {attempt + 1}/{max_retries + 1}): {e}. "
                    f"Retrying in {delay:.1f} seconds..."
                )
                await asyncio.sleep(delay)
            else:
                logger.error(
                    f"{operation_name} failed after {max_retries + 1} attempts: {e}"
                )

    # All retries failed
    raise last_exception


def retry_with_backoff_sync(
    operation_func: Callable,
    max_retries: int = 3,
    base_delay: float = 1.0,
    max_delay: float = 60.0,
    backoff_factor: float = 2.0,
    operation_name: str = "operation",
    fatal_error_patterns: list[str] | None = None,
) -> Any:
    """
    Retry a synchronous operation with exponential backoff.

    Similar to retry_with_backoff but for synchronous operations.

    Args:
        operation_func: Synchronous function to retry
        max_retries: Maximum number of retry attempts
        base_delay: Initial delay in seconds
        max_delay: Maximum delay between retries
        backoff_factor: Multiplier for delay on each retry
        operation_name: Name of operation for logging
        fatal_error_patterns: List of error patterns that should not be retried

    Returns:
        Result of the operation if successful

    Raises:
        Exception: Last exception if all retries fail

    Example:
        def pinecone_operation():
            return pinecone_index.upsert(vectors=vectors)

        result = retry_with_backoff_sync(
            pinecone_operation,
            max_retries=5,
            operation_name="Pinecone upsert"
        )
    """
    if fatal_error_patterns is None:
        fatal_error_patterns = [
            "invalid api key",
            "authentication failed",
            "quota exceeded",
            "index not found",
            "dimension mismatch",
            "insufficient quota",
            "rate limit exceeded",
        ]

    last_exception = None

    for attempt in range(max_retries + 1):
        try:
            return operation_func()
        except Exception as e:
            last_exception = e
            abort_on_credential_error(e)

            # Check if this is a fatal error that shouldn't be retried
            error_str = str(e).lower()
            if any(fatal_error in error_str for fatal_error in fatal_error_patterns):
                logger.error(f"{operation_name} failed with fatal error: {e}")
                raise e

            if attempt < max_retries:
                # Calculate delay with exponential backoff
                delay = min(base_delay * (backoff_factor**attempt), max_delay)
                logger.warning(
                    f"{operation_name} failed (attempt {attempt + 1}/{max_retries + 1}): {e}. "
                    f"Retrying in {delay:.1f} seconds..."
                )
                time.sleep(delay)
            else:
                logger.error(
                    f"{operation_name} failed after {max_retries + 1} attempts: {e}"
                )

    # All retries failed
    raise last_exception


# Common retry configurations for different operation types
EMBEDDING_RETRY_CONFIG = {
    "max_retries": 3,
    "base_delay": 2.0,
    "max_delay": 30.0,
    "backoff_factor": 2.0,
}

PINECONE_RETRY_CONFIG = {
    "max_retries": 5,
    "base_delay": 1.0,
    "max_delay": 30.0,
    "backoff_factor": 2.0,
}

NETWORK_RETRY_CONFIG = {
    "max_retries": 3,
    "base_delay": 1.0,
    "max_delay": 60.0,
    "backoff_factor": 2.0,
}
