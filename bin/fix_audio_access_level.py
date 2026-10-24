#! /usr/bin/env python3

"""Set access fields on selected Pinecone audio records.

Some Treasures audio records are copies of Kriyaban-only talks. Those
records store access_level "public" and required_access_level 0. The
correct values are access_level "kriyaban" and required_access_level 200.

This script does not change vector values. It does not re-embed audio.
It updates only access_level and required_access_level.

Default mode is a dry run. Pass --apply to write. Pass --rollback to
restore old values from a JSONL backup. Pass --verify-only to read ids
from a backup or report and check the new values.

Usage (from repo root):
    uv run python bin/fix_audio_access_level.py --site ananda --keys-file FILE
    uv run python bin/fix_audio_access_level.py --site ananda --keys-file FILE --limit 1
    uv run python bin/fix_audio_access_level.py --site ananda --keys-file FILE --apply
    uv run python bin/fix_audio_access_level.py --site ananda --rollback FILE
    uv run python bin/fix_audio_access_level.py --site ananda --verify-only FILE
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[1]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from data_ingestion.audio_video.audio_access_level_fix import (  # noqa: E402
    AUDIO_ID_PREFIX,
    AUDIO_TYPE,
    DEFAULT_LIBRARY,
    REPORT_NAME,
    TARGET_ACCESS_LEVEL,
    TARGET_REQUIRED_ACCESS_LEVEL,
    AccessLevelFixError,
    AudioAccessRecord,
    VectorPlanRow,
    apply_file_limit,
    assert_out_dir_outside_repo,
    build_plan_rows,
    compare_live_plan_with_report,
    decode_vector_id,
    encode_vector_id,
    file_vector_counts,
    has_library_mismatch,
    load_id_rows,
    mask_secrets,
    new_backup_path,
    parse_keys,
    parse_required_access_level,
    plan_rows_from_report,
    read_jsonl,
    rollback_hint,
    sha256_file,
    summary_counts,
    update_rows,
    write_jsonl,
)

LIST_LIMIT = 100
FETCH_BATCH = 20
UPDATE_BATCH = 100
DEFAULT_PAUSE_SECONDS = 1.0
DEFAULT_OUT_DIR = Path.home() / "audio-access-level-fix"


def _assert_project_python() -> None:
    """Fail when the process is not the project Python 3.11."""
    if sys.version_info[:2] != (3, 11):
        venv_python = _REPO_ROOT / ".venv" / "bin" / "python"
        venv_cmd = (
            f"  {venv_python} bin/{Path(__file__).name} ...\n"
            if venv_python.is_file()
            else ""
        )
        raise SystemExit(
            "This script requires the project Python 3.11 environment.\n"
            f"Current interpreter: {sys.executable} ({sys.version.split()[0]})\n\n"
            "If a pyenv virtualenv is active, run `deactivate` first, then from repo root:\n"
            "  uv sync\n"
            f"  uv run python bin/{Path(__file__).name} --site <site>\n"
            f"{venv_cmd}"
        )


def fetch_metadata(index, ids: list[str]) -> dict[str, dict]:
    """Fetch metadata for vector ids. Encode spaces when needed."""
    encoded = [encode_vector_id(vector_id) for vector_id in ids]
    try:
        response = index.fetch(ids=encoded, include_values=False)
    except TypeError:
        response = index.fetch(ids=encoded)
    vectors = response.vectors if hasattr(response, "vectors") else response["vectors"]
    original = {encode_vector_id(vector_id): vector_id for vector_id in ids}
    found: dict[str, dict] = {}
    for key, vector in vectors.items():
        metadata = (
            vector.metadata if hasattr(vector, "metadata") else vector["metadata"]
        )
        vector_id = original.get(key, decode_vector_id(key))
        found[vector_id] = dict(metadata or {})
    return found


def list_audio_records(index) -> list[AudioAccessRecord]:
    """List audio vectors and read filename, library, and access fields."""
    vector_ids: list[str] = []
    for batch in index.list(prefix=AUDIO_ID_PREFIX, limit=LIST_LIMIT):
        vector_ids.extend(batch)
    records: list[AudioAccessRecord] = []
    for start in range(0, len(vector_ids), FETCH_BATCH):
        chunk = vector_ids[start : start + FETCH_BATCH]
        fetched = fetch_metadata(index, chunk)
        for vector_id, metadata in fetched.items():
            if str(metadata.get("type") or "") != AUDIO_TYPE:
                continue
            filename = str(metadata.get("filename") or "")
            if not filename:
                continue
            records.append(AudioAccessRecord.from_metadata(vector_id, metadata))
    return records


def print_summary(rows: list[VectorPlanRow], mode: str) -> None:
    """Print file count and vector count. Do not print text."""
    counts = summary_counts(rows)
    print(f"Mode: {mode}")
    print(f"Files: {counts['file_count']}")
    print(f"Vectors: {counts['vector_count']}")
    print(f"Already 200 files: {counts['already_200_files']}")
    print(f"Library mismatch files: {counts['library_mismatch_files']}")
    print(f"Missing files: {counts['missing_files']}")


def write_report(out_dir: Path, rows: list[VectorPlanRow]) -> Path:
    """Write one report line for every vector id."""
    path = out_dir / REPORT_NAME
    write_jsonl(path, [row.to_report_dict() for row in rows if row.vector_id])
    return path


def write_backup(path: Path, rows: list[VectorPlanRow]) -> Path:
    """Write old access fields for every vector that will change."""
    if path.exists():
        raise AccessLevelFixError("Refuse apply. Backup file already exists.")
    write_jsonl(path, [row.to_backup_dict() for row in update_rows(rows)])
    return path


def load_report_rows(report_path: Path) -> list[VectorPlanRow]:
    """Read the dry-run report. Refuse when the file is missing."""
    if not report_path.is_file():
        raise AccessLevelFixError(
            "Refuse apply. Dry-run report is missing. Run a dry run first."
        )
    return plan_rows_from_report(read_jsonl(report_path))


def update_access_fields(
    index,
    rows: list[VectorPlanRow],
    pause_seconds: float,
    sleep_fn: Callable[[float], None],
) -> int:
    """Set the two access fields. Use batches of 100 and a pause."""
    ids = [row.vector_id for row in update_rows(rows)]
    metadata = {
        "access_level": TARGET_ACCESS_LEVEL,
        "required_access_level": TARGET_REQUIRED_ACCESS_LEVEL,
    }
    for start in range(0, len(ids), UPDATE_BATCH):
        batch = ids[start : start + UPDATE_BATCH]
        for vector_id in batch:
            index.update(
                id=encode_vector_id(vector_id),
                set_metadata=metadata,
            )
        if start + UPDATE_BATCH < len(ids) and pause_seconds > 0:
            sleep_fn(pause_seconds)
    return len(ids)


def restore_access_fields(
    index,
    rows: list[VectorPlanRow],
    pause_seconds: float,
    sleep_fn: Callable[[float], None],
) -> int:
    """Restore old access fields from backup rows."""
    for start in range(0, len(rows), UPDATE_BATCH):
        batch = rows[start : start + UPDATE_BATCH]
        for row in batch:
            index.update(
                id=encode_vector_id(row.vector_id),
                set_metadata={
                    "access_level": row.old_access_level,
                    "required_access_level": row.old_required_access_level,
                },
            )
        if start + UPDATE_BATCH < len(rows) and pause_seconds > 0:
            sleep_fn(pause_seconds)
    return len(rows)


def values_match_target(metadata: dict) -> bool:
    """Return True when both access fields have the target values."""
    access = str(metadata.get("access_level") or "")
    required = parse_required_access_level(metadata.get("required_access_level"))
    return access == TARGET_ACCESS_LEVEL and required == TARGET_REQUIRED_ACCESS_LEVEL


def values_match_old(metadata: dict, row: VectorPlanRow) -> bool:
    """Return True when both access fields still have the old values."""
    access = str(metadata.get("access_level") or "")
    required = parse_required_access_level(metadata.get("required_access_level"))
    return access == row.old_access_level and required == row.old_required_access_level


def verify_new_values(index, rows: list[VectorPlanRow], backup_path: Path) -> None:
    """Fetch every changed id and check the new access fields."""
    ids = [row.vector_id for row in update_rows(rows)]
    fetched = fetch_metadata(index, ids)
    if len(fetched) != len(ids):
        print(rollback_hint(backup_path))
        raise AccessLevelFixError(
            f"Verify failed. Vector count changed. {rollback_hint(backup_path)}"
        )
    for vector_id in ids:
        metadata = fetched.get(vector_id) or {}
        if not values_match_target(metadata):
            print(rollback_hint(backup_path))
            raise AccessLevelFixError(
                f"Verify failed. New access fields do not match. "
                f"{rollback_hint(backup_path)}"
            )


def verify_restored_values(index, rows: list[VectorPlanRow]) -> None:
    """Fetch every restored id and check the old access fields."""
    ids = [row.vector_id for row in rows if row.vector_id]
    fetched = fetch_metadata(index, ids)
    if len(fetched) != len(ids):
        raise AccessLevelFixError("Verify failed. Vector count changed.")
    for row in rows:
        metadata = fetched.get(row.vector_id) or {}
        if not values_match_old(metadata, row):
            raise AccessLevelFixError("Verify failed. Rollback values do not match.")


def print_verify_only_result(still_old: int, ok: int, missing: int) -> None:
    """Print verify-only counts. Do not print text."""
    print("Mode: verify-only")
    print(f"Ids with new values: {ok}")
    print(f"Ids that still have the old values: {still_old}")
    print(f"Ids missing: {missing}")


def verify_only(index, path: Path) -> int:
    """Read ids from a backup or report and check the new access fields."""
    rows = [row for row in load_id_rows(path) if row.vector_id]
    fetched = fetch_metadata(index, [row.vector_id for row in rows])
    still_old = 0
    ok = 0
    missing = 0
    for row in rows:
        metadata = fetched.get(row.vector_id)
        if metadata is None:
            missing += 1
            continue
        if values_match_target(metadata):
            ok += 1
        elif values_match_old(metadata, row):
            still_old += 1
    print_verify_only_result(still_old, ok, missing)
    if ok != len(rows) or missing:
        raise AccessLevelFixError(
            "Verify-only failed. Some ids do not have the new values."
        )
    return 0


def load_selected_keys(keys_file: Path | None) -> list[str]:
    """Read the keys file. Refuse an empty list."""
    if keys_file is None:
        raise AccessLevelFixError("Refuse. --keys-file is required.")
    if not keys_file.is_file():
        raise AccessLevelFixError("Refuse. --keys-file is missing.")
    keys = parse_keys(keys_file.read_text(encoding="utf-8"))
    if not keys:
        raise AccessLevelFixError("Refuse. --keys-file has no filenames.")
    return keys


def build_live_rows(index, keys: list[str], library: str) -> list[VectorPlanRow]:
    """Build the live plan from all audio records, then the key list."""
    records = list_audio_records(index)
    return build_plan_rows(records, keys, library)


def run_dry_run(out_dir: Path, rows: list[VectorPlanRow]) -> int:
    """Write the report and print counts. Do not write Pinecone."""
    write_report(out_dir, rows)
    print_summary(rows, "dry-run")
    print("Dry run. No Pinecone writes.")
    if has_library_mismatch(rows):
        raise AccessLevelFixError("Refuse. A selected file has a different library.")
    return 0


def run_apply(
    index,
    out_dir: Path,
    full_rows: list[VectorPlanRow],
    limited_rows: list[VectorPlanRow],
    pause_seconds: float,
    sleep_fn: Callable[[float], None],
    now: datetime,
) -> int:
    """Compare the live plan with the report, write a new backup, then update."""
    if has_library_mismatch(full_rows):
        raise AccessLevelFixError("Refuse. A selected file has a different library.")
    report_rows = load_report_rows(out_dir / REPORT_NAME)
    apply_set = {row.filename for row in update_rows(limited_rows)}
    compare_live_plan_with_report(full_rows, report_rows, apply_set)
    if file_vector_counts(limited_rows) != {
        name: file_vector_counts(report_rows).get(name, 0) for name in apply_set
    }:
        raise AccessLevelFixError(
            "Refuse apply. Vector count does not match the dry-run report."
        )
    backup_path = new_backup_path(out_dir, now)
    write_backup(backup_path, limited_rows)
    print(f"Backup records: {len(update_rows(limited_rows))}")
    print(f"Backup SHA-256: {sha256_file(backup_path)}")
    updated = update_access_fields(index, limited_rows, pause_seconds, sleep_fn)
    verify_new_values(index, limited_rows, backup_path)
    print_summary(limited_rows, "apply")
    print(f"Updated vectors: {updated}")
    return 0


def run_rollback(
    index,
    backup_path: Path,
    pause_seconds: float,
    sleep_fn: Callable[[float], None],
) -> int:
    """Restore old access fields from a backup file."""
    rows = load_id_rows(backup_path)
    restored = restore_access_fields(index, rows, pause_seconds, sleep_fn)
    verify_restored_values(index, rows)
    print("Mode: rollback")
    print(f"Restored vectors: {restored}")
    return 0


def run(
    args: argparse.Namespace,
    index,
    *,
    repo_root: Path = _REPO_ROOT,
    pause_seconds: float = DEFAULT_PAUSE_SECONDS,
    sleep_fn: Callable[[float], None] = time.sleep,
    now: datetime | None = None,
) -> int:
    """Run dry-run, apply, rollback, or verify-only with an injected index."""
    mode_flags = [bool(args.apply), bool(args.rollback), bool(args.verify_only)]
    if sum(mode_flags) > 1:
        raise AccessLevelFixError(
            "Refuse. Do not combine --apply, --rollback, and --verify-only."
        )
    out_dir = assert_out_dir_outside_repo(Path(args.out_dir), repo_root)
    out_dir.mkdir(parents=True, exist_ok=True)
    clock = now or datetime.now(UTC)

    if args.rollback:
        return run_rollback(index, Path(args.rollback), pause_seconds, sleep_fn)
    if args.verify_only:
        return verify_only(index, Path(args.verify_only))

    keys = load_selected_keys(args.keys_file)
    full_rows = build_live_rows(index, keys, args.library)
    limited_rows = apply_file_limit(full_rows, args.limit if args.apply else None)

    if not args.apply:
        return run_dry_run(out_dir, full_rows)
    return run_apply(
        index,
        out_dir,
        full_rows,
        limited_rows,
        pause_seconds,
        sleep_fn,
        clock,
    )


def build_argument_parser() -> argparse.ArgumentParser:
    """Build the command-line parser. Default mode is dry run."""
    parser = argparse.ArgumentParser(
        description=(
            "Set Pinecone audio access_level to kriyaban and "
            "required_access_level to 200. Default mode is a dry run."
        )
    )
    parser.add_argument(
        "--site",
        required=True,
        help="Site id for the environment file.",
    )
    parser.add_argument(
        "--keys-file",
        type=Path,
        help="Text file of Pinecone filename values. One value per line. Off-repo.",
    )
    parser.add_argument(
        "--library",
        default=DEFAULT_LIBRARY,
        help=f"Library name to select. Default: {DEFAULT_LIBRARY}.",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Write access field updates. Default is dry run.",
    )
    parser.add_argument(
        "--rollback",
        metavar="BACKUP",
        help="Restore access fields from a JSONL backup file.",
    )
    parser.add_argument(
        "--verify-only",
        metavar="FILE",
        help="Read ids from a backup or report and check the new values.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        metavar="N",
        help="Update only the first N files. Use this for a canary.",
    )
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=DEFAULT_OUT_DIR,
        help=(
            "Directory for the report and backup. "
            f"Default: {DEFAULT_OUT_DIR}. Must stay outside the repository."
        ),
    )
    parser.add_argument("--index-name", help="Override PINECONE_INDEX_NAME.")
    return parser


def get_index(index_name: str | None):
    """Return the live Pinecone index. Tests inject a fake index instead."""
    from pinecone import Pinecone

    api_key = os.getenv("PINECONE_API_KEY")
    name = index_name or os.getenv("PINECONE_INDEX_NAME")
    if not api_key:
        raise AccessLevelFixError("PINECONE_API_KEY is not set.")
    if not name:
        raise AccessLevelFixError("PINECONE_INDEX_NAME is not set.")
    return Pinecone(api_key=api_key).Index(name)


def main(argv: list[str] | None = None) -> int:
    """Parse arguments, load the site, and run the selected mode."""
    _assert_project_python()
    parser = build_argument_parser()
    args = parser.parse_args(argv)
    try:
        from pyutil.env_utils import load_env

        load_env(args.site)
        index = get_index(args.index_name)
        return run(args, index)
    except AccessLevelFixError as exc:
        print(mask_secrets(str(exc)), file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001
        print(mask_secrets(f"Error: {exc}"), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
