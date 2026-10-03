"""Tests for the audio and YouTube ingest orchestrator."""

import logging
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from data_ingestion.bin.ingest_cli import (
    _load_crystal_represented,
    _run_audio_command,
    _run_youtube_command,
    build_queue_argv,
    build_transcribe_argv,
    main,
    run_audio,
    run_youtube,
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


def test_audio_command_logs_pinecone_index_before_processing(monkeypatch, caplog):
    monkeypatch.setenv("PINECONE_INGEST_INDEX_NAME", "ananda-2026-09-26--3-large")
    order = []

    def load_env(_site):
        order.append("load_env")

    def run_audio(_args, **_kwargs):
        order.append("run_audio")

    monkeypatch.setattr("data_ingestion.bin.ingest_cli.load_env", load_env)
    monkeypatch.setattr(
        "data_ingestion.bin.ingest_cli.get_bucket_name", lambda: "ananda-chatbot"
    )
    monkeypatch.setattr("data_ingestion.bin.ingest_cli.get_s3_client", lambda: object())
    monkeypatch.setattr(
        "data_ingestion.bin.ingest_cli.IngestSourcePublisher", MagicMock()
    )
    monkeypatch.setattr("data_ingestion.bin.ingest_cli.run_audio", run_audio)

    with caplog.at_level(logging.INFO):
        _run_audio_command(SimpleNamespace(site="ananda"))

    assert "Target pinecone collection: ananda-2026-09-26--3-large" in caplog.text
    assert order == ["load_env", "run_audio"]


def test_youtube_list_edit_does_not_log_the_pinecone_index(monkeypatch, caplog):
    monkeypatch.setenv("PINECONE_INGEST_INDEX_NAME", "ananda-2026-09-26--3-large")
    monkeypatch.setattr("data_ingestion.bin.ingest_cli.load_env", lambda _site: None)
    monkeypatch.setattr(
        "data_ingestion.bin.ingest_cli.get_bucket_name", lambda: "ananda-chatbot"
    )
    monkeypatch.setattr("data_ingestion.bin.ingest_cli.get_s3_client", lambda: object())
    monkeypatch.setattr(
        "data_ingestion.bin.ingest_cli.IngestSourcePublisher", MagicMock()
    )
    monkeypatch.setattr(
        "data_ingestion.bin.ingest_cli.run_youtube", lambda *a, **k: None
    )

    with caplog.at_level(logging.INFO):
        _run_youtube_command(SimpleNamespace(site="ananda", no_ingest=True))

    assert "Target pinecone collection" not in caplog.text


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

    publisher.pull_state.assert_called_once_with(reuse_local=True)
    publisher.sync_audio.assert_not_called()
    publisher.sync_state.assert_called_once_with(
        dry_run=False,
        cache_snapshot=publisher.whisper_cache_snapshot.return_value,
    )
    assert len(calls) == 2
    assert "manage_queue.py" in calls[0][1]
    assert build_transcribe_argv(_audio_args(), tmp_path) == calls[1]


def _youtube_args(**overrides):
    args = MagicMock()
    args.site = "ananda"
    args.author = "Swami Kriyananda"
    args.library = "Ananda Youtube"
    args.required_access_level = 0
    args.add_url = ["https://youtu.be/newvideo111"]
    args.add_playlist = []
    args.remove_url = []
    args.remove_playlist = []
    args.list_name = None
    args.no_ingest = False
    args.reindex = False
    args.yes = True
    for key, value in overrides.items():
        setattr(args, key, value)
    return args


def test_run_youtube_queues_new_video_and_syncs_when_transcribe_fails(tmp_path):
    publisher = MagicMock()
    publisher.read_youtube_source_list.return_value = {"entries": []}
    queue = MagicMock()
    queue.add_item.return_value = "item-1"
    queue.get_all_items.return_value = []
    calls = []

    def runner(command, check):
        calls.append(command)
        raise RuntimeError("whisper failed")

    with pytest.raises(RuntimeError, match="whisper failed"):
        run_youtube(
            _youtube_args(),
            publisher=publisher,
            repo_root=tmp_path,
            runner=runner,
            expand_playlist=lambda url: [],
            queue_factory=lambda: queue,
            load_processed_ids=lambda site: set(),
            normalize_author=lambda author, site: author,
        )

    publisher.pull_state.assert_called_once_with(reuse_local=True)
    publisher.pull_youtube_data_map.assert_called_once()
    filename, payload = publisher.write_youtube_source_list.call_args.args
    assert filename == "ananda-youtube-links.json"
    assert payload["entries"][0]["kind"] == "url"
    assert payload["entries"][0]["library"] == "Ananda Youtube"
    assert payload["entries"][0]["required_access_level"] == 0
    queued = queue.add_item.call_args.args[1]
    assert queued["youtube_id"] == "newvideo111"
    assert "transcribe_and_ingest_media.py" in calls[0][1]
    assert "--yes" in calls[0]
    publisher.sync_state.assert_called_once_with(
        dry_run=False,
        cache_snapshot=publisher.whisper_cache_snapshot.return_value,
    )


def test_run_youtube_does_not_transcribe_videos_already_in_the_map(tmp_path):
    publisher = MagicMock()
    publisher.read_youtube_source_list.return_value = {
        "entries": [
            {
                "kind": "url",
                "url": "https://youtu.be/newvideo111",
                "author": "Swami Kriyananda",
                "library": "Ananda Youtube",
                "required_access_level": 0,
            }
        ]
    }
    queue = MagicMock()
    queue.get_all_items.return_value = []
    runner = MagicMock()

    selection = run_youtube(
        _youtube_args(add_url=[]),
        publisher=publisher,
        repo_root=tmp_path,
        runner=runner,
        expand_playlist=lambda url: [],
        queue_factory=lambda: queue,
        load_processed_ids=lambda site: {"newvideo111"},
        normalize_author=lambda author, site: author,
    )

    assert selection.videos == []
    assert selection.skipped_processed == 1
    publisher.write_youtube_source_list.assert_not_called()
    queue.add_item.assert_not_called()
    runner.assert_not_called()
    publisher.sync_state.assert_called_once_with(
        dry_run=False,
        cache_snapshot=publisher.whisper_cache_snapshot.return_value,
    )


def test_run_youtube_reindex_queues_videos_already_in_the_map(tmp_path):
    publisher = MagicMock()
    publisher.read_youtube_source_list.return_value = {
        "entries": [
            {
                "kind": "url",
                "url": "https://youtu.be/newvideo111",
                "author": "Swami Kriyananda",
                "library": "Ananda Youtube",
                "required_access_level": 0,
            }
        ]
    }
    queue = MagicMock()
    queue.get_all_items.return_value = []
    runner = MagicMock()

    selection = run_youtube(
        _youtube_args(add_url=[], reindex=True),
        publisher=publisher,
        repo_root=tmp_path,
        runner=runner,
        expand_playlist=lambda url: [],
        queue_factory=lambda: queue,
        load_processed_ids=lambda site: {"newvideo111"},
        normalize_author=lambda author, site: author,
    )

    assert selection.skipped_processed == 0
    assert selection.videos[0].youtube_id == "newvideo111"
    queue.add_item.assert_called_once()
    runner.assert_called_once()


def test_run_youtube_list_edit_without_ingest_skips_state_sync(tmp_path):
    publisher = MagicMock()
    publisher.read_youtube_source_list.return_value = {"entries": []}
    runner = MagicMock()

    result = run_youtube(
        _youtube_args(no_ingest=True),
        publisher=publisher,
        repo_root=tmp_path,
        runner=runner,
        expand_playlist=lambda url: [],
        queue_factory=MagicMock,
        load_processed_ids=lambda site: set(),
        normalize_author=lambda author, site: author,
    )

    assert result is None
    publisher.pull_state.assert_not_called()
    publisher.pull_youtube_data_map.assert_not_called()
    publisher.write_youtube_source_list.assert_called_once()
    runner.assert_not_called()
    publisher.sync_state.assert_not_called()


def test_run_youtube_add_requires_author_and_library(tmp_path):
    publisher = MagicMock()

    with pytest.raises(SystemExit, match="--author and --library"):
        run_youtube(
            _youtube_args(author=None, library=None),
            publisher=publisher,
            repo_root=tmp_path,
            expand_playlist=lambda url: [],
            queue_factory=MagicMock,
            load_processed_ids=lambda site: set(),
            normalize_author=lambda author, site: author,
        )

    publisher.read_youtube_source_list.assert_not_called()


def test_run_youtube_reports_playlist_failure_and_queues_the_rest(tmp_path, capsys):
    publisher = MagicMock()
    publisher.read_youtube_source_list.return_value = {
        "entries": [
            {
                "kind": "playlist",
                "url": "https://www.youtube.com/playlist?list=PLbroken",
                "author": "Swami Kriyananda",
                "library": "Ananda Youtube",
                "required_access_level": 0,
            },
            {
                "kind": "url",
                "url": "https://youtu.be/newvideo111",
                "author": "Swami Kriyananda",
                "library": "Ananda Youtube",
                "required_access_level": 0,
            },
        ]
    }
    queue = MagicMock()
    queue.add_item.return_value = "item-1"
    queue.get_all_items.return_value = []

    def expand_playlist(url):
        raise RuntimeError("yt-dlp unavailable")

    selection = run_youtube(
        _youtube_args(add_url=[]),
        publisher=publisher,
        repo_root=tmp_path,
        runner=MagicMock(),
        expand_playlist=expand_playlist,
        queue_factory=lambda: queue,
        load_processed_ids=lambda site: set(),
        normalize_author=lambda author, site: author,
    )

    assert [video.youtube_id for video in selection.videos] == ["newvideo111"]
    assert "PLbroken" in capsys.readouterr().out
    assert queue.add_item.call_args.args[1]["youtube_id"] == "newvideo111"
    publisher.write_youtube_source_list.assert_not_called()


def test_library_cli_parses_dump_and_replace(monkeypatch):
    seen = {}

    def handler(args):
        seen["command"] = args.command
        seen["dump"] = args.dump
        seen["s3_key"] = args.s3_key
        seen["replace_library"] = args.replace_library
        seen["skip_catalog"] = args.skip_catalog

    monkeypatch.setattr("data_ingestion.bin.ingest_cli._run_library_command", handler)
    main(
        [
            "library",
            "--site",
            "ananda",
            "--dump",
            "anandalib.sql.gz",
            "--replace-library",
            "--skip-catalog",
        ]
    )

    assert seen == {
        "command": "library",
        "dump": "anandalib.sql.gz",
        "s3_key": None,
        "replace_library": True,
        "skip_catalog": True,
    }


def test_pdf_cli_parses_local_dir_and_replace(monkeypatch):
    seen = {}

    def handler(args):
        seen["command"] = args.command
        seen["site"] = args.site
        seen["local_dir"] = args.local_dir
        seen["replace_library"] = args.replace_library
        seen["s3_prefix"] = args.s3_prefix

    monkeypatch.setattr("data_ingestion.bin.ingest_cli._run_pdf_command", handler)
    main(
        [
            "pdf",
            "--site",
            "crystal",
            "--local-dir",
            "/books",
            "--replace-library",
        ]
    )

    assert seen == {
        "command": "pdf",
        "site": "crystal",
        "local_dir": "/books",
        "replace_library": True,
        "s3_prefix": None,
    }


def test_youtube_cli_parses_add_and_remove(monkeypatch):
    seen = {}

    def handler(args):
        seen["command"] = args.command
        seen["add_playlist"] = args.add_playlist
        seen["remove_url"] = args.remove_url
        seen["required_access_level"] = args.required_access_level
        seen["library"] = args.library

    monkeypatch.setattr("data_ingestion.bin.ingest_cli._run_youtube_command", handler)
    main(
        [
            "youtube",
            "--site",
            "ananda",
            "--author",
            "Swami Kriyananda",
            "--library",
            "Ananda Youtube",
            "--add-playlist",
            "https://www.youtube.com/playlist?list=PLabc",
            "--remove-url",
            "https://youtu.be/oldvideo111",
            "--required-access-level",
            "200",
            "--yes",
        ]
    )

    assert seen["command"] == "youtube"
    assert seen["library"] == "Ananda Youtube"
    assert seen["add_playlist"] == ["https://www.youtube.com/playlist?list=PLabc"]
    assert seen["remove_url"] == ["https://youtu.be/oldvideo111"]
    assert seen["required_access_level"] == 200


def test_crystal_loader_returns_filenames_and_titles(monkeypatch):
    monkeypatch.setenv("PINECONE_INGEST_INDEX_NAME", "crystal-index")

    class _Index:
        pass

    class _Client:
        def Index(self, name):
            assert name == "crystal-index"
            return _Index()

    monkeypatch.setattr(
        "data_ingestion.bin.ingest_cli.get_pinecone_client",
        lambda: _Client(),
    )
    monkeypatch.setattr(
        "data_ingestion.bin.ingest_cli.represented_pdfs_from_index",
        lambda index, library: ({"already.pdf"}, {"product title"}),
    )

    assert _load_crystal_represented() == ({"already.pdf"}, {"product title"})
