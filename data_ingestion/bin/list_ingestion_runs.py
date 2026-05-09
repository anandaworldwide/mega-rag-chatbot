#!/usr/bin/env python
"""List prior manual ingestion runs from the local JSONL run ledger."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

_script_dir = Path(__file__).resolve().parent
_project_root = _script_dir.parents[1]
if str(_project_root) not in sys.path:
    sys.path.insert(0, str(_project_root))

from data_ingestion.utils.ingestion_run_logger import get_default_log_path  # noqa: E402

PACIFIC_TZ = ZoneInfo("America/Los_Angeles")


def load_ingestion_events(log_path: Path) -> list[dict[str, Any]]:
    """Load JSONL ingestion run events from disk."""
    if not log_path.exists():
        return []

    events = []
    with log_path.open(encoding="utf-8") as log_file:
        for line_number, line in enumerate(log_file, start=1):
            stripped_line = line.strip()
            if not stripped_line:
                continue
            try:
                events.append(json.loads(stripped_line))
            except json.JSONDecodeError as exc:
                raise ValueError(
                    f"Invalid JSON on line {line_number} of {log_path}"
                ) from exc
    return events


def latest_records_by_run(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Collapse append-only events to the latest record for each run."""
    latest_records: dict[str, dict[str, Any]] = {}
    for event in events:
        run_id = event.get("run_id")
        if not run_id:
            continue
        latest_records[run_id] = event
    return list(latest_records.values())


def get_record_index(record: dict[str, Any]) -> str | None:
    """Return the primary Pinecone index name from a run record."""
    pinecone = record.get("pinecone") or {}
    return pinecone.get("PINECONE_INGEST_INDEX_NAME") or pinecone.get(
        "PINECONE_INDEX_NAME"
    )


def get_record_library(record: dict[str, Any]) -> str | None:
    """Return the library value from args or source summary."""
    args = record.get("args") or {}
    source_summary = record.get("source_summary") or {}
    return (
        args.get("library")
        or args.get("library_name")
        or source_summary.get("library")
        or source_summary.get("library_name")
    )


def record_matches_filters(record: dict[str, Any], args: argparse.Namespace) -> bool:
    """Return whether a record matches CLI filters."""
    if args.site and record.get("site") != args.site:
        return False
    if args.method and record.get("method") != args.method:
        return False
    if args.status and record.get("status") != args.status:
        return False
    if args.index and get_record_index(record) != args.index:
        return False
    return not (args.library and get_record_library(record) != args.library)


def format_outcome(outcome: dict[str, Any]) -> str:
    """Format common outcome counts into a compact summary."""
    if not outcome:
        return "outcome=(none)"

    keys = [
        "queued",
        "processed",
        "skipped",
        "errors",
        "fully_indexed",
        "fetched_records",
    ]
    parts = [f"{key}={outcome[key]}" for key in keys if key in outcome]
    return ", ".join(parts) if parts else "outcome=(recorded)"


def format_source(source_summary: dict[str, Any]) -> str:
    """Format non-empty source summary fields."""
    if not source_summary:
        return "source=(none)"
    parts = [
        f"{key}={value}"
        for key, value in source_summary.items()
        if value not in (None, "", [])
    ]
    return ", ".join(parts) if parts else "source=(none)"


def format_pacific_timestamp(value: str | None) -> str:
    """Format an ISO timestamp in Pacific time for CLI display."""
    if not value:
        return "unfinished"

    try:
        timestamp = value.replace("Z", "+00:00")
        parsed_datetime = datetime.fromisoformat(timestamp)
    except ValueError:
        return value

    if parsed_datetime.tzinfo is None:
        parsed_datetime = parsed_datetime.replace(tzinfo=UTC)

    pacific_datetime = parsed_datetime.astimezone(PACIFIC_TZ)
    hour = pacific_datetime.strftime("%I").lstrip("0") or "12"
    return (
        f"{pacific_datetime.month}/{pacific_datetime.day}/"
        f"{pacific_datetime:%y} {hour}:{pacific_datetime:%M:%S} "
        f"{pacific_datetime:%p} {pacific_datetime:%Z}"
    )


def print_records(records: list[dict[str, Any]]) -> None:
    """Print ingestion run records in a copyable format."""
    if not records:
        print("No ingestion runs found.")
        return

    for record in records:
        started_at = format_pacific_timestamp(record.get("started_at"))
        finished_at = format_pacific_timestamp(record.get("finished_at"))
        method = record.get("method", "unknown-method")
        status = record.get("status", "unknown-status")
        site = record.get("site", "unknown-site")
        index_name = get_record_index(record) or "unknown-index"
        library = get_record_library(record) or "unknown-library"
        print(f"{started_at} | {record.get('command', '')}")
        print(f"  status={status} | method={method} | finished={finished_at}")
        print(f"  site={site} | index={index_name} | library={library}")
        print(f"  {format_source(record.get('source_summary') or {})}")
        print(f"  {format_outcome(record.get('outcome') or {})}")


def parse_args() -> argparse.Namespace:
    """Parse CLI arguments."""
    parser = argparse.ArgumentParser(
        description="List manual ingestion runs from the local run ledger."
    )
    parser.add_argument("--site", help="Filter by site ID")
    parser.add_argument(
        "--method",
        choices=["sql_database", "media_queue", "media_process"],
        help="Filter by ingestion method",
    )
    parser.add_argument("--library", help="Filter by library name")
    parser.add_argument("--index", help="Filter by Pinecone index name")
    parser.add_argument("--status", help="Filter by run status")
    parser.add_argument(
        "--limit",
        type=int,
        default=20,
        help="Maximum runs to show after filtering (default: 20)",
    )
    parser.add_argument(
        "--log-path",
        type=Path,
        default=get_default_log_path(),
        help="Path to ingestion run JSONL log",
    )
    return parser.parse_args()


def main() -> None:
    """CLI entry point."""
    args = parse_args()
    events = load_ingestion_events(args.log_path)
    latest_records = latest_records_by_run(events)
    filtered_records = [
        record for record in latest_records if record_matches_filters(record, args)
    ]
    filtered_records.sort(
        key=lambda record: record.get("started_at", ""),
        reverse=True,
    )
    print_records(filtered_records[: args.limit])


if __name__ == "__main__":
    main()
