"""Tests for the Ananda Library dump orchestrator."""

import gzip
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

from data_ingestion.sql_to_vector_db.library_ingest import (
    materialize_sql_dump,
    run_library,
)


def test_materialize_sql_dump_ignores_html_after_gzip(tmp_path: Path):
    raw = tmp_path / "anandalib.sql.gz"
    payload = b"SELECT 1;\n"
    raw.write_bytes(gzip.compress(payload) + b"\n<html>trailer</html>")

    sql_path = materialize_sql_dump(raw, tmp_path / "out")

    assert sql_path.read_bytes() == payload
    assert sql_path.suffix == ".sql"


def test_run_library_keeps_vectors_and_tears_down_mysql(tmp_path: Path):
    dump = tmp_path / "anandalib.sql"
    dump.write_text("SELECT 1;\n", encoding="utf-8")
    publisher = MagicMock()
    calls = []

    def runner(command, **kwargs):
        calls.append((list(command), kwargs.get("env")))
        return None

    def importer(sql_file, username, *, password, host, port):
        assert sql_file.endswith(".sql")
        assert username == "libuser"
        assert password == "pw"
        assert host == "127.0.0.1"
        assert port == 3307
        return "anandalib_2026_09_26"

    run_library(
        SimpleNamespace(
            site="ananda",
            dump=str(dump),
            s3_key=None,
            replace_library=False,
        ),
        publisher=publisher,
        repo_root=tmp_path,
        runner=runner,
        importer=importer,
        environ={
            "DB_USER": "libuser",
            "DB_PASSWORD": "pw",
            "DB_HOST": "db.example",
        },
        artifact_version="ananda-20260926-143000",
    )

    publisher.upload_dump.assert_called_once_with(dump, dry_run=False)
    commands = [command for command, _env in calls]
    assert commands[0][:2] == ["docker", "compose"]
    assert commands[0][-3:] == ["up", "-d", "--wait"]
    grant = commands[1]
    assert "GRANT ALL PRIVILEGES" in " ".join(grant)
    assert "libuser" in " ".join(grant)
    assert "pw" not in " ".join(grant)
    ingest = next(command for command in commands if "ingest_db_text.py" in command[1])
    assert "--keep-data" in ingest
    assert "--database" in ingest
    assert "anandalib_2026_09_26" in ingest
    assert "Ananda Library" in ingest
    assert "luca_required_access_level" in ingest
    catalog = next(
        command
        for command in commands
        if "analyze_title_prefix_catalog.py" in command[1]
    )
    assert "--write-artifacts" in catalog
    assert "ananda-20260926-143000" in catalog
    publish = next(
        command
        for command in commands
        if command[0].endswith("publish_title_catalog_to_s3.sh")
    )
    assert publish[-4:] == ["--site", "ananda", "--profile", "ananda"]
    assert commands[-1][-2:] == ["down", "-v"]
    ingest_env = next(
        env for command, env in calls if "ingest_db_text.py" in command[1]
    )
    assert ingest_env["DB_HOST"] == "127.0.0.1"
    assert calls[0][1]["MYSQL_USER"] == "libuser"
    assert calls[0][1]["MYSQL_PASSWORD"] == "pw"


def test_replace_library_requires_typed_name_and_omits_keep_data(tmp_path: Path):
    dump = tmp_path / "anandalib.sql"
    dump.write_text("SELECT 1;\n", encoding="utf-8")
    calls = []

    def runner(command, **kwargs):
        calls.append(list(command))
        return None

    prompts = []

    def prompt(message):
        prompts.append(message)
        return "Ananda Library"

    run_library(
        SimpleNamespace(
            site="ananda",
            dump=str(dump),
            s3_key=None,
            replace_library=True,
            yes=True,
        ),
        publisher=MagicMock(),
        repo_root=tmp_path,
        runner=runner,
        importer=lambda *_args, **_kwargs: "anandalib_2026_09_26",
        environ={"DB_USER": "root", "DB_PASSWORD": "pw"},
        prompt=prompt,
        artifact_version="ananda-test",
    )

    assert prompts
    assert "Ananda Library" in prompts[0]
    ingest = next(command for command in calls if "ingest_db_text.py" in command[1])
    assert "--keep-data" not in ingest


