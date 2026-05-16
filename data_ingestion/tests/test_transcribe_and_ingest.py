"""
Tests for transcribe_and_ingest_media.py script functionality.

Tests cover:
1. Metadata verification and updates
2. Process file error handling
3. Report merging
4. Edge cases and error conditions
5. File processing pipeline
"""

from unittest.mock import (
    Mock,
    mock_open,
    patch,
)

import pytest

from data_ingestion.audio_video.transcribe_and_ingest_media import (
    _parse_positive_int,
    _resolve_worker_count,
    merge_reports,
    preprocess_youtube_video,
    process_file,
    verify_and_update_transcription_metadata,
)


@pytest.fixture
def sample_transcription_data():
    return {
        "text": "Sample transcription text",
        "words": [{"word": "Sample", "start": 0.0, "end": 0.5}],
    }


@pytest.fixture
def sample_youtube_data():
    return {
        "youtube_id": "test123",
        "media_metadata": {
            "title": "Test Video",
            "url": "https://youtube.com/watch?v=test123",
            "duration": 120,
            "upload_date": "20240101",
            "channel": "Test Channel",
            "view_count": 1000,
            "description": "Test description",
        },
    }


def test_resolve_worker_count_preserves_default():
    with patch(
        "data_ingestion.audio_video.transcribe_and_ingest_media.cpu_count"
    ) as mock_cpu_count:
        mock_cpu_count.return_value = 12

        assert _resolve_worker_count(None) == 4


def test_resolve_worker_count_uses_explicit_value():
    assert _resolve_worker_count(8) == 8


def test_parse_positive_int_rejects_zero():
    with pytest.raises(Exception, match="positive integer"):
        _parse_positive_int("0")


def test_verify_metadata_basic_audio():
    """Test metadata verification for basic audio file"""
    transcription = "Just a text string"
    file_path = "test.mp3"
    author = "Test Author"
    library = "Test Library"

    result = verify_and_update_transcription_metadata(
        transcription, file_path, author, library, False, site="test"
    )

    assert isinstance(result, dict)
    assert result["text"] == transcription
    assert result["file_path"] == file_path
    assert result["author"] == author
    assert result["library"] == library
    assert result["type"] == "audio_file"
    assert result["media_type"] == "audio"
    assert "created_at" in result
    assert "updated_at" in result


@patch("data_ingestion.audio_video.transcribe_and_ingest_media.save_transcription")
def test_verify_metadata_youtube(
    mock_save_transcription, sample_transcription_data, sample_youtube_data
):
    """Test metadata verification for YouTube content"""
    # Mock the save_transcription function to avoid database operations
    mock_save_transcription.return_value = None

    result = verify_and_update_transcription_metadata(
        sample_transcription_data,
        None,
        "Test Author",
        "Test Library",
        True,
        sample_youtube_data,
        site="test",
    )

    assert result["title"] == sample_youtube_data["media_metadata"]["title"]
    assert result["source_url"] == sample_youtube_data["media_metadata"]["url"]
    assert result["youtube_id"] == sample_youtube_data["youtube_id"]
    assert result["type"] == "youtube"
    assert result["media_type"] == "video"


def test_process_file_private_video():
    """Test handling of private YouTube videos"""
    youtube_data = {
        "url": "https://youtube.com/watch?v=private123",
        "error": "private_video",
    }

    result = process_file(
        None,
        None,
        None,
        False,
        False,
        "Test Author",
        "Test Library",
        site_config={"domain": "test.com"},  # Add missing site_config
        is_youtube_video=True,
        youtube_data=youtube_data,
    )

    assert result["private_videos"] == 1
    assert result["errors"] == 0
    assert len(result["error_details"]) == 1
    assert "Private video" in result["error_details"][0]


def test_merge_reports():
    """Test report merging functionality with corrected counting logic"""
    reports = [
        {
            "processed": 1,
            "skipped": 0,
            "errors": 1,
            "error_details": ["Error 1"],
            "warnings": ["Warning 1"],
            "fully_indexed": 1,
            "chunk_lengths": [100],
            "private_videos": 1,
        },
        {
            "processed": 2,
            "skipped": 1,
            "errors": 0,
            "error_details": [],
            "warnings": ["Warning 2"],
            "fully_indexed": 2,
            "chunk_lengths": [200, 300],
            "private_videos": 0,
        },
    ]

    merged = merge_reports(reports)

    # After the fix: files that are fully_indexed should be counted as processed
    assert merged["processed"] == 3  # Total fully_indexed files
    assert merged["skipped"] == 0  # No files should be skipped if they were processed
    assert merged["errors"] == 1
    assert len(merged["error_details"]) == 1
    assert len(merged["warnings"]) == 2
    assert merged["fully_indexed"] == 3
    assert len(merged["chunk_lengths"]) == 3
    assert merged["private_videos"] == 1


@patch("data_ingestion.audio_video.transcribe_and_ingest_media.save_transcription")
def test_verify_metadata_legacy_format(mock_save_transcription):
    """Test handling of legacy format transcription data"""
    # Mock the save_transcription function to avoid database operations
    mock_save_transcription.return_value = None

    legacy_text = "This is legacy text only format"
    result = verify_and_update_transcription_metadata(
        legacy_text, "test.mp3", "Test Author", "Test Library", False, site="test"
    )

    assert isinstance(result, dict)
    assert result["text"] == legacy_text
    assert isinstance(result["words"], list)
    assert len(result["words"]) == 0
    assert result["type"] == "audio_file"


