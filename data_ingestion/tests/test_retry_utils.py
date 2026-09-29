"""
Tests for retry utilities.

This module tests the retry logic with exponential backoff for both
async and sync operations, including error handling and configuration validation.
"""

import asyncio
from unittest.mock import AsyncMock, Mock, patch

import pytest

from data_ingestion.utils.retry_utils import (
    EMBEDDING_RETRY_CONFIG,
    NETWORK_RETRY_CONFIG,
    PINECONE_RETRY_CONFIG,
    retry_with_backoff,
    retry_with_backoff_sync,
)


class TestRetryWithBackoffAsync:
    """Test the async retry_with_backoff function."""

    @pytest.mark.asyncio
    async def test_successful_operation_no_retries(self):
        """Test that successful operations return immediately without retries."""
        mock_operation = AsyncMock(return_value="success")

        result = await retry_with_backoff(
            mock_operation, max_retries=3, operation_name="test_operation"
        )

        assert result == "success"
        assert mock_operation.call_count == 1

    @pytest.mark.asyncio
    async def test_operation_succeeds_after_retries(self):
        """Test that operations succeed after some retries."""
        mock_operation = AsyncMock()
        # Fail twice, then succeed
        mock_operation.side_effect = [
            Exception("Network error"),
            Exception("Timeout error"),
            "success",
        ]

        with patch("asyncio.sleep") as mock_sleep:
            result = await retry_with_backoff(
                mock_operation,
                max_retries=3,
                base_delay=1.0,
                backoff_factor=2.0,
                operation_name="test_operation",
            )

        assert result == "success"
        assert mock_operation.call_count == 3

        # Verify backoff delays were called
        expected_calls = [
            pytest.approx(1.0),  # First retry: base_delay
            pytest.approx(2.0),  # Second retry: base_delay * backoff_factor
        ]
        actual_calls = [call[0][0] for call in mock_sleep.call_args_list]
        assert actual_calls == expected_calls

    @pytest.mark.asyncio
    async def test_max_retries_exceeded(self):
        """Test that function raises exception when max retries are exceeded."""
        mock_operation = AsyncMock()
        mock_operation.side_effect = Exception("Persistent error")

        with patch("asyncio.sleep"), pytest.raises(Exception, match="Persistent error"):
            await retry_with_backoff(
                mock_operation, max_retries=2, operation_name="test_operation"
            )
        # Should be called max_retries + 1 times (initial + retries)
        assert mock_operation.call_count == 3

    @pytest.mark.asyncio
    async def test_fatal_errors_no_retry(self):
        """Test that fatal errors are not retried."""
        mock_operation = AsyncMock()
        mock_operation.side_effect = Exception("Invalid API key")

        def stop_process(code):
            raise SystemExit(code)

        with (
            patch(
                "data_ingestion.utils.credential_errors.os._exit",
                side_effect=stop_process,
            ),
            pytest.raises(SystemExit),
        ):
            await retry_with_backoff(
                mock_operation, max_retries=3, operation_name="test_operation"
            )

        # Should only be called once (no retries for fatal errors)
        assert mock_operation.call_count == 1

    @pytest.mark.asyncio
    async def test_custom_fatal_error_patterns(self):
        """Test custom fatal error patterns."""
        mock_operation = AsyncMock()
        mock_operation.side_effect = Exception("Custom fatal error")

        with pytest.raises(Exception, match="Custom fatal error"):
            await retry_with_backoff(
                mock_operation,
                max_retries=3,
                operation_name="test_operation",
                fatal_error_patterns=["custom fatal"],
            )

        assert mock_operation.call_count == 1

    @pytest.mark.asyncio
    async def test_max_delay_cap(self):
        """Test that delay is capped at max_delay."""
        mock_operation = AsyncMock()
        mock_operation.side_effect = [
            Exception("Error 1"),
            Exception("Error 2"),
            Exception("Error 3"),
            "success",
        ]

        with patch("asyncio.sleep") as mock_sleep:
            result = await retry_with_backoff(
                mock_operation,
                max_retries=3,
                base_delay=10.0,
                max_delay=15.0,
                backoff_factor=3.0,
                operation_name="test_operation",
            )

        assert result == "success"

        # Check that delays are capped
        actual_calls = [call[0][0] for call in mock_sleep.call_args_list]
        # Expected: [10.0, 15.0 (capped), 15.0 (capped)]
        assert actual_calls == [10.0, 15.0, 15.0]

    @pytest.mark.asyncio
    async def test_default_fatal_error_patterns(self):
        """Test that default fatal error patterns work correctly."""
        fatal_errors = [
            "Invalid API key",
            "Authentication failed",
            "Quota exceeded",
            "Index not found",
            "Dimension mismatch",
            "Insufficient quota",
            "Rate limit exceeded",
        ]

        def stop_process(code):
            raise SystemExit(code)

        for error_msg in fatal_errors:
            mock_operation = AsyncMock()
            mock_operation.side_effect = Exception(error_msg)

            if "api key" in error_msg.lower():
                with (
                    patch(
                        "data_ingestion.utils.credential_errors.os._exit",
                        side_effect=stop_process,
                    ),
                    pytest.raises(SystemExit),
                ):
                    await retry_with_backoff(
                        mock_operation, max_retries=3, operation_name="test_operation"
                    )
            else:
                with pytest.raises(Exception, match=error_msg):
                    await retry_with_backoff(
                        mock_operation, max_retries=3, operation_name="test_operation"
                    )

            assert mock_operation.call_count == 1
            mock_operation.reset_mock()


