#! /usr/bin/env python3

"""Repoint Pinecone audio metadata.filename to a live S3 key.

Pinecone stores metadata.filename as the S3 key without public/audio/.
This script does not change vector ids. It does not re-embed audio.
Default mode is a dry run. Pass --apply to write. Pass --rollback to
restore filenames from a JSONL backup.

Do not run this script until the ingest PR is merged and Michael says yes.

Usage (from repo root):
    uv run python bin/fix_audio_filenames.py --site ananda
    uv run python bin/fix_audio_filenames.py --site ananda --limit 1
    uv run python bin/fix_audio_filenames.py --site ananda --apply
    uv run python bin/fix_audio_filenames.py --site ananda --rollback FILE
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
from collections import Counter, defaultdict
from collections.abc import Iterable
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from botocore.exceptions import ClientError
from pinecone import Pinecone

from data_ingestion.audio_video.audio_filename_fix import (
    find_old_copy_key,
    pick_target,
)
from data_ingestion.utils.s3_utils import (
    get_bucket_name,
    get_s3_client,
    list_s3_object_keys,
)
from pyutil.env_utils import load_env

_REPO_ROOT = Path(__file__).resolve().parents[1]


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


_assert_project_python()

AUDIO_ID_PREFIX = "audio||"
AUDIO_S3_PREFIX = "public/audio/"
LIST_LIMIT = 100
FETCH_BATCH = 20
FETCH_WORKERS = 8
FETCH_RETRIES = 3
FETCH_BACKOFF_SEC = 0.2
UPDATE_BATCH = 100
VERIFY_INTERVAL_SEC = 5
VERIFY_LIMIT_SEC = 120
SAMPLE_LIMIT = 3
REPORT_NAME = "filename-fix-report.jsonl"
BACKUP_PREFIX = "filename-fix-backup-"
DEFAULT_OUT_DIR = Path.home() / "audio-filename-fix"
APPLYABLE_RESULTS = frozenset({"ok", "no_old_copy"})

_SECRET_PATTERNS = (
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(
        r"(?i)(aws_?secret_?access_?key|aws_?access_?key_?id|"
        r"pinecone[_-]?api[_-]?key|secret[_-]?key|api[_-]?key)"
        r"\s*[=:]\s*\S+"
    ),
)


class FilenameFixError(Exception):
    """Stop the run. The message is safe to print."""


@dataclass
class AudioRecord:
    """One Pinecone audio vector used by the fix script."""

    vector_id: str
    filename: str
    library: str
    title: str


@dataclass
class RemapRow:
    """One dry-run or apply decision for an old filename."""

    old_key: str
    new_key: str | None
    rule: str
    result: str
    vector_count: int
    vector_ids: list[str] = field(default_factory=list)
    s3_size: int | None = None
    old_copy_size: int | None = None

    def to_report(self) -> dict:
        """Return the public report fields. Vector ids stay out of the file."""
        return {
            "old_key": self.old_key,
            "new_key": self.new_key,
            "rule": self.rule,
            "result": self.result,
            "vector_count": self.vector_count,
            "s3_size": self.s3_size,
            "old_copy_size": self.old_copy_size,
        }


def is_applyable(row: RemapRow) -> bool:
    """Return True when apply may write this row."""
    return row.result in APPLYABLE_RESULTS and bool(row.new_key)


def is_applyable_result(result: str | None) -> bool:
    """Return True when a report result is allowed to apply."""
    return result in APPLYABLE_RESULTS


def mask_secrets(text: str) -> str:
    """Replace credential-like strings before print."""
    masked = text
    for pattern in _SECRET_PATTERNS:
        masked = pattern.sub("[secret]", masked)
    return masked


def default_out_dir() -> Path:
    """Return the default output directory. It is outside the repository."""
    return DEFAULT_OUT_DIR


def assert_out_dir_outside_repo(out_dir: Path, repo_root: Path = _REPO_ROOT) -> Path:
    """Refuse an output path that would write data into this public repo."""
    resolved = out_dir.expanduser().resolve()
    repo = repo_root.resolve()
    if resolved == repo or repo in resolved.parents:
        raise FilenameFixError("Refuse. --out-dir must be outside the repository.")
    return resolved


def call_index_fetch(index, ids: list[str]):
    """Call index.fetch with raw vector ids."""
    try:
        return index.fetch(ids=ids, include_values=False)
    except TypeError:
        return index.fetch(ids=ids)


def metadata_from_fetch(response) -> dict[str, dict]:
    """Read metadata from a fetch response. Keep the raw ids."""
    vectors = response.vectors if hasattr(response, "vectors") else response["vectors"]
    found: dict[str, dict] = {}
    for key, vector in vectors.items():
        metadata = (
            vector.metadata if hasattr(vector, "metadata") else vector["metadata"]
        )
        found[key] = dict(metadata or {})
    return found


def fetch_metadata(index, ids: list[str]) -> dict[str, dict]:
    """Fetch metadata for raw vector ids."""
    return metadata_from_fetch(call_index_fetch(index, ids))


def fetch_metadata_with_retry(
    index, ids: list[str], sleep=time.sleep
) -> dict[str, dict]:
    """Fetch one batch. Retry a failed batch up to three times."""
    last_error: Exception | None = None
    for attempt in range(FETCH_RETRIES):
        try:
            return fetch_metadata(index, ids)
        except FilenameFixError:
            raise
        except Exception as exc:
            last_error = exc
            if attempt < FETCH_RETRIES - 1:
                sleep(FETCH_BACKOFF_SEC)
    raise FilenameFixError(
        f"Fetch failed after {FETCH_RETRIES} tries."
    ) from last_error


def fetch_all_metadata(
    index, vector_ids: list[str], sleep=time.sleep
) -> dict[str, dict]:
    """Fetch all ids in parallel. Return metadata in the input id order."""
    if not vector_ids:
        return {}
    batches = [
        vector_ids[start : start + FETCH_BATCH]
        for start in range(0, len(vector_ids), FETCH_BATCH)
    ]
    batch_results: list[dict[str, dict]] = [{} for _ in batches]
    with ThreadPoolExecutor(max_workers=FETCH_WORKERS) as pool:
        futures = {
            pool.submit(fetch_metadata_with_retry, index, batch, sleep): index_number
            for index_number, batch in enumerate(batches)
        }
        for future in as_completed(futures):
            batch_results[futures[future]] = future.result()
    combined: dict[str, dict] = {}
    for batch in batch_results:
        combined.update(batch)
    return {
        vector_id: combined[vector_id]
        for vector_id in vector_ids
        if vector_id in combined
    }


def records_from_metadata(
    vector_ids: list[str], fetched: dict[str, dict]
) -> list[AudioRecord]:
    """Build audio records in the same order as vector_ids."""
    records: list[AudioRecord] = []
    for vector_id in vector_ids:
        metadata = fetched.get(vector_id)
        if not metadata:
            continue
        if str(metadata.get("type") or "") != "audio":
            continue
        filename = str(metadata.get("filename") or "")
        if not filename:
            continue
        records.append(
            AudioRecord(
                vector_id=vector_id,
                filename=filename,
                library=str(metadata.get("library") or ""),
                title=str(metadata.get("title") or ""),
            )
        )
    return records


def list_audio_records(index) -> list[AudioRecord]:
    """List audio vectors and read filename, library, and title."""
    vector_ids: list[str] = []
    for batch in index.list(prefix=AUDIO_ID_PREFIX, limit=LIST_LIMIT):
        vector_ids.extend(batch)
    fetched = fetch_all_metadata(index, vector_ids)
    return records_from_metadata(vector_ids, fetched)


def strip_audio_prefix(key: str) -> str:
    """Drop public/audio/ from a live S3 key."""
    if key.startswith(AUDIO_S3_PREFIX):
        return key[len(AUDIO_S3_PREFIX) :]
    return key


def list_live_s3_keys(s3_client, bucket: str) -> list[str]:
    """List live object keys under public/audio/. Return relative keys."""
    keys = list_s3_object_keys(AUDIO_S3_PREFIX, s3_client=s3_client, bucket_name=bucket)
    relative = []
    for key in keys:
        rel = strip_audio_prefix(key)
        if rel:
            relative.append(rel)
    return relative


def used_keys_from_records(
    records: list[AudioRecord], s3_keys: Iterable[str]
) -> set[str]:
    """Return live filenames that any audio record already uses."""
    s3_set = set(s3_keys)
    return {record.filename for record in records if record.filename in s3_set}


def collect_candidate_rows(
    records: list[AudioRecord],
    s3_keys: list[str],
    used_keys: Iterable[str],
) -> list[RemapRow]:
    """Pick a target for each missing filename. Do not assign first-wins."""
    filename_to_ids: dict[str, list[str]] = defaultdict(list)
    for record in records:
        filename_to_ids[record.filename].append(record.vector_id)
    s3_set = set(s3_keys)
    used = set(used_keys)
    rows: list[RemapRow] = []
    for old_key, vector_ids in sorted(filename_to_ids.items()):
        if old_key in s3_set:
            continue
        new_key, rule = pick_target(old_key, s3_keys, used)
        result = "ok" if new_key else "skip"
        rows.append(
            RemapRow(
                old_key=old_key,
                new_key=new_key,
                rule=rule,
                result=result,
                vector_count=len(vector_ids),
                vector_ids=list(vector_ids),
            )
        )
    return rows


def mark_collisions(rows: list[RemapRow]) -> list[RemapRow]:
    """Skip every row that shares a target with another row."""
    target_counts = Counter(row.new_key for row in rows if row.new_key)
    for row in rows:
        if row.new_key and target_counts[row.new_key] > 1:
            row.rule = "collision"
            row.result = "skip"
    return rows


def build_remap_rows(
    records: list[AudioRecord],
    s3_keys: list[str],
    used_keys: Iterable[str] | None = None,
) -> list[RemapRow]:
    """Build remap rows for filenames that are missing from S3."""
    if used_keys is None:
        used_keys = used_keys_from_records(records, s3_keys)
    return mark_collisions(collect_candidate_rows(records, s3_keys, used_keys))


def head_size(s3_client, bucket: str, relative_key: str) -> int | None:
    """HEAD one key. Return None when the object is missing."""
    full_key = f"{AUDIO_S3_PREFIX}{relative_key}"
    try:
        response = s3_client.head_object(Bucket=bucket, Key=full_key)
    except ClientError as exc:
        code = str(exc.response.get("Error", {}).get("Code", ""))
        if code in {"404", "NoSuchKey", "NotFound"}:
            return None
        raise FilenameFixError(mask_secrets(str(exc))) from exc
    return int(response["ContentLength"])


def head_new_key(s3_client, bucket: str, relative_key: str) -> int:
    """HEAD a new key. Stop when the object is missing."""
    size = head_size(s3_client, bucket, relative_key)
    if size is None:
        raise FilenameFixError(f"New key is missing in S3: {relative_key}")
    return size


def apply_size_check(s3_client, bucket: str, row: RemapRow, s3_keys: list[str]) -> None:
    """Compare the new key size with the ignore or set-aside copy."""
    if not row.new_key:
        return
    row.s3_size = head_new_key(s3_client, bucket, row.new_key)
    old_copy = find_old_copy_key(row.old_key, s3_keys)
    if old_copy is None:
        row.result = "no_old_copy"
        return
    row.old_copy_size = head_size(s3_client, bucket, old_copy)
    if row.old_copy_size is None:
        row.result = "no_old_copy"
        return
    if row.old_copy_size != row.s3_size:
        row.result = "size_mismatch"


def attach_s3_sizes(
    s3_client, bucket: str, rows: list[RemapRow], s3_keys: list[str]
) -> None:
    """HEAD new keys and old copies. Stop on a missing new key."""
    for row in rows:
        if row.result != "ok" or not row.new_key:
            continue
        apply_size_check(s3_client, bucket, row, s3_keys)


def read_line_items(path: Path) -> tuple[set[str], set[str]]:
    """Read vector ids and old keys from a text file."""
    vector_ids: set[str] = set()
    old_keys: set[str] = set()
    for raw in path.read_text(encoding="utf-8").splitlines():
        item = raw.strip()
        if not item or item.startswith("#"):
            continue
        if item.startswith(AUDIO_ID_PREFIX):
            vector_ids.add(item)
        else:
            old_keys.add(item)
    return vector_ids, old_keys


def filter_records(
    records: list[AudioRecord],
    only_old_key: str | None,
    ids_file: Path | None,
) -> list[AudioRecord]:
    """Limit records to one old key or to ids from a file."""
    selected = records
    file_ids: set[str] = set()
    file_keys: set[str] = set()
    if ids_file is not None:
        file_ids, file_keys = read_line_items(ids_file)
    if only_old_key:
        file_keys.add(only_old_key)
    if file_ids:
        selected = [record for record in selected if record.vector_id in file_ids]
    if file_keys:
        selected = [record for record in selected if record.filename in file_keys]
    return selected


def apply_limit(rows: list[RemapRow], limit: int | None) -> list[RemapRow]:
    """Keep skip rows. Keep only the first N successful remaps."""
    if limit is None:
        return rows
    kept: list[RemapRow] = []
    ok_seen = 0
    for row in rows:
        if is_applyable(row):
            if ok_seen >= limit:
                continue
            ok_seen += 1
        kept.append(row)
    return kept


def write_jsonl(path: Path, rows: list[dict]) -> None:
    """Write one JSON object per line."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=True) + "\n")


