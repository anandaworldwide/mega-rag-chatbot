"""
Unit tests for data_ingestion.utils.pinecone_utils module.

Tests cover all Pinecone operations with comprehensive mocking to avoid
live connections, including both sync and async versions, error handling,
and edge cases.
"""

import os
from unittest.mock import Mock, patch

import pytest
from pinecone.exceptions import PineconeException

from data_ingestion.utils.pinecone_utils import (
    batch_upsert_vectors,
    clear_library_vectors,
    clear_library_vectors_async,
    count_vectors_by_prefix,
    create_pinecone_index_if_not_exists,
    create_pinecone_index_if_not_exists_async,
    get_index_stats,
    get_pinecone_client,
    get_pinecone_ingest_index_name,
    validate_pinecone_config,
)


class TestGetPineconeClient:
    """Test Pinecone client initialization."""

    def test_get_pinecone_client_success(self):
        """Test successful client creation with API key."""
        with (
            patch.dict(os.environ, {"PINECONE_API_KEY": "test-api-key"}),
            patch("data_ingestion.utils.pinecone_utils.Pinecone") as mock_pinecone,
        ):
            mock_client = Mock()
            mock_pinecone.return_value = mock_client

            client = get_pinecone_client()

            mock_pinecone.assert_called_once_with(api_key="test-api-key")
            assert client == mock_client

    def test_get_pinecone_client_missing_api_key(self):
        """Test error when API key is missing."""
        with (
            patch.dict(os.environ, {}, clear=True),
            pytest.raises(
                ValueError, match="PINECONE_API_KEY environment variable not set"
            ),
        ):
            get_pinecone_client()

    def test_get_pinecone_client_empty_api_key(self):
        """Test error when API key is empty."""
        with (
            patch.dict(os.environ, {"PINECONE_API_KEY": ""}),
            pytest.raises(
                ValueError, match="PINECONE_API_KEY environment variable not set"
            ),
        ):
            get_pinecone_client()


class TestGetPineconeIngestIndexName:
    """Test index name retrieval."""

    def test_get_index_name_success(self):
        """Test successful index name retrieval."""
        with patch.dict(os.environ, {"PINECONE_INGEST_INDEX_NAME": "test-index"}):
            index_name = get_pinecone_ingest_index_name()
            assert index_name == "test-index"

    def test_get_index_name_missing(self):
        """Test error when index name is missing."""
        with (
            patch.dict(os.environ, {}, clear=True),
            pytest.raises(
                ValueError,
                match="PINECONE_INGEST_INDEX_NAME environment variable not set",
            ),
        ):
            get_pinecone_ingest_index_name()

    def test_get_index_name_empty(self):
        """Test error when index name is empty."""
        with (
            patch.dict(os.environ, {"PINECONE_INGEST_INDEX_NAME": ""}),
            pytest.raises(
                ValueError,
                match="PINECONE_INGEST_INDEX_NAME environment variable not set",
            ),
        ):
            get_pinecone_ingest_index_name()


class TestValidatePineconeConfig:
    """Test Pinecone configuration validation."""

    def test_validate_config_success(self):
        """Test successful configuration validation."""
        env_vars = {
            "PINECONE_API_KEY": "test-key",
            "PINECONE_INGEST_INDEX_NAME": "test-index",
            "OPENAI_INGEST_EMBEDDINGS_DIMENSION": "1536",
            "PINECONE_CLOUD": "aws",
            "PINECONE_REGION": "us-west-2",
        }

        with patch.dict(os.environ, env_vars):
            config = validate_pinecone_config()

            assert config["PINECONE_API_KEY"] == "test-key"
            assert config["PINECONE_INGEST_INDEX_NAME"] == "test-index"
            assert config["OPENAI_INGEST_EMBEDDINGS_DIMENSION"] == "1536"
            assert config["PINECONE_CLOUD"] == "aws"
            assert config["PINECONE_REGION"] == "us-west-2"

    def test_validate_config_missing_vars(self):
        """Test error when required variables are missing."""
        with (
            patch.dict(os.environ, {"PINECONE_API_KEY": "test-key"}, clear=True),
            pytest.raises(ValueError, match="Missing required environment variables"),
        ):
            validate_pinecone_config()

    def test_validate_config_invalid_dimension(self):
        """Test error when dimension is not a valid integer."""
        env_vars = {
            "PINECONE_API_KEY": "test-key",
            "PINECONE_INGEST_INDEX_NAME": "test-index",
            "OPENAI_INGEST_EMBEDDINGS_DIMENSION": "not-a-number",
            "PINECONE_CLOUD": "aws",
            "PINECONE_REGION": "us-west-2",
        }

        with (
            patch.dict(os.environ, env_vars),
            pytest.raises(ValueError, match="must be a valid integer"),
        ):
            validate_pinecone_config()

    def test_validate_config_zero_dimension(self):
        """Test error when dimension is zero."""
        env_vars = {
            "PINECONE_API_KEY": "test-key",
            "PINECONE_INGEST_INDEX_NAME": "test-index",
            "OPENAI_INGEST_EMBEDDINGS_DIMENSION": "0",
            "PINECONE_CLOUD": "aws",
            "PINECONE_REGION": "us-west-2",
        }

        with (
            patch.dict(os.environ, env_vars),
            pytest.raises(ValueError, match="must be a positive integer"),
        ):
            validate_pinecone_config()


