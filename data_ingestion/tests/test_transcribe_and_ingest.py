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


def test_resolve_local_audio_path_uses_existing_file(tmp_path):
    from data_ingestion.audio_video.transcribe_and_ingest_media import (
        resolve_local_audio_path,
    )

    local = tmp_path / "talk.mp3"
    local.write_bytes(b"audio")

    path, downloaded = resolve_local_audio_path(
        str(local), "public/audio/bhaktan/talk.mp3"
    )

    assert path == str(local)
    assert downloaded is False


def test_resolve_local_audio_path_downloads_when_file_missing():
    from data_ingestion.audio_video.transcribe_and_ingest_media import (
        resolve_local_audio_path,
    )

    with patch(
        "data_ingestion.audio_video.transcribe_and_ingest_media.download_s3_object_to_temp",
        return_value="/tmp/ingest-audio-talk.mp3",
    ) as mock_download:
        path, downloaded = resolve_local_audio_path(
            "/missing/talk.mp3", "public/audio/bhaktan/talk.mp3"
        )

    assert path == "/tmp/ingest-audio-talk.mp3"
    assert downloaded is True
    mock_download.assert_called_once_with("public/audio/bhaktan/talk.mp3")


def test_resolve_local_audio_path_without_s3_key_returns_none():
    from data_ingestion.audio_video.transcribe_and_ingest_media import (
        resolve_local_audio_path,
    )

    path, downloaded = resolve_local_audio_path("/missing/talk.mp3", None)

    assert path is None
    assert downloaded is False


def test_handle_s3_upload_skips_when_downloaded_from_s3():
    from data_ingestion.audio_video.transcribe_and_ingest_media import _handle_s3_upload

    with patch(
        "data_ingestion.audio_video.transcribe_and_ingest_media.upload_to_s3"
    ) as mock_upload:
        report = _handle_s3_upload(
            "/tmp/talk.mp3",
            "talk.mp3",
            "public/audio/bhaktan/talk.mp3",
            dryrun=False,
            is_youtube_video=False,
            skip_upload=True,
        )

    mock_upload.assert_not_called()
    assert report["errors"] == 0
    assert report["skipped"] == 1


def test_handle_s3_upload_skips_when_object_already_same_size():
    from data_ingestion.audio_video.transcribe_and_ingest_media import _handle_s3_upload

    with patch(
        "data_ingestion.audio_video.transcribe_and_ingest_media.upload_to_s3",
        return_value=False,
    ) as mock_upload:
        report = _handle_s3_upload(
            "/tmp/talk.mp3",
            "talk.mp3",
            "public/audio/bhaktan/talk.mp3",
            dryrun=False,
            is_youtube_video=False,
        )

    mock_upload.assert_called_once()
    assert report["errors"] == 0
    assert report["skipped"] == 1


def test_process_item_downloads_missing_audio_and_skips_reupload():
    from data_ingestion.audio_video.transcribe_and_ingest_media import process_item

    item = {
        "id": "item-1",
        "type": "audio_file",
        "data": {
            "file_path": "/missing/talk.mp3",
            "s3_key": "public/audio/bhaktan/talk.mp3",
            "author": "Swami Kriyananda",
            "library": "The Bhaktan Files",
            "required_access_level": 0,
        },
    }
    args = Mock(force=False, dryrun=False, site="ananda")

    with (
        patch(
            "data_ingestion.audio_video.transcribe_and_ingest_media.resolve_local_audio_path",
            return_value=("/tmp/ingest-audio-talk.mp3", True),
        ) as mock_resolve,
        patch(
            "data_ingestion.audio_video.transcribe_and_ingest_media.process_file",
            return_value={"processed": 1, "errors": 0},
        ) as mock_process_file,
        patch("os.path.getsize", return_value=1024),
        patch("os.path.exists", return_value=True),
        patch("os.remove") as mock_remove,
        patch("data_ingestion.audio_video.transcribe_and_ingest_media.save_estimate"),
    ):
        item_id, report = process_item(item, args, Mock(), Mock(), {})

    assert item_id == "item-1"
    assert report["processed"] == 1
    mock_resolve.assert_called_once_with(
        "/missing/talk.mp3", "public/audio/bhaktan/talk.mp3"
    )
    assert mock_process_file.call_args.kwargs["s3_key"] == (
        "public/audio/bhaktan/talk.mp3"
    )
    assert mock_process_file.call_args.kwargs["skip_upload"] is True
    mock_remove.assert_called_once_with("/tmp/ingest-audio-talk.mp3")


def test_process_item_keeps_local_audio_and_does_not_skip_upload(tmp_path):
    from data_ingestion.audio_video.transcribe_and_ingest_media import process_item

    local = tmp_path / "talk.mp3"
    local.write_bytes(b"audio")
    item = {
        "id": "item-2",
        "type": "audio_file",
        "data": {
            "file_path": str(local),
            "s3_key": "public/audio/bhaktan/talk.mp3",
            "author": "Swami Kriyananda",
            "library": "The Bhaktan Files",
            "required_access_level": 0,
        },
    }
    args = Mock(force=False, dryrun=False, site="ananda")

    with (
        patch(
            "data_ingestion.audio_video.transcribe_and_ingest_media.process_file",
            return_value={"processed": 1, "errors": 0},
        ) as mock_process_file,
        patch("data_ingestion.audio_video.transcribe_and_ingest_media.save_estimate"),
    ):
        process_item(item, args, Mock(), Mock(), {})

    assert mock_process_file.call_args.kwargs["skip_upload"] is False
    assert mock_process_file.call_args.args[0] == str(local)
    assert local.exists()


def test_process_item_reports_s3_download_error():
    from data_ingestion.audio_video.transcribe_and_ingest_media import process_item
    from data_ingestion.utils.s3_utils import S3DownloadError

    item = {
        "id": "item-3",
        "type": "audio_file",
        "data": {
            "file_path": "/missing/talk.mp3",
            "s3_key": "public/audio/bhaktan/talk.mp3",
            "author": "Swami Kriyananda",
            "library": "The Bhaktan Files",
        },
    }
    args = Mock(force=False, dryrun=False, site="ananda")

    with patch(
        "data_ingestion.audio_video.transcribe_and_ingest_media.resolve_local_audio_path",
        side_effect=S3DownloadError("NoSuchKey"),
    ):
        item_id, report = process_item(item, args, Mock(), Mock(), {})

    assert item_id == "item-3"
    assert report["errors"] == 1
    assert report["error_details"] == ["NoSuchKey"]
