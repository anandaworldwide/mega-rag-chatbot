"""Unit tests for the audio filename fix script. Data is synthetic."""

import importlib.util
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from botocore.exceptions import ClientError


def load_script_module():
    """Load the script from bin/."""
    script_path = Path(__file__).resolve().parents[1] / "bin" / "fix_audio_filenames.py"
    spec = importlib.util.spec_from_file_location("fix_audio_filenames", script_path)
    if spec is None or spec.loader is None:
        raise AssertionError("Could not load fix_audio_filenames.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


SCRIPT = load_script_module()
OLD_KEY = "treasures/Talk A.mp3"
NEW_KEY = "treasures/album/Talk A.mp3"
VECTOR_A = "audio||Treasures||Talk A||hash||0"
VECTOR_B = "audio||Treasures||Talk A||hash||1"


class FakeIndex:
    """In-memory Pinecone index. Tests never call a live service."""

    def __init__(self, records: list[SCRIPT.AudioRecord]):
        self.vectors = {
            record.vector_id: {
                "metadata": {
                    "filename": record.filename,
                    "library": record.library,
                    "title": record.title,
                    "type": "audio",
                }
            }
            for record in records
        }
        self.updates: list[tuple[str, dict]] = []

    def list(self, prefix="", limit=100):
        ids = [vector_id for vector_id in self.vectors if vector_id.startswith(prefix)]
        for start in range(0, len(ids), limit):
            yield ids[start : start + limit]

    def fetch(self, ids, include_values=False):
        found = {}
        for vector_id in ids:
            decoded = SCRIPT.decode_vector_id(vector_id)
            key = decoded if decoded in self.vectors else vector_id
            if key in self.vectors:
                found[key] = SimpleNamespace(
                    metadata=dict(self.vectors[key]["metadata"])
                )
        return SimpleNamespace(vectors=found)

    def update(self, id, set_metadata):
        decoded = SCRIPT.decode_vector_id(id)
        key = decoded if decoded in self.vectors else id
        self.updates.append((key, dict(set_metadata)))
        if key in self.vectors:
            self.vectors[key]["metadata"].update(set_metadata)


class FakeS3:
    """In-memory S3 client for HEAD checks."""

    def __init__(self, sizes: dict[str, int]):
        self.sizes = sizes
        self.head_calls: list[str] = []

    def head_object(self, Bucket, Key):
        self.head_calls.append(Key)
        relative = SCRIPT.strip_audio_prefix(Key)
        if relative not in self.sizes:
            raise ClientError(
                {"Error": {"Code": "404", "Message": "Not Found"}},
                "HeadObject",
            )
        return {"ContentLength": self.sizes[relative]}


def sample_records() -> list[SCRIPT.AudioRecord]:
    return [
        SCRIPT.AudioRecord(VECTOR_A, OLD_KEY, "Treasures", "Talk A"),
        SCRIPT.AudioRecord(VECTOR_B, OLD_KEY, "Treasures", "Talk A"),
    ]


def make_args(out_dir: Path, **overrides) -> SimpleNamespace:
    values = {
        "site": "ananda",
        "apply": False,
        "rollback": None,
        "limit": None,
        "ids_file": None,
        "only_old_key": None,
        "out_dir": out_dir,
        "index_name": None,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def test_dry_run_writes_report_and_changes_nothing(tmp_path: Path, capsys):
    index = FakeIndex(sample_records())
    s3 = FakeS3({NEW_KEY: 2048})
    args = make_args(tmp_path)
    live_keys = [f"public/audio/{NEW_KEY}"]

    with patch.object(SCRIPT, "list_s3_object_keys", return_value=live_keys):
        result = SCRIPT.run(args, index, s3, "test-bucket")

    report_path = tmp_path / SCRIPT.REPORT_NAME
    assert result == 0
    assert index.updates == []
    assert report_path.is_file()
    line = report_path.read_text(encoding="utf-8").strip().splitlines()[0]
    row = json.loads(line)
    assert row["old_key"] == OLD_KEY
    assert row["new_key"] == NEW_KEY
    assert row["rule"] == "R1"
    assert row["result"] == "ok"
    assert row["vector_count"] == 2
    assert row["s3_size"] == 2048
    assert "Dry run. No Pinecone writes." in capsys.readouterr().out


def test_apply_refuses_without_backup():
    index = FakeIndex(sample_records())
    rows = [
        SCRIPT.RemapRow(
            old_key=OLD_KEY,
            new_key=NEW_KEY,
            rule="R1",
            result="ok",
            vector_count=2,
            vector_ids=[VECTOR_A, VECTOR_B],
        )
    ]

    try:
        SCRIPT.apply_remap(index, rows, sample_records(), backup_path=None)
    except SCRIPT.FilenameFixError as exc:
        assert "Backup file is missing" in str(exc)
    else:
        raise AssertionError("Expected FilenameFixError when backup is missing")
    assert index.updates == []


def test_apply_updates_all_vectors_of_a_file(tmp_path: Path):
    records = sample_records()
    index = FakeIndex(records)
    s3 = FakeS3({NEW_KEY: 2048})
    live_keys = [f"public/audio/{NEW_KEY}"]
    report_row = {
        "old_key": OLD_KEY,
        "new_key": NEW_KEY,
        "rule": "R1",
        "result": "ok",
        "vector_count": 2,
        "s3_size": 2048,
    }
    (tmp_path / SCRIPT.REPORT_NAME).write_text(
        json.dumps(report_row) + "\n", encoding="utf-8"
    )
    args = make_args(tmp_path, apply=True)

    with patch.object(SCRIPT, "list_s3_object_keys", return_value=live_keys):
        updated = SCRIPT.run(args, index, s3, "test-bucket")

    assert updated == 2
    assert {vector_id for vector_id, _meta in index.updates} == {VECTOR_A, VECTOR_B}
    assert index.vectors[VECTOR_A]["metadata"]["filename"] == NEW_KEY
    assert index.vectors[VECTOR_B]["metadata"]["filename"] == NEW_KEY
    backup_path = tmp_path / SCRIPT.BACKUP_NAME
    assert backup_path.is_file()
    backup_lines = backup_path.read_text(encoding="utf-8").splitlines()
    assert len(backup_lines) == 2


def test_vector_count_mismatch_stops_apply(tmp_path: Path):
    index = FakeIndex(sample_records())
    s3 = FakeS3({NEW_KEY: 2048})
    live_keys = [f"public/audio/{NEW_KEY}"]
    report_row = {
        "old_key": OLD_KEY,
        "new_key": NEW_KEY,
        "rule": "R1",
        "result": "ok",
        "vector_count": 3,
        "s3_size": 2048,
    }
    (tmp_path / SCRIPT.REPORT_NAME).write_text(
        json.dumps(report_row) + "\n", encoding="utf-8"
    )
    args = make_args(tmp_path, apply=True)

    try:
        with patch.object(SCRIPT, "list_s3_object_keys", return_value=live_keys):
            SCRIPT.run(args, index, s3, "test-bucket")
    except SCRIPT.FilenameFixError as exc:
        assert "Vector count does not match the dry-run report" in str(exc)
    else:
        raise AssertionError("Expected FilenameFixError for a vector count mismatch")
    assert index.updates == []
    assert not (tmp_path / SCRIPT.BACKUP_NAME).exists()


def test_rollback_restores_old_filename(tmp_path: Path):
    records = [
        SCRIPT.AudioRecord(VECTOR_A, NEW_KEY, "Treasures", "Talk A"),
        SCRIPT.AudioRecord(VECTOR_B, NEW_KEY, "Treasures", "Talk A"),
    ]
    index = FakeIndex(records)
    backup_path = tmp_path / SCRIPT.BACKUP_NAME
    SCRIPT.write_backup(tmp_path, sample_records())
    args = make_args(tmp_path, rollback=str(backup_path))

    restored = SCRIPT.run(args, index, FakeS3({}), "test-bucket")

    assert restored == 2
    assert index.vectors[VECTOR_A]["metadata"]["filename"] == OLD_KEY
    assert index.vectors[VECTOR_B]["metadata"]["filename"] == OLD_KEY


def test_missing_new_key_stops_the_run(tmp_path: Path):
    index = FakeIndex(sample_records())
    s3 = FakeS3({})
    live_keys = [f"public/audio/{NEW_KEY}"]
    args = make_args(tmp_path)

    try:
        with patch.object(SCRIPT, "list_s3_object_keys", return_value=live_keys):
            SCRIPT.run(args, index, s3, "test-bucket")
    except SCRIPT.FilenameFixError as exc:
        assert str(exc) == f"New key is missing in S3: {NEW_KEY}"
    else:
        raise AssertionError("Expected FilenameFixError when the new key is missing")
    assert index.updates == []
    assert not (tmp_path / SCRIPT.REPORT_NAME).exists()


def test_out_dir_inside_repo_is_refused():
    repo_root = Path(__file__).resolve().parents[1]
    inside = repo_root / "tmp-audio-fix-out"

    try:
        SCRIPT.assert_out_dir_outside_repo(inside, repo_root=repo_root)
    except SCRIPT.FilenameFixError as exc:
        assert "outside the repository" in str(exc)
    else:
        raise AssertionError("Expected FilenameFixError for an in-repo out-dir")


def test_encode_vector_id_percent_encodes_spaces():
    raw = "audio||Treasures||Talk A||hash||0"
    encoded = SCRIPT.encode_vector_id(raw)
    assert encoded == "audio||Treasures||Talk%20A||hash||0"
    assert SCRIPT.decode_vector_id(encoded) == raw
    assert SCRIPT.encode_vector_id("audio||Treasures||TalkA||0") == (
        "audio||Treasures||TalkA||0"
    )


def test_mask_secrets_hides_keys():
    text = "PINECONE_API_KEY=abc123 AWS_SECRET_ACCESS_KEY=xyz AKIAIOSFODNN7EXAMPLE"
    masked = SCRIPT.mask_secrets(text)
    assert "abc123" not in masked
    assert "xyz" not in masked
    assert "AKIAIOSFODNN7EXAMPLE" not in masked
    assert "[secret]" in masked