def write_report(out_dir: Path, rows: list[RemapRow]) -> Path:
    """Write the dry-run report to the output directory."""
    path = out_dir / REPORT_NAME
    write_jsonl(path, [row.to_report() for row in rows])
    return path


def new_backup_path(out_dir: Path, now: datetime | None = None) -> Path:
    """Return a new backup path. Refuse to overwrite an existing file."""
    stamp = (now or datetime.now(UTC)).strftime("%Y%m%dT%H%M%S%fZ")
    path = out_dir / f"{BACKUP_PREFIX}{stamp}.jsonl"
    if not path.exists():
        return path
    suffix = 1
    while True:
        path = out_dir / f"{BACKUP_PREFIX}{stamp}-{suffix}.jsonl"
        if not path.exists():
            return path
        suffix += 1


def list_backup_files(out_dir: Path) -> list[Path]:
    """Return backup files in the output directory."""
    return sorted(out_dir.glob(f"{BACKUP_PREFIX}*.jsonl"))


def write_backup(
    out_dir: Path,
    records: list[AudioRecord],
    now: datetime | None = None,
) -> Path:
    """Write old metadata for every vector that will change."""
    path = new_backup_path(out_dir, now=now)
    if path.exists():
        raise FilenameFixError(f"Refuse. Backup file already exists: {path}")
    write_jsonl(
        path,
        [
            {
                "id": record.vector_id,
                "filename": record.filename,
                "library": record.library,
                "title": record.title,
            }
            for record in records
        ],
    )
    return path