class TestCreatePineconeIndexSync:
    """Test synchronous index creation."""

    def test_create_index_already_exists(self, capsys):
        """Test when index already exists."""
        mock_pinecone = Mock()
        mock_pinecone.describe_index.return_value = Mock()

        create_pinecone_index_if_not_exists(mock_pinecone, "test-index")

        # Verify describe_index was called but index creation was skipped
        mock_pinecone.describe_index.assert_called_once_with("test-index")
        # Verify create_index was not called
        mock_pinecone.create_index.assert_not_called()

    def test_create_index_not_exists_success(self, capsys):
        """Test successful index creation."""
        mock_pinecone = Mock()
        mock_pinecone.describe_index.side_effect = [
            PineconeException("Not found"),
            Mock(status={"ready": True}),
        ]

        env_vars = {
            "PINECONE_API_KEY": "test-key",
            "PINECONE_INGEST_INDEX_NAME": "test-index",
            "OPENAI_INGEST_EMBEDDINGS_DIMENSION": "1536",
            "PINECONE_CLOUD": "aws",
            "PINECONE_REGION": "us-west-2",
        }

        with (
            patch.dict(os.environ, env_vars),
            patch("data_ingestion.utils.pinecone_utils.ServerlessSpec") as mock_spec,
        ):
            mock_spec_instance = Mock()
            mock_spec.return_value = mock_spec_instance

            create_pinecone_index_if_not_exists(
                mock_pinecone, "test-index", wait_for_ready=True
            )

            mock_pinecone.create_index.assert_called_once_with(
                name="test-index",
                dimension=1536,
                metric="cosine",
                spec=mock_spec_instance,
            )

            captured = capsys.readouterr()
            assert "Index 'test-index' created successfully" in captured.out

    def test_create_index_dry_run_decline(self):
        """Test dry run mode with user declining creation."""
        mock_pinecone = Mock()
        mock_pinecone.describe_index.side_effect = PineconeException("Not found")

        with (
            patch("builtins.input", return_value="n"),
            pytest.raises(SystemExit, match="1"),
        ):
            create_pinecone_index_if_not_exists(
                mock_pinecone, "test-index", dry_run=True
            )

    def test_create_index_dry_run_accept(self, capsys):
        """Test dry run mode with user accepting creation."""
        mock_pinecone = Mock()
        mock_pinecone.describe_index.side_effect = [
            PineconeException("Not found"),
            Mock(status={"ready": True}),
        ]

        env_vars = {
            "PINECONE_API_KEY": "test-key",
            "PINECONE_INGEST_INDEX_NAME": "test-index",
            "OPENAI_INGEST_EMBEDDINGS_DIMENSION": "1536",
            "PINECONE_CLOUD": "aws",
            "PINECONE_REGION": "us-west-2",
        }

        with (
            patch.dict(os.environ, env_vars),
            patch("builtins.input", return_value="y"),
            patch("data_ingestion.utils.pinecone_utils.ServerlessSpec"),
        ):
            create_pinecone_index_if_not_exists(
                mock_pinecone, "test-index", dry_run=True
            )

            mock_pinecone.create_index.assert_called_once()