def test_replace_library_cancel_does_not_start_mysql(tmp_path: Path):
    dump = tmp_path / "anandalib.sql"
    dump.write_text("SELECT 1;\n", encoding="utf-8")
    publisher = MagicMock()
    runner = MagicMock()

    try:
        run_library(
            SimpleNamespace(
                site="ananda",
                dump=str(dump),
                s3_key=None,
                replace_library=True,
                yes=True,
            ),
            publisher=publisher,
            repo_root=tmp_path,
            runner=runner,
            environ={"DB_USER": "root", "DB_PASSWORD": "pw"},
            prompt=lambda _message: "no",
        )
    except SystemExit as exc:
        assert "cancelled" in str(exc)
    else:
        raise AssertionError("expected replace to be cancelled")

    runner.assert_not_called()
    publisher.upload_dump.assert_not_called()


def test_failed_ingest_stops_mysql_without_deleting_the_volume(tmp_path: Path):
    dump = tmp_path / "anandalib.sql"
    dump.write_text("SELECT 1;\n", encoding="utf-8")
    calls = []

    def runner(command, **kwargs):
        calls.append(list(command))
        if "ingest_db_text.py" in command[1]:
            raise RuntimeError("ingest failed")
        return None

    try:
        run_library(
            SimpleNamespace(
                site="ananda",
                dump=str(dump),
                s3_key=None,
                replace_library=False,
            ),
            publisher=MagicMock(),
            repo_root=tmp_path,
            runner=runner,
            importer=lambda *_args, **_kwargs: "anandalib_2026_09_26",
            environ={"DB_USER": "root", "DB_PASSWORD": "pw"},
            artifact_version="ananda-test",
        )
    except RuntimeError as exc:
        assert str(exc) == "ingest failed"
    else:
        raise AssertionError("expected ingest failure")

    assert calls[-1][-1] == "down"
    assert "-v" not in calls[-1]
    assert not any("analyze_title_prefix_catalog.py" in command[1] for command in calls)


def test_run_library_downloads_latest_s3_dump_when_no_local_file(tmp_path: Path):
    publisher = MagicMock()
    publisher.latest_dump_key.return_value = (
        "ingestion/dumps/anandalib/anandalib_wp_20260914.sql"
    )

    def download(_key, dest):
        Path(dest).write_text("SELECT 1;\n", encoding="utf-8")
        return dest

    publisher.download_dump.side_effect = download
    calls = []

    run_library(
        SimpleNamespace(site="ananda", dump=None, s3_key=None, replace_library=False),
        publisher=publisher,
        repo_root=tmp_path,
        runner=lambda command, **_kwargs: calls.append(list(command)),
        importer=lambda *_args, **_kwargs: "anandalib_2026_09_26",
        environ={"DB_USER": "root", "DB_PASSWORD": "pw"},
        artifact_version="ananda-test",
    )

    publisher.upload_dump.assert_not_called()
    publisher.latest_dump_key.assert_called_once_with()
    publisher.download_dump.assert_called_once()
    assert "ingest_db_text.py" in calls[1][1]


def test_run_library_uses_explicit_s3_key(tmp_path: Path):
    publisher = MagicMock()

    def download(key, dest):
        assert key == "ingestion/dumps/anandalib/chosen.sql.gz"
        Path(dest).write_bytes(gzip.compress(b"SELECT 1;\n"))
        return dest

    publisher.download_dump.side_effect = download

    run_library(
        SimpleNamespace(
            site="ananda",
            dump=None,
            s3_key="ingestion/dumps/anandalib/chosen.sql.gz",
            replace_library=False,
        ),
        publisher=publisher,
        repo_root=tmp_path,
        runner=lambda *_args, **_kwargs: None,
        importer=lambda sql_file, *_args, **_kwargs: "anandalib_2026_09_26",
        environ={"DB_USER": "root", "DB_PASSWORD": "pw"},
        artifact_version="ananda-test",
    )

    publisher.latest_dump_key.assert_not_called()
    publisher.download_dump.assert_called_once()
