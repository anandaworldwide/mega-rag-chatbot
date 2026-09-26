"""Tests for the audio ingest orchestrator."""

from pathlib import Path
from unittest.mock import MagicMock

from data_ingestion.bin.ingest_cli import (
    build_queue_argv,
    build_transcribe_argv,
    run_audio,
)


def _audio_args(**overrides):
    args = MagicMock()
    args.site = "ananda"
    args.library = "treasures"
    args.author = "Swami Kriyananda"
    args.required_access_level = 0
    args.yes = True
    args.ignore_path_access_levels = False
    args.local_dir = None
    args.s3_prefix = None
    args.key_prefix = None
    for key, value in overrides.items():
        setattr(args, key, value)
    return args


def test_build_queue_argv_uses_s3_prefix_for_library():
    command = build_queue_argv(_audio_args(), Path("/repo"))
    assert command[-2:] == ["--s3-prefix", "public/audio/treasures/"]
    assert "--yes" in command
    assert "--directory" not in command


def test_build_queue_argv_local_dir_does_not_list_s3():
    command = build_queue_argv(
        _audio_args(local_dir="/incoming", s3_prefix="public/audio/treasures/"),
        Path("/repo"),
    )
    assert "--directory" in command
    assert "/incoming" in command
    assert "--s3-prefix" not in command


def test_run_audio_pushes_state_when_transcribe_fails(tmp_path):
    publisher = MagicMock()
    calls = []

    def runner(command, check):
        calls.append(command)
        if "transcribe_and_ingest_media.py" in command[1]:
            raise RuntimeError("whisper failed")

    try:
        run_audio(
            _audio_args(),
            publisher=publisher,
            repo_root=tmp_path,
            runner=runner,
        )
    except RuntimeError as exc:
        assert str(exc) == "whisper failed"
    else:
        raise AssertionError("expected transcribe failure")

    publisher.pull_state.assert_called_once()
    publisher.sync_audio.assert_not_called()
    publisher.sync_state.assert_called_once_with(dry_run=False)
    assert len(calls) == 2
    assert "manage_queue.py" in calls[0][1]
    assert build_transcribe_argv(_audio_args(), tmp_path) == calls[1]
