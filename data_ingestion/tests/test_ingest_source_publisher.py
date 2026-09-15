"""Tests for publishing ingest originals and state to S3."""

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from botocore.exceptions import ClientError

from data_ingestion.utils.ingest_source_publisher import IngestSourcePublisher


def _not_found_error() -> ClientError:
    return ClientError(
        {"Error": {"Code": "404", "Message": "Not Found"}},
        "HeadObject",
    )


def test_sync_audio_dry_run_reports_new_mp3_without_uploading(tmp_path):
    local_dir = tmp_path / "bhaktan-talks"
    mp3_path = local_dir / "Talks" / "a.mp3"
    mp3_path.parent.mkdir(parents=True)
    mp3_path.write_bytes(b"abc")

    s3_client = MagicMock()
    s3_client.head_object.side_effect = _not_found_error()

    publisher = IngestSourcePublisher(
        site="ananda",
        bucket="ananda-chatbot",
        s3_client=s3_client,
        repo_root=tmp_path,
    )
    report = publisher.sync_audio(local_dir, "bhaktan", dry_run=True)

    assert [action.s3_key for action in report.uploads] == [
        "public/audio/bhaktan/Talks/a.mp3"
    ]
    s3_client.upload_file.assert_not_called()


def test_sync_audio_skips_object_with_same_size(tmp_path):
    local_dir = tmp_path / "treasures"
    mp3_path = local_dir / "talk.mp3"
    local_dir.mkdir()
    mp3_path.write_bytes(b"same")

    s3_client = MagicMock()
    s3_client.head_object.return_value = {"ContentLength": 4}

    publisher = IngestSourcePublisher(
        site="ananda",
        bucket="ananda-chatbot",
        s3_client=s3_client,
        repo_root=tmp_path,
    )
    report = publisher.sync_audio(local_dir, "treasures", dry_run=False)

    assert [action.status for action in report.actions] == ["skip_same_size"]
    s3_client.upload_file.assert_not_called()


def test_sync_audio_rewrites_kriyaban_folder_and_uploads_readme(tmp_path):
    local_dir = tmp_path / "bhaktan"
    restricted = local_dir / "Kriyaban only" / "talk.mp3"
    restricted.parent.mkdir(parents=True)
    restricted.write_bytes(b"abc")
    readme = local_dir / "README.rtf"
    readme.write_bytes(b"notes")
    junk = local_dir / ".DS_Store"
    junk.write_bytes(b"junk")

    s3_client = MagicMock()
    s3_client.head_object.side_effect = _not_found_error()
    publisher = IngestSourcePublisher(
        site="ananda",
        bucket="ananda-chatbot",
        s3_client=s3_client,
        repo_root=tmp_path,
    )
    report = publisher.sync_audio(local_dir, "bhaktan", dry_run=True)

    keys = [action.s3_key for action in report.uploads]
    assert "public/audio/bhaktan/kriyaban-only/talk.mp3" in keys
    assert "public/audio/bhaktan/README.rtf" in keys
    assert not any(".DS_Store" in key for key in keys)
    assert any("kriyaban-only=" in note for note in report.notes)


@patch("data_ingestion.utils.ingest_source_publisher.tqdm")
def test_sync_audio_progress_wraps_audio_files(mock_tqdm, tmp_path):
    mock_tqdm.side_effect = lambda items, **kwargs: items
    local_dir = tmp_path / "bhaktan"
    mp3_path = local_dir / "talk.mp3"
    local_dir.mkdir()
    mp3_path.write_bytes(b"abc")

    s3_client = MagicMock()
    s3_client.head_object.side_effect = _not_found_error()
    publisher = IngestSourcePublisher(
        site="ananda",
        bucket="ananda-chatbot",
        s3_client=s3_client,
        repo_root=tmp_path,
    )
    publisher.sync_audio(local_dir, "bhaktan", dry_run=True)

    mock_tqdm.assert_called_once()
    wrapped = mock_tqdm.call_args.args[0]
    assert wrapped == [mp3_path]
    assert mock_tqdm.call_args.kwargs["desc"] == "Audio bhaktan"


