"""Set access fields on selected Pinecone audio records.

This module is pure. It does not call Pinecone. It does not read S3.
The target values are access_level "kriyaban" and required_access_level 200.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections import defaultdict
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import quote, unquote

TARGET_ACCESS_LEVEL = "kriyaban"
TARGET_REQUIRED_ACCESS_LEVEL = 200
AUDIO_ID_PREFIX = "audio||"
AUDIO_TYPE = "audio"
DEFAULT_LIBRARY = "Treasures"
RESULT_UPDATE = "update"
RESULT_ALREADY_200 = "already_200"
RESULT_LIBRARY_MISMATCH = "library_mismatch"
RESULT_MISSING = "missing"
REPORT_NAME = "access-level-fix-report.jsonl"
BACKUP_NAME_PREFIX = "access-level-fix-backup-"

_SECRET_PATTERNS = (
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(
        r"(?i)(aws_?secret_?access_?key|aws_?access_?key_?id|"
        r"pinecone[_-]?api[_-]?key|secret[_-]?key|api[_-]?key)"
        r"\s*[=:]\s*\S+"
    ),
)


class AccessLevelFixError(Exception):
    """Stop the run. The message is safe to print."""


@dataclass(frozen=True)
class AudioAccessRecord:
    """One audio vector used by the access-level fix."""

    vector_id: str
    filename: str
    library: str
    access_level: str
    required_access_level: int
    extra_metadata: tuple[tuple[str, object], ...] = ()

    @classmethod
    def from_metadata(
        cls, vector_id: str, metadata: Mapping[str, object]
    ) -> AudioAccessRecord:
        """Build a record from Pinecone metadata. Extra fields stay on the side."""
        reserved = {
            "filename",
            "library",
            "access_level",
            "required_access_level",
            "type",
        }
        extra = tuple(
            sorted(
                (str(key), value)
                for key, value in metadata.items()
                if key not in reserved
            )
        )
        return cls(
            vector_id=vector_id,
            filename=str(metadata.get("filename") or ""),
            library=str(metadata.get("library") or ""),
            access_level=str(metadata.get("access_level") or "public"),
            required_access_level=parse_required_access_level(
                metadata.get("required_access_level")
            ),
            extra_metadata=extra,
        )


@dataclass(frozen=True)
class VectorPlanRow:
    """One dry-run or apply decision for a single vector."""

    vector_id: str
    filename: str
    library: str
    old_access_level: str
    old_required_access_level: int
    new_access_level: str
    new_required_access_level: int
    result: str

    def to_report_dict(self) -> dict[str, object]:
        """Return one report line. The line names the vector and the access fields."""
        return {
            "id": self.vector_id,
            "filename": self.filename,
            "library": self.library,
            "old_access_level": self.old_access_level,
            "old_required_access_level": self.old_required_access_level,
            "new_access_level": self.new_access_level,
            "new_required_access_level": self.new_required_access_level,
            "result": self.result,
        }

    def to_backup_dict(self) -> dict[str, object]:
        """Return one backup line with the old access fields."""
        return {
            "id": self.vector_id,
            "old_access_level": self.old_access_level,
            "old_required_access_level": self.old_required_access_level,
            "filename": self.filename,
            "library": self.library,
        }

    def compare_tuple(self) -> tuple[object, ...]:
        """Return a stable tuple used to compare a live plan with a report."""
        return (
            self.vector_id,
            self.filename,
            self.library,
            self.old_access_level,
            self.old_required_access_level,
            self.new_access_level,
            self.new_required_access_level,
            self.result,
        )


def parse_required_access_level(value: object) -> int:
    """Read required_access_level as an int. Bad values become 0."""
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


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


def assert_out_dir_outside_repo(out_dir: Path, repo_root: Path) -> Path:
    """Refuse an output path that would write data into this public repo."""
    resolved = out_dir.expanduser().resolve()
    repo = repo_root.resolve()
    if resolved == repo or repo in resolved.parents:
        raise AccessLevelFixError("Refuse. --out-dir must be outside the repository.")
    return resolved


def parse_keys(text: str) -> list[str]:
    """Read one filename per line. Skip blanks and comment lines."""
    keys: list[str] = []
    seen: set[str] = set()
    for raw in text.splitlines():
        item = raw.strip()
        if not item or item.startswith("#"):
            continue
        if item in seen:
            continue
        seen.add(item)
        keys.append(item)
    return keys


def classify_record(record: AudioAccessRecord, library: str) -> str:
    """Classify one record against the target library and level 200."""
    if record.library != library:
        return RESULT_LIBRARY_MISMATCH
    if record.required_access_level == TARGET_REQUIRED_ACCESS_LEVEL:
        return RESULT_ALREADY_200
    return RESULT_UPDATE


def _target_for_result(record: AudioAccessRecord, result: str) -> tuple[str, int]:
    if result == RESULT_UPDATE:
        return TARGET_ACCESS_LEVEL, TARGET_REQUIRED_ACCESS_LEVEL
    return record.access_level, record.required_access_level


def _file_result(results: set[str]) -> str:
    if RESULT_LIBRARY_MISMATCH in results:
        return RESULT_LIBRARY_MISMATCH
    if RESULT_UPDATE in results:
        return RESULT_UPDATE
    if RESULT_ALREADY_200 in results:
        return RESULT_ALREADY_200
    return RESULT_MISSING


def build_vector_row(record: AudioAccessRecord, library: str) -> VectorPlanRow:
    """Build one plan row from a live record."""
    result = classify_record(record, library)
    new_access, new_required = _target_for_result(record, result)
    return VectorPlanRow(
        vector_id=record.vector_id,
        filename=record.filename,
        library=record.library,
        old_access_level=record.access_level,
        old_required_access_level=record.required_access_level,
        new_access_level=new_access,
        new_required_access_level=new_required,
        result=result,
    )


def build_plan_rows(
    records: Iterable[AudioAccessRecord],
    keys: Iterable[str],
    library: str,
) -> list[VectorPlanRow]:
    """Build a plan from all records before any file-count limit.

    Library mismatch and already_200 use the full record set. The key list
    only selects filenames. It does not drop other records of those files.
    """
    wanted = list(dict.fromkeys(keys))
    by_filename: dict[str, list[AudioAccessRecord]] = defaultdict(list)
    for record in records:
        if record.filename in wanted:
            by_filename[record.filename].append(record)

    rows: list[VectorPlanRow] = []
    for key in wanted:
        file_records = by_filename.get(key, [])
        if not file_records:
            rows.append(
                VectorPlanRow(
                    vector_id="",
                    filename=key,
                    library=library,
                    old_access_level="",
                    old_required_access_level=0,
                    new_access_level="",
                    new_required_access_level=0,
                    result=RESULT_MISSING,
                )
            )
            continue
        for record in file_records:
            rows.append(build_vector_row(record, library))
    return rows


def filenames_in_result_order(rows: Iterable[VectorPlanRow], result: str) -> list[str]:
    """Return unique filenames for one result, in first-seen order."""
    names: list[str] = []
    seen: set[str] = set()
    for row in rows:
        if row.result != result or row.filename in seen:
            continue
        seen.add(row.filename)
        names.append(row.filename)
    return names


def apply_file_limit(
    rows: list[VectorPlanRow], limit: int | None
) -> list[VectorPlanRow]:
    """Keep all skip rows. Keep update rows for only the first N files."""
    if limit is None:
        return rows
    update_files = filenames_in_result_order(rows, RESULT_UPDATE)
    keep_update = set(update_files[:limit])
    kept: list[VectorPlanRow] = []
    for row in rows:
        if row.result == RESULT_UPDATE and row.filename not in keep_update:
            continue
        kept.append(row)
    return kept


def update_rows(rows: Iterable[VectorPlanRow]) -> list[VectorPlanRow]:
    """Return only the rows that will write new access fields."""
    return [row for row in rows if row.result == RESULT_UPDATE]


def file_vector_counts(rows: Iterable[VectorPlanRow]) -> dict[str, int]:
    """Count vectors per filename for update rows."""
    counts: dict[str, int] = defaultdict(int)
    for row in update_rows(rows):
        counts[row.filename] += 1
    return dict(counts)


def compare_live_plan_with_report(
    live_rows: list[VectorPlanRow],
    report_rows: list[VectorPlanRow],
    apply_filenames: set[str],
) -> None:
    """Stop apply when the live plan differs from the dry-run report."""
    live = [row for row in update_rows(live_rows) if row.filename in apply_filenames]
    reported = [
        row for row in update_rows(report_rows) if row.filename in apply_filenames
    ]
    live_sig = tuple(sorted(row.compare_tuple() for row in live))
    report_sig = tuple(sorted(row.compare_tuple() for row in reported))
    if live_sig != report_sig:
        raise AccessLevelFixError(
            "Refuse apply. Live plan does not match the dry-run report."
        )
    if file_vector_counts(live) != file_vector_counts(reported):
        raise AccessLevelFixError(
            "Refuse apply. Vector count does not match the dry-run report."
        )


def has_library_mismatch(rows: Iterable[VectorPlanRow]) -> bool:
    """Return True when any selected filename has a different library."""
    return any(row.result == RESULT_LIBRARY_MISMATCH for row in rows)


def record_matches_level_filter(
    metadata: Mapping[str, object], max_required_level: int
) -> bool:
    """Return True when a record would match a required_access_level filter."""
    required = parse_required_access_level(metadata.get("required_access_level"))
    return required <= max_required_level


def filter_records_by_required_level(
    records: Iterable[Mapping[str, object]],
    max_required_level: int,
) -> list[Mapping[str, object]]:
    """Keep records whose required_access_level is at or below the max."""
    return [
        record
        for record in records
        if record_matches_level_filter(record, max_required_level)
    ]


def new_backup_path(out_dir: Path, when: datetime | None = None) -> Path:
    """Return a new timestamped backup path. Never reuse an existing file."""
    stamp = (when or datetime.now(UTC)).strftime("%Y%m%dT%H%M%SZ")
    path = out_dir / f"{BACKUP_NAME_PREFIX}{stamp}.jsonl"
    if not path.exists():
        return path
    suffix = 2
    while True:
        candidate = out_dir / f"{BACKUP_NAME_PREFIX}{stamp}-{suffix}.jsonl"
        if not candidate.exists():
            return candidate
        suffix += 1


def write_jsonl(path: Path, rows: Iterable[Mapping[str, object]]) -> None:
    """Write one JSON object per line."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=True) + "\n")