class TestRetryWithBackoffSync:
    """Test the sync retry_with_backoff_sync function."""

    def test_successful_operation_no_retries(self):
        """Test that successful operations return immediately without retries."""
        mock_operation = Mock(return_value="success")

        result = retry_with_backoff_sync(
            mock_operation, max_retries=3, operation_name="test_operation"
        )

        assert result == "success"
        assert mock_operation.call_count == 1

    def test_operation_succeeds_after_retries(self):
        """Test that operations succeed after some retries."""
        mock_operation = Mock()
        # Fail twice, then succeed
        mock_operation.side_effect = [
            Exception("Network error"),
            Exception("Timeout error"),
            "success",
        ]

        with patch("time.sleep") as mock_sleep:
            result = retry_with_backoff_sync(
                mock_operation,
                max_retries=3,
                base_delay=1.0,
                backoff_factor=2.0,
                operation_name="test_operation",
            )

        assert result == "success"
        assert mock_operation.call_count == 3

        # Verify backoff delays were called
        expected_calls = [
            pytest.approx(1.0),  # First retry: base_delay
            pytest.approx(2.0),  # Second retry: base_delay * backoff_factor
        ]
        actual_calls = [call[0][0] for call in mock_sleep.call_args_list]
        assert actual_calls == expected_calls

    def test_max_retries_exceeded(self):
        """Test that function raises exception when max retries are exceeded."""
        mock_operation = Mock()
        mock_operation.side_effect = Exception("Persistent error")

        with patch("time.sleep"), pytest.raises(Exception, match="Persistent error"):
            retry_with_backoff_sync(
                mock_operation, max_retries=2, operation_name="test_operation"
            )
        # Should be called max_retries + 1 times (initial + retries)
        assert mock_operation.call_count == 3

    def test_fatal_errors_no_retry(self):
        """Test that fatal errors are not retried."""
        mock_operation = Mock()
        mock_operation.side_effect = Exception("Quota exceeded")

        with pytest.raises(Exception, match="Quota exceeded"):
            retry_with_backoff_sync(
                mock_operation, max_retries=3, operation_name="test_operation"
            )

        # Should only be called once (no retries for fatal errors)
        assert mock_operation.call_count == 1


class TestRetryConfigurations:
    """Test the predefined retry configurations."""

    def test_embedding_retry_config(self):
        """Test EMBEDDING_RETRY_CONFIG has expected values."""
        expected = {
            "max_retries": 3,
            "base_delay": 2.0,
            "max_delay": 30.0,
            "backoff_factor": 2.0,
        }
        assert expected == EMBEDDING_RETRY_CONFIG

    def test_pinecone_retry_config(self):
        """Test PINECONE_RETRY_CONFIG has expected values."""
        expected = {
            "max_retries": 5,
            "base_delay": 1.0,
            "max_delay": 30.0,
            "backoff_factor": 2.0,
        }
        assert expected == PINECONE_RETRY_CONFIG

    def test_network_retry_config(self):
        """Test NETWORK_RETRY_CONFIG has expected values."""
        expected = {
            "max_retries": 3,
            "base_delay": 1.0,
            "max_delay": 60.0,
            "backoff_factor": 2.0,
        }
        assert expected == NETWORK_RETRY_CONFIG

    @pytest.mark.asyncio
    async def test_config_integration_async(self):
        """Test that predefined configs work with async retry function."""
        mock_operation = AsyncMock(return_value="config_success")

        result = await retry_with_backoff(
            mock_operation, operation_name="test_config", **EMBEDDING_RETRY_CONFIG
        )

        assert result == "config_success"
        assert mock_operation.call_count == 1

    def test_config_integration_sync(self):
        """Test that predefined configs work with sync retry function."""
        mock_operation = Mock(return_value="config_success")

        result = retry_with_backoff_sync(
            mock_operation, operation_name="test_config", **PINECONE_RETRY_CONFIG
        )

        assert result == "config_success"
        assert mock_operation.call_count == 1