class TestCreatePineconeIndexAsync:
    """Test asynchronous index creation."""

    @pytest.mark.asyncio
    async def test_create_index_async_already_exists(self, capsys):
        """Test async when index already exists."""
        mock_pinecone = Mock()

        with patch("asyncio.to_thread", return_value=Mock()) as mock_to_thread:
            await create_pinecone_index_if_not_exists_async(mock_pinecone, "test-index")

            # Verify describe_index was called via to_thread
            mock_to_thread.assert_called_once_with(
                mock_pinecone.describe_index, "test-index"
            )
            # Verify create_index was not called
            mock_pinecone.create_index.assert_not_called()

    @pytest.mark.asyncio
    async def test_create_index_async_success(self, capsys):
        """Test successful async index creation."""
        mock_pinecone = Mock()

        env_vars = {
            "PINECONE_API_KEY": "test-key",
            "PINECONE_INGEST_INDEX_NAME": "test-index",
            "OPENAI_INGEST_EMBEDDINGS_DIMENSION": "1536",
            "PINECONE_CLOUD": "aws",
            "PINECONE_REGION": "us-west-2",
        }

        with (
            patch.dict(os.environ, env_vars),
            patch("asyncio.to_thread") as mock_to_thread,
            patch("data_ingestion.utils.pinecone_utils.ServerlessSpec"),
        ):
            # First call raises NotFoundException, second returns ready status
            mock_to_thread.side_effect = [
                PineconeException("Not found"),  # describe_index
                None,  # create_index
                Mock(status={"ready": True}),  # describe_index for wait
            ]

            await create_pinecone_index_if_not_exists_async(mock_pinecone, "test-index")

            assert mock_to_thread.call_count >= 2
            captured = capsys.readouterr()
            assert "Index 'test-index' created successfully" in captured.out


class TestClearLibraryVectors:
    """Test vector clearing operations."""

    def test_clear_vectors_dry_run(self, capsys):
        """Test dry run mode skips deletion."""
        mock_index = Mock()

        result = clear_library_vectors(mock_index, "test-library", dry_run=True)

        assert result is True
        captured = capsys.readouterr()
        assert "Dry run: Skipping vector deletion" in captured.out

    def test_clear_vectors_no_vectors_found(self, capsys):
        """Test when no vectors are found."""
        mock_index = Mock()
        mock_index.list.return_value = iter([])  # Empty generator

        result = clear_library_vectors(
            mock_index, "test-library", ask_confirmation=False
        )

        assert result is True
        captured = capsys.readouterr()
        assert "No existing vectors found" in captured.out

    def test_clear_vectors_success(self, capsys):
        """Test successful vector deletion."""
        mock_index = Mock()
        # Mock the generator to return batches of vector IDs
        mock_index.list.return_value = iter([["vec1", "vec2"], ["vec3"]])
        mock_index.delete.return_value = None

        result = clear_library_vectors(
            mock_index, "test-library", ask_confirmation=False
        )

        assert result is True
        # Note: This tests the backward-compatible filtering pattern that works with both
        # old 3-part format and new 7-part format (content_type||library||...)
        mock_index.list.assert_called_once_with(
            prefix="text||test-library||", limit=100
        )
        mock_index.delete.assert_called_once_with(ids=["vec1", "vec2", "vec3"])

        captured = capsys.readouterr()
        assert "Successfully deleted 3 vectors" in captured.out

    def test_clear_vectors_user_confirmation_decline(self):
        """Test user declining deletion."""
        mock_index = Mock()
        mock_index.list.return_value = iter([["vec1", "vec2"]])

        with patch("builtins.input", return_value="n"):
            result = clear_library_vectors(
                mock_index, "test-library", ask_confirmation=True
            )

            assert result is False
            mock_index.delete.assert_not_called()

    def test_clear_vectors_user_confirmation_accept(self, capsys):
        """Test user accepting deletion."""
        mock_index = Mock()
        mock_index.list.return_value = iter([["vec1", "vec2"]])

        with patch("builtins.input", return_value="y"):
            result = clear_library_vectors(
                mock_index, "test-library", ask_confirmation=True
            )

            assert result is True
            mock_index.delete.assert_called_once()

    def test_clear_vectors_with_progress_callback(self):
        """Test vector deletion with progress callback."""
        mock_index = Mock()
        mock_index.list.return_value = iter([["vec1", "vec2"]])

        progress_calls = []

        def progress_callback(total, current, operation):
            progress_calls.append((total, current, operation))

        result = clear_library_vectors(
            mock_index,
            "test-library",
            ask_confirmation=False,
            progress_callback=progress_callback,
        )

        assert result is True
        assert len(progress_calls) >= 2  # At least listing and deleting calls
        assert any(call[2] == "listing" for call in progress_calls)
        assert any(call[2] == "deleting" for call in progress_calls)

    def test_clear_vectors_listing_error(self, capsys):
        """Test error during vector listing."""
        mock_index = Mock()
        mock_index.list.side_effect = Exception("API Error")

        result = clear_library_vectors(mock_index, "test-library")

        assert result is False
        captured = capsys.readouterr()
        assert "Error listing vectors" in captured.out

    def test_clear_vectors_deletion_error(self, capsys):
        """Test error during vector deletion."""
        mock_index = Mock()
        mock_index.list.return_value = iter([["vec1", "vec2"]])
        mock_index.delete.side_effect = Exception("Delete Error")

        result = clear_library_vectors(
            mock_index, "test-library", ask_confirmation=False
        )

        assert result is False
        captured = capsys.readouterr()
        assert "Error deleting vectors" in captured.out

    def test_clear_vectors_keyboard_interrupt(self, capsys):
        """Test KeyboardInterrupt (Ctrl+C) handling during confirmation prompt."""
        mock_index = Mock()
        mock_index.list.return_value = iter([["vec1", "vec2"]])

        # Mock input to raise KeyboardInterrupt (simulating Ctrl+C)
        with patch("builtins.input", side_effect=KeyboardInterrupt()):
            result = clear_library_vectors(
                mock_index, "test-library", ask_confirmation=True
            )

        assert result is False
        captured = capsys.readouterr()
        assert "Deletion aborted by user (Ctrl+C)." in captured.out