def sha256_file(path: Path) -> str:
    """Return the SHA-256 hex digest of a file."""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_report(report_path: Path) -> list[dict]:
    """Read the dry-run report. Stop when the file is missing."""
    if not report_path.is_file():
        raise FilenameFixError(
            "Refuse apply. Dry-run report is missing. Run a dry run first."
        )
    rows: list[dict] = []
    with report_path.open(encoding="utf-8") as handle:
        for line in handle:
            text = line.strip()
            if not text:
                continue
            rows.append(json.loads(text))
    return rows


def load_report_counts(report_path: Path) -> dict[str, int]:
    """Read vector counts for successful remaps from a dry-run report."""
    counts: dict[str, int] = {}
    for row in load_report(report_path):
        if is_applyable_result(row.get("result")):
            counts[str(row["old_key"])] = int(row["vector_count"])
    return counts


def load_report_pairs(report_path: Path) -> dict[str, str | None]:
    """Read approved old_key to new_key pairs from a dry-run report."""
    pairs: dict[str, str | None] = {}
    for row in load_report(report_path):
        if is_applyable_result(row.get("result")):
            new_key = row.get("new_key")
            pairs[str(row["old_key"])] = str(new_key) if new_key else None
    return pairs


def assert_pairs_match(
    rows: list[RemapRow], approved_pairs: dict[str, str | None]
) -> None:
    """Stop apply when a live new_key differs from the dry-run report."""
    for row in rows:
        if not is_applyable(row):
            continue
        if row.old_key not in approved_pairs:
            raise FilenameFixError(
                f"Refuse apply. Dry-run report does not cover {row.old_key}."
            )
        if row.new_key != approved_pairs[row.old_key]:
            raise FilenameFixError(
                f"Refuse apply. New key for {row.old_key} does not match the dry-run report."
            )


