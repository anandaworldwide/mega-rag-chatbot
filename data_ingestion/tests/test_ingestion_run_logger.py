import argparse
import importlib.util
import json
from pathlib import Path
from unittest.mock import MagicMock, patch

from data_ingestion.audio_video import manage_queue, transcribe_and_ingest_media
from data_ingestion.sql_to_vector_db import ingest_db_text
from data_ingestion.utils.ingestion_run_logger import IngestionRunLogger, build_command


def load_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines()]


def load_history_module():
    module_path = (
        Path(__file__).resolve().parents[1] / "bin" / "list_ingestion_runs.py"
    )
    spec = importlib.util.spec_from_file_location("list_ingestion_runs", module_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_logger_appends_started_and_completed_events(tmp_path, monkeypatch):
    log_path = tmp_path / "ingestion_runs.jsonl"
    monkeypatch.setenv("PINECONE_INGEST_INDEX_NAME", "test-index")
    logger = IngestionRunLogger(log_path)

    started = logger.start_run(
        method="sql_database",
        site="ananda",
        args={"library_name": "Ananda Library"},
        source_summary={"database": "anandalib"},
        argv=["python", "ingest_db_text.py", "--site", "ananda"],
    )
    logger.finish_run(started, outcome={"processed": 3, "errors": 0})

    events = load_jsonl(log_path)
    assert len(events) == 2
    assert events[0]["status"] == "started"
    assert events[1]["status"] == "completed"
    assert events[1]["method"] == "sql_database"
    assert events[1]["site"] == "ananda"
    assert events[1]["pinecone"]["PINECONE_INGEST_INDEX_NAME"] == "test-index"
    assert events[1]["outcome"]["processed"] == 3
    assert events[1]["command"] == "python ingest_db_text.py --site ananda"
    assert events[1]["raw_argv"] == ["python", "ingest_db_text.py", "--site", "ananda"]


def test_build_command_adds_python_for_live_script_argv(monkeypatch):
    monkeypatch.setattr(
        "sys.argv",
        ["data_ingestion/audio_video/manage_queue.py", "--site", "ananda"],
    )

    assert (
        build_command()
        == "python data_ingestion/audio_video/manage_queue.py --site ananda"
    )


def test_history_cli_collapses_and_filters_records(tmp_path):
    history_module = load_history_module()
    log_path = tmp_path / "ingestion_runs.jsonl"
    logger = IngestionRunLogger(log_path)
    first = logger.start_run(
        method="media_queue",
        site="ananda",
        args={"library": "bhaktan"},
        argv=["python", "manage_queue.py", "--site", "ananda"],
    )
    logger.finish_run(first, outcome={"queued": 2})
    second = logger.start_run(
        method="sql_database",
        site="crystal",
        args={"library_name": "Crystal"},
        argv=["python", "ingest_db_text.py", "--site", "crystal"],
    )

    events = history_module.load_ingestion_events(log_path)
    latest = history_module.latest_records_by_run(events)

    assert len(latest) == 2
    first_latest = next(record for record in latest if record["run_id"] == first["run_id"])
    assert first_latest["status"] == "completed"
    args = argparse.Namespace(
        site="ananda",
        method="media_queue",
        status="completed",
        index=None,
        library="bhaktan",
    )
    assert history_module.record_matches_filters(first_latest, args)
    assert not history_module.record_matches_filters(second, args)


def test_history_cli_formats_timestamps_in_pacific_time():
    history_module = load_history_module()

    assert (
        history_module.format_pacific_timestamp("2026-04-27T01:14:06+00:00")
        == "4/26/26 6:14:06 PM PDT"
    )
    assert history_module.format_pacific_timestamp(None) == "unfinished"


def test_history_cli_prints_timestamp_and_command_first(capsys):
    history_module = load_history_module()
    history_module.print_records(
        [
            {
                "started_at": "2026-04-27T01:14:06+00:00",
                "finished_at": "2026-04-27T01:15:06+00:00",
                "status": "completed",
                "method": "media_queue",
                "site": "ananda",
                "args": {"library": "treasures"},
                "pinecone": {"PINECONE_INGEST_INDEX_NAME": "ananda-index"},
                "source_summary": {"directory": "/tmp/talks"},
                "outcome": {"queued": 3},
                "command": "python manage_queue.py --site ananda",
            }
        ]
    )

    output_lines = capsys.readouterr().out.splitlines()
    assert output_lines[0] == (
        "4/26/26 6:14:06 PM PDT | python manage_queue.py --site ananda"
    )
    assert output_lines[1] == (
        "  status=completed | method=media_queue | finished=4/26/26 6:15:06 PM PDT"
    )
    assert output_lines[2] == "  site=ananda | index=ananda-index | library=treasures"


def test_sql_ingestion_logs_empty_run(tmp_path, monkeypatch):
    log_path = tmp_path / "ingestion_runs.jsonl"
    monkeypatch.setenv("INGESTION_RUN_LOG_PATH", str(log_path))
    monkeypatch.setenv("PINECONE_INGEST_INDEX_NAME", "sql-index")
    args = argparse.Namespace(
        site="ananda",
        database="anandalib",
        library_name="Ananda Library",
        keep_data=False,
        batch_size=10,
        max_records=None,
        dry_run=False,
        no_pinecone=False,
        overwrite_pdfs=False,
        no_pdf_uploads=False,
        debug_pdfs=False,
        required_access_level_field="luca_required_access_level",
    )

    with (
        patch.object(ingest_db_text, "load_environment"),
        patch.object(ingest_db_text, "get_config", return_value={}),
        patch.object(ingest_db_text, "load_site_config", return_value={}),
        patch.object(
            ingest_db_text,
            "setup_connections_and_index",
            return_value=(MagicMock(), MagicMock()),
        ),
        patch.object(ingest_db_text, "get_checkpoint_file_path", return_value="ckpt"),
        patch.object(
            ingest_db_text,
            "handle_checkpoint_or_clear_data",
            return_value=set(),
        ),
        patch.object(ingest_db_text, "fetch_all_data", return_value=[]),
        patch.object(ingest_db_text, "close_db_connection"),
    ):
        ingest_db_text._run_ingestion(args)

    events = load_jsonl(log_path)
    assert events[-1]["status"] == "completed"
    assert events[-1]["method"] == "sql_database"
    assert events[-1]["source_summary"]["database"] == "anandalib"
    assert events[-1]["outcome"]["fetched_records"] == 0


def test_media_queue_main_logs_route_outcome(tmp_path, monkeypatch):
    log_path = tmp_path / "ingestion_runs.jsonl"
    monkeypatch.setenv("INGESTION_RUN_LOG_PATH", str(log_path))
    monkeypatch.setattr(
        "sys.argv",
        [
            "manage_queue.py",
            "--site",
            "ananda",
            "--video",
            "https://youtu.be/test123",
            "--default-author",
            "Swami Kriyananda",
            "--library",
            "bhaktan",
        ],
    )
    queue = MagicMock()
    queue.get_queue_status.return_value = {"pending": 2, "completed": 0, "error": 0, "total": 2}

    with (
        patch.object(manage_queue, "initialize_environment"),
        patch.object(manage_queue, "IngestQueue", return_value=queue),
        patch.object(manage_queue, "_route_operation", return_value={"queued": 2}),
    ):
        manage_queue.main()

    events = load_jsonl(log_path)
    assert events[-1]["status"] == "completed"
    assert events[-1]["method"] == "media_queue"
    assert events[-1]["source_summary"]["video"] == "https://youtu.be/test123"
    assert events[-1]["outcome"]["queued"] == 2
    assert events[-1]["outcome"]["queue_status"]["pending"] == 2


def test_media_queue_main_logs_handler_validation_failure(tmp_path, monkeypatch):
    log_path = tmp_path / "ingestion_runs.jsonl"
    monkeypatch.setenv("INGESTION_RUN_LOG_PATH", str(log_path))
    monkeypatch.setattr(
        "sys.argv",
        [
            "manage_queue.py",
            "--site",
            "ananda",
            "--video",
            "https://youtu.be/test123",
            "--default-author",
            "Swami Kriyananda",
            "--library",
            "bhaktan",
        ],
    )
    queue = MagicMock()
    queue.get_queue_status.return_value = {
        "pending": 0,
        "completed": 0,
        "error": 0,
        "total": 0,
    }

    with (
        patch.object(manage_queue, "initialize_environment"),
        patch.object(manage_queue, "IngestQueue", return_value=queue),
        patch.object(manage_queue, "_route_operation", return_value=False),
    ):
        manage_queue.main()

    events = load_jsonl(log_path)
    assert events[-1]["status"] == "failed"
    assert events[-1]["method"] == "media_queue"
    assert events[-1]["error"] == "Operation validation failed"
    assert events[-1]["outcome"]["validation_failed"] is True
    assert events[-1]["outcome"]["operation"] == "video"


def test_media_process_main_logs_processing_report(tmp_path, monkeypatch):
    log_path = tmp_path / "ingestion_runs.jsonl"
    monkeypatch.setenv("INGESTION_RUN_LOG_PATH", str(log_path))
    monkeypatch.setenv("PINECONE_INGEST_INDEX_NAME", "media-index")
    monkeypatch.setattr(
        "sys.argv",
        [
            "transcribe_and_ingest_media.py",
            "--site",
            "ananda",
            "--queue",
            "queue-bhaktan",
        ],
    )
    queue = MagicMock()
    queue.get_queue_status.return_value = {
        "pending": 0,
        "completed": 2,
        "error": 0,
        "total": 2,
    }
    report = {
        "processed": 2,
        "skipped": 0,
        "errors": 0,
        "error_details": [],
        "warnings": ["one warning"],
        "fully_indexed": 2,
        "chunk_lengths": [],
        "private_videos": 0,
    }

    with (
        patch.object(transcribe_and_ingest_media, "initialize_environment"),
        patch.object(transcribe_and_ingest_media, "IngestQueue", return_value=queue),
        patch("builtins.input", return_value="yes"),
        patch.object(transcribe_and_ingest_media, "_setup_vector_clearing"),
        patch.object(
            transcribe_and_ingest_media,
            "_run_worker_pool_processing",
            return_value=report,
        ),
        patch.object(transcribe_and_ingest_media, "print_report"),
        patch.object(transcribe_and_ingest_media, "reset_terminal"),
    ):
        transcribe_and_ingest_media.main()

    events = load_jsonl(log_path)
    assert events[-1]["status"] == "completed"
    assert events[-1]["method"] == "media_process"
    assert events[-1]["source_summary"]["queue"] == "queue-bhaktan"
    assert events[-1]["outcome"]["processed"] == 2
    assert events[-1]["outcome"]["warnings"] == 1
