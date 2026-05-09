"""
Tests for manage_queue.py module.

This module manages distributed media ingestion workflows with DynamoDB, S3, YouTube integration,
and queue management. Tests cover core functionality including path operations, file processing,
environment setup, and queue operations.
"""

from unittest.mock import MagicMock, patch

import pytest

from data_ingestion.audio_video.manage_queue import (
    add_to_queue,
    get_unique_files,
    initialize_environment,
    process_audio_input,
    truncate_path,
)


class TestManageQueue:
    """Test suite for manage_queue.py core functions."""

    def test_truncate_path_with_long_path(self):
        """Test that truncate_path correctly shortens long file paths while preserving context."""
        # Test with a long path that should be truncated
        long_path = "/very/long/path/to/nested/directory/structure/audio_file.mp3"
        result = truncate_path(long_path, num_dirs=3)

        # Should preserve 3 directories plus filename (4 parts total due to -1 index)
        expected = "nested/directory/structure/audio_file.mp3"
        assert result == expected

    def test_truncate_path_with_short_path(self):
        """Test that truncate_path leaves short paths unchanged."""
        short_path = "path/to/file.mp3"
        result = truncate_path(short_path, num_dirs=3)

        # Should return original path since it's already short
        assert result == short_path

    def test_truncate_path_with_single_file(self):
        """Test that truncate_path handles single filename correctly."""
        single_file = "audio_file.mp3"
        result = truncate_path(single_file, num_dirs=3)

        # Should return original filename
        assert result == single_file

    def test_truncate_path_with_different_num_dirs(self):
        """Test that truncate_path respects different num_dirs parameters."""
        path = "/path/to/nested/directory/file.mp3"

        # Test with num_dirs=2
        result_2 = truncate_path(path, num_dirs=2)
        expected_2 = "nested/directory/file.mp3"  # Fixed expectation
        assert result_2 == expected_2

        # Test with num_dirs=1
        result_1 = truncate_path(path, num_dirs=1)
        expected_1 = "directory/file.mp3"  # Fixed expectation
        assert result_1 == expected_1

    @patch("data_ingestion.audio_video.manage_queue.get_file_hash")
    @patch("os.walk")
    def test_get_unique_files_with_duplicates(self, mock_walk, mock_hash):
        """Test that get_unique_files correctly deduplicates files based on hash."""
        # Mock directory walk to return test files
        mock_walk.return_value = [
            (
                "/test/dir",
                [],
                ["file1.mp3", "file2.wav", "duplicate.mp3", "file3.flac"],
            ),
            ("/test/dir/subdir", [], ["another_duplicate.mp3"]),
        ]

        # Mock hash function to simulate duplicates
        def mock_hash_func(file_path):
            if "duplicate" in file_path:
                return "duplicate_hash"
            elif "file1" in file_path:
                return "file1_hash"
            elif "file2" in file_path:
                return "file2_hash"
            elif "file3" in file_path:
                return "file3_hash"
            else:
                return "unique_hash"

        mock_hash.side_effect = mock_hash_func

        # Call function
        result = get_unique_files("/test/dir")

        # Should return unique files only (first occurrence of each hash)
        assert len(result) == 4  # file1, file2, first duplicate, file3

        # Check that get_file_hash was called for each audio file
        assert mock_hash.call_count == 5

    @patch("data_ingestion.audio_video.manage_queue.get_file_hash")
    @patch("os.walk")
    def test_get_unique_files_empty_directory(self, mock_walk, mock_hash):
        """Test that get_unique_files handles empty directories correctly."""
        # Mock empty directory
        mock_walk.return_value = [("/empty/dir", [], [])]

        result = get_unique_files("/empty/dir")

        # Should return empty list
        assert result == []
        assert mock_hash.call_count == 0

    @patch(
        "data_ingestion.audio_video.manage_queue.LIBRARY_CONFIG",
        {"TestLibrary": {"name": "test_lib"}},
    )
    @patch("os.path.isfile")
    @patch("os.path.isdir")
    def test_process_audio_input_single_file(self, mock_isdir, mock_isfile):
        """Test that process_audio_input correctly handles single audio files."""
        # Setup mocks
        mock_isfile.return_value = True
        mock_isdir.return_value = False

        # Create mock queue
        mock_queue = MagicMock()
        mock_queue.add_item.return_value = "test_item_id"

        # Test with valid audio file
        result = process_audio_input(
            "/path/to/audio.mp3", mock_queue, "Test Author", "TestLibrary"
        )

        # Should return list with item ID
        assert result == ["test_item_id"]

        # Verify queue.add_item was called with correct parameters
        mock_queue.add_item.assert_called_once_with(
            "audio_file",
            {
                "file_path": "/path/to/audio.mp3",
                "author": "Test Author",
                "library": {"name": "test_lib"},
                "s3_folder": "testlibrary",
                "s3_key": "public/audio/testlibrary/audio.mp3",
                "required_access_level": 0,
            },
        )

    @patch("data_ingestion.audio_video.manage_queue.LIBRARY_CONFIG", {})
    def test_process_audio_input_invalid_library(self):
        """Test that process_audio_input raises error for invalid library."""
        mock_queue = MagicMock()

        # Test with invalid library
        with pytest.raises(ValueError, match="Library 'InvalidLibrary' not found"):
            process_audio_input(
                "/path/to/audio.mp3", mock_queue, "Test Author", "InvalidLibrary"
            )

    @patch(
        "data_ingestion.audio_video.manage_queue.LIBRARY_CONFIG",
        {"TestLibrary": {"name": "test_lib"}},
    )
    @patch("os.path.isfile")
    @patch("os.path.isdir")
    def test_process_audio_input_unsupported_file(self, mock_isdir, mock_isfile):
        """Test that process_audio_input rejects unsupported file types."""
        # Setup mocks
        mock_isfile.return_value = True
        mock_isdir.return_value = False

        mock_queue = MagicMock()

        # Test with unsupported file type
        result = process_audio_input(
            "/path/to/document.txt", mock_queue, "Test Author", "TestLibrary"
        )

        # Should return empty list
        assert result == []

        # Queue should not be called
        mock_queue.add_item.assert_not_called()

    @patch("data_ingestion.audio_video.manage_queue.load_env")
    @patch("data_ingestion.audio_video.manage_queue.configure_logging")
    def test_initialize_environment(self, mock_configure_logging, mock_load_env):
        """Test that initialize_environment correctly sets up environment and logging."""
        # Create mock args
        mock_args = MagicMock()
        mock_args.site = "test_site"
        mock_args.debug = True

        # Call function
        initialize_environment(mock_args)

        # Verify environment and logging setup
        mock_load_env.assert_called_once_with("test_site")
        mock_configure_logging.assert_called_once_with(True)

    @patch("data_ingestion.audio_video.manage_queue.load_env")
    @patch("data_ingestion.audio_video.manage_queue.configure_logging")
    def test_initialize_environment_no_debug(
        self, mock_configure_logging, mock_load_env
    ):
        """Test that initialize_environment handles debug=False correctly."""
        # Create mock args with debug=False
        mock_args = MagicMock()
        mock_args.site = "prod_site"
        mock_args.debug = False

        # Call function
        initialize_environment(mock_args)

        # Verify environment and logging setup
        mock_load_env.assert_called_once_with("prod_site")
        mock_configure_logging.assert_called_once_with(False)

    @patch("data_ingestion.audio_video.manage_queue.extract_youtube_id")
    def test_add_to_queue_youtube_video(self, mock_extract_youtube_id):
        """Test that add_to_queue correctly handles YouTube video addition."""
        # Setup mock
        mock_extract_youtube_id.return_value = "test_video_id"

        # Create mock args and queue
        mock_args = MagicMock()
        mock_args.video = "https://youtube.com/watch?v=test_video_id"
        mock_args.playlist = None
        mock_args.audio = None
        mock_args.directory = None
        mock_args.default_author = "Test Author"
        mock_args.library = "TestLibrary"
        mock_args.required_access_level = 200

        mock_queue = MagicMock()
        mock_queue.add_item.return_value = "queue_item_id"

        # Call function
        add_to_queue(mock_args, mock_queue)

        # Verify YouTube ID extraction and queue addition
        mock_extract_youtube_id.assert_called_once_with(
            "https://youtube.com/watch?v=test_video_id"
        )
        mock_queue.add_item.assert_called_once_with(
            "youtube_video",
            {
                "url": "https://youtube.com/watch?v=test_video_id",
                "youtube_id": "test_video_id",
                "author": "Test Author",
                "library": "TestLibrary",
                "source": None,
                "required_access_level": 200,
            },
        )

    @patch("data_ingestion.audio_video.manage_queue.get_playlist_videos")
    def test_add_to_queue_youtube_playlist(self, mock_get_playlist_videos):
        """Test that add_to_queue correctly handles YouTube playlist processing."""
        # Setup mock playlist videos
        mock_playlist_videos = [
            {"url": "https://youtube.com/watch?v=video1", "youtube_id": "video1"},
            {"url": "https://youtube.com/watch?v=video2", "youtube_id": "video2"},
        ]
        mock_get_playlist_videos.return_value = mock_playlist_videos

        # Create mock args and queue
        mock_args = MagicMock()
        mock_args.video = None
        mock_args.playlist = "https://youtube.com/playlist?list=test_playlist"
        mock_args.audio = None
        mock_args.directory = None
        mock_args.default_author = "Test Author"
        mock_args.library = "TestLibrary"
        mock_args.required_access_level = 200

        mock_queue = MagicMock()
        mock_queue.add_item.return_value = "queue_item_id"

        # Call function
        add_to_queue(mock_args, mock_queue)

        # Verify playlist processing
        mock_get_playlist_videos.assert_called_once_with(
            "https://youtube.com/playlist?list=test_playlist"
        )

        # Verify each video was added to queue
        assert mock_queue.add_item.call_count == 2

        # Check first video call
        first_call = mock_queue.add_item.call_args_list[0]
        assert first_call[0][0] == "youtube_video"
        assert first_call[0][1]["url"] == "https://youtube.com/watch?v=video1"
        assert first_call[0][1]["youtube_id"] == "video1"
        assert first_call[0][1]["required_access_level"] == 200
        assert (
            first_call[0][1]["source"]
            == "https://youtube.com/playlist?list=test_playlist"
        )

    @patch("data_ingestion.audio_video.manage_queue.process_audio_input")
    def test_add_to_queue_audio_file(self, mock_process_audio_input):
        """Test that add_to_queue correctly delegates audio file processing."""
        # Setup mock
        mock_process_audio_input.return_value = ["audio_item_id"]

        # Create mock args and queue
        mock_args = MagicMock()
        mock_args.video = None
        mock_args.playlist = None
        mock_args.audio = "/path/to/audio.mp3"
        mock_args.directory = None
        mock_args.default_author = "Test Author"
        mock_args.library = "TestLibrary"
        mock_args.site = "test_site"
        mock_args.required_access_level = 200

        mock_queue = MagicMock()

        # Call function
        add_to_queue(mock_args, mock_queue)

        # Verify audio processing delegation
        mock_process_audio_input.assert_called_once_with(
            "/path/to/audio.mp3",
            mock_queue,
            "Test Author",
            "TestLibrary",
            "test_site",
            200,
        )

    def test_add_to_queue_no_valid_input(self):
        """Test that add_to_queue handles case with no valid input provided."""
        # Create mock args with no inputs
        mock_args = MagicMock()
        mock_args.video = None
        mock_args.playlist = None
        mock_args.audio = None
        mock_args.directory = None

        mock_queue = MagicMock()

        # Call function - should not raise exception but log error
        add_to_queue(mock_args, mock_queue)

        # Queue should not be called
        mock_queue.add_item.assert_not_called()