def live_counts_for_keys(
    records: list[AudioRecord], keys: Iterable[str]
) -> dict[str, int]:
    """Count live vectors for each requested old key."""
    wanted = set(keys)
    counts = Counter(record.filename for record in records if record.filename in wanted)
    return {key: counts.get(key, 0) for key in keys}


def assert_counts_match(
    report_counts: dict[str, int], live_counts: dict[str, int]
) -> None:
    """Stop apply when live counts differ from the dry-run report."""
    if report_counts != live_counts:
        raise FilenameFixError(
            "Refuse apply. Vector count does not match the dry-run report."
        )


def update_filenames(index, vector_ids: list[str], new_key: str) -> int:
    """Set filename on every vector id. Use batches of 100."""
    for start in range(0, len(vector_ids), UPDATE_BATCH):
        batch = vector_ids[start : start + UPDATE_BATCH]
        for vector_id in batch:
            index.update(
                id=vector_id,
                set_metadata={"filename": new_key},
            )
    return len(vector_ids)


def verify_filenames(
    index,
    vector_ids: list[str],
    expected: str,
    interval: float = VERIFY_INTERVAL_SEC,
    limit: float = VERIFY_LIMIT_SEC,
    sleep=time.sleep,
) -> None:
    """Re-fetch vectors and confirm filename and count.

    Pinecone fetch can lag after an update. Poll until all ids show the
    expected filename, or until the time limit. A change in vector count
    fails at once.
    """
    waited = 0
    while True:
        fetched = fetch_metadata(index, vector_ids)
        if len(fetched) != len(vector_ids):
            raise FilenameFixError("Verify failed. Vector count changed.")
        matched = True
        for vector_id in vector_ids:
            metadata = fetched.get(vector_id)
            if not metadata or metadata.get("filename") != expected:
                matched = False
                break
        if matched:
            print(f"Verify matched after {waited} seconds.")
            return
        if waited >= limit:
            raise FilenameFixError(
                "Verify failed. Filename does not match. "
                f"Waited {waited} seconds."
            )
        sleep(interval)
        waited += interval


