"""
Tests for s3_utils.py module.

This module handles AWS S3 integration including file uploads, deduplication,
and error handling with exponential backoff retry logic. Tests cover both
happy path scenarios and various error conditions.
"""

import os
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError

from data_ingestion.utils.s3_utils import (
    S3UploadError,
    check_unique_filenames,
    exponential_backoff,
    file_exists_with_same_size,
    get_bucket_name,
    get_s3_client,
    upload_to_s3,
)


class TestS3Utils:
    """Test suite for s3_utils.py core functions."""

    def test_get_s3_client(self):
        """Test that get_s3_client returns a boto3 S3 client."""
        with patch("data_ingestion.utils.s3_utils.boto3.client") as mock_client:
            mock_s3_client = MagicMock()
            mock_client.return_value = mock_s3_client

            result = get_s3_client()

            mock_client.assert_called_once_with("s3")
            assert result == mock_s3_client

    def test_get_bucket_name(self):
        """Test that get_bucket_name returns the correct environment variable."""
        with patch.dict(os.environ, {"S3_BUCKET_NAME": "test-bucket"}):
            result = get_bucket_name()
            assert result == "test-bucket"

    def test_get_bucket_name_not_set(self):
        """Test that get_bucket_name returns None when environment variable is not set."""
        with patch.dict(os.environ, {}, clear=True):
            result = get_bucket_name()
            assert result is None

    def test_exponential_backoff_calculation(self):
        """Test exponential backoff calculation with proper bounds."""
        # Test that backoff increases with attempt number
        backoff_0 = exponential_backoff(0)
        backoff_1 = exponential_backoff(1)
        backoff_2 = exponential_backoff(2)

        # Should be approximately 1, 2, 4 seconds plus random component
        assert 1.0 <= backoff_0 <= 2.0  # 2^0 + random(0,1)
        assert 2.0 <= backoff_1 <= 3.0  # 2^1 + random(0,1)
        assert 4.0 <= backoff_2 <= 5.0  # 2^2 + random(0,1)

    def test_exponential_backoff_max_limit(self):
        """Test that exponential backoff respects maximum limit of 5 seconds."""
        # Test with high attempt numbers to ensure cap at 5 seconds
        backoff_high = exponential_backoff(10)
        assert backoff_high <= 5.0

    def test_file_exists_with_same_size_match(self):
        """Test file_exists_with_same_size when file exists with matching size."""
        mock_s3_client = MagicMock()
        mock_s3_client.head_object.return_value = {"ContentLength": 1024}

        with patch("os.path.getsize", return_value=1024):
            result = file_exists_with_same_size(
                mock_s3_client, "test-bucket", "test-key", "/path/to/file"
            )

        assert result is True
        mock_s3_client.head_object.assert_called_once_with(
            Bucket="test-bucket", Key="test-key"
        )

    def test_file_exists_with_same_size_different_size(self):
        """Test file_exists_with_same_size when file exists but size differs."""
        mock_s3_client = MagicMock()
        mock_s3_client.head_object.return_value = {"ContentLength": 2048}

        with patch("os.path.getsize", return_value=1024):
            result = file_exists_with_same_size(
                mock_s3_client, "test-bucket", "test-key", "/path/to/file"
            )

        assert result is False

    def test_file_exists_with_same_size_not_found(self):
        """Test file_exists_with_same_size when file doesn't exist in S3."""
        mock_s3_client = MagicMock()
        mock_s3_client.head_object.side_effect = ClientError(
            {"Error": {"Code": "404"}}, "HeadObject"
        )

        with patch("os.path.getsize", return_value=1024):
            result = file_exists_with_same_size(
                mock_s3_client, "test-bucket", "test-key", "/path/to/file"
            )

        assert result is False

    def test_file_exists_with_same_size_s3_error(self):
        """Test file_exists_with_same_size when S3 returns other errors."""
        mock_s3_client = MagicMock()
        mock_s3_client.head_object.side_effect = ClientError(
            {"Error": {"Code": "AccessDenied"}}, "HeadObject"
        )

        with patch("os.path.getsize", return_value=1024):
            result = file_exists_with_same_size(
                mock_s3_client, "test-bucket", "test-key", "/path/to/file"
            )

        assert result is False

    def test_file_exists_with_same_size_local_file_error(self):
        """Test file_exists_with_same_size when local file access fails."""
        mock_s3_client = MagicMock()

        with patch("os.path.getsize", side_effect=OSError("File not found")):
            result = file_exists_with_same_size(
                mock_s3_client, "test-bucket", "test-key", "/path/to/file"
            )

        assert result is False

    @patch("data_ingestion.utils.s3_utils.get_bucket_name")
    @patch("data_ingestion.utils.s3_utils.get_s3_client")
    @patch("data_ingestion.utils.s3_utils.file_exists_with_same_size")
    def test_upload_to_s3_success(
        self, mock_file_exists, mock_get_client, mock_get_bucket
    ):
        """Test successful S3 upload."""
        # Setup mocks
        mock_s3_client = MagicMock()
        mock_get_client.return_value = mock_s3_client
        mock_get_bucket.return_value = "test-bucket"
        mock_file_exists.return_value = False  # File doesn't exist, so upload

        # Call function
        upload_to_s3("/path/to/file.mp3", "audio/file.mp3")

        # Verify calls
        mock_s3_client.upload_file.assert_called_once_with(
            "/path/to/file.mp3", "test-bucket", "audio/file.mp3"
        )
        mock_file_exists.assert_called_once_with(
            mock_s3_client, "test-bucket", "audio/file.mp3", "/path/to/file.mp3"
        )

    @patch("data_ingestion.utils.s3_utils.get_bucket_name")
    @patch("data_ingestion.utils.s3_utils.get_s3_client")
    @patch("data_ingestion.utils.s3_utils.file_exists_with_same_size")
    def test_upload_to_s3_file_already_exists(
        self, mock_file_exists, mock_get_client, mock_get_bucket
    ):
        """Test S3 upload when file already exists with same size."""
        # Setup mocks
        mock_s3_client = MagicMock()
        mock_get_client.return_value = mock_s3_client
        mock_get_bucket.return_value = "test-bucket"
        mock_file_exists.return_value = True  # File exists with same size

        # Call function
        upload_to_s3("/path/to/file.mp3", "audio/file.mp3")

        # Verify upload was skipped
        mock_s3_client.upload_file.assert_not_called()
        mock_file_exists.assert_called_once()

    @patch("data_ingestion.utils.s3_utils.get_bucket_name")
    @patch("data_ingestion.utils.s3_utils.get_s3_client")
    @patch("data_ingestion.utils.s3_utils.file_exists_with_same_size")
    def test_upload_to_s3_overwrite_true(
        self, mock_file_exists, mock_get_client, mock_get_bucket
    ):
        """Test S3 upload with overwrite=True bypasses existence check."""
        # Setup mocks
        mock_s3_client = MagicMock()
        mock_get_client.return_value = mock_s3_client
        mock_get_bucket.return_value = "test-bucket"
        mock_file_exists.return_value = True  # File exists but should be overwritten

        # Call function with overwrite=True
        result = upload_to_s3("/path/to/file.pdf", "pdf/file.pdf", overwrite=True)

        # Verify upload proceeded despite file existing
        mock_s3_client.upload_file.assert_called_once_with(
            "/path/to/file.pdf", "test-bucket", "pdf/file.pdf"
        )
        # Verify existence check was skipped
        mock_file_exists.assert_not_called()
        assert result is True

    @patch("data_ingestion.utils.s3_utils.get_bucket_name")
    @patch("data_ingestion.utils.s3_utils.get_s3_client")
    @patch("data_ingestion.utils.s3_utils.file_exists_with_same_size")
    def test_upload_to_s3_overwrite_false_file_exists(
        self, mock_file_exists, mock_get_client, mock_get_bucket
    ):
        """Test S3 upload with overwrite=False (default) respects existence check."""
        # Setup mocks
        mock_s3_client = MagicMock()
        mock_get_client.return_value = mock_s3_client
        mock_get_bucket.return_value = "test-bucket"
        mock_file_exists.return_value = True  # File exists

        # Call function with overwrite=False (default)
        result = upload_to_s3("/path/to/file.pdf", "pdf/file.pdf", overwrite=False)

        # Verify upload was skipped
        mock_s3_client.upload_file.assert_not_called()
        mock_file_exists.assert_called_once_with(
            mock_s3_client, "test-bucket", "pdf/file.pdf", "/path/to/file.pdf"
        )
        assert result is False

    def test_upload_to_s3_missing_key(self):
        """Test upload_to_s3 raises ValueError when s3_key is not provided."""
        with pytest.raises(ValueError, match="s3_key must be provided"):
            upload_to_s3("/path/to/file.mp3", "")

        with pytest.raises(ValueError, match="s3_key must be provided"):
            upload_to_s3("/path/to/file.mp3", None)

    @patch("data_ingestion.utils.s3_utils.get_bucket_name")
    @patch("data_ingestion.utils.s3_utils.get_s3_client")
    @patch("data_ingestion.utils.s3_utils.file_exists_with_same_size")
    @patch("time.sleep")  # Mock sleep to speed up tests
    def test_upload_to_s3_retry_on_time_skew(
        self, mock_sleep, mock_file_exists, mock_get_client, mock_get_bucket
    ):
        """Test S3 upload retry logic for RequestTimeTooSkewed errors."""
        # Setup mocks
        mock_s3_client = MagicMock()
        mock_get_client.return_value = mock_s3_client
        mock_get_bucket.return_value = "test-bucket"
        mock_file_exists.return_value = False

        # First call fails with RequestTimeTooSkewed, second succeeds
        mock_s3_client.upload_file.side_effect = [
            ClientError({"Error": {"Code": "RequestTimeTooSkewed"}}, "PutObject"),
            None,  # Success on retry
        ]

        # Call function
        upload_to_s3("/path/to/file.mp3", "audio/file.mp3")

        # Verify retry occurred
        assert mock_s3_client.upload_file.call_count == 2
        mock_sleep.assert_called_once()  # Should have slept during backoff

    @patch("data_ingestion.utils.s3_utils.get_bucket_name")
    @patch("data_ingestion.utils.s3_utils.get_s3_client")
    @patch("data_ingestion.utils.s3_utils.file_exists_with_same_size")
    @patch("time.sleep")
    def test_upload_to_s3_max_retries_exceeded(
        self, mock_sleep, mock_file_exists, mock_get_client, mock_get_bucket
    ):
        """Test S3 upload raises S3UploadError after max retries exceeded."""
        # Setup mocks
        mock_s3_client = MagicMock()
        mock_get_client.return_value = mock_s3_client
        mock_get_bucket.return_value = "test-bucket"
        mock_file_exists.return_value = False

        # Always fail with RequestTimeTooSkewed
        mock_s3_client.upload_file.side_effect = ClientError(
            {"Error": {"Code": "RequestTimeTooSkewed"}}, "PutObject"
        )

        # Call function and expect exception
        with pytest.raises(S3UploadError, match="Failed to upload.*after 5 attempts"):
            upload_to_s3("/path/to/file.mp3", "audio/file.mp3")

        # Verify all retries were attempted
        assert mock_s3_client.upload_file.call_count == 5

    @patch("data_ingestion.utils.s3_utils.get_bucket_name")
    @patch("data_ingestion.utils.s3_utils.get_s3_client")
    @patch("data_ingestion.utils.s3_utils.file_exists_with_same_size")
    def test_upload_to_s3_immediate_error(
        self, mock_file_exists, mock_get_client, mock_get_bucket
    ):
        """Test S3 upload raises S3UploadError for non-retryable errors."""
        # Setup mocks
        mock_s3_client = MagicMock()
        mock_get_client.return_value = mock_s3_client
        mock_get_bucket.return_value = "test-bucket"
        mock_file_exists.return_value = False

        # Fail with AccessDenied (non-retryable)
        mock_s3_client.upload_file.side_effect = ClientError(
            {"Error": {"Code": "AccessDenied"}}, "PutObject"
        )

        # Call function and expect immediate exception
        with pytest.raises(S3UploadError, match="Error uploading"):
            upload_to_s3("/path/to/file.mp3", "audio/file.mp3")

        # Verify no retries for non-retryable error
        assert mock_s3_client.upload_file.call_count == 1

    @patch("data_ingestion.utils.s3_utils.get_bucket_name")
    @patch("data_ingestion.utils.s3_utils.get_s3_client")
    @patch("os.walk")
    def test_check_unique_filenames_with_conflicts(
        self, mock_walk, mock_get_client, mock_get_bucket
    ):
        """Test check_unique_filenames detects local duplicates and S3 conflicts."""
        # Setup mocks
        mock_s3_client = MagicMock()
        mock_get_client.return_value = mock_s3_client
        mock_get_bucket.return_value = "test-bucket"

        # Mock local file structure
        mock_walk.return_value = [
            ("/path/audio", [], ["file1.mp3", "file2.wav", "duplicate.mp3"]),
            ("/path/video", [], ["file3.mp4", "duplicate.mp3"]),  # Local duplicate
        ]

        # Mock S3 response
        mock_paginator = MagicMock()
        mock_s3_client.get_paginator.return_value = mock_paginator
        mock_paginator.paginate.return_value = [
            {
                "Contents": [
                    {"Key": "public/audio/file1.mp3"},  # S3 conflict
                    {"Key": "public/video/other.mp4"},
                ]
            }
        ]

        result = check_unique_filenames("/path")

        # Verify results
        assert "file1.mp3" in result  # S3 conflict
        assert "duplicate.mp3" in result  # Local duplicate
        assert "file2.wav" not in result  # No conflicts
        assert "file3.mp4" not in result  # No conflicts

        # Verify S3 conflict entry
        assert "S3: public/audio/file1.mp3" in result["file1.mp3"]

        # Verify local duplicate entries
        duplicate_paths = result["duplicate.mp3"]
        assert "/path/audio/duplicate.mp3" in duplicate_paths
        assert "/path/video/duplicate.mp3" in duplicate_paths

    @patch("data_ingestion.utils.s3_utils.get_bucket_name")
    @patch("data_ingestion.utils.s3_utils.get_s3_client")
    @patch("os.walk")
    def test_check_unique_filenames_s3_error(
        self, mock_walk, mock_get_client, mock_get_bucket
    ):
        """Test check_unique_filenames handles S3 access errors gracefully."""
        # Setup mocks
        mock_s3_client = MagicMock()
        mock_get_client.return_value = mock_s3_client
        mock_get_bucket.return_value = "test-bucket"

        # Mock local files
        mock_walk.return_value = [
            ("/path/audio", [], ["file1.mp3"]),
        ]

        # Mock S3 error
        mock_paginator = MagicMock()
        mock_s3_client.get_paginator.return_value = mock_paginator
        mock_paginator.paginate.side_effect = ClientError(
            {"Error": {"Code": "AccessDenied"}}, "ListObjects"
        )

        result = check_unique_filenames("/path")

        # Should return empty dict when S3 access fails
        assert result == {}

    @patch("data_ingestion.utils.s3_utils.get_bucket_name")
    @patch("data_ingestion.utils.s3_utils.get_s3_client")
    @patch("os.walk")
    def test_check_unique_filenames_no_conflicts(
        self, mock_walk, mock_get_client, mock_get_bucket
    ):
        """Test check_unique_filenames returns empty dict when no conflicts exist."""
        # Setup mocks
        mock_s3_client = MagicMock()
        mock_get_client.return_value = mock_s3_client
        mock_get_bucket.return_value = "test-bucket"

        # Mock local files
        mock_walk.return_value = [
            ("/path/audio", [], ["unique1.mp3", "unique2.wav"]),
        ]

        # Mock S3 response with no conflicts
        mock_paginator = MagicMock()
        mock_s3_client.get_paginator.return_value = mock_paginator
        mock_paginator.paginate.return_value = [
            {
                "Contents": [
                    {"Key": "public/audio/different.mp3"},
                    {"Key": "public/video/other.mp4"},
                ]
            }
        ]

        result = check_unique_filenames("/path")

        # Should return empty dict when no conflicts
        assert result == {}

    def test_download_s3_object_to_file_success(self, tmp_path):
        from data_ingestion.utils.s3_utils import download_s3_object_to_file

        dest = tmp_path / "talk.mp3"
        mock_s3_client = MagicMock()

        with (
            patch(
                "data_ingestion.utils.s3_utils.get_s3_client",
                return_value=mock_s3_client,
            ),
            patch(
                "data_ingestion.utils.s3_utils.get_bucket_name",
                return_value="ananda-chatbot",
            ),
        ):
            download_s3_object_to_file("public/audio/bhaktan/talk.mp3", str(dest))

        mock_s3_client.download_file.assert_called_once_with(
            "ananda-chatbot", "public/audio/bhaktan/talk.mp3", str(dest)
        )

    def test_download_s3_object_to_temp_uses_key_suffix(self):
        from data_ingestion.utils.s3_utils import download_s3_object_to_temp

        with patch(
            "data_ingestion.utils.s3_utils.download_s3_object_to_file"
        ) as mock_download:
            mock_download.side_effect = lambda key, dest, max_attempts=5: dest
            temp_path = download_s3_object_to_temp(
                "public/audio/bhaktan/kriyaban-only/talk.flac"
            )

        try:
            assert temp_path.endswith(".flac")
            mock_download.assert_called_once()
            assert mock_download.call_args.args[0] == (
                "public/audio/bhaktan/kriyaban-only/talk.flac"
            )
            assert mock_download.call_args.args[1] == temp_path
            assert os.path.exists(temp_path)
        finally:
            if os.path.exists(temp_path):
                os.remove(temp_path)
