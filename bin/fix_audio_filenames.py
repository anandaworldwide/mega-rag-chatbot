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
from collections import Counter, defaultdict
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import quote, unquote

from botocore.exceptions import ClientError
from pinecone import Pinecone

from data_ingestion.audio_video.audio_filename_fix import pick_target
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
UPDATE_BATCH = 100
SAMPLE_LIMIT = 3
REPORT_NAME = "filename-fix-report.jsonl"
BACKUP_NAME = "filename-fix-backup.jsonl"
DEFAULT_OUT_DIR = Path.home() / "audio-filename-fix"

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

    def to_report(self) -> dict:
        """Return the public report fields. Vector ids stay out of the file."""
        return {
            "old_key": self.old_key,
            "new_key": self.new_key,
            "rule": self.rule,
            "result": self.result,
            "vector_count": self.vector_count,
            "s3_size": self.s3_size,
        }


def mask_secrets(text: str) -> str:
    """Replace credential-like strings before print."""
    masked = text
    for pattern in _SECRET_PATTERNS:
        masked = pattern.sub("[secret]", masked)
    return masked


def encode_vector_id(vector_id: str) -> str:
    """Percent-encode spaces in a vector id. Leave other characters."""
    if " " not in vector_id:
        return vector_id
    return quote(vector_id, safe="|")


def decode_vector_id(vector_id: str) -> str:
    """Undo percent-encoding when a fetch key comes back encoded."""
    if "%" not in vector_id:
        return vector_id
    return unquote(vector_id)


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


def list_audio_records(index) -> list[AudioRecord]:
    """List audio vectors and read filename, library, and title."""
    vector_ids: list[str] = []
    for batch in index.list(prefix=AUDIO_ID_PREFIX, limit=LIST_LIMIT):
        vector_ids.extend(batch)
    records: list[AudioRecord] = []
    for start in range(0, len(vector_ids), FETCH_BATCH):
        chunk = vector_ids[start : start + FETCH_BATCH]
        fetched = fetch_metadata(index, chunk)
        for vector_id, metadata in fetched.items():
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


def build_remap_rows(records: list[AudioRecord], s3_keys: list[str]) -> list[RemapRow]:
    """Build remap rows for filenames that are missing from S3."""
    filename_to_ids: dict[str, list[str]] = defaultdict(list)
    for record in records:
        filename_to_ids[record.filename].append(record.vector_id)
    s3_set = set(s3_keys)
    used_keys = {name for name in filename_to_ids if name in s3_set}
    rows: list[RemapRow] = []
    for old_key, vector_ids in sorted(filename_to_ids.items()):
        if old_key in s3_set:
            continue
        new_key, rule = pick_target(old_key, s3_keys, used_keys)
        result = "ok" if new_key else "skip"
        if new_key:
            used_keys.add(new_key)
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


def head_new_key(s3_client, bucket: str, relative_key: str) -> int:
    """HEAD a new key. Stop when the object is missing."""
    full_key = f"{AUDIO_S3_PREFIX}{relative_key}"
    try:
        response = s3_client.head_object(Bucket=bucket, Key=full_key)
    except ClientError as exc:
        code = str(exc.response.get("Error", {}).get("Code", ""))
        if code in {"404", "NoSuchKey", "NotFound"}:
            raise FilenameFixError(f"New key is missing in S3: {relative_key}") from exc
        raise FilenameFixError(mask_secrets(str(exc))) from exc
    return int(response["ContentLength"])


def attach_s3_sizes(s3_client, bucket: str, rows: list[RemapRow]) -> None:
    """HEAD every new key. Record the size. Stop on a missing key."""
    for row in rows:
        if not row.new_key:
            continue
        row.s3_size = head_new_key(s3_client, bucket, row.new_key)


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
        if row.result == "ok":
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


def write_backup(out_dir: Path, records: list[AudioRecord]) -> Path:
    """Write old metadata for every vector that will change."""
    path = out_dir / BACKUP_NAME
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