def apply_remap(
    index,
    rows: list[RemapRow],
    records: list[AudioRecord],
    backup_path: Path | None,
    interval: float = VERIFY_INTERVAL_SEC,
    limit: float = VERIFY_LIMIT_SEC,
    sleep=time.sleep,
) -> int:
    """Update every vector of each remapped file. Require a backup file."""
    if backup_path is None or not Path(backup_path).is_file():
        raise FilenameFixError("Refuse apply. Backup file is missing.")
    by_filename: dict[str, list[AudioRecord]] = defaultdict(list)
    for record in records:
        by_filename[record.filename].append(record)
    updated = 0
    try:
        for row in rows:
            if not is_applyable(row) or not row.new_key:
                continue
            file_records = by_filename.get(row.old_key, [])
            ids = [record.vector_id for record in file_records]
            updated += update_filenames(index, ids, row.new_key)
            try:
                verify_filenames(
                    index,
                    ids,
                    row.new_key,
                    interval=interval,
                    limit=limit,
                    sleep=sleep,
                )
                if len(ids) != row.vector_count:
                    raise FilenameFixError("Verify failed. Vector count changed.")
            except FilenameFixError as exc:
                raise FilenameFixError(
                    f"{exc} Run --rollback with {backup_path}."
                ) from exc
    except FilenameFixError:
        raise
    except Exception as exc:
        raise FilenameFixError(
            f"Apply stopped. {mask_secrets(str(exc))}. "
            f"Run --rollback with {backup_path}."
        ) from exc
    return updated


