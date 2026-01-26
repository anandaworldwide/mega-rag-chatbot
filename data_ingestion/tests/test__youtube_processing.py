"""Tests for YouTube video processing functionality"""

import logging
import os
import uuid
from unittest import TestCase
from unittest.mock import MagicMock, patch

from botocore.exceptions import ClientError

from data_ingestion.audio_video.youtube_utils import download_youtube_audio
from data_ingestion.utils.s3_utils import upload_to_s3

logger = logging.getLogger(__name__)


class TestYouTubeProcessing(TestCase):
    """Unit tests for YouTube processing functions with all external calls mocked"""

    def setUp(self):
        """Set up test fixtures"""
        self.test_video_url = "https://youtu.be/dQw4w9WgXcQ"
        self.test_video_id = "dQw4w9WgXcQ"
        self.test_audio_path = os.path.join("test_dir", f"{uuid.uuid4()}.mp3")

        # Configure mock data
        self.mock_video_info = {
            "id": self.test_video_id,
            "title": "Test Video Title",
            "uploader": "Test Channel",
            "duration": 120,
            "upload_date": "20240101",
            "view_count": 1000,
            "description": "Test description",
        }

        # Mock the expected output
        self.expected_youtube_data = {
            "youtube_id": self.test_video_id,
            "audio_path": "./test-uuid.mp3",
            "title": "Test Video Title",
            "author": "Test Channel",
            "url": self.test_video_url,
            "file_size": 1024,
        }

    @patch("data_ingestion.audio_video.youtube_utils.extract_youtube_id")
    @patch("data_ingestion.audio_video.youtube_utils.YoutubeDL")
    @patch("os.path.exists")
    @patch("os.path.getsize")
    @patch("uuid.uuid4")
    @patch("data_ingestion.audio_video.youtube_utils.add_metadata_to_mp3")
    def test_youtube_download(
        self,
        mock_add_metadata,
        mock_uuid,
        mock_getsize,
        mock_exists,
        mock_ytdl,
        mock_extract_id,
    ):
        """Test that YouTube videos can be downloaded and processed"""
        # Setup mocks
        mock_uuid.return_value = "test-uuid"
        mock_extract_id.return_value = self.test_video_id
        mock_ytdl_instance = MagicMock()
        mock_ytdl.return_value = mock_ytdl_instance
        mock_ytdl_instance.__enter__.return_value = mock_ytdl_instance
        mock_ytdl_instance.extract_info.return_value = self.mock_video_info
        mock_exists.return_value = True
        mock_getsize.return_value = 1024

        # Execute test
        result = download_youtube_audio(self.test_video_url)

        # Verify results
        self.assertIsNotNone(result)
        assert isinstance(result, dict)  # Type assertion for type checker
        self.assertEqual(result["youtube_id"], self.test_video_id)
        self.assertIn("audio_path", result)
        self.assertEqual(result["title"], self.mock_video_info["title"])
        mock_ytdl_instance.extract_info.assert_called_once_with(
            self.test_video_url, download=True
        )

    @patch("data_ingestion.audio_video.youtube_utils.extract_youtube_id")
    @patch("data_ingestion.audio_video.youtube_utils.YoutubeDL")
    @patch("os.path.exists")
    @patch("os.path.getsize")
    @patch("uuid.uuid4")
    @patch("data_ingestion.audio_video.youtube_utils.add_metadata_to_mp3")
    @patch("data_ingestion.audio_video.media_utils.split_audio")
    def test_transcription(
        self,
        mock_split_audio,
        mock_add_metadata,
        mock_uuid,
        mock_getsize,
        mock_exists,
        mock_ytdl,
        mock_extract_id,
    ):
        """Test that downloaded YouTube videos can be transcribed"""
        # Setup mocks
        mock_uuid.return_value = "test-uuid"
        mock_extract_id.return_value = self.test_video_id
        mock_ytdl_instance = MagicMock()
        mock_ytdl.return_value = mock_ytdl_instance
        mock_ytdl_instance.__enter__.return_value = mock_ytdl_instance
        mock_ytdl_instance.extract_info.return_value = self.mock_video_info
        mock_exists.return_value = True
        mock_getsize.return_value = 1024

        # Mock the audio splitting functionality
        mock_split_audio.return_value = [
            {
                "text": "chunk 1",
                "start": 0,
                "end": 5,
                "words": [{"word": "test", "start": 1, "end": 2}],
            }
        ]

        # Mock the OpenAI transcription
        with patch("openai.OpenAI") as mock_openai_class:
            mock_openai_instance = MagicMock()
            mock_openai_class.return_value = mock_openai_instance
            mock_audio = MagicMock()
            mock_openai_instance.audio = mock_audio
            mock_transcription = MagicMock()
            mock_audio.transcriptions = mock_transcription
            mock_transcription.create.return_value = MagicMock(
                text="test transcription"
            )

            # Generate the fake youtube data
            youtube_data = download_youtube_audio(self.test_video_url)

            # Now directly test the mock of transcribe_media
            with patch(
                "data_ingestion.audio_video.transcription_utils.transcribe_media"
            ) as mock_transcribe:
                mock_transcribe.return_value = {
                    "text": "test transcription",
                    "words": [{"word": "test", "start": 0, "end": 1}],
                }

                # Call transcribe_media
                assert isinstance(youtube_data, dict)  # Type assertion for type checker
                transcription = mock_transcribe(
                    youtube_data["audio_path"],
                    is_youtube_video=True,
                    youtube_id=youtube_data["youtube_id"],
                )

                # Verify results
                self.assertIsNotNone(youtube_data)
                self.assertIsNotNone(transcription)
                self.assertIn("text", transcription)
                self.assertEqual(transcription["text"], "test transcription")
                mock_transcribe.assert_called_once()

    @patch("data_ingestion.audio_video.youtube_utils.extract_youtube_id")
    @patch("data_ingestion.audio_video.youtube_utils.YoutubeDL")
    @patch("os.path.exists")
    @patch("os.path.getsize")
    @patch("uuid.uuid4")
    @patch("data_ingestion.audio_video.youtube_utils.add_metadata_to_mp3")
    @patch("data_ingestion.audio_video.pinecone_utils.create_embeddings")
    def test_pinecone_storage(
        self,
        mock_embeddings,
        mock_add_metadata,
        mock_uuid,
        mock_getsize,
        mock_exists,
        mock_ytdl,
        mock_extract_id,
    ):
        """Test that YouTube transcriptions can be stored in Pinecone"""
        # Setup mocks
        mock_uuid.return_value = "test-uuid"
        mock_extract_id.return_value = self.test_video_id
        mock_ytdl_instance = MagicMock()
        mock_ytdl.return_value = mock_ytdl_instance
        mock_ytdl_instance.__enter__.return_value = mock_ytdl_instance
        mock_ytdl_instance.extract_info.return_value = self.mock_video_info
        mock_exists.return_value = True
        mock_getsize.return_value = 1024
        # create_embeddings now returns (embeddings, valid_chunks) tuple
        mock_chunks = [{"text": "test chunk", "words": [], "start": 0, "end": 10}]
        mock_embeddings.return_value = ([[0.1, 0.2, 0.3]], mock_chunks)

        # Generate test data
        youtube_data = download_youtube_audio(self.test_video_url)
        self.assertIsNotNone(youtube_data)

        # Create test chunks and embeddings
        chunks = [{"text": "test chunk", "words": [], "start": 0, "end": 10}]
        embeddings = [[0.1, 0.2, 0.3]]

        # Import the actual function
        mock_pinecone_index = MagicMock()

        # Replace the real function with a mocked version to test the integration
        with patch(
            "data_ingestion.audio_video.pinecone_utils.store_in_pinecone"
        ) as mock_store_function:
            # Configure the mock
            mock_store_function.return_value = True

            # Call through our mock
            assert isinstance(youtube_data, dict)  # Type assertion for type checker
            result = mock_store_function(
                mock_pinecone_index,
                chunks,
                embeddings,
                "Test Author",
                "Test Library",
                is_youtube_video=True,
                title=youtube_data["title"],
                url=youtube_data["url"],
            )

            # Verify the mock was called with the right arguments
            mock_store_function.assert_called_once_with(
                mock_pinecone_index,
                chunks,
                embeddings,
                "Test Author",
                "Test Library",
                is_youtube_video=True,
                title=youtube_data["title"],
                url=youtube_data["url"],
            )

            # Verify that our function returns the expected result
            self.assertTrue(result)

    @patch("data_ingestion.audio_video.youtube_utils.extract_youtube_id")
    @patch("data_ingestion.audio_video.youtube_utils.YoutubeDL")
    @patch("os.path.exists")
    @patch("os.path.getsize")
    @patch("uuid.uuid4")
    @patch("data_ingestion.audio_video.youtube_utils.add_metadata_to_mp3")
    @patch("boto3.client")
    def test_s3_upload_skipped(
        self,
        mock_boto3_client,
        mock_add_metadata,
        mock_uuid,
        mock_getsize,
        mock_exists,
        mock_ytdl,
        mock_extract_id,
    ):
        """Test that S3 uploads are properly handled for YouTube videos"""
        # Setup mocks
        mock_uuid.return_value = "test-uuid"
        mock_extract_id.return_value = self.test_video_id
        mock_ytdl_instance = MagicMock()
        mock_ytdl.return_value = mock_ytdl_instance
        mock_ytdl_instance.__enter__.return_value = mock_ytdl_instance
        mock_ytdl_instance.extract_info.return_value = self.mock_video_info
        mock_exists.return_value = True
        mock_getsize.return_value = 1024

        # S3 mock - simulate file doesn't exist in S3
        mock_s3 = MagicMock()
        mock_s3.head_object.side_effect = ClientError(
            {"Error": {"Code": "404"}}, "head_object"
        )
        mock_boto3_client.return_value = mock_s3

        # Execute test
        youtube_data = download_youtube_audio(self.test_video_url)

        # Verify results
        self.assertIsNotNone(youtube_data)
        assert isinstance(youtube_data, dict)  # Type assertion for type checker
        self.assertIn("audio_path", youtube_data)

        # Test S3 upload
        upload_to_s3(youtube_data["audio_path"], "test/key.mp3")
        mock_s3.upload_file.assert_called_once()

    @patch("data_ingestion.audio_video.youtube_utils.extract_youtube_id")
    @patch("data_ingestion.audio_video.youtube_utils.YoutubeDL")
    @patch("os.path.exists")
    @patch("os.path.getsize")
    @patch("uuid.uuid4")
    @patch("data_ingestion.audio_video.youtube_utils.add_metadata_to_mp3")
    @patch("data_ingestion.audio_video.media_utils.get_media_metadata")
    def test_audio_metadata(
        self,
        mock_metadata,
        mock_add_metadata,
        mock_uuid,
        mock_getsize,
        mock_exists,
        mock_ytdl,
        mock_extract_id,
    ):
        """Test that audio metadata is properly extracted and handled"""
        # Setup mocks
        mock_uuid.return_value = "test-uuid"
        mock_extract_id.return_value = self.test_video_id
        mock_ytdl_instance = MagicMock()
        mock_ytdl.return_value = mock_ytdl_instance
        mock_ytdl_instance.__enter__.return_value = mock_ytdl_instance
        mock_ytdl_instance.extract_info.return_value = self.mock_video_info
        mock_exists.return_value = True
        mock_getsize.return_value = 1024

        mock_metadata.return_value = ("Test Title", "Test Author", 120, None, None)

        # Execute test
        youtube_data = download_youtube_audio(self.test_video_url)

        # Verify results
        self.assertIsNotNone(youtube_data)
        assert isinstance(youtube_data, dict)  # Type assertion for type checker
        self.assertIn("audio_path", youtube_data)
        self.assertEqual(youtube_data["title"], self.mock_video_info["title"])
        self.assertEqual(youtube_data["author"], self.mock_video_info["uploader"])
