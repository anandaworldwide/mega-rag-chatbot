"""
OpenAI Embeddings Utilities

This module provides unified embeddings functionality for the data ingestion pipeline.
It consolidates OpenAI API interactions, configuration validation, and error handling
for both synchronous and asynchronous operations.

Key Features:
- Unified OpenAI embeddings interface
- Both sync and async API support
- Comprehensive configuration validation
- Batch processing optimization
- Robust error handling and retry logic
- Environment variable management

Usage:
    from data_ingestion.utils.embeddings_utils import OpenAIEmbeddings, validate_embedding_config

    # Validate configuration
    config = validate_embedding_config()

    # Create embeddings instance
    embeddings = OpenAIEmbeddings(model=config["model"])

    # Generate embeddings
    vector = await embeddings.embed_query("Your text here")
    vectors = await embeddings.embed_texts(["Text 1", "Text 2"])
"""

import asyncio
import logging
import os
import time

from openai import OpenAI

from data_ingestion.utils.credential_errors import abort_on_credential_error

logger = logging.getLogger(__name__)


def validate_embedding_config() -> dict[str, str]:
    """
    Validate that all required OpenAI embeddings configuration is available.

    Returns:
        Dict[str, str]: Dictionary of validated configuration values including:
            - model: OpenAI embeddings model name
            - api_key: OpenAI API key
            - dimension: Expected embedding dimension

    Raises:
        ValueError: If any required configuration is missing or invalid

    Example:
        >>> config = validate_embedding_config()
        >>> print(f"Using model: {config['model']}")
    """
    required_vars = {
        "OPENAI_API_KEY": os.environ.get("OPENAI_API_KEY"),
        "OPENAI_INGEST_EMBEDDINGS_MODEL": os.environ.get(
            "OPENAI_INGEST_EMBEDDINGS_MODEL"
        ),
        "OPENAI_INGEST_EMBEDDINGS_DIMENSION": os.environ.get(
            "OPENAI_INGEST_EMBEDDINGS_DIMENSION"
        ),
    }

    missing_vars = [var for var, value in required_vars.items() if not value]
    if missing_vars:
        raise ValueError(
            f"Missing required environment variables: {', '.join(missing_vars)}"
        )

    # Validate dimension is a valid positive integer
    try:
        dimension = int(required_vars["OPENAI_INGEST_EMBEDDINGS_DIMENSION"])
        if dimension <= 0:
            raise ValueError(
                "OPENAI_INGEST_EMBEDDINGS_DIMENSION must be a positive integer"
            )
    except ValueError as e:
        if "invalid literal" in str(e):
            raise ValueError(
                "OPENAI_INGEST_EMBEDDINGS_DIMENSION must be a valid integer"
            ) from e
        raise

    return {
        "api_key": required_vars["OPENAI_API_KEY"],
        "model": required_vars["OPENAI_INGEST_EMBEDDINGS_MODEL"],
        "dimension": str(dimension),
    }


def get_embedding_dimension() -> int:
    """
    Get the expected embedding dimension from configuration.

    Returns:
        int: The embedding dimension

    Raises:
        ValueError: If dimension is not configured or invalid

    Example:
        >>> dim = get_embedding_dimension()
        >>> print(f"Embedding dimension: {dim}")
    """
    dimension_str = os.environ.get("OPENAI_INGEST_EMBEDDINGS_DIMENSION")
    if not dimension_str:
        raise ValueError(
            "OPENAI_INGEST_EMBEDDINGS_DIMENSION environment variable not set"
        )

    try:
        dimension = int(dimension_str)
        if dimension <= 0:
            raise ValueError(
                "OPENAI_INGEST_EMBEDDINGS_DIMENSION must be a positive integer"
            )
        return dimension
    except ValueError as e:
        if "invalid literal" in str(e):
            raise ValueError(
                "OPENAI_INGEST_EMBEDDINGS_DIMENSION must be a valid integer"
            ) from e
        raise


