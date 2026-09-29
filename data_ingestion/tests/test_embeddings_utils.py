"""
Unit tests for embeddings_utils module.

Tests cover:
- Configuration validation
- Sync and async embeddings generation
- Error handling and retry logic
- Batch processing functionality
- Legacy compatibility
- Utility functions
"""

import os
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from data_ingestion.utils.embeddings_utils import (
    LegacyOpenAIEmbeddings,
    OpenAIEmbeddings,
    chunk_texts_for_processing,
    create_embeddings_client,
    estimate_batch_size,
    get_embedding_dimension,
    validate_embedding_config,
)


class TestConfigValidation:
    """Test configuration validation functions."""

    def test_validate_embedding_config_success(self):
        """Test successful configuration validation."""
        with patch.dict(
            os.environ,
            {
                "OPENAI_API_KEY": "test-key",
                "OPENAI_INGEST_EMBEDDINGS_MODEL": "text-embedding-ada-002",
                "OPENAI_INGEST_EMBEDDINGS_DIMENSION": "1536",
            },
        ):
            config = validate_embedding_config()

            assert config["api_key"] == "test-key"
            assert config["model"] == "text-embedding-ada-002"
            assert config["dimension"] == "1536"

    def test_validate_embedding_config_missing_api_key(self):
        """Test configuration validation with missing API key."""
        with patch.dict(
            os.environ,
            {
                "OPENAI_INGEST_EMBEDDINGS_MODEL": "text-embedding-ada-002",
                "OPENAI_INGEST_EMBEDDINGS_DIMENSION": "1536",
            },
            clear=True,
        ):
            with pytest.raises(
                ValueError,
                match="Missing required environment variables.*OPENAI_API_KEY",
            ):
                validate_embedding_config()

    def test_validate_embedding_config_missing_model(self):
        """Test configuration validation with missing model."""
        with patch.dict(
            os.environ,
            {
                "OPENAI_API_KEY": "test-key",
                "OPENAI_INGEST_EMBEDDINGS_DIMENSION": "1536",
            },
            clear=True,
        ):
            with pytest.raises(
                ValueError,
                match="Missing required environment variables.*OPENAI_INGEST_EMBEDDINGS_MODEL",
            ):
                validate_embedding_config()

    def test_validate_embedding_config_invalid_dimension(self):
        """Test configuration validation with invalid dimension."""
        with patch.dict(
            os.environ,
            {
                "OPENAI_API_KEY": "test-key",
                "OPENAI_INGEST_EMBEDDINGS_MODEL": "text-embedding-ada-002",
                "OPENAI_INGEST_EMBEDDINGS_DIMENSION": "invalid",
            },
        ):
            with pytest.raises(ValueError, match="must be a valid integer"):
                validate_embedding_config()

    def test_validate_embedding_config_negative_dimension(self):
        """Test configuration validation with negative dimension."""
        with patch.dict(
            os.environ,
            {
                "OPENAI_API_KEY": "test-key",
                "OPENAI_INGEST_EMBEDDINGS_MODEL": "text-embedding-ada-002",
                "OPENAI_INGEST_EMBEDDINGS_DIMENSION": "-1",
            },
        ):
            with pytest.raises(ValueError, match="must be a positive integer"):
                validate_embedding_config()

    def test_get_embedding_dimension_success(self):
        """Test successful dimension retrieval."""
        with patch.dict(os.environ, {"OPENAI_INGEST_EMBEDDINGS_DIMENSION": "1536"}):
            dimension = get_embedding_dimension()
            assert dimension == 1536

    def test_get_embedding_dimension_missing(self):
        """Test dimension retrieval with missing environment variable."""
        with patch.dict(os.environ, {}, clear=True):
            with pytest.raises(
                ValueError,
                match="OPENAI_INGEST_EMBEDDINGS_DIMENSION environment variable not set",
            ):
                get_embedding_dimension()

    def test_get_embedding_dimension_invalid(self):
        """Test dimension retrieval with invalid value."""
        with patch.dict(os.environ, {"OPENAI_INGEST_EMBEDDINGS_DIMENSION": "invalid"}):
            with pytest.raises(ValueError, match="must be a valid integer"):
                get_embedding_dimension()