@patch("data_ingestion.audio_video.transcribe_and_ingest_media.save_transcription")
@patch("os.path.exists")
@patch("data_ingestion.audio_video.media_utils.get_media_metadata")
@patch("os.stat")
@patch("data_ingestion.audio_video.media_utils.MP3")
@patch("os.makedirs")
@patch("builtins.open", new_callable=mock_open, read_data=b"mock binary data")
def test_verify_metadata_with_file_stats(
    mock_file,
    mock_makedirs,
    mock_mp3,
    mock_stat,
    mock_get_metadata,
    mock_exists,
    mock_save_transcription,
):
    """Test metadata verification with file statistics"""
    # Mock the save_transcription function to avoid database operations
    mock_save_transcription.return_value = None

    mock_exists.return_value = True
    mock_get_metadata.return_value = (
        "Test Title",
        "File Author",
        120,
        None,
        "Test Album",
    )
    mock_stat.return_value = Mock(st_size=1024)

    # Create proper mock tag objects with list-like behavior
    class MockTag:
        def __init__(self, text):
            self.text = text

        def __getitem__(self, idx):
            return self.text[idx]

    mock_tags = Mock()
    mock_tags.get.side_effect = lambda key, default=None: {
        "TIT2": MockTag(["Test Title"]),
        "TPE1": MockTag(["File Author"]),
        "TALB": MockTag(["Test Album"]),
        "COMM:url:eng": MockTag(["http://example.com"]),
    }.get(key, default)

    # Set up MP3 mock with proper __getitem__ behavior
    mock_mp3_instance = Mock()
    mock_mp3_instance.tags = mock_tags
    mock_mp3_instance.info = Mock(length=120)
    mock_mp3.return_value = mock_mp3_instance

    transcription_data = {
        "text": "test",
        "words": [{"word": "test", "start": 0, "end": 1}],
    }

    result = verify_and_update_transcription_metadata(
        transcription_data, "test.mp3", None, "Test Library", False, site="test"
    )

    assert isinstance(result, dict)
    assert result["title"] == "Test Title"
    assert result["author"] == "File Author"
    assert result["duration"] == 120
    assert result["album"] == "Test Album"
    assert result["file_name"] == "test.mp3"
    assert result["file_size"] == 1024


def test_preprocess_youtube_private():
    """Test preprocessing of private YouTube videos"""
    with patch(
        "data_ingestion.audio_video.youtube_utils.download_youtube_audio"
    ) as mock_download:
        mock_download.return_value = None
        result, youtube_id = preprocess_youtube_video(
            "https://youtube.com/watch?v=private123", Mock(), "test"
        )
        assert result is None
        assert youtube_id is None


def test_merge_reports_empty():
    """Test merging empty reports"""
    reports = [{}, {"processed": 0, "errors": 0}, {"warnings": [], "chunk_lengths": []}]

    merged = merge_reports(reports)

    assert merged["processed"] == 0
    assert merged["errors"] == 0
    assert merged["warnings"] == []
    assert merged["chunk_lengths"] == []


def test_counting_logic_for_cached_transcriptions():
    """
    Test that files using cached transcriptions but getting fully indexed
    are correctly counted as 'processed', not 'skipped' after the fix.

    This test verifies that the counting logic properly handles files that
    use cached transcriptions but still go through the complete processing pipeline.
    """
    from data_ingestion.audio_video.transcribe_and_ingest_media import merge_reports

    # Simulate the scenario where a file uses a cached transcription
    # and goes through complete processing

    # Step 1: Transcription report (file uses cached transcription)
    transcription_report = {
        "processed": 0,
        "skipped": 1,  # Marked as skipped because it used cached transcription
        "errors": 0,
        "error_details": [],
        "warnings": [],
        "fully_indexed": 0,
        "chunk_lengths": [],
        "private_videos": 0,
    }

    # Step 2: Processing report (file gets fully processed and indexed)
    processing_report = {
        "processed": 0,
        "skipped": 0,
        "errors": 0,
        "error_details": [],
        "warnings": [],
        "fully_indexed": 1,  # File was successfully indexed
        "chunk_lengths": [150, 200],  # Word counts for chunks
        "private_videos": 0,
    }

    # Step 3: Upload report (successful upload)
    upload_report = {
        "processed": 0,
        "skipped": 0,
        "errors": 0,
        "error_details": [],
        "warnings": [],
        "fully_indexed": 0,
        "chunk_lengths": [],
        "private_videos": 0,
    }

    # Test the merge logic (this is what process_file does)
    final_report = merge_reports(
        [transcription_report, processing_report, upload_report]
    )

    # AFTER THE FIX: Files that are fully indexed should be counted as processed
    assert final_report["processed"] == 1, (
        "File should be marked as processed since it was fully indexed"
    )
    assert final_report["skipped"] == 0, (
        "File shouldn't be marked as skipped if it was processed"
    )
    assert final_report["fully_indexed"] == 1, "File was successfully indexed"
    assert final_report["errors"] == 0, "No errors should be reported"
    assert len(final_report["chunk_lengths"]) == 2, "Chunk data should be preserved"
