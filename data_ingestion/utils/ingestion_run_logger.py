"""Append-only ingestion run logging for manual data ingestion workflows.

This module is used by ingestion scripts rather than invoked directly. Run one
of the supported manual ingestion commands and it will append started/completed
or failed events to `.cache/ingestion-runs/ingestion_runs.jsonl`:

    uv run python data_ingestion/sql_to_vector_db/ingest_db_text.py --site ananda ...
    uv run python data_ingestion/audio_video/manage_queue.py --site ananda ...
    uv run python data_ingestion/audio_video/transcribe_and_ingest_media.py --site ananda

Inspect the most recent runs from the command line:

    uv run python data_ingestion/bin/list_ingestion_runs.py --site ananda --status completed
    uv run python data_ingestion/bin/list_ingestion_runs.py --site ananda --method media_queue

Set `INGESTION_RUN_LOG_PATH=/path/to/ingestion_runs.jsonl` before running either
the ingestion scripts or `data_ingestion/bin/list_ingestion_runs.py` to use a
different ledger.
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 1
LOG_PATH_ENV_VAR = "INGESTION_RUN_LOG_PATH"
DEFAULT_RELATIVE_LOG_PATH = Path(".cache/ingestion-runs/ingestion_runs.jsonl")
PINECONE_CONTEXT_KEYS = (
    "PINECONE_INGEST_INDEX_NAME",
    "PINECONE_INDEX_NAME",
    "PINECONE_NAMESPACE",
)


def utc_now_iso() -> str:
    """Return an ISO-8601 UTC timestamp."""
    return datetime.now(UTC).isoformat()


def get_repo_root() -> Path:
    """Return the repository root based on this module location."""
    return Path(__file__).resolve().parents[2]


def get_default_log_path() -> Path:
    """Return the ingestion run log path."""
    configured_path = os.environ.get(LOG_PATH_ENV_VAR)
    if configured_path:
        return Path(configured_path).expanduser()
    return get_repo_root() / DEFAULT_RELATIVE_LOG_PATH


def to_jsonable(value: Any) -> Any:
    """Convert common Python values into JSON-serializable values."""
    if isinstance(value, argparse.Namespace):
        return to_jsonable(vars(value))
    if isinstance(value, dict):
        return {str(key): to_jsonable(item) for key, item in value.items()}
    if isinstance(value, list | tuple | set):
        return [to_jsonable(item) for item in value]
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, str | int | float | bool) or value is None:
        return value
    return str(value)


def get_git_context(repo_root: Path | None = None) -> dict[str, Any]:
    """Return lightweight git context without failing ingestion if git is unavailable."""
    root = repo_root or get_repo_root()
    context: dict[str, Any] = {
        "sha": None,
        "dirty": None,
    }

    try:
        sha_result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=root,
            check=True,
            capture_output=True,
            text=True,
            timeout=5,
        )
        context["sha"] = sha_result.stdout.strip()

        dirty_result = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=root,
            check=True,
            capture_output=True,
            text=True,
            timeout=5,
        )
        context["dirty"] = bool(dirty_result.stdout.strip())
    except Exception:
        context["sha"] = None
        context["dirty"] = None

    return context


def get_pinecone_context() -> dict[str, str | None]:
    """Return non-secret Pinecone targeting context from the environment."""
    return {key: os.environ.get(key) for key in PINECONE_CONTEXT_KEYS}


def build_command(argv: list[str] | None = None) -> str:
    """Build a copyable shell command from argv."""
    command_argv = argv if argv is not None else ["python", *sys.argv]
    return shlex.join(command_argv)


@dataclass
class IngestionRunLogger:
    """Append-only JSONL logger for ingestion run events."""

    log_path: Path

    @classmethod
    def from_environment(cls) -> IngestionRunLogger:
        """Create a logger using the default or environment-configured path."""
        return cls(get_default_log_path())

    def append_event(self, record: dict[str, Any]) -> None:
        """Append a JSON record to the ingestion run log."""
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        with self.log_path.open("a", encoding="utf-8") as log_file:
            log_file.write(
                json.dumps(to_jsonable(record), sort_keys=True, ensure_ascii=False)
                + "\n"
            )

    def start_run(
        self,
        *,
        method: str,
        site: str | None,
        args: argparse.Namespace | dict[str, Any] | None = None,
        source_summary: dict[str, Any] | None = None,
        argv: list[str] | None = None,
        extra_context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Append and return a started ingestion run record."""
        started_at = utc_now_iso()
        record: dict[str, Any] = {
            "schema_version": SCHEMA_VERSION,
            "run_id": str(uuid.uuid4()),
            "event": "started",
            "status": "started",
            "method": method,
            "site": site,
            "started_at": started_at,
            "finished_at": None,
            "command": build_command(argv),
            "raw_argv": list(argv if argv is not None else sys.argv),
            "python_executable": sys.executable,
            "args": to_jsonable(args or {}),
            "cwd": os.getcwd(),
            "git": get_git_context(),
            "pinecone": get_pinecone_context(),
            "source_summary": to_jsonable(source_summary or {}),
            "outcome": {},
            "extra_context": to_jsonable(extra_context or {}),
            "followups": {"title_catalog_refresh_needed": True},
            "error": None,
        }
        self.append_event(record)
        return record

    def finish_run(
        self,
        run_record: dict[str, Any],
        *,
        status: str = "completed",
        outcome: dict[str, Any] | None = None,
        extra_context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Append and return a terminal run record."""
        finished_record = {
            **run_record,
            "event": status,
            "status": status,
            "finished_at": utc_now_iso(),
            "outcome": to_jsonable(outcome or {}),
            "extra_context": to_jsonable(
                {**run_record.get("extra_context", {}), **(extra_context or {})}
            ),
        }
        self.append_event(finished_record)
        return finished_record

    def fail_run(
        self,
        run_record: dict[str, Any],
        *,
        error: BaseException | str,
        outcome: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Append and return a failed run record."""
        failed_record = {
            **run_record,
            "event": "failed",
            "status": "failed",
            "finished_at": utc_now_iso(),
            "outcome": to_jsonable(outcome or {}),
            "error": str(error),
        }
        self.append_event(failed_record)
        return failed_record


def start_run(**kwargs: Any) -> dict[str, Any]:
    """Start an ingestion run using the environment-configured logger."""
    return IngestionRunLogger.from_environment().start_run(**kwargs)


def finish_run(run_record: dict[str, Any], **kwargs: Any) -> dict[str, Any]:
    """Finish an ingestion run using the environment-configured logger."""
    return IngestionRunLogger.from_environment().finish_run(run_record, **kwargs)


def fail_run(run_record: dict[str, Any], **kwargs: Any) -> dict[str, Any]:
    """Fail an ingestion run using the environment-configured logger."""
    return IngestionRunLogger.from_environment().fail_run(run_record, **kwargs)