class TestOpenAIEmbeddings:
    """Test the OpenAIEmbeddings class."""

    @pytest.fixture
    def mock_env(self):
        """Mock environment variables."""
        with patch.dict(
            os.environ,
            {
                "OPENAI_API_KEY": "test-api-key",
                "OPENAI_INGEST_EMBEDDINGS_MODEL": "text-embedding-ada-002",
                "OPENAI_INGEST_EMBEDDINGS_DIMENSION": "1536",
            },
        ):
            yield

    @pytest.fixture
    def mock_openai_client(self):
        """Mock OpenAI client."""
        with patch("data_ingestion.utils.embeddings_utils.OpenAI") as mock_openai:
            mock_client = MagicMock()
            mock_openai.return_value = mock_client

            # Mock successful embedding response
            mock_response = MagicMock()
            mock_response.data = [
                MagicMock(embedding=[0.1, 0.2, 0.3]),
                MagicMock(embedding=[0.4, 0.5, 0.6]),
            ]
            mock_client.embeddings.create.return_value = mock_response

            yield mock_client

    def test_init_with_env_vars(self, mock_env, mock_openai_client):
        """Test initialization with environment variables."""
        embeddings = OpenAIEmbeddings()

        assert embeddings.model == "text-embedding-ada-002"
        assert embeddings.api_key == "test-api-key"
        assert embeddings.chunk_size == 1000
        assert embeddings.max_retries == 3
        assert embeddings.retry_delay == 1.0

    def test_init_with_parameters(self, mock_env, mock_openai_client):
        """Test initialization with explicit parameters."""
        embeddings = OpenAIEmbeddings(
            model="custom-model",
            api_key="custom-key",
            chunk_size=500,
            max_retries=5,
            retry_delay=0.5,
        )

        assert embeddings.model == "custom-model"
        assert embeddings.api_key == "custom-key"
        assert embeddings.chunk_size == 500
        assert embeddings.max_retries == 5
        assert embeddings.retry_delay == 0.5

    def test_init_missing_api_key(self, mock_openai_client):
        """Test initialization with missing API key."""
        with patch.dict(os.environ, {}, clear=True):
            with pytest.raises(ValueError, match="OpenAI model not provided"):
                OpenAIEmbeddings()

    def test_embed_query_sync(self, mock_env, mock_openai_client):
        """Test synchronous single query embedding."""
        embeddings = OpenAIEmbeddings()
        result = embeddings.embed_query("test text")

        assert result == [0.1, 0.2, 0.3]
        mock_openai_client.embeddings.create.assert_called_once_with(
            input=["test text"], model="text-embedding-ada-002"
        )

    def test_embed_texts_sync(self, mock_env, mock_openai_client):
        """Test synchronous multiple text embedding."""
        embeddings = OpenAIEmbeddings()
        result = embeddings.embed_texts(["text 1", "text 2"])

        assert result == [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]]
        mock_openai_client.embeddings.create.assert_called_once_with(
            input=["text 1", "text 2"], model="text-embedding-ada-002"
        )

    def test_embed_texts_sync_empty_input(self, mock_env, mock_openai_client):
        """Test synchronous embedding with empty input."""
        embeddings = OpenAIEmbeddings()
        result = embeddings.embed_texts([])

        assert result == []
        mock_openai_client.embeddings.create.assert_not_called()

    def test_embed_texts_sync_filter_empty(self, mock_env, mock_openai_client):
        """Test synchronous embedding filtering empty texts."""
        # Mock to return only one embedding for the single valid text
        mock_response = MagicMock()
        mock_response.data = [MagicMock(embedding=[0.1, 0.2, 0.3])]
        mock_openai_client.embeddings.create.return_value = mock_response

        embeddings = OpenAIEmbeddings()
        result = embeddings.embed_texts(["", "  ", "valid text"])

        assert result == [[0.1, 0.2, 0.3]]
        mock_openai_client.embeddings.create.assert_called_once_with(
            input=["valid text"], model="text-embedding-ada-002"
        )

    @pytest.mark.asyncio
    async def test_embed_query_async(self, mock_env, mock_openai_client):
        """Test asynchronous single query embedding."""
        embeddings = OpenAIEmbeddings()

        with patch("asyncio.to_thread", new_callable=AsyncMock) as mock_to_thread:
            mock_to_thread.return_value = (
                mock_openai_client.embeddings.create.return_value
            )

            result = await embeddings.embed_query_async("test text")

            assert result == [0.1, 0.2, 0.3]
            mock_to_thread.assert_called_once()

    @pytest.mark.asyncio
    async def test_embed_texts_async(self, mock_env, mock_openai_client):
        """Test asynchronous multiple text embedding."""
        embeddings = OpenAIEmbeddings()

        with patch("asyncio.to_thread", new_callable=AsyncMock) as mock_to_thread:
            mock_to_thread.return_value = (
                mock_openai_client.embeddings.create.return_value
            )

            result = await embeddings.embed_texts_async(["text 1", "text 2"])

            assert result == [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]]
            mock_to_thread.assert_called_once()

    @pytest.mark.asyncio
    async def test_embed_texts_async_empty_input(self, mock_env, mock_openai_client):
        """Test asynchronous embedding with empty input."""
        embeddings = OpenAIEmbeddings()
        result = await embeddings.embed_texts_async([])

        assert result == []

    def test_embed_texts_batch_processing(self, mock_env, mock_openai_client):
        """Test batch processing for large text lists."""
        embeddings = OpenAIEmbeddings(chunk_size=2)

        # Mock multiple API calls
        mock_openai_client.embeddings.create.side_effect = [
            MagicMock(
                data=[MagicMock(embedding=[0.1, 0.2]), MagicMock(embedding=[0.3, 0.4])]
            ),
            MagicMock(data=[MagicMock(embedding=[0.5, 0.6])]),
        ]

        result = embeddings.embed_texts(["text1", "text2", "text3"])

        assert result == [[0.1, 0.2], [0.3, 0.4], [0.5, 0.6]]
        assert mock_openai_client.embeddings.create.call_count == 2

    def test_embed_retry_logic(self, mock_env, mock_openai_client):
        """Test retry logic on API failures."""
        embeddings = OpenAIEmbeddings(max_retries=2, retry_delay=0.01)

        # First call fails, second succeeds
        mock_openai_client.embeddings.create.side_effect = [
            Exception("API Error"),
            MagicMock(data=[MagicMock(embedding=[0.1, 0.2, 0.3])]),
        ]

        with patch("time.sleep"):  # Speed up test
            result = embeddings.embed_query("test text")

        assert result == [0.1, 0.2, 0.3]
        assert mock_openai_client.embeddings.create.call_count == 2

    def test_embed_retry_exhausted(self, mock_env, mock_openai_client):
        """Test retry logic when all attempts fail."""
        embeddings = OpenAIEmbeddings(max_retries=2, retry_delay=0.01)

        # All calls fail
        mock_openai_client.embeddings.create.side_effect = Exception("API Error")

        with patch("time.sleep"):  # Speed up test
            with pytest.raises(Exception, match="API Error"):
                embeddings.embed_query("test text")

        assert mock_openai_client.embeddings.create.call_count == 2

    def test_invalid_api_key_stops_without_retry(self, mock_env, mock_openai_client):
        embeddings = OpenAIEmbeddings(max_retries=3, retry_delay=0.01)
        mock_openai_client.embeddings.create.side_effect = Exception(
            "Error code: 401 - Incorrect API key provided: sk-test. "
            "{'code': 'invalid_api_key'}"
        )

        def stop_process(code):
            raise SystemExit(code)

        with (
            patch(
                "data_ingestion.utils.credential_errors.os._exit",
                side_effect=stop_process,
            ),
            pytest.raises(SystemExit),
        ):
            embeddings.embed_query("test text")

        assert mock_openai_client.embeddings.create.call_count == 1

    @pytest.mark.asyncio
    async def test_embed_async_retry_logic(self, mock_env, mock_openai_client):
        """Test async retry logic on API failures."""
        embeddings = OpenAIEmbeddings(max_retries=2, retry_delay=0.01)

        with patch("asyncio.to_thread", new_callable=AsyncMock) as mock_to_thread:
            # First call fails, second succeeds
            mock_to_thread.side_effect = [
                Exception("API Error"),
                MagicMock(data=[MagicMock(embedding=[0.1, 0.2, 0.3])]),
            ]

            with patch("asyncio.sleep", new_callable=AsyncMock):  # Speed up test
                result = await embeddings.embed_query_async("test text")

            assert result == [0.1, 0.2, 0.3]
            assert mock_to_thread.call_count == 2