class TestClearLibraryVectorsAsync:
    """Test asynchronous vector clearing operations."""

    @pytest.mark.asyncio
    async def test_clear_vectors_async_success(self, capsys):
        """Test successful async vector deletion."""
        mock_index = Mock()

        # Mock the async operations
        with patch("asyncio.to_thread") as mock_to_thread:
            # First call: list vectors (returns generator-like object)
            mock_list_response = Mock()
            mock_list_response.__next__ = Mock(
                side_effect=[["vec1", "vec2"], StopIteration]
            )
            mock_to_thread.side_effect = [
                mock_list_response,  # list call
                None,  # delete call
            ]

            result = await clear_library_vectors_async(mock_index, "test-library")

            assert result is True
            assert mock_to_thread.call_count == 2
            captured = capsys.readouterr()
            assert "Cleared a total of" in captured.out

    @pytest.mark.asyncio
    async def test_clear_vectors_async_list_response(self, capsys):
        """Test async deletion with direct list response."""
        mock_index = Mock()

        with patch("asyncio.to_thread") as mock_to_thread:
            # Return direct list instead of generator
            mock_to_thread.side_effect = [
                ["vec1", "vec2"],  # list call returns direct list
                None,  # delete call
            ]

            result = await clear_library_vectors_async(mock_index, "test-library")

            assert result is True
            captured = capsys.readouterr()
            assert "Cleared a total of 2" in captured.out

    @pytest.mark.asyncio
    async def test_clear_vectors_async_error(self, capsys):
        """Test error handling in async vector deletion."""
        mock_index = Mock()

        with patch("asyncio.to_thread", side_effect=Exception("Async Error")):
            result = await clear_library_vectors_async(mock_index, "test-library")

            assert result is False
            captured = capsys.readouterr()
            assert "Error clearing test-library vectors" in captured.out


class TestGetIndexStats:
    """Test index statistics retrieval."""

    def test_get_index_stats_success(self):
        """Test successful stats retrieval."""
        mock_index = Mock()
        mock_stats = Mock()
        mock_stats.total_vector_count = 1000
        mock_stats.dimension = 1536
        mock_stats.index_fullness = 0.5
        mock_stats.namespaces = {"default": Mock()}
        mock_index.describe_index_stats.return_value = mock_stats

        stats = get_index_stats(mock_index)

        assert stats["total_vector_count"] == 1000
        assert stats["dimension"] == 1536
        assert stats["index_fullness"] == 0.5
        assert "namespaces" in stats

    def test_get_index_stats_error(self):
        """Test error handling in stats retrieval."""
        mock_index = Mock()
        mock_index.describe_index_stats.side_effect = Exception("Stats Error")

        stats = get_index_stats(mock_index)

        assert stats == {}


class TestCountVectorsByPrefix:
    """Test vector counting by prefix."""

    def test_count_vectors_success(self):
        """Test successful vector counting."""
        mock_index = Mock()
        mock_index.list.return_value = iter([["vec1", "vec2"], ["vec3"]])

        count = count_vectors_by_prefix(mock_index, "test||prefix||")

        assert count == 3
        mock_index.list.assert_called_once_with(prefix="test||prefix||", limit=100)

    def test_count_vectors_empty(self):
        """Test counting when no vectors found."""
        mock_index = Mock()
        mock_index.list.return_value = iter([])

        count = count_vectors_by_prefix(mock_index, "test||prefix||")

        assert count == 0

    def test_count_vectors_error(self):
        """Test error handling in vector counting."""
        mock_index = Mock()
        mock_index.list.side_effect = Exception("Count Error")

        count = count_vectors_by_prefix(mock_index, "test||prefix||")

        assert count == 0