class OpenAIEmbeddings:
    """
    Unified OpenAI embeddings client with both sync and async support.

    This class provides a consistent interface for generating embeddings using OpenAI's API
    with support for batch processing, error handling, and retry logic.

    Attributes:
        model (str): OpenAI model name for embeddings
        api_key (str): OpenAI API key
        chunk_size (int): Maximum batch size for API calls
        max_retries (int): Maximum number of retry attempts
        retry_delay (float): Initial delay between retries (with exponential backoff)

    Example:
        >>> embeddings = OpenAIEmbeddings()
        >>> vector = await embeddings.embed_query("Hello world")
        >>> vectors = await embeddings.embed_texts(["Text 1", "Text 2"])
    """

    def __init__(
        self,
        model: str | None = None,
        api_key: str | None = None,
        chunk_size: int = 1000,
        max_retries: int = 3,
        retry_delay: float = 1.0,
    ):
        """
        Initialize the OpenAI embeddings client.

        Args:
            model: OpenAI model name. If None, uses OPENAI_INGEST_EMBEDDINGS_MODEL env var
            api_key: OpenAI API key. If None, uses OPENAI_API_KEY env var
            chunk_size: Maximum batch size for processing multiple texts
            max_retries: Maximum number of retry attempts for failed requests
            retry_delay: Initial delay between retries in seconds

        Raises:
            ValueError: If API key is not provided and not found in environment
        """
        self.model = model or os.environ.get("OPENAI_INGEST_EMBEDDINGS_MODEL")
        if not self.model:
            raise ValueError(
                "OpenAI model not provided and OPENAI_INGEST_EMBEDDINGS_MODEL environment variable not set"
            )
        self.api_key = api_key or os.environ.get("OPENAI_API_KEY")
        if not self.api_key:
            raise ValueError(
                "OpenAI API key not provided and OPENAI_API_KEY environment variable not set"
            )

        self.chunk_size = chunk_size
        self.max_retries = max_retries
        self.retry_delay = retry_delay

        # Initialize OpenAI client for sync operations
        self._client = OpenAI(api_key=self.api_key)

        logger.info(f"Initialized OpenAI embeddings with model: {self.model}")

    def embed_query(self, text: str) -> list[float]:
        """
        Generate an embedding for a single text string (synchronous).

        Args:
            text: The text to embed

        Returns:
            List[float]: The embedding vector

        Raises:
            Exception: If embedding generation fails after all retries

        Example:
            >>> embeddings = OpenAIEmbeddings()
            >>> vector = embeddings.embed_query("Hello world")
            >>> print(f"Embedding dimension: {len(vector)}")
        """
        return self.embed_texts([text])[0]

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        """
        Generate embeddings for multiple texts (synchronous).

        Args:
            texts: List of texts to embed

        Returns:
            List[List[float]]: List of embedding vectors

        Raises:
            Exception: If embedding generation fails after all retries

        Example:
            >>> embeddings = OpenAIEmbeddings()
            >>> vectors = embeddings.embed_texts(["Text 1", "Text 2"])
            >>> print(f"Generated {len(vectors)} embeddings")
        """
        if not texts:
            return []

        # Filter out empty texts
        valid_texts = [text.strip() for text in texts if text and text.strip()]
        if not valid_texts:
            logger.warning("All texts were empty after filtering")
            return []

        all_embeddings = []

        # Process in batches to respect API limits
        for i in range(0, len(valid_texts), self.chunk_size):
            batch = valid_texts[i : i + self.chunk_size]
            batch_embeddings = self._embed_batch_sync(batch)
            all_embeddings.extend(batch_embeddings)

        return all_embeddings

    async def embed_query_async(self, text: str) -> list[float]:
        """
        Generate an embedding for a single text string (asynchronous).

        Args:
            text: The text to embed

        Returns:
            List[float]: The embedding vector

        Raises:
            Exception: If embedding generation fails after all retries

        Example:
            >>> embeddings = OpenAIEmbeddings()
            >>> vector = await embeddings.embed_query_async("Hello world")
        """
        results = await self.embed_texts_async([text])
        return results[0]

    async def embed_texts_async(self, texts: list[str]) -> list[list[float]]:
        """
        Generate embeddings for multiple texts (asynchronous).

        Args:
            texts: List of texts to embed

        Returns:
            List[List[float]]: List of embedding vectors

        Raises:
            Exception: If embedding generation fails after all retries

        Example:
            >>> embeddings = OpenAIEmbeddings()
            >>> vectors = await embeddings.embed_texts_async(["Text 1", "Text 2"])
        """
        if not texts:
            return []

        # Filter out empty texts
        valid_texts = [text.strip() for text in texts if text and text.strip()]
        if not valid_texts:
            logger.warning("All texts were empty after filtering")
            return []

        all_embeddings = []

        # Process in batches to respect API limits
        for i in range(0, len(valid_texts), self.chunk_size):
            batch = valid_texts[i : i + self.chunk_size]
            batch_embeddings = await self._embed_batch_async(batch)
            all_embeddings.extend(batch_embeddings)

        return all_embeddings

    def _embed_batch_sync(self, texts: list[str]) -> list[list[float]]:
        """
        Generate embeddings for a batch of texts (synchronous implementation).

        Args:
            texts: List of texts to embed (should be <= chunk_size)

        Returns:
            List[List[float]]: List of embedding vectors

        Raises:
            Exception: If embedding generation fails after all retries
        """
        for attempt in range(self.max_retries):
            try:
                response = self._client.embeddings.create(input=texts, model=self.model)

                # Extract embeddings from response
                embeddings = [item.embedding for item in response.data]

                logger.debug(
                    f"Generated {len(embeddings)} embeddings using {self.model}"
                )
                return embeddings

            except Exception as e:
                abort_on_credential_error(e)
                if attempt < self.max_retries - 1:
                    delay = self.retry_delay * (2**attempt)  # Exponential backoff
                    logger.warning(
                        f"Embedding generation failed (attempt {attempt + 1}/{self.max_retries}): {e}"
                    )
                    logger.info(f"Retrying in {delay} seconds...")
                    time.sleep(delay)
                else:
                    logger.error(
                        f"Embedding generation failed after {self.max_retries} attempts: {e}"
                    )
                    raise

    async def _embed_batch_async(self, texts: list[str]) -> list[list[float]]:
        """
        Generate embeddings for a batch of texts (asynchronous implementation).

        Args:
            texts: List of texts to embed (should be <= chunk_size)

        Returns:
            List[List[float]]: List of embedding vectors

        Raises:
            Exception: If embedding generation fails after all retries
        """
        for attempt in range(self.max_retries):
            try:
                # Use asyncio.to_thread for async API call
                response = await asyncio.to_thread(
                    self._client.embeddings.create, input=texts, model=self.model
                )

                # Extract embeddings from response
                embeddings = [item.embedding for item in response.data]

                logger.debug(
                    f"Generated {len(embeddings)} embeddings using {self.model}"
                )
                return embeddings

            except Exception as e:
                abort_on_credential_error(e)
                if attempt < self.max_retries - 1:
                    delay = self.retry_delay * (2**attempt)  # Exponential backoff
                    logger.warning(
                        f"Embedding generation failed (attempt {attempt + 1}/{self.max_retries}): {e}"
                    )
                    logger.info(f"Retrying in {delay} seconds...")
                    await asyncio.sleep(delay)
                else:
                    logger.error(
                        f"Embedding generation failed after {self.max_retries} attempts: {e}"
                    )
                    raise