class TestLegacyOpenAIEmbeddings:
    """Test the legacy compatibility wrapper."""

    @pytest.fixture
    def mock_env(self):
        """Mock environment variables."""
        with patch.dict(
            os.environ,
            {
                "OPENAI_API_KEY": "test-api-key",
                "OPENAI_INGEST_EMBEDDINGS_MODEL": "text-embedding-ada-002",
            },
        ):
            yield

    @pytest.mark.asyncio
    async def test_legacy_embed_query(self, mock_env):
        """Test legacy async embed_query."""
        with patch(
            "data_ingestion.utils.embeddings_utils.OpenAIEmbeddings"
        ) as mock_embeddings_class:
            mock_embeddings = MagicMock()
            mock_embeddings.embed_query_async = AsyncMock(return_value=[0.1, 0.2, 0.3])
            mock_embeddings_class.return_value = mock_embeddings

            legacy_embeddings = LegacyOpenAIEmbeddings(model="text-embedding-ada-002")
            result = await legacy_embeddings.embed_query("test text")

            assert result == [0.1, 0.2, 0.3]
            mock_embeddings.embed_query_async.assert_called_once_with("test text")

    @pytest.mark.asyncio
    async def test_legacy_embed_texts(self, mock_env):
        """Test legacy async embed_texts."""
        with patch(
            "data_ingestion.utils.embeddings_utils.OpenAIEmbeddings"
        ) as mock_embeddings_class:
            mock_embeddings = MagicMock()
            mock_embeddings.embed_texts_async = AsyncMock(
                return_value=[[0.1, 0.2], [0.3, 0.4]]
            )
            mock_embeddings_class.return_value = mock_embeddings

            legacy_embeddings = LegacyOpenAIEmbeddings(model="text-embedding-ada-002")
            result = await legacy_embeddings.embed_texts(["text1", "text2"])

            assert result == [[0.1, 0.2], [0.3, 0.4]]
            mock_embeddings.embed_texts_async.assert_called_once_with(
                ["text1", "text2"]
            )