class TestRetryTimingBehavior:
    """Test timing behavior and edge cases."""

    @pytest.mark.asyncio
    async def test_exponential_backoff_calculation(self):
        """Test that exponential backoff is calculated correctly."""
        mock_operation = AsyncMock()
        mock_operation.side_effect = [
            Exception("Error 1"),
            Exception("Error 2"),
            Exception("Error 3"),
            Exception("Error 4"),
            "success",
        ]

        with patch("asyncio.sleep") as mock_sleep:
            result = await retry_with_backoff(
                mock_operation,
                max_retries=4,
                base_delay=1.0,
                backoff_factor=2.0,
                max_delay=100.0,  # High enough to not cap
                operation_name="test_backoff",
            )

        assert result == "success"

        # Expected delays: 1.0, 2.0, 4.0, 8.0
        expected_delays = [1.0, 2.0, 4.0, 8.0]
        actual_delays = [call[0][0] for call in mock_sleep.call_args_list]
        assert actual_delays == expected_delays

    @pytest.mark.asyncio
    async def test_zero_retries(self):
        """Test behavior with max_retries=0."""
        mock_operation = AsyncMock()
        mock_operation.side_effect = Exception("Immediate failure")

        with pytest.raises(Exception, match="Immediate failure"):
            await retry_with_backoff(
                mock_operation, max_retries=0, operation_name="test_zero_retries"
            )

        assert mock_operation.call_count == 1

    def test_sync_timing_accuracy(self):
        """Test that sync version respects timing constraints."""
        mock_operation = Mock()
        mock_operation.side_effect = [Exception("Error"), "success"]

        with patch("time.sleep") as mock_sleep:
            result = retry_with_backoff_sync(
                mock_operation,
                max_retries=1,
                base_delay=0.1,
                operation_name="test_timing",
            )

        assert result == "success"
        mock_sleep.assert_called_once_with(0.1)


class TestErrorMessageHandling:
    """Test error message handling and logging."""

    @pytest.mark.asyncio
    async def test_case_insensitive_fatal_errors(self):
        """Test that fatal error detection is case insensitive."""
        fatal_variations = [
            "INVALID API KEY",
            "Invalid Api Key",
            "invalid api key",
            "Authentication Failed",
            "AUTHENTICATION FAILED",
        ]

        def stop_process(code):
            raise SystemExit(code)

        for error_msg in fatal_variations:
            mock_operation = AsyncMock()
            mock_operation.side_effect = Exception(error_msg)

            if "api key" in error_msg.lower():
                with (
                    patch(
                        "data_ingestion.utils.credential_errors.os._exit",
                        side_effect=stop_process,
                    ),
                    pytest.raises(SystemExit),
                ):
                    await retry_with_backoff(
                        mock_operation,
                        max_retries=3,
                        operation_name="test_case_insensitive",
                    )
            else:
                with pytest.raises(Exception, match=error_msg):
                    await retry_with_backoff(
                        mock_operation,
                        max_retries=3,
                        operation_name="test_case_insensitive",
                    )

            assert mock_operation.call_count == 1
            mock_operation.reset_mock()

    @pytest.mark.asyncio
    async def test_partial_fatal_error_matching(self):
        """Test that fatal errors match partial strings."""
        mock_operation = AsyncMock()
        mock_operation.side_effect = Exception("OpenAI quota exceeded for requests")

        with pytest.raises(Exception, match="quota exceeded"):
            await retry_with_backoff(
                mock_operation, max_retries=3, operation_name="test_partial_matching"
            )

        assert mock_operation.call_count == 1


class TestAsyncTimeoutScenarios:
    """Test async timeout and cancellation scenarios."""

    @pytest.mark.asyncio
    async def test_operation_with_timeout(self):
        """Test retry behavior with asyncio.TimeoutError."""

        async def slow_operation():
            await asyncio.sleep(0.5)  # Reduced from 1.0 for faster testing
            return "should not reach here"

        async def timeout_operation():
            return await asyncio.wait_for(slow_operation(), timeout=0.1)

        # Don't patch asyncio.sleep here as we want the actual timeout to occur
        with pytest.raises(asyncio.TimeoutError):
            await retry_with_backoff(
                timeout_operation,
                max_retries=2,
                base_delay=0.1,  # Short delay for fast testing
                operation_name="test_timeout",
            )

    @pytest.mark.asyncio
    async def test_mixed_error_types(self):
        """Test handling of different exception types."""
        mock_operation = AsyncMock()
        mock_operation.side_effect = [
            ValueError("Value error"),
            ConnectionError("Connection error"),
            asyncio.TimeoutError("Timeout error"),
            "success",
        ]

        with patch("asyncio.sleep"):
            result = await retry_with_backoff(
                mock_operation, max_retries=3, operation_name="test_mixed_errors"
            )

        assert result == "success"
        assert mock_operation.call_count == 4