def read_jsonl(path: Path) -> list[dict[str, object]]:
    """Read one JSON object per line. Skip blank lines."""
    rows: list[dict[str, object]] = []
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            text = line.strip()
            if not text:
                continue
            loaded = json.loads(text)
            if not isinstance(loaded, dict):
                raise AccessLevelFixError("Refuse. JSONL line is not an object.")
            rows.append(loaded)
    return rows


def plan_rows_from_report(
    raw_rows: Iterable[Mapping[str, object]],
) -> list[VectorPlanRow]:
    """Rebuild plan rows from a dry-run report."""
    rows: list[VectorPlanRow] = []
    for raw in raw_rows:
        rows.append(
            VectorPlanRow(
                vector_id=str(raw.get("id") or ""),
                filename=str(raw.get("filename") or ""),
                library=str(raw.get("library") or ""),
                old_access_level=str(raw.get("old_access_level") or ""),
                old_required_access_level=parse_required_access_level(
                    raw.get("old_required_access_level")
                ),
                new_access_level=str(raw.get("new_access_level") or ""),
                new_required_access_level=parse_required_access_level(
                    raw.get("new_required_access_level")
                ),
                result=str(raw.get("result") or ""),
            )
        )
    return rows


def plan_rows_from_backup(
    raw_rows: Iterable[Mapping[str, object]],
) -> list[VectorPlanRow]:
    """Rebuild plan rows from a backup file. New values are the target fields."""
    rows: list[VectorPlanRow] = []
    for raw in raw_rows:
        old_access = str(raw.get("old_access_level") or raw.get("access_level") or "")
        old_required = parse_required_access_level(
            raw.get("old_required_access_level", raw.get("required_access_level"))
        )
        rows.append(
            VectorPlanRow(
                vector_id=str(raw.get("id") or ""),
                filename=str(raw.get("filename") or ""),
                library=str(raw.get("library") or ""),
                old_access_level=old_access,
                old_required_access_level=old_required,
                new_access_level=TARGET_ACCESS_LEVEL,
                new_required_access_level=TARGET_REQUIRED_ACCESS_LEVEL,
                result=RESULT_UPDATE,
            )
        )
    return rows