class TestFactoryFunction:
    """Test the factory function."""

    def test_create_embeddings_client_default_config(self):
        """Test factory function with default configuration."""
        with patch.dict(
            os.environ,
            {
                "OPENAI_API_KEY": "test-key",
                "OPENAI_INGEST_EMBEDDINGS_MODEL": "text-embedding-ada-002",
                "OPENAI_INGEST_EMBEDDINGS_DIMENSION": "1536",
            },
        ):
            with patch(
                "data_ingestion.utils.embeddings_utils.OpenAIEmbeddings"
            ) as mock_embeddings:
                create_embeddings_client()

                mock_embeddings.assert_called_once_with(
                    model="text-embedding-ada-002", api_key="test-key"
                )

    def test_create_embeddings_client_custom_params(self):
        """Test factory function with custom parameters."""
        with patch.dict(
            os.environ,
            {
                "OPENAI_API_KEY": "test-key",
                "OPENAI_INGEST_EMBEDDINGS_MODEL": "text-embedding-ada-002",
                "OPENAI_INGEST_EMBEDDINGS_DIMENSION": "1536",
            },
        ):
            with patch(
                "data_ingestion.utils.embeddings_utils.OpenAIEmbeddings"
            ) as mock_embeddings:
                create_embeddings_client(
                    model="custom-model", api_key="custom-key", chunk_size=500
                )

                mock_embeddings.assert_called_once_with(
                    model="custom-model", api_key="custom-key", chunk_size=500
                )

    def test_create_embeddings_client_invalid_config(self):
        """Test factory function with invalid configuration."""
        with patch.dict(os.environ, {}, clear=True):
            with pytest.raises(
                ValueError, match="Missing required environment variables"
            ):
                create_embeddings_client()


