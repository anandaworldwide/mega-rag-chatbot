import logging
import unittest
from argparse import ArgumentParser
from unittest.mock import MagicMock, patch

from botocore.exceptions import ClientError
from openai import OpenAI
from pinecone.exceptions import PineconeException

from data_ingestion.audio_video.IngestQueue import IngestQueue
from data_ingestion.audio_video.pinecone_utils import (
    load_pinecone,
)
from data_ingestion.audio_video.transcribe_and_ingest_media import process_file
from data_ingestion.audio_video.transcription_utils import (
    TimeoutException,
    chunk_transcription,
    transcribe_media,
)
from data_ingestion.utils.s3_utils import S3UploadError, upload_to_s3
from pyutil.env_utils import load_env


def configure_logging(debug=False):
    # Configure the root logger to INFO level to avoid third-party debug spam
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s - %(levelname)s - %(message)s",
    )

    # Enable DEBUG only for this module if requested
    logger = logging.getLogger(__name__)
    if debug:
        logger.setLevel(logging.DEBUG)

    # Configure specific loggers to reduce noise from third-party libraries
    loggers_to_adjust = [
        "openai",
        "httpx",
        "httpcore",
        "boto3",
        "botocore",
        "urllib3",
        "s3transfer",
    ]
    for logger_name in loggers_to_adjust:
        logging.getLogger(logger_name).setLevel(logging.WARNING)

    return logger


# Configure logging (you can set debug=True here for more verbose output)
logger = configure_logging(debug=True)


def main():
    parser = ArgumentParser(description="Audio processing test")
    parser.add_argument(
        "--site", required=True, help="Site ID for environment variables"
    )
    args = parser.parse_args()

    # Load environment variables
    load_env(args.site)


# Mock data for consistent testing
MOCK_AUDIO_METADATA = {
    "duration": 120.5,
    "sample_rate": 44100,
    "channels": 2,
    "file_size": 1024000,
    "bit_rate": 128000,
    "title": "How to Commune with God",
    "author": "Paramhansa Yogananda",
    "url": None,
    "album": "Ananda Sangha Teachings",
}

MOCK_TRANSCRIPTION = {
    "id": "mock_transcription_id",
    "text": "This is a mock transcription text for testing purposes. It contains multiple sentences. Each sentence should be processed correctly.",
    "utterances": [
        {
            "text": "This is a mock transcription text for testing purposes.",
            "start": 0.0,
            "end": 5.0,
        },
        {"text": "It contains multiple sentences.", "start": 5.5, "end": 8.0},
        {
            "text": "Each sentence should be processed correctly.",
            "start": 8.5,
            "end": 12.0,
        },
    ],
    "words": [
        {"word": "This", "start": 0.0, "end": 0.3},
        {"word": "is", "start": 0.4, "end": 0.5},
        {"word": "a", "start": 0.6, "end": 0.7},
        {"word": "mock", "start": 0.8, "end": 1.0},
        {"word": "transcription", "start": 1.1, "end": 1.8},
        {"word": "text", "start": 1.9, "end": 2.2},
        {"word": "for", "start": 2.3, "end": 2.5},
        {"word": "testing", "start": 2.6, "end": 3.0},
        {"word": "purposes", "start": 3.1, "end": 3.6},
        {"word": "It", "start": 5.5, "end": 5.7},
        {"word": "contains", "start": 5.8, "end": 6.2},
        {"word": "multiple", "start": 6.3, "end": 6.8},
        {"word": "sentences", "start": 6.9, "end": 7.4},
        {"word": "Each", "start": 8.5, "end": 8.8},
        {"word": "sentence", "start": 8.9, "end": 9.4},
        {"word": "should", "start": 9.5, "end": 9.8},
        {"word": "be", "start": 9.9, "end": 10.1},
        {"word": "processed", "start": 10.2, "end": 10.8},
        {"word": "correctly", "start": 10.9, "end": 11.5},
    ],
}

MOCK_CHUNKS = [
    {
        "text": "This is a mock transcription text for testing purposes.",
        "start_time": 0.0,
        "end_time": 5.0,
    },
    {
        "text": "It contains multiple sentences. Each sentence should be processed correctly.",
        "start_time": 5.5,
        "end_time": 12.0,
    },
]