def read_backup(backup_path: Path) -> list[AudioRecord]:
    """Read backup records from JSONL."""
    if not backup_path.is_file():
        raise FilenameFixError("Refuse rollback. Backup file is missing.")
    records: list[AudioRecord] = []
    with backup_path.open(encoding="utf-8") as handle:
        for line in handle:
            text = line.strip()
            if not text:
                continue
            row = json.loads(text)
            records.append(
                AudioRecord(
                    vector_id=str(row["id"]),
                    filename=str(row["filename"]),
                    library=str(row.get("library") or ""),
                    title=str(row.get("title") or ""),
                )
            )
    return records


def rollback_from_backup(
    index,
    backup_path: Path,
    interval: float = VERIFY_INTERVAL_SEC,
    limit: float = VERIFY_LIMIT_SEC,
    sleep=time.sleep,
) -> int:
    """Set filename back from a backup file."""
    records = read_backup(backup_path)
    ids = [record.vector_id for record in records]
    for start in range(0, len(records), UPDATE_BATCH):
        batch = records[start : start + UPDATE_BATCH]
        for record in batch:
            index.update(
                id=record.vector_id,
                set_metadata={"filename": record.filename},
            )
    by_name: dict[str, list[str]] = defaultdict(list)
    for record in records:
        by_name[record.filename].append(record.vector_id)
    for filename, file_ids in by_name.items():
        verify_filenames(
            index,
            file_ids,
            filename,
            interval=interval,
            limit=limit,
            sleep=sleep,
        )
    print(f"Rollback vectors: {len(records)}")
    for record in records[:SAMPLE_LIMIT]:
        print(f"  {record.filename}")
    if len(ids) > SAMPLE_LIMIT:
        print(f"  ... and {len(ids) - SAMPLE_LIMIT} more")
    return len(records)


def print_named_rows(label: str, rows: list[RemapRow]) -> None:
    """Print a short named list. Show only a few keys."""
    if not rows:
        return
    print(f"{label}: {len(rows)}")
    for row in rows[:SAMPLE_LIMIT]:
        print(f"  {row.old_key}")
    extra = len(rows) - SAMPLE_LIMIT
    if extra > 0:
        print(f"  ... and {extra} more")


def print_summary(rows: list[RemapRow], mode: str) -> None:
    """Print counts and a few names. Do not print credentials."""
    apply_rows = [row for row in rows if is_applyable(row)]
    skip_rows = [row for row in rows if not is_applyable(row)]
    print(f"Mode: {mode}")
    print(f"Remap files: {len(apply_rows)}")
    print(f"Skip files: {len(skip_rows)}")
    print(f"Remap vectors: {sum(row.vector_count for row in apply_rows)}")
    for row in apply_rows[:SAMPLE_LIMIT]:
        print(f"  {row.old_key} -> {row.new_key} ({row.rule})")
    extra = len(apply_rows) - SAMPLE_LIMIT
    if extra > 0:
        print(f"  ... and {extra} more")
    print_named_rows(
        "Size mismatch files",
        [row for row in rows if row.result == "size_mismatch"],
    )
    print_named_rows(
        "No old copy files",
        [row for row in rows if row.result == "no_old_copy"],
    )


def get_index(pc: Pinecone, index_name: str | None = None):
    """Return the live Pinecone index."""
    name = index_name or os.getenv("PINECONE_INDEX_NAME")
    if not name:
        raise FilenameFixError("PINECONE_INDEX_NAME is not set.")
    return pc.Index(name)