class TestUtilityFunctions:
    """Test utility functions."""

    def test_estimate_batch_size_empty_list(self):
        """Test batch size estimation with empty list."""
        result = estimate_batch_size([])
        assert result == 1

    def test_estimate_batch_size_short_texts(self):
        """Test batch size estimation with short texts."""
        texts = ["short", "text", "list"]
        result = estimate_batch_size(texts, max_tokens_per_batch=1000)

        # Short texts should allow larger batch sizes
        assert result == 3  # All texts can fit

    def test_estimate_batch_size_long_texts(self):
        """Test batch size estimation with long texts."""
        texts = ["very " * 100 + "long text"] * 10  # 10 long texts
        result = estimate_batch_size(texts, max_tokens_per_batch=100)

        # Long texts should result in smaller batch sizes
        assert result >= 1

    def test_estimate_batch_size_zero_length(self):
        """Test batch size estimation with zero-length texts."""
        texts = ["", "", ""]
        result = estimate_batch_size(texts)
        assert result == 3

    def test_chunk_texts_for_processing_default_batch_size(self):
        """Test text chunking with default batch size."""
        texts = ["text1", "text2", "text3", "text4"]

        with patch(
            "data_ingestion.utils.embeddings_utils.estimate_batch_size", return_value=2
        ):
            result = chunk_texts_for_processing(texts)

            assert result == [["text1", "text2"], ["text3", "text4"]]

    def test_chunk_texts_for_processing_custom_batch_size(self):
        """Test text chunking with custom batch size."""
        texts = ["text1", "text2", "text3", "text4", "text5"]
        result = chunk_texts_for_processing(texts, batch_size=3)

        assert result == [["text1", "text2", "text3"], ["text4", "text5"]]

    def test_chunk_texts_for_processing_empty_list(self):
        """Test text chunking with empty list."""
        result = chunk_texts_for_processing([])
        assert result == []

    def test_chunk_texts_for_processing_single_item(self):
        """Test text chunking with single item."""
        texts = ["single text"]
        result = chunk_texts_for_processing(texts, batch_size=5)

        assert result == [["single text"]]


class TestIntegration:
    """Integration tests combining multiple components."""

    @pytest.fixture
    def mock_env(self):
        """Mock environment variables."""
        with patch.dict(
            os.environ,
            {
                "OPENAI_API_KEY": "test-api-key",
                "OPENAI_INGEST_EMBEDDINGS_MODEL": "text-embedding-ada-002",
                "OPENAI_INGEST_EMBEDDINGS_DIMENSION": "1536",
            },
        ):
            yield

    def test_end_to_end_workflow(self, mock_env):
        """Test complete workflow from config validation to embedding generation."""
        with patch("data_ingestion.utils.embeddings_utils.OpenAI") as mock_openai:
            mock_client = MagicMock()
            mock_openai.return_value = mock_client

            # Mock embedding response
            mock_response = MagicMock()
            mock_response.data = [MagicMock(embedding=[0.1, 0.2, 0.3])]
            mock_client.embeddings.create.return_value = mock_response

            # Validate config
            config = validate_embedding_config()
            assert config["model"] == "text-embedding-ada-002"

            # Create embeddings client
            embeddings = create_embeddings_client()

            # Generate embedding
            result = embeddings.embed_query("test text")

            assert result == [0.1, 0.2, 0.3]
            mock_client.embeddings.create.assert_called_once()

    def test_batch_processing_integration(self, mock_env):
        """Test integration of batch processing utilities."""
        with patch("data_ingestion.utils.embeddings_utils.OpenAI") as mock_openai:
            mock_client = MagicMock()
            mock_openai.return_value = mock_client

            # Mock multiple batch responses
            mock_client.embeddings.create.side_effect = [
                MagicMock(
                    data=[
                        MagicMock(embedding=[0.1, 0.2]),
                        MagicMock(embedding=[0.3, 0.4]),
                    ]
                ),
                MagicMock(data=[MagicMock(embedding=[0.5, 0.6])]),
            ]

            # Large text list
            texts = ["text1", "text2", "text3"]

            # Chunk texts
            batches = chunk_texts_for_processing(texts, batch_size=2)
            assert len(batches) == 2

            # Process with embeddings
            embeddings = OpenAIEmbeddings(chunk_size=2)
            result = embeddings.embed_texts(texts)

            assert result == [[0.1, 0.2], [0.3, 0.4], [0.5, 0.6]]
            assert mock_client.embeddings.create.call_count == 2


if __name__ == "__main__":
    pytest.main([__file__])