class TestBatchUpsertVectors:
    """Test batch vector upsertion."""

    def test_batch_upsert_success(self):
        """Test successful batch upsertion."""
        mock_index = Mock()
        mock_index.upsert.return_value = None

        vectors = [
            {"id": "vec1", "values": [0.1, 0.2], "metadata": {"key": "value1"}},
            {"id": "vec2", "values": [0.3, 0.4], "metadata": {"key": "value2"}},
            {"id": "vec3", "values": [0.5, 0.6], "metadata": {"key": "value3"}},
        ]

        success, count = batch_upsert_vectors(mock_index, vectors, batch_size=2)

        assert success is True
        assert count == 3
        assert mock_index.upsert.call_count == 2  # 2 batches: [2 vectors], [1 vector]

    def test_batch_upsert_with_progress_callback(self):
        """Test batch upsertion with progress tracking."""
        mock_index = Mock()

        vectors = [{"id": f"vec{i}", "values": [0.1], "metadata": {}} for i in range(5)]

        progress_calls = []

        def progress_callback(total, current, operation):
            progress_calls.append((total, current, operation))

        success, count = batch_upsert_vectors(
            mock_index, vectors, batch_size=2, progress_callback=progress_callback
        )

        assert success is True
        assert count == 5
        assert len(progress_calls) == 3  # 3 batches
        assert all(call[2] == "upserting" for call in progress_calls)

    def test_batch_upsert_partial_failure(self):
        """Test batch upsertion with some batch failures."""
        mock_index = Mock()
        # First batch succeeds, second fails, third succeeds
        mock_index.upsert.side_effect = [None, Exception("Batch Error"), None]

        vectors = [{"id": f"vec{i}", "values": [0.1], "metadata": {}} for i in range(6)]

        success, count = batch_upsert_vectors(mock_index, vectors, batch_size=2)

        assert success is True  # Overall success despite one batch failure
        assert count == 4  # Only 2 batches succeeded (4 vectors)

    def test_batch_upsert_complete_failure(self):
        """Test batch upsertion with complete failure."""
        mock_index = Mock()
        mock_index.upsert.side_effect = Exception("Complete Failure")

        vectors = [{"id": "vec1", "values": [0.1], "metadata": {}}]

        success, count = batch_upsert_vectors(mock_index, vectors)

        assert success is True  # Function completes but no vectors upserted
        assert count == 0


class TestIntegration:
    """Integration tests combining multiple functions."""

    def test_full_pinecone_setup_workflow(self, capsys):
        """Test complete Pinecone setup workflow."""
        env_vars = {
            "PINECONE_API_KEY": "test-key",
            "PINECONE_INGEST_INDEX_NAME": "test-index",
            "OPENAI_INGEST_EMBEDDINGS_DIMENSION": "1536",
            "PINECONE_CLOUD": "aws",
            "PINECONE_REGION": "us-west-2",
        }

        with (
            patch.dict(os.environ, env_vars),
            patch(
                "data_ingestion.utils.pinecone_utils.Pinecone"
            ) as mock_pinecone_class,
        ):
            # Test config validation
            config = validate_pinecone_config()
            assert len(config) == 5

            # Test client creation
            mock_client = Mock()
            mock_pinecone_class.return_value = mock_client

            client = get_pinecone_client()
            assert client == mock_client

            # Test index name retrieval
            index_name = get_pinecone_ingest_index_name()
            assert index_name == "test-index"

    def test_vector_operations_workflow(self):
        """Test vector operations workflow."""
        mock_index = Mock()

        # Test vector counting
        mock_index.list.return_value = iter([["vec1", "vec2"]])
        count = count_vectors_by_prefix(mock_index, "test||")
        assert count == 2

        # Test vector clearing
        mock_index.list.return_value = iter([["vec1", "vec2"]])
        result = clear_library_vectors(mock_index, "test-lib", ask_confirmation=False)
        assert result is True

        # Test vector upsertion
        vectors = [{"id": "new_vec", "values": [0.1], "metadata": {}}]
        success, upserted = batch_upsert_vectors(mock_index, vectors)
        assert success is True
        assert upserted == 1