def load_id_rows(path: Path) -> list[VectorPlanRow]:
    """Read vector rows from a backup file or a dry-run report."""
    if not path.is_file():
        raise AccessLevelFixError("Refuse. The file is missing.")
    raw_rows = read_jsonl(path)
    if not raw_rows:
        raise AccessLevelFixError("Refuse. The file has no records.")
    if "new_access_level" in raw_rows[0]:
        return [row for row in plan_rows_from_report(raw_rows) if row.vector_id]
    return [row for row in plan_rows_from_backup(raw_rows) if row.vector_id]


def sha256_file(path: Path) -> str:
    """Return the SHA-256 hex digest of a file."""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def rollback_hint(backup_path: Path) -> str:
    """Return the verify-failure hint with the backup path."""
    return f"run --rollback with {backup_path}"


def summary_counts(rows: Iterable[VectorPlanRow]) -> dict[str, int]:
    """Return file and vector counts. Do not include text fields."""
    row_list = list(rows)
    update = update_rows(row_list)
    update_files = {row.filename for row in update}
    return {
        "file_count": len(update_files),
        "vector_count": len(update),
        "already_200_files": len(
            filenames_in_result_order(row_list, RESULT_ALREADY_200)
        ),
        "library_mismatch_files": len(
            filenames_in_result_order(row_list, RESULT_LIBRARY_MISMATCH)
        ),
        "missing_files": len(filenames_in_result_order(row_list, RESULT_MISSING)),
    }