def test_sync_audio_uploads_when_not_dry_run(tmp_path):
    local_dir = tmp_path / "bhaktan"
    mp3_path = local_dir / "new.mp3"
    local_dir.mkdir()
    mp3_path.write_bytes(b"data")

    s3_client = MagicMock()
    s3_client.head_object.side_effect = _not_found_error()

    publisher = IngestSourcePublisher(
        site="ananda",
        bucket="ananda-chatbot",
        s3_client=s3_client,
        repo_root=tmp_path,
    )
    report = publisher.sync_audio(local_dir, "bhaktan", dry_run=False)

    assert len(report.uploads) == 1
    s3_client.upload_file.assert_called_once_with(
        str(mp3_path), "ananda-chatbot", "public/audio/bhaktan/new.mp3"
    )


def test_sync_audio_rejects_unknown_library(tmp_path):
    publisher = IngestSourcePublisher(
        site="ananda",
        bucket="ananda-chatbot",
        s3_client=MagicMock(),
        repo_root=tmp_path,
    )
    with pytest.raises(ValueError, match="not in library_config"):
        publisher.sync_audio(tmp_path, "unknown-lib", dry_run=True)


def test_upload_dump_and_youtube_list(tmp_path):
    dump_path = tmp_path / "anandalib_2025_03_06.sql.gz"
    dump_path.write_bytes(b"sql")
    list_path = tmp_path / "youtube-links.xlsx"
    list_path.write_bytes(b"xlsx")

    s3_client = MagicMock()
    s3_client.head_object.side_effect = _not_found_error()

    publisher = IngestSourcePublisher(
        site="ananda",
        bucket="ananda-chatbot",
        s3_client=s3_client,
        repo_root=tmp_path,
    )
    dump_report = publisher.upload_dump(dump_path, dry_run=False)
    list_report = publisher.upload_youtube_list(list_path, dry_run=False)

    assert dump_report.uploads[0].s3_key == (
        "ingestion/dumps/anandalib/anandalib_2025_03_06.sql.gz"
    )
    assert list_report.uploads[0].s3_key == (
        "site-config/data_ingestion/youtube/lists/youtube-links.xlsx"
    )
    assert s3_client.upload_file.call_count == 2


@patch("data_ingestion.utils.ingest_source_publisher.get_default_log_path")
@patch("data_ingestion.utils.ingest_source_publisher.get_transcriptions_dir")
@patch("data_ingestion.utils.ingest_source_publisher.get_transcriptions_db_path")
@patch("data_ingestion.utils.ingest_source_publisher.get_youtube_data_map_path")
def test_sync_state_reports_missing_local_files(
    mock_youtube_map,
    mock_transcriptions_db,
    mock_transcriptions_dir,
    mock_log_path,
    tmp_path,
):
    mock_youtube_map.return_value = str(tmp_path / "ananda-youtube_data_map.json")
    mock_transcriptions_db.return_value = str(tmp_path / "ananda-transcriptions.db")
    mock_transcriptions_dir.return_value = str(tmp_path / "transcriptions" / "ananda")
    mock_log_path.return_value = tmp_path / "ingestion_runs.jsonl"

    publisher = IngestSourcePublisher(
        site="ananda",
        bucket="ananda-chatbot",
        s3_client=MagicMock(),
        repo_root=tmp_path,
    )
    report = publisher.sync_state(dry_run=True)

    assert {action.status for action in report.actions} == {"missing_local"}
    assert len(report.missing_local) == 4