def build_argument_parser() -> argparse.ArgumentParser:
    """Build the command-line parser. Default mode is dry run."""
    parser = argparse.ArgumentParser(
        description=(
            "Repoint Pinecone audio filename metadata to a live S3 key. "
            "Default mode is a dry run."
        )
    )
    parser.add_argument(
        "--site",
        required=True,
        help="Site id for the environment file.",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Write filename updates. Default is dry run.",
    )
    parser.add_argument(
        "--rollback",
        metavar="BACKUP",
        help="Restore filename values from a JSONL backup file.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        metavar="N",
        help="Process only the first N successful remaps. Use this for a canary.",
    )
    parser.add_argument(
        "--ids-file",
        type=Path,
        help="Text file of vector ids or old keys. One item per line.",
    )
    parser.add_argument(
        "--only-old-key",
        help="Process one old filename. Example: treasures/Talk A.mp3",
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


def run(
    args: argparse.Namespace,
    index,
    s3_client,
    bucket: str,
) -> int:
    """Run dry-run, apply, or rollback with injected clients."""
    if args.apply and args.rollback:
        raise FilenameFixError("Refuse. Do not combine --apply and --rollback.")
    out_dir = assert_out_dir_outside_repo(Path(args.out_dir))
    out_dir.mkdir(parents=True, exist_ok=True)

    if args.rollback:
        return rollback_from_backup(index, Path(args.rollback))

    all_records = list_audio_records(index)
    s3_keys = list_live_s3_keys(s3_client, bucket)
    used_keys = used_keys_from_records(all_records, s3_keys)
    records = filter_records(all_records, args.only_old_key, args.ids_file)
    rows = build_remap_rows(records, s3_keys, used_keys=used_keys)
    attach_s3_sizes(s3_client, bucket, rows, s3_keys)
    rows = apply_limit(rows, args.limit)

    if not args.apply:
        report_path = write_report(out_dir, rows)
        print(f"Report SHA-256: {sha256_file(report_path)}")
        print_summary(rows, "dry-run")
        print("Dry run. No Pinecone writes.")
        return 0

    report_path = out_dir / REPORT_NAME
    report_counts = load_report_counts(report_path)
    approved_pairs = load_report_pairs(report_path)
    assert_pairs_match(rows, approved_pairs)
    ok_keys = {row.old_key for row in rows if is_applyable(row)}
    compare_counts = {
        key: report_counts[key] for key in ok_keys if key in report_counts
    }
    if set(compare_counts) != ok_keys:
        raise FilenameFixError(
            "Refuse apply. Dry-run report does not cover the selected files."
        )
    assert_counts_match(compare_counts, live_counts_for_keys(records, ok_keys))

    backup_records = [record for record in records if record.filename in ok_keys]
    backup_path = write_backup(out_dir, backup_records)
    print(f"Backup path: {backup_path}")
    print(f"Backup records: {len(backup_records)}")
    print(f"Backup SHA-256: {sha256_file(backup_path)}")
    if not backup_path.is_file() or backup_path.stat().st_size == 0:
        raise FilenameFixError("Refuse apply. Backup file is missing.")

    updated = apply_remap(index, rows, records, backup_path)
    print_summary(rows, "apply")
    print(f"Updated vectors: {updated}")
    return updated


def main(argv: list[str] | None = None) -> int:
    """Parse arguments, load the site, and run the selected mode."""
    parser = build_argument_parser()
    args = parser.parse_args(argv)
    try:
        load_env(args.site)
        pc = Pinecone(api_key=os.getenv("PINECONE_API_KEY"))
        index = get_index(pc, args.index_name)
        s3_client = get_s3_client()
        bucket = get_bucket_name()
        if not bucket:
            raise FilenameFixError("S3_BUCKET_NAME is not set.")
        return run(args, index, s3_client, bucket)
    except FilenameFixError as exc:
        print(mask_secrets(str(exc)), file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001
        print(mask_secrets(f"Error: {exc}"), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