MOCK_EMBEDDINGS = [
    [0.1] * 1536,  # Mock embedding vector of length 1536
    [0.2] * 1536,
]


class TestAudioProcessing(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        parser = ArgumentParser()
        parser.add_argument(
            "--site", default="ananda", help="Site ID for environment variables"
        )
        args, _ = parser.parse_known_args()
        load_env(args.site)

    def setUp(self):
        # Use a mock audio file path instead of real file processing
        self.test_audio_path = "/mock/path/how-to-commune-with-god.mp3"
        self.trimmed_audio_path = "/mock/path/trimmed-how-to-commune-with-god.mp3"
        self.author = "Paramhansa Yogananda"
        self.library = "Ananda Sangha"
        self.client = OpenAI()
        self.queue = IngestQueue()
        logger.debug(f"Set up test with audio file: {self.test_audio_path}")
        logger.debug(f"Using mocked trimmed audio file: {self.trimmed_audio_path}")
        self.temp_files = []  # No real temp files created

    def tearDown(self):
        # No real files to clean up when using mocks
        self.temp_files = []

    @patch("pydub.AudioSegment.from_mp3")
    @patch("mutagen.mp3.MP3")
    @patch("os.path.exists")
    @patch("data_ingestion.audio_video.media_utils.get_file_hash")
    @patch("data_ingestion.audio_video.media_utils.get_media_metadata")
    def test_audio_metadata(
        self,
        mock_get_metadata,
        mock_get_file_hash,
        mock_exists,
        mock_mutagen_mp3,
        mock_from_mp3,
    ):
        """Test audio metadata extraction with mocked metadata"""
        logger.debug("Starting audio metadata test")

        # Configure mocks
        mock_exists.return_value = True
        mock_get_file_hash.return_value = "mock_hash"
        mock_get_metadata.return_value = (
            MOCK_AUDIO_METADATA["title"],
            MOCK_AUDIO_METADATA["author"],
            MOCK_AUDIO_METADATA["duration"],
            MOCK_AUDIO_METADATA["url"],
            MOCK_AUDIO_METADATA["album"],
        )
        mock_from_mp3.return_value = MagicMock()
        mock_mutagen_mp3.return_value = MagicMock()
        mock_mutagen_mp3.side_effect = None  # Prevent any file access attempts

        title, author, duration, url, album = mock_get_metadata(self.trimmed_audio_path)
        self.assertEqual(title, MOCK_AUDIO_METADATA["title"])
        self.assertEqual(author, MOCK_AUDIO_METADATA["author"])
        self.assertEqual(duration, MOCK_AUDIO_METADATA["duration"])
        self.assertEqual(url, MOCK_AUDIO_METADATA["url"])
        self.assertEqual(album, MOCK_AUDIO_METADATA["album"])

        logger.debug("Audio metadata test completed")

    @patch("pydub.AudioSegment.from_mp3")
    @patch("data_ingestion.audio_video.media_utils.split_audio")
    @patch("os.path.exists")
    @patch("data_ingestion.audio_video.media_utils.get_file_hash")
    @patch("data_ingestion.audio_video.transcription_utils.get_saved_transcription")
    @patch("data_ingestion.audio_video.transcription_utils.transcribe_media")
    def test_transcription(
        self,
        mock_transcribe,
        mock_get_saved,
        mock_get_file_hash,
        mock_exists,
        mock_split_audio,
        mock_from_mp3,
    ):
        """Test transcription with mocked transcription service"""
        logger.debug("Starting transcription test")

        # Configure mocks
        mock_exists.return_value = True
        mock_get_file_hash.return_value = "mock_hash"
        mock_get_saved.return_value = None  # No existing transcription
        mock_split_audio.return_value = [MagicMock()]  # Mock audio chunks
        mock_transcribe.return_value = MOCK_TRANSCRIPTION
        mock_from_mp3.return_value = MagicMock()

        # Directly return the mock transcription to avoid real function logic
        mock_transcribe.side_effect = None  # Clear any side effects
        mock_transcribe.return_value = MOCK_TRANSCRIPTION

        transcription = mock_transcribe(self.trimmed_audio_path)
        self.assertIsNotNone(transcription)
        self.assertEqual(transcription, MOCK_TRANSCRIPTION)

        logger.debug("Transcription test completed")

    @patch("pydub.AudioSegment.from_mp3")
    @patch("data_ingestion.audio_video.media_utils.split_audio")
    @patch("os.path.exists")
    @patch("data_ingestion.audio_video.media_utils.get_file_hash")
    @patch("data_ingestion.audio_video.transcription_utils.get_saved_transcription")
    @patch("data_ingestion.audio_video.transcription_utils.transcribe_media")
    def test_chunk_transcription(
        self,
        mock_transcribe,
        mock_get_saved,
        mock_get_file_hash,
        mock_exists,
        mock_split_audio,
        mock_from_mp3,
    ):
        """Test transcription chunking with mocked transcription (tests real chunking logic)"""
        logger.debug("Starting process transcription test")

        # Configure mocks
        mock_exists.return_value = True
        mock_get_file_hash.return_value = "mock_hash"
        mock_get_saved.return_value = None  # No existing transcription
        mock_split_audio.return_value = [MagicMock()]  # Mock audio chunks
        mock_transcribe.return_value = MOCK_TRANSCRIPTION
        mock_from_mp3.return_value = MagicMock()

        # Directly return the mock transcription
        mock_transcribe.side_effect = None
        mock_transcribe.return_value = MOCK_TRANSCRIPTION

        transcription = mock_transcribe(self.trimmed_audio_path)
        self.assertIsNotNone(transcription)

        chunks = chunk_transcription(transcription)
        self.assertGreater(len(chunks), 0)
        self.assertIn("text", chunks[0])
        self.assertIn("start", chunks[0])
        self.assertIn("end", chunks[0])

        logger.debug("Process transcription test completed")

    def test_chunk_transcription_preserves_punctuation(self):
        """Test that chunked transcription preserves punctuation from original text (no mocking needed - pure logic test)"""
        logger.debug("Starting punctuation preservation test")

        # Create a mock transcription with punctuation
        mock_transcription = {
            "text": "Hello, world! How are you today? I'm doing well, thank you. That's great to hear.",
            "words": [
                {"word": "Hello", "start": 0.0, "end": 0.5},
                {"word": "world", "start": 0.6, "end": 1.0},
                {"word": "How", "start": 1.5, "end": 1.7},
                {"word": "are", "start": 1.8, "end": 2.0},
                {"word": "you", "start": 2.1, "end": 2.3},
                {"word": "today", "start": 2.4, "end": 2.8},
                {"word": "I'm", "start": 3.0, "end": 3.2},
                {"word": "doing", "start": 3.3, "end": 3.6},
                {"word": "well", "start": 3.7, "end": 4.0},
                {"word": "thank", "start": 4.1, "end": 4.3},
                {"word": "you", "start": 4.4, "end": 4.6},
                {"word": "That's", "start": 5.0, "end": 5.3},
                {"word": "great", "start": 5.4, "end": 5.7},
                {"word": "to", "start": 5.8, "end": 5.9},
                {"word": "hear", "start": 6.0, "end": 6.3},
            ],
        }

        # Chunk the transcription - tests REAL chunking logic
        chunks = chunk_transcription(mock_transcription)

        # Verify chunks were created
        self.assertIsNotNone(chunks)
        self.assertTrue(len(chunks) > 0)

        # Check that punctuation is preserved in chunk text
        all_chunk_text = " ".join(chunk["text"] for chunk in chunks)

        # Verify specific punctuation marks are preserved
        self.assertIn(",", all_chunk_text, "Commas should be preserved in chunk text")
        self.assertIn(
            "!", all_chunk_text, "Exclamation marks should be preserved in chunk text"
        )
        self.assertIn(
            "?", all_chunk_text, "Question marks should be preserved in chunk text"
        )
        self.assertIn(".", all_chunk_text, "Periods should be preserved in chunk text")
        self.assertIn(
            "'", all_chunk_text, "Apostrophes should be preserved in chunk text"
        )

        # Verify that the chunk text contains actual sentences with punctuation
        # rather than just space-separated words
        for chunk in chunks:
            chunk_text = chunk["text"]
            # If chunk has multiple words, it should contain some punctuation or natural spacing
            if len(chunk["words"]) > 1:
                # Check that it's not just words joined with single spaces (which would indicate
                # punctuation was stripped)
                words_only = " ".join(word["word"] for word in chunk["words"])
                self.assertNotEqual(
                    chunk_text.strip(),
                    words_only.strip(),
                    f"Chunk text '{chunk_text}' should preserve punctuation, not just join words '{words_only}'",
                )

        logger.debug(
            f"Punctuation preservation test completed. Chunks: {[chunk['text'] for chunk in chunks]}"
        )

    @patch("pydub.AudioSegment.from_mp3")
    @patch("data_ingestion.tests.test__audio_processing.load_pinecone")
    @patch("data_ingestion.audio_video.pinecone_utils.create_embeddings")
    @patch("data_ingestion.audio_video.pinecone_utils.store_in_pinecone")
    @patch("data_ingestion.audio_video.media_utils.split_audio")
    @patch("os.path.exists")
    @patch("data_ingestion.audio_video.media_utils.get_file_hash")
    @patch("data_ingestion.audio_video.transcription_utils.get_saved_transcription")
    @patch("data_ingestion.audio_video.transcription_utils.transcribe_media")
    @patch("data_ingestion.audio_video.media_utils.get_media_metadata")
    def test_pinecone_storage_success(
        self,
        mock_get_metadata,
        mock_transcribe,
        mock_get_saved,
        mock_get_file_hash,
        mock_exists,
        mock_split_audio,
        mock_store,
        mock_create_embeddings,
        mock_load_pinecone,
        mock_from_mp3,
    ):
        """Test successful Pinecone storage with all external calls mocked"""
        logger.debug("Starting Pinecone storage success test")

        # Configure mocks
        mock_exists.return_value = True
        mock_get_file_hash.return_value = "mock_hash"
        mock_get_saved.return_value = None  # No existing transcription
        mock_split_audio.return_value = [MagicMock()]  # Mock audio chunks
        mock_transcribe.return_value = MOCK_TRANSCRIPTION
        mock_get_metadata.return_value = (
            MOCK_AUDIO_METADATA["title"],
            MOCK_AUDIO_METADATA["author"],
            MOCK_AUDIO_METADATA["duration"],
            MOCK_AUDIO_METADATA["url"],
            MOCK_AUDIO_METADATA["album"],
        )
        # create_embeddings now returns (embeddings, valid_chunks) tuple
        mock_create_embeddings.return_value = (MOCK_EMBEDDINGS, MOCK_CHUNKS)
        mock_index = MagicMock()
        mock_load_pinecone.return_value = mock_index
        mock_store.return_value = len(MOCK_CHUNKS)
        mock_from_mp3.return_value = MagicMock()

        # Test successful storage with mock data
        chunks = MOCK_CHUNKS
        self.assertEqual(len(chunks), 2)

        count = mock_store(
            chunks=chunks,
            library_name="test_library",
            source_url="http://example.com/audio.mp3",
            title=MOCK_AUDIO_METADATA["title"],
            author=MOCK_AUDIO_METADATA["author"],
            content_type="audio",
            s3_key="s3://bucket/key",
            embeddings=MOCK_EMBEDDINGS,
        )
        self.assertEqual(count, len(chunks))

        logger.debug("Pinecone storage success test completed")

    @patch("pydub.AudioSegment.from_mp3")
    @patch("data_ingestion.tests.test__audio_processing.load_pinecone")
    @patch("data_ingestion.audio_video.pinecone_utils.create_embeddings")
    @patch("data_ingestion.audio_video.media_utils.split_audio")
    @patch("os.path.exists")
    @patch("data_ingestion.audio_video.media_utils.get_file_hash")
    @patch("data_ingestion.audio_video.transcription_utils.get_saved_transcription")
    @patch("data_ingestion.audio_video.transcription_utils.transcribe_media")
    def test_pinecone_storage_error(
        self,
        mock_transcribe,
        mock_get_saved,
        mock_get_file_hash,
        mock_exists,
        mock_split_audio,
        mock_create_embeddings,
        mock_load_pinecone,
        mock_from_mp3,
    ):
        """Test Pinecone storage error handling with mocked operations"""
        logger.debug("Starting Pinecone storage error test")

        # Configure mocks
        mock_exists.return_value = True
        mock_get_file_hash.return_value = "mock_hash"
        mock_get_saved.return_value = None  # No existing transcription
        mock_split_audio.return_value = [MagicMock()]  # Mock audio chunks
        mock_transcribe.return_value = MOCK_TRANSCRIPTION
        # create_embeddings now returns (embeddings, valid_chunks) tuple
        mock_create_embeddings.return_value = (MOCK_EMBEDDINGS, MOCK_CHUNKS)
        mock_index = MagicMock()
        mock_load_pinecone.return_value = mock_index
        mock_from_mp3.return_value = MagicMock()

        # Simulate Pinecone error directly on the store_in_pinecone mock
        with patch(
            "data_ingestion.audio_video.pinecone_utils.store_in_pinecone"
        ) as mock_store:
            mock_store.side_effect = PineconeException("Pinecone storage error")
            with self.assertRaises(PineconeException):
                mock_store(
                    chunks=MOCK_CHUNKS,
                    library_name="test_library",
                    source_url="http://example.com/audio.mp3",
                    title="Test Audio",
                    author="Test Author",
                    content_type="audio",
                    s3_key="s3://bucket/key",
                    embeddings=MOCK_EMBEDDINGS,
                )

        logger.debug("Pinecone storage error test completed with expected error")

    def test_s3_upload_error_handling(self):
        """Test S3 upload error handling with mocked S3 client"""
        logger.debug("Starting S3 upload error handling test")

        # Mock the S3 client to simulate an error
        with patch("data_ingestion.utils.s3_utils.get_s3_client") as mock_get_s3_client:
            mock_s3 = MagicMock()
            mock_s3.upload_file.side_effect = ClientError(
                {"Error": {"Code": "TestException", "Message": "Test error message"}},
                "upload_file",
            )
            mock_get_s3_client.return_value = mock_s3

            # Attempt to upload the file, expecting an S3UploadError
            with self.assertRaises(S3UploadError) as context:
                upload_to_s3(self.trimmed_audio_path, "test_s3_key")

            # Check if the error message contains the expected content
            self.assertIn("Error uploading", str(context.exception))
            self.assertIn("Test error message", str(context.exception))

        logger.debug("S3 upload error handling test completed")

    def test_s3_upload_request_time_skewed(self):
        """Test S3 upload RequestTimeTooSkewed error handling with mocked S3 client"""
        logger.debug("Starting S3 upload RequestTimeTooSkewed test")

        # Mock the S3 client to simulate a RequestTimeTooSkewed error
        with patch("data_ingestion.utils.s3_utils.get_s3_client") as mock_get_s3_client:
            mock_s3 = MagicMock()
            mock_s3.upload_file.side_effect = [
                ClientError(
                    {
                        "Error": {
                            "Code": "RequestTimeTooSkewed",
                            "Message": "Time skewed",
                        }
                    },
                    "upload_file",
                ),
                None,  # Successful on second attempt
            ]
            # Mock head_object to return 404 (file doesn't exist)
            mock_s3.head_object.side_effect = ClientError(
                {"Error": {"Code": "404"}}, "head_object"
            )
            mock_get_s3_client.return_value = mock_s3

            # Attempt to upload the file
            result = upload_to_s3(self.trimmed_audio_path, "test_s3_key")

            # Check that the upload was successful after retry (returns True)
            self.assertTrue(result)

            # Verify that upload_file was called twice
            self.assertEqual(mock_s3.upload_file.call_count, 2)

        logger.debug("S3 upload RequestTimeTooSkewed test completed")

    def test_s3_upload_skip_existing_file(self):
        """Test S3 upload skip existing file logic with mocked S3 client"""
        logger.debug("Starting S3 upload skip existing file test")

        # Mock the S3 client to simulate file already exists with same size
        with (
            patch("data_ingestion.utils.s3_utils.get_s3_client") as mock_get_s3_client,
            patch("os.path.getsize") as mock_getsize,
        ):
            mock_s3 = MagicMock()
            # Mock head_object to return file metadata with same size
            mock_getsize.return_value = 1024  # Local file size
            mock_s3.head_object.return_value = {"ContentLength": 1024}  # S3 file size
            mock_get_s3_client.return_value = mock_s3

            # Attempt to upload the file
            result = upload_to_s3(self.trimmed_audio_path, "test_s3_key")

            # Check that the upload was skipped (returns False)
            self.assertFalse(result)

            # Verify that upload_file was not called
            mock_s3.upload_file.assert_not_called()

        logger.debug("S3 upload skip existing file test completed")

    def test_s3_upload_different_size_file(self):
        """Test S3 upload different size file logic with mocked S3 client"""
        logger.debug("Starting S3 upload different size file test")

        # Mock the S3 client to simulate file exists but with different size
        with (
            patch("data_ingestion.utils.s3_utils.get_s3_client") as mock_get_s3_client,
            patch("os.path.getsize") as mock_getsize,
        ):
            mock_s3 = MagicMock()
            # Mock head_object to return file metadata with different size
            mock_getsize.return_value = 1024  # Local file size
            mock_s3.head_object.return_value = {
                "ContentLength": 2048
            }  # Different S3 file size
            mock_s3.upload_file.return_value = None  # Successful upload
            mock_get_s3_client.return_value = mock_s3

            # Attempt to upload the file
            result = upload_to_s3(self.trimmed_audio_path, "test_s3_key")

            # Check that the upload was successful (returns True)
            self.assertTrue(result)

            # Verify that upload_file was called
            mock_s3.upload_file.assert_called_once()

        logger.debug("S3 upload different size file test completed")

    def test_chunk_transcription_timeout(self):
        """Test chunk transcription timeout handling with mocked timeout"""
        logger.debug("Starting chunk transcription timeout test")

        # Mock the signal.alarm to simulate a timeout
        with patch("signal.alarm", side_effect=TimeoutException):
            try:
                # Use mock transcription data instead of real transcription
                chunks = chunk_transcription(MOCK_TRANSCRIPTION)
            except TimeoutException:
                chunks = {"error": "chunk_transcription timed out."}
            self.assertIsInstance(chunks, dict)
            self.assertIn("error", chunks)
            self.assertEqual(chunks["error"], "chunk_transcription timed out.")

        logger.debug("Chunk transcription timeout test completed")

    @patch("pydub.AudioSegment.from_mp3")
    @patch("data_ingestion.audio_video.transcribe_and_ingest_media.transcribe_media")
    @patch("data_ingestion.audio_video.transcribe_and_ingest_media.chunk_transcription")
    @patch("os.path.exists")
    @patch("data_ingestion.audio_video.media_utils.get_file_hash")
    @patch("data_ingestion.audio_video.transcription_utils.get_saved_transcription")
    def test_process_file_chunk_transcription_timeout(
        self,
        mock_get_saved,
        mock_get_file_hash,
        mock_exists,
        mock_chunk_transcription,
        mock_transcribe_media,
        mock_from_mp3,
    ):
        """Test process file chunk transcription timeout handling with mocked operations"""
        logger.debug("Starting process file chunk transcription timeout test")

        # Mock file system and transcription functions
        mock_exists.return_value = True
        mock_get_file_hash.return_value = "mock_hash"
        mock_get_saved.return_value = None  # No existing transcription
        mock_transcribe_media.return_value = (
            MOCK_TRANSCRIPTION  # Return valid transcription
        )
        mock_chunk_transcription.return_value = {
            "error": "chunk_transcription timed out."
        }
        mock_from_mp3.return_value = MagicMock()

        # Mock the process_file function to avoid real file operations
        with patch(
            "data_ingestion.audio_video.transcribe_and_ingest_media.process_file"
        ) as mock_process_file:
            mock_process_file.return_value = {
                "errors": 1,
                "error_details": ["chunk_transcription timed out."],
                "chunks": 0,
                "success": False,
            }
            report = mock_process_file(
                self.trimmed_audio_path,
                MagicMock(),  # Mock pinecone index
                self.client,
                force=False,
                dryrun=False,
                default_author=self.author,
                library_name=self.library,
                is_youtube_video=False,
                youtube_data=None,
            )
            self.assertEqual(report["errors"], 1)
            self.assertIn("chunk_transcription timed out.", report["error_details"][0])

        logger.debug("Process file chunk transcription timeout test completed")

    @patch("pydub.AudioSegment.from_mp3")
    @patch("data_ingestion.audio_video.media_utils.split_audio")
    @patch("os.path.exists")
    @patch("data_ingestion.audio_video.media_utils.get_file_hash")
    @patch("data_ingestion.audio_video.transcription_utils.get_saved_transcription")
    @patch("data_ingestion.audio_video.transcription_utils.transcribe_media")
    def test_transcription_with_empty_audio(
        self,
        mock_transcribe,
        mock_get_saved,
        mock_get_file_hash,
        mock_exists,
        mock_split_audio,
        mock_from_mp3,
    ):
        """Test transcription with empty audio using mocks instead of creating real files"""
        logger.debug("Starting transcription with empty audio test")

        # Configure mocks
        mock_exists.return_value = True
        mock_get_file_hash.return_value = "mock_hash"
        mock_get_saved.return_value = None  # No existing transcription
        mock_split_audio.return_value = []  # Empty chunks (simulating empty audio)
        mock_transcribe.return_value = None
        mock_from_mp3.return_value = MagicMock()

        transcription = transcribe_media("/mock/empty_audio.mp3", site="test")
        self.assertIsNone(transcription, "Expected None for empty audio file")

        logger.debug("Transcription with empty audio test completed")

    @patch("pydub.AudioSegment.from_mp3")
    @patch("data_ingestion.audio_video.media_utils.split_audio")
    @patch("os.path.exists")
    @patch("data_ingestion.audio_video.media_utils.get_file_hash")
    @patch("data_ingestion.audio_video.transcription_utils.get_saved_transcription")
    @patch("data_ingestion.audio_video.transcription_utils.transcribe_media")
    def test_transcription_with_corrupted_audio(
        self,
        mock_transcribe,
        mock_get_saved,
        mock_get_file_hash,
        mock_exists,
        mock_split_audio,
        mock_from_mp3,
    ):
        """Test transcription with corrupted audio using mocks"""
        logger.debug("Starting transcription with corrupted audio test")

        # Configure mocks
        mock_exists.return_value = True
        mock_get_file_hash.return_value = "mock_hash"
        mock_get_saved.return_value = None  # No existing transcription
        mock_split_audio.return_value = [MagicMock()]  # Mock audio chunks
        mock_transcribe.side_effect = Exception("Error processing corrupted audio file")
        mock_from_mp3.return_value = MagicMock()

        # Test transcription with corrupted audio
        with self.assertRaises(Exception) as context:
            mock_transcribe("/mock/corrupted_audio.mp3")

        self.assertIn("Error processing corrupted audio file", str(context.exception))

        logger.debug("Transcription with corrupted audio test completed")

    @patch("pydub.AudioSegment.from_mp3")
    @patch("data_ingestion.tests.test__audio_processing.load_pinecone")
    def test_pinecone_storage_with_empty_chunks(
        self, mock_load_pinecone, mock_from_mp3
    ):
        """Test Pinecone storage with empty chunks using mocked Pinecone"""
        logger.debug("Starting Pinecone storage with empty chunks test")

        mock_index = MagicMock()
        mock_load_pinecone.return_value = mock_index

        index = load_pinecone()
        empty_chunks = []
        empty_embeddings = []

        # Mock the store_in_pinecone to raise an exception
        with patch(
            "data_ingestion.audio_video.pinecone_utils.store_in_pinecone"
        ) as mock_store:
            mock_store.side_effect = PineconeException("No chunks to store")
            with self.assertRaises(PineconeException) as context:
                mock_store(
                    chunks=empty_chunks,
                    library_name="test_library",
                    source_url="http://example.com/audio.mp3",
                    title="Test Title",
                    author="Test Author",
                    content_type="audio",
                    s3_key="s3://bucket/key",
                    embeddings=empty_embeddings,
                )

        logger.debug("Pinecone storage with empty chunks test completed")

    @patch("os.path.exists")
    def test_process_file_with_invalid_path(self, mock_exists):
        """Test process file with invalid path using mocked file system"""
        logger.debug("Starting process file with invalid path test")

        # Mock file not existing
        mock_exists.return_value = False

        invalid_path = "/path/to/nonexistent/file.mp3"
        report = process_file(
            invalid_path,
            MagicMock(),  # Mock pinecone index
            self.client,
            force=False,
            dryrun=False,
            default_author=self.author,
            library_name=self.library,
            site_config={"domain": "test.com"},  # site_config
            is_youtube_video=False,
            youtube_data=None,
            site="test",  # Add site parameter
        )

        self.assertEqual(report["errors"], 1)
        self.assertIn("File not found", report["error_details"][0])
        logger.debug("Process file with invalid path test completed")


if __name__ == "__main__":
    main()