def load_report_counts(report_path: Path) -> dict[str, int]:
    """Read vector counts for successful remaps from a dry-run report."""
    if not report_path.is_file():
        raise FilenameFixError(
            "Refuse apply. Dry-run report is missing. Run a dry run first."
        )
    counts: dict[str, int] = {}
    with report_path.open(encoding="utf-8") as handle:
        for line in handle:
            text = line.strip()
            if not text:
                continue
            row = json.loads(text)
            if row.get("result") == "ok":
                counts[str(row["old_key"])] = int(row["vector_count"])
    return counts


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
                id=encode_vector_id(vector_id),
                set_metadata={"filename": new_key},
            )
    return len(vector_ids)


def verify_filenames(index, vector_ids: list[str], expected: str) -> None:
    """Re-fetch vectors and confirm filename and count."""
    fetched = fetch_metadata(index, vector_ids)
    if len(fetched) != len(vector_ids):
        raise FilenameFixError("Verify failed. Vector count changed.")
    for vector_id in vector_ids:
        metadata = fetched.get(vector_id)
        if not metadata or metadata.get("filename") != expected:
            raise FilenameFixError("Verify failed. Filename does not match.")


def apply_remap(
    index,
    rows: list[RemapRow],
    records: list[AudioRecord],
    backup_path: Path | None,
) -> int:
    """Update every vector of each remapped file. Require a backup file."""
    if backup_path is None or not Path(backup_path).is_file():
        raise FilenameFixError("Refuse apply. Backup file is missing.")
    by_filename: dict[str, list[AudioRecord]] = defaultdict(list)
    for record in records:
        by_filename[record.filename].append(record)
    updated = 0
    for row in rows:
        if row.result != "ok" or not row.new_key:
            continue
        file_records = by_filename.get(row.old_key, [])
        ids = [record.vector_id for record in file_records]
        updated += update_filenames(index, ids, row.new_key)
        verify_filenames(index, ids, row.new_key)
        if len(ids) != row.vector_count:
            raise FilenameFixError("Verify failed. Vector count changed.")
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


def rollback_from_backup(index, backup_path: Path) -> int:
    """Set filename back from a backup file."""
    records = read_backup(backup_path)
    ids = [record.vector_id for record in records]
    for start in range(0, len(records), UPDATE_BATCH):
        batch = records[start : start + UPDATE_BATCH]
        for record in batch:
            index.update(
                id=encode_vector_id(record.vector_id),
                set_metadata={"filename": record.filename},
            )
    by_name: dict[str, list[str]] = defaultdict(list)
    for record in records:
        by_name[record.filename].append(record.vector_id)
    for filename, file_ids in by_name.items():
        verify_filenames(index, file_ids, filename)
    print(f"Rollback vectors: {len(records)}")
    for record in records[:SAMPLE_LIMIT]:
        print(f"  {record.filename}")
    if len(ids) > SAMPLE_LIMIT:
        print(f"  ... and {len(ids) - SAMPLE_LIMIT} more")
    return len(records)


def print_summary(rows: list[RemapRow], mode: str) -> None:
    """Print counts and a few names. Do not print credentials."""
    ok_rows = [row for row in rows if row.result == "ok"]
    skip_rows = [row for row in rows if row.result != "ok"]
    print(f"Mode: {mode}")
    print(f"Remap files: {len(ok_rows)}")
    print(f"Skip files: {len(skip_rows)}")
    print(f"Remap vectors: {sum(row.vector_count for row in ok_rows)}")
    for row in ok_rows[:SAMPLE_LIMIT]:
        print(f"  {row.old_key} -> {row.new_key} ({row.rule})")
    extra = len(ok_rows) - SAMPLE_LIMIT
    if extra > 0:
        print(f"  ... and {extra} more")


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

    records = filter_records(
        list_audio_records(index),
        args.only_old_key,
        args.ids_file,
    )
    s3_keys = list_live_s3_keys(s3_client, bucket)
    rows = apply_limit(build_remap_rows(records, s3_keys), args.limit)
    attach_s3_sizes(s3_client, bucket, rows)

    if not args.apply:
        write_report(out_dir, rows)
        print_summary(rows, "dry-run")
        print("Dry run. No Pinecone writes.")
        return 0

    report_path = out_dir / REPORT_NAME
    report_counts = load_report_counts(report_path)
    ok_keys = {row.old_key for row in rows if row.result == "ok"}
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
