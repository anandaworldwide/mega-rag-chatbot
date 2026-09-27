"""Whisper input for .m4a originals."""

from pathlib import Path
from unittest.mock import MagicMock

from data_ingestion.audio_video.media_utils import (
    get_media_metadata,
    materialize_whisper_audio,
)
from data_ingestion.audio_video.transcribe_and_ingest_media import (
    process_file,
    process_item,
)


def test_materialize_whisper_audio_converts_m4a_without_replacing_it(tmp_path):
    source = tmp_path / "talk.m4a"
    source.write_bytes(b"m4a-bytes")
    commands = []

    def runner(command, check):
        commands.append(command)
        assert check is True
        Path(command[-1]).write_bytes(b"mp3")

    whisper_path, temps = materialize_whisper_audio(str(source), runner=runner)

    assert Path(whisper_path).name.startswith("talk.whisper.")
    assert Path(whisper_path).suffix == ".mp3"
    assert Path(whisper_path).parent != source.parent
    assert source.read_bytes() == b"m4a-bytes"
    assert temps == [whisper_path]
    assert commands[0][:8] == [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostats",
        "-y",
        "-i",
        str(source),
    ]
    assert commands[0][-1] == whisper_path


def test_materialize_whisper_audio_leaves_mp3_unchanged(tmp_path):
    source = tmp_path / "talk.mp3"
    source.write_bytes(b"mp3")

    def runner(command, check):
        raise AssertionError(command)

    whisper_path, temps = materialize_whisper_audio(str(source), runner=runner)

    assert whisper_path == str(source)
    assert temps == []


def test_get_media_metadata_reads_m4a_tags(tmp_path, monkeypatch):
    source = tmp_path / "Higher Kriya.m4a"
    source.write_bytes(b"m4a")

    class _Info:
        length = 12.5

    class _Audio:
        tags = {
            "\xa9nam": ["Higher Kriya"],
            "\xa9ART": ["Swami Kriyananda"],
            "\xa9alb": ["Kriyaban Retreat"],
        }
        info = _Info()

    monkeypatch.setattr(
        "data_ingestion.audio_video.media_utils.MP4",
        lambda _path: _Audio(),
    )

    title, author, duration, url, album = get_media_metadata(str(source), "ananda")

    assert title == "Higher Kriya"
    assert "Kriyananda" in author
    assert duration == 12.5
    assert url is None
    assert album == "Kriyaban Retreat"


def test_process_file_uploads_m4a_and_reads_its_tags(tmp_path, monkeypatch):
    m4a = tmp_path / "talk.m4a"
    m4a.write_bytes(b"m4a")
    mp3 = tmp_path / "talk.whisper.mp3"
    mp3.write_bytes(b"mp3")
    seen = {}
    empty = {
        "errors": 0,
        "skipped": 0,
        "processed": 0,
        "error_details": [],
        "warnings": [],
        "fully_indexed": 0,
        "chunk_lengths": [],
        "private_videos": 0,
    }

    def store(*_args, **kwargs):
        seen["metadata_path"] = kwargs.get("metadata_path")
        return empty

    def upload(file_path, file_name, *_args, **kwargs):
        seen["upload_path"] = file_path
        seen["file_name"] = file_name
        seen["skip_upload"] = kwargs.get("skip_upload")
        return empty

    monkeypatch.setattr(
        "data_ingestion.audio_video.transcribe_and_ingest_media._handle_transcription",
        lambda *_args, **_kwargs: ([{"text": "hello"}], empty),
    )
    monkeypatch.setattr(
        "data_ingestion.audio_video.transcribe_and_ingest_media._process_and_store_transcription",
        store,
    )
    monkeypatch.setattr(
        "data_ingestion.audio_video.transcribe_and_ingest_media._handle_s3_upload",
        upload,
    )

    process_file(
        str(mp3),
        None,
        None,
        False,
        False,
        "Swami Kriyananda",
        "The Bhaktan Files",
        {},
        s3_key="public/audio/bhaktan/talk.m4a",
        site="ananda",
        skip_upload=False,
        content_hash_path=str(m4a),
    )

    assert seen["metadata_path"] == str(m4a)
    assert seen["upload_path"] == str(m4a)
    assert seen["file_name"] == "talk.m4a"
    assert seen["skip_upload"] is False


def test_process_item_whispers_mp3_and_keeps_m4a_key(tmp_path, monkeypatch):
    m4a = tmp_path / "talk.m4a"
    m4a.write_bytes(b"m4a")
    mp3 = tmp_path / "talk.whisper.mp3"
    mp3.write_bytes(b"mp3")
    seen = {}

    def fake_process_file(file_path, *_args, **kwargs):
        seen["file_path"] = file_path
        seen["kwargs"] = kwargs
        return {"errors": 0}

    monkeypatch.setattr(
        "data_ingestion.audio_video.transcribe_and_ingest_media.materialize_whisper_audio",
        lambda path: (str(mp3), [str(mp3)]),
    )
    monkeypatch.setattr(
        "data_ingestion.audio_video.transcribe_and_ingest_media.process_file",
        fake_process_file,
    )
    monkeypatch.setattr(
        "data_ingestion.audio_video.transcribe_and_ingest_media.save_estimate",
        lambda *_args, **_kwargs: None,
    )
    s3_key = "public/audio/bhaktan/kriyaban-only/album/talk.m4a"
    item = {
        "id": "1",
        "type": "audio_file",
        "data": {
            "file_path": str(m4a),
            "s3_key": s3_key,
            "author": "Swami Kriyananda",
            "library": "The Bhaktan Files",
            "required_access_level": 200,
        },
    }

    process_item(
        item, MagicMock(force=False, dryrun=True, site="ananda"), None, None, {}
    )

    assert seen["file_path"] == str(mp3)
    assert seen["kwargs"]["s3_key"] == s3_key
    assert seen["kwargs"]["skip_upload"] is False
    assert seen["kwargs"]["content_hash_path"] == str(m4a)
    assert m4a.exists()
    assert not mp3.exists()