# Legacy compatibility classes
class LegacyOpenAIEmbeddings:
    """
    Legacy compatibility wrapper for existing code that uses the old interface.

    This class provides backward compatibility with the existing OpenAIEmbeddings
    implementation while using the new unified interface internally.

    Example:
        >>> # For scripts that use the old async-only interface
        >>> embeddings = LegacyOpenAIEmbeddings(model="text-embedding-ada-002")
        >>> vector = await embeddings.embed_query("Hello world")
    """

    def __init__(self, model: str, api_key: str | None = None):
        """Initialize legacy embeddings wrapper."""
        self._embeddings = OpenAIEmbeddings(model=model, api_key=api_key)

    async def embed_query(self, text: str) -> list[float]:
        """Generate embedding for a single text (async-only for legacy compatibility)."""
        return await self._embeddings.embed_query_async(text)

    async def embed_texts(self, texts: list[str]) -> list[list[float]]:
        """Generate embeddings for multiple texts (async-only for legacy compatibility)."""
        return await self._embeddings.embed_texts_async(texts)


def create_embeddings_client(
    model: str | None = None, api_key: str | None = None, **kwargs
) -> OpenAIEmbeddings:
    """
    Factory function to create an embeddings client with validated configuration.

    Args:
        model: OpenAI model name. If None, uses validated config
        api_key: OpenAI API key. If None, uses validated config
        **kwargs: Additional arguments passed to OpenAIEmbeddings

    Returns:
        OpenAIEmbeddings: Configured embeddings client

    Raises:
        ValueError: If configuration validation fails

    Example:
        >>> embeddings = create_embeddings_client()
        >>> # Uses validated environment configuration
    """
    config = validate_embedding_config()

    return OpenAIEmbeddings(
        model=model or config["model"], api_key=api_key or config["api_key"], **kwargs
    )


# Utility functions for batch processing
def estimate_batch_size(texts: list[str], max_tokens_per_batch: int = 8000) -> int:
    """
    Estimate optimal batch size based on text lengths and token limits.

    Args:
        texts: List of texts to process
        max_tokens_per_batch: Maximum tokens per API call

    Returns:
        int: Recommended batch size

    Example:
        >>> texts = ["Short text", "Much longer text with many words..."]
        >>> batch_size = estimate_batch_size(texts)
        >>> print(f"Recommended batch size: {batch_size}")
    """
    if not texts:
        return 1

    # Rough estimation: 1 token ≈ 4 characters
    avg_tokens_per_text = sum(len(text) for text in texts) // (len(texts) * 4)

    if avg_tokens_per_text == 0:
        return len(texts)

    estimated_batch_size = max_tokens_per_batch // avg_tokens_per_text
    return max(1, min(estimated_batch_size, len(texts)))


def chunk_texts_for_processing(
    texts: list[str], batch_size: int | None = None
) -> list[list[str]]:
    """
    Split texts into optimal batches for processing.

    Args:
        texts: List of texts to chunk
        batch_size: Batch size. If None, estimates optimal size

    Returns:
        List[List[str]]: List of text batches

    Example:
        >>> texts = ["Text 1", "Text 2", "Text 3", "Text 4"]
        >>> batches = chunk_texts_for_processing(texts, batch_size=2)
        >>> print(f"Created {len(batches)} batches")
    """
    if not texts:
        return []

    if batch_size is None:
        batch_size = estimate_batch_size(texts)

    batches = []
    for i in range(0, len(texts), batch_size):
        batch = texts[i : i + batch_size]
        batches.append(batch)

    return batches
