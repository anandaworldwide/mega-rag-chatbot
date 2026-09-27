"""Whisper input for .m4a originals."""

from pathlib import Path
from unittest.mock import MagicMock

from data_ingestion.audio_video.media_utils import materialize_whisper_audio
from data_ingestion.audio_video.transcribe_and_ingest_media import process_item


def test_materialize_whisper_audio_converts_m4a_without_replacing_it(tmp_path):
    source = tmp_path / "talk.m4a"
    source.write_bytes(b"m4a-bytes")
    commands = []

    def runner(command, check):
        commands.append(command)
        assert check is True
        Path(command[-1]).write_bytes(b"mp3")

    whisper_path, temps = materialize_whisper_audio(str(source), runner=runner)

    assert Path(whisper_path).name == "talk.whisper.mp3"
    assert source.read_bytes() == b"m4a-bytes"
    assert temps == [whisper_path]
    assert commands[0][:4] == ["ffmpeg", "-y", "-i", str(source)]
    assert commands[0][-1] == whisper_path


def test_materialize_whisper_audio_leaves_mp3_unchanged(tmp_path):
    source = tmp_path / "talk.mp3"
    source.write_bytes(b"mp3")

    def runner(command, check):
        raise AssertionError(command)

    whisper_path, temps = materialize_whisper_audio(str(source), runner=runner)

    assert whisper_path == str(source)
    assert temps == []


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
    assert seen["kwargs"]["skip_upload"] is True
    assert seen["kwargs"]["content_hash_path"] == str(m4a)
    assert m4a.exists()
    assert not mp3.exists()