@patch("data_ingestion.utils.ingest_source_publisher.get_default_log_path")
@patch("data_ingestion.utils.ingest_source_publisher.get_transcriptions_dir")
@patch("data_ingestion.utils.ingest_source_publisher.get_transcriptions_db_path")
@patch("data_ingestion.utils.ingest_source_publisher.get_youtube_data_map_path")
@patch("data_ingestion.utils.ingest_source_publisher.tqdm")
def test_sync_state_progress_wraps_cache_files(
    mock_tqdm,
    mock_youtube_map,
    mock_transcriptions_db,
    mock_transcriptions_dir,
    mock_log_path,
    tmp_path,
):
    mock_tqdm.side_effect = lambda items, **kwargs: items
    cache_dir = tmp_path / "transcriptions" / "ananda"
    cache_dir.mkdir(parents=True)
    (cache_dir / "a.json.gz").write_bytes(b"x")
    (cache_dir / "b.json.gz").write_bytes(b"y")
    mock_youtube_map.return_value = str(tmp_path / "missing-map.json")
    mock_transcriptions_db.return_value = str(tmp_path / "missing.db")
    mock_transcriptions_dir.return_value = str(cache_dir)
    mock_log_path.return_value = tmp_path / "missing.jsonl"

    publisher = IngestSourcePublisher(
        site="ananda",
        bucket="ananda-chatbot",
        s3_client=MagicMock(),
        repo_root=tmp_path,
    )
    publisher.sync_state(dry_run=True)

    mock_tqdm.assert_called_once()
    wrapped = mock_tqdm.call_args.args[0]
    assert {path.name for path in wrapped} == {"a.json.gz", "b.json.gz"}
    assert mock_tqdm.call_args.kwargs["desc"] == "Transcription cache"


def test_format_sync_report_includes_counts_and_dry_run_banner():
    from data_ingestion.utils.ingest_source_publisher import (
        SyncAction,
        SyncReport,
        format_sync_report,
    )

    report = SyncReport(
        actions=[
            SyncAction(Path("a.mp3"), "public/audio/bhaktan/a.mp3", "upload"),
            SyncAction(Path("b.mp3"), "public/audio/bhaktan/b.mp3", "skip_same_size"),
        ]
    )
    text = format_sync_report(report, dry_run=True)
    assert "DRY-RUN" in text
    assert "upload=1" in text
    assert "skip_same_size=1" in text


@patch("data_ingestion.utils.ingest_source_publisher.get_default_log_path")
@patch("data_ingestion.utils.ingest_source_publisher.get_transcriptions_dir")
@patch("data_ingestion.utils.ingest_source_publisher.get_transcriptions_db_path")
@patch("data_ingestion.utils.ingest_source_publisher.get_youtube_data_map_path")
def test_inventory_includes_local_youtube_list_files(
    mock_youtube_map,
    mock_transcriptions_db,
    mock_transcriptions_dir,
    mock_log_path,
    tmp_path,
):
    mock_youtube_map.return_value = str(tmp_path / "missing-map.json")
    mock_transcriptions_db.return_value = str(tmp_path / "missing.db")
    mock_transcriptions_dir.return_value = str(tmp_path / "missing-cache")
    mock_log_path.return_value = tmp_path / "missing.jsonl"

    list_dir = tmp_path / "data_ingestion" / "audio_video" / "data"
    list_dir.mkdir(parents=True)
    list_path = list_dir / "luca-youtube-links.xlsx"
    list_path.write_bytes(b"xlsx")

    s3_client = MagicMock()
    s3_client.head_object.side_effect = _not_found_error()
    publisher = IngestSourcePublisher(
        site="ananda",
        bucket="ananda-chatbot",
        s3_client=s3_client,
        repo_root=tmp_path,
    )
    report = publisher.inventory()
    list_keys = [action.s3_key for action in report.uploads]
    assert (
        "site-config/data_ingestion/youtube/lists/luca-youtube-links.xlsx" in list_keys
    )


def test_parse_library_path_mapping():
    from data_ingestion.utils.ingest_source_publisher import parse_library_path_mapping

    library, path = parse_library_path_mapping("bhaktan=/data/bhaktan-talks")
    assert library == "bhaktan"
    assert path == Path("/data/bhaktan-talks")
    with pytest.raises(ValueError, match="LIBRARY=PATH"):
        parse_library_path_mapping("bhaktan")
