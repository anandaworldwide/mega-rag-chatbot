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
IGNORE_KEY = "treasures/ignore/Talk A.mp3"
VECTOR_A = "audio||Treasures||Talk A||hash||0"
VECTOR_B = "audio||Treasures||Talk A||hash||1"
MATCH_SIZE = 2048


def live_audio_keys(*relative_keys: str) -> list[str]:
    return [f"public/audio/{key}" for key in relative_keys]


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
            if "%20" in vector_id:
                continue
            if vector_id in self.vectors:
                found[vector_id] = SimpleNamespace(
                    metadata=dict(self.vectors[vector_id]["metadata"])
                )
        return SimpleNamespace(vectors=found)

    def update(self, id, set_metadata):
        if "%20" in id:
            raise KeyError(f"id not found: {id}")
        self.updates.append((id, dict(set_metadata)))
        if id in self.vectors:
            self.vectors[id]["metadata"].update(set_metadata)


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
    s3 = FakeS3({NEW_KEY: MATCH_SIZE, IGNORE_KEY: MATCH_SIZE})
    args = make_args(tmp_path)
    live_keys = live_audio_keys(NEW_KEY, IGNORE_KEY)

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
    assert row["s3_size"] == MATCH_SIZE
    assert row["old_copy_size"] == MATCH_SIZE
    output = capsys.readouterr().out
    digest = SCRIPT.sha256_file(report_path)
    assert "Dry run. No Pinecone writes." in output
    assert f"Report SHA-256: {digest}" in output


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
    s3 = FakeS3({NEW_KEY: MATCH_SIZE, IGNORE_KEY: MATCH_SIZE})
    live_keys = live_audio_keys(NEW_KEY, IGNORE_KEY)
    report_row = {
        "old_key": OLD_KEY,
        "new_key": NEW_KEY,
        "rule": "R1",
        "result": "ok",
        "vector_count": 2,
        "s3_size": MATCH_SIZE,
        "old_copy_size": MATCH_SIZE,
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
    backups = SCRIPT.list_backup_files(tmp_path)
    assert len(backups) == 1
    backup_lines = backups[0].read_text(encoding="utf-8").splitlines()
    assert len(backup_lines) == 2


def test_vector_count_mismatch_stops_apply(tmp_path: Path):
    index = FakeIndex(sample_records())
    s3 = FakeS3({NEW_KEY: MATCH_SIZE, IGNORE_KEY: MATCH_SIZE})
    live_keys = live_audio_keys(NEW_KEY, IGNORE_KEY)
    report_row = {
        "old_key": OLD_KEY,
        "new_key": NEW_KEY,
        "rule": "R1",
        "result": "ok",
        "vector_count": 3,
        "s3_size": MATCH_SIZE,
        "old_copy_size": MATCH_SIZE,
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
    assert SCRIPT.list_backup_files(tmp_path) == []


def test_rollback_restores_old_filename(tmp_path: Path):
    records = [
        SCRIPT.AudioRecord(VECTOR_A, NEW_KEY, "Treasures", "Talk A"),
        SCRIPT.AudioRecord(VECTOR_B, NEW_KEY, "Treasures", "Talk A"),
    ]
    index = FakeIndex(records)
    backup_path = SCRIPT.write_backup(tmp_path, sample_records())
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


def test_encoded_ids_are_rejected_on_fetch_update_and_rollback(tmp_path: Path):
    """Fail if a percent-encoded id is sent to fetch, update, or rollback."""
    encoded = VECTOR_A.replace(" ", "%20")
    assert " " in VECTOR_A
    assert "%20" in encoded

    fake = FakeIndex(sample_records())
    assert SCRIPT.fetch_metadata(fake, [encoded]) == {}
    fetched = SCRIPT.fetch_metadata(fake, [VECTOR_A, VECTOR_B])
    assert set(fetched) == {VECTOR_A, VECTOR_B}

    try:
        fake.update(id=encoded, set_metadata={"filename": NEW_KEY})
    except KeyError as exc:
        assert encoded in str(exc)
    else:
        raise AssertionError("Expected reject of encoded update id")
    assert fake.updates == []
    assert fake.vectors[VECTOR_A]["metadata"]["filename"] == OLD_KEY

    index = TrackingIndex(sample_records())
    listed = SCRIPT.list_audio_records(index)
    assert [record.vector_id for record in listed] == [VECTOR_A, VECTOR_B]
    SCRIPT.update_filenames(index, [VECTOR_A], NEW_KEY)
    assert index.updates[0][0] == VECTOR_A
    assert "%20" not in index.updates[0][0]

    backup_path = SCRIPT.write_backup(
        tmp_path,
        [SCRIPT.AudioRecord(VECTOR_A, OLD_KEY, "Treasures", "Talk A")],
    )
    backup_row = json.loads(backup_path.read_text(encoding="utf-8"))
    assert backup_row["id"] == VECTOR_A
    assert " " in backup_row["id"]
    assert "%20" not in backup_row["id"]

    rollback_index = TrackingIndex(
        [SCRIPT.AudioRecord(VECTOR_A, NEW_KEY, "Treasures", "Talk A")]
    )
    SCRIPT.rollback_from_backup(rollback_index, backup_path)
    assert rollback_index.updates[0][0] == VECTOR_A
    assert "%20" not in rollback_index.updates[0][0]
    assert rollback_index.vectors[VECTOR_A]["metadata"]["filename"] == OLD_KEY


def test_canary_then_full_apply_keeps_both_backups(tmp_path: Path):
    old_b = "treasures/Talk B.mp3"
    new_b = "treasures/album/Talk B.mp3"
    ignore_b = "treasures/ignore/Talk B.mp3"
    vector_c = "audio||Treasures||Talk B||hash||0"
    records = [
        *sample_records(),
        SCRIPT.AudioRecord(vector_c, old_b, "Treasures", "Talk B"),
    ]
    index = FakeIndex(records)
    s3 = FakeS3(
        {
            NEW_KEY: MATCH_SIZE,
            IGNORE_KEY: MATCH_SIZE,
            new_b: MATCH_SIZE,
            ignore_b: MATCH_SIZE,
        }
    )
    live_keys = live_audio_keys(NEW_KEY, IGNORE_KEY, new_b, ignore_b)
    report_rows = [
        {
            "old_key": OLD_KEY,
            "new_key": NEW_KEY,
            "rule": "R1",
            "result": "ok",
            "vector_count": 2,
            "s3_size": MATCH_SIZE,
            "old_copy_size": MATCH_SIZE,
        },
        {
            "old_key": old_b,
            "new_key": new_b,
            "rule": "R1",
            "result": "ok",
            "vector_count": 1,
            "s3_size": MATCH_SIZE,
            "old_copy_size": MATCH_SIZE,
        },
    ]
    (tmp_path / SCRIPT.REPORT_NAME).write_text(
        "".join(json.dumps(row) + "\n" for row in report_rows),
        encoding="utf-8",
    )

    with patch.object(SCRIPT, "list_s3_object_keys", return_value=live_keys):
        canary = SCRIPT.run(
            make_args(tmp_path, apply=True, limit=1), index, s3, "test-bucket"
        )
        full = SCRIPT.run(make_args(tmp_path, apply=True), index, s3, "test-bucket")

    backups = SCRIPT.list_backup_files(tmp_path)
    assert canary == 2
    assert full == 1
    assert len(backups) == 2
    assert backups[0] != backups[1]
    assert index.vectors[VECTOR_A]["metadata"]["filename"] == NEW_KEY
    assert index.vectors[VECTOR_B]["metadata"]["filename"] == NEW_KEY
    assert index.vectors[vector_c]["metadata"]["filename"] == new_b

    SCRIPT.rollback_from_backup(index, backups[0])
    SCRIPT.rollback_from_backup(index, backups[1])
    assert index.vectors[VECTOR_A]["metadata"]["filename"] == OLD_KEY
    assert index.vectors[VECTOR_B]["metadata"]["filename"] == OLD_KEY
    assert index.vectors[vector_c]["metadata"]["filename"] == old_b


def test_filter_does_not_pick_key_used_by_another_record(tmp_path: Path, capsys):
    used_key = "treasures/album/Talk A.mp3"
    other_id = "audio||Treasures||Talk C||hash||0"
    records = [
        SCRIPT.AudioRecord(VECTOR_A, OLD_KEY, "Treasures", "Talk A"),
        SCRIPT.AudioRecord(other_id, used_key, "Treasures", "Talk C"),
    ]
    index = FakeIndex(records)
    s3 = FakeS3({used_key: MATCH_SIZE})
    args = make_args(tmp_path, only_old_key=OLD_KEY)

    with patch.object(
        SCRIPT, "list_s3_object_keys", return_value=live_audio_keys(used_key)
    ):
        SCRIPT.run(args, index, s3, "test-bucket")

    row = json.loads((tmp_path / SCRIPT.REPORT_NAME).read_text(encoding="utf-8"))
    assert row["old_key"] == OLD_KEY
    assert row["new_key"] is None
    assert row["result"] == "skip"
    assert row["rule"] == "zero targets"
    assert index.updates == []


def test_apply_stops_when_new_key_differs_from_report(tmp_path: Path):
    other_new = "treasures/copy/Talk A.mp3"
    index = FakeIndex(sample_records())
    s3 = FakeS3({NEW_KEY: MATCH_SIZE, IGNORE_KEY: MATCH_SIZE})
    report_row = {
        "old_key": OLD_KEY,
        "new_key": other_new,
        "rule": "R1",
        "result": "ok",
        "vector_count": 2,
        "s3_size": MATCH_SIZE,
        "old_copy_size": MATCH_SIZE,
    }
    (tmp_path / SCRIPT.REPORT_NAME).write_text(
        json.dumps(report_row) + "\n", encoding="utf-8"
    )
    args = make_args(tmp_path, apply=True)

    try:
        with patch.object(
            SCRIPT,
            "list_s3_object_keys",
            return_value=live_audio_keys(NEW_KEY, IGNORE_KEY),
        ):
            SCRIPT.run(args, index, s3, "test-bucket")
    except SCRIPT.FilenameFixError as exc:
        assert OLD_KEY in str(exc)
        assert "does not match the dry-run report" in str(exc)
    else:
        raise AssertionError("Expected FilenameFixError for a new_key mismatch")
    assert index.updates == []
    assert SCRIPT.list_backup_files(tmp_path) == []


def test_size_check_keeps_matching_old_copy(tmp_path: Path):
    index = FakeIndex(sample_records())
    s3 = FakeS3({NEW_KEY: MATCH_SIZE, IGNORE_KEY: MATCH_SIZE})
    args = make_args(tmp_path)

    with patch.object(
        SCRIPT,
        "list_s3_object_keys",
        return_value=live_audio_keys(NEW_KEY, IGNORE_KEY),
    ):
        SCRIPT.run(args, index, s3, "test-bucket")

    row = json.loads((tmp_path / SCRIPT.REPORT_NAME).read_text(encoding="utf-8"))
    assert row["result"] == "ok"
    assert row["s3_size"] == MATCH_SIZE
    assert row["old_copy_size"] == MATCH_SIZE
    assert index.updates == []


def test_size_mismatch_skips_remap(tmp_path: Path, capsys):
    index = FakeIndex(sample_records())
    s3 = FakeS3({NEW_KEY: MATCH_SIZE, IGNORE_KEY: 999})
    args = make_args(tmp_path)

    with patch.object(
        SCRIPT,
        "list_s3_object_keys",
        return_value=live_audio_keys(NEW_KEY, IGNORE_KEY),
    ):
        SCRIPT.run(args, index, s3, "test-bucket")

    row = json.loads((tmp_path / SCRIPT.REPORT_NAME).read_text(encoding="utf-8"))
    output = capsys.readouterr().out
    assert row["result"] == "size_mismatch"
    assert row["s3_size"] == MATCH_SIZE
    assert row["old_copy_size"] == 999
    assert "Size mismatch files: 1" in output
    assert index.updates == []


def test_no_old_copy_stays_ok_and_is_listed(tmp_path: Path, capsys):
    index = FakeIndex(sample_records())
    s3 = FakeS3({NEW_KEY: MATCH_SIZE})
    args = make_args(tmp_path)

    with patch.object(
        SCRIPT, "list_s3_object_keys", return_value=live_audio_keys(NEW_KEY)
    ):
        SCRIPT.run(args, index, s3, "test-bucket")

    row = json.loads((tmp_path / SCRIPT.REPORT_NAME).read_text(encoding="utf-8"))
    output = capsys.readouterr().out
    assert row["result"] == "no_old_copy"
    assert row["new_key"] == NEW_KEY
    assert row["s3_size"] == MATCH_SIZE
    assert row["old_copy_size"] is None
    assert "No old copy files: 1" in output
    assert index.updates == []


def test_no_old_copy_is_still_applied(tmp_path: Path):
    index = FakeIndex(sample_records())
    s3 = FakeS3({NEW_KEY: MATCH_SIZE})
    report_row = {
        "old_key": OLD_KEY,
        "new_key": NEW_KEY,
        "rule": "R1",
        "result": "no_old_copy",
        "vector_count": 2,
        "s3_size": MATCH_SIZE,
        "old_copy_size": None,
    }
    (tmp_path / SCRIPT.REPORT_NAME).write_text(
        json.dumps(report_row) + "\n", encoding="utf-8"
    )
    args = make_args(tmp_path, apply=True)

    with patch.object(
        SCRIPT, "list_s3_object_keys", return_value=live_audio_keys(NEW_KEY)
    ):
        updated = SCRIPT.run(args, index, s3, "test-bucket")

    assert updated == 2
    assert index.vectors[VECTOR_A]["metadata"]["filename"] == NEW_KEY
    assert index.vectors[VECTOR_B]["metadata"]["filename"] == NEW_KEY


def test_two_old_keys_that_pick_one_target_are_collisions(tmp_path: Path):
    old_one = "treasures/old1/Talk A.mp3"
    old_two = "treasures/old2/Talk A.mp3"
    records = [
        SCRIPT.AudioRecord(VECTOR_A, old_one, "Treasures", "Talk A"),
        SCRIPT.AudioRecord(VECTOR_B, old_two, "Treasures", "Talk A"),
    ]
    index = FakeIndex(records)
    s3 = FakeS3({NEW_KEY: MATCH_SIZE, IGNORE_KEY: MATCH_SIZE})
    args = make_args(tmp_path)

    with patch.object(
        SCRIPT,
        "list_s3_object_keys",
        return_value=live_audio_keys(NEW_KEY, IGNORE_KEY),
    ):
        SCRIPT.run(args, index, s3, "test-bucket")

    rows = [
        json.loads(line)
        for line in (tmp_path / SCRIPT.REPORT_NAME)
        .read_text(encoding="utf-8")
        .splitlines()
        if line
    ]
    assert {row["old_key"] for row in rows} == {old_one, old_two}
    assert all(row["result"] == "skip" for row in rows)
    assert all(row["rule"] == "collision" for row in rows)
    assert all(row["new_key"] == NEW_KEY for row in rows)
    assert index.updates == []


class FlakyFetchIndex(FakeIndex):
    """Fail fetch a set number of times, then succeed."""

    def __init__(self, records, fail_times=2):
        super().__init__(records)
        self.fail_times = fail_times
        self.fetch_calls = 0

    def fetch(self, ids, include_values=False):
        self.fetch_calls += 1
        if self.fetch_calls <= self.fail_times:
            raise RuntimeError("transient fetch error")
        return super().fetch(ids, include_values)


class UpdateFailIndex(FakeIndex):
    """Raise on update to simulate a Pinecone write error."""

    def update(self, id, set_metadata):
        raise RuntimeError("Pinecone timeout")


class TrackingIndex(FakeIndex):
    """Fail the test when a percent-encoded id is sent."""

    def fetch(self, ids, include_values=False):
        for vector_id in ids:
            if "%20" in vector_id:
                raise AssertionError(f"encoded fetch id: {vector_id}")
        return super().fetch(ids, include_values)

    def update(self, id, set_metadata):
        if "%20" in id:
            raise AssertionError(f"encoded update id: {id}")
        return super().update(id, set_metadata)


class VerifyFailIndex(FakeIndex):
    """Apply writes. Fetch then returns a wrong filename."""

    def fetch(self, ids, include_values=False):
        found = {}
        for vector_id in ids:
            if "%20" in vector_id:
                continue
            if vector_id in self.vectors:
                metadata = dict(self.vectors[vector_id]["metadata"])
                metadata["filename"] = "wrong"
                found[vector_id] = SimpleNamespace(metadata=metadata)
        return SimpleNamespace(vectors=found)


def test_verify_failure_names_the_backup_for_rollback(tmp_path: Path):
    backup_path = SCRIPT.write_backup(tmp_path, sample_records())
    index = VerifyFailIndex(sample_records())
    rows = [
        SCRIPT.RemapRow(
            old_key=OLD_KEY,
            new_key=NEW_KEY,
            rule="R1",
            result="ok",
            vector_count=2,
        )
    ]

    try:
        SCRIPT.apply_remap(index, rows, sample_records(), backup_path)
    except SCRIPT.FilenameFixError as exc:
        message = str(exc)
        assert "Verify failed" in message
        assert f"Run --rollback with {backup_path}" in message
    else:
        raise AssertionError("Expected FilenameFixError after a verify failure")
    assert index.updates


def test_mask_secrets_hides_keys():
    text = "PINECONE_API_KEY=abc123 AWS_SECRET_ACCESS_KEY=xyz AKIAIOSFODNN7EXAMPLE"
    masked = SCRIPT.mask_secrets(text)
    assert "abc123" not in masked
    assert "xyz" not in masked
    assert "AKIAIOSFODNN7EXAMPLE" not in masked
    assert "[secret]" in masked


def test_fetch_retries_then_succeeds():
    index = FlakyFetchIndex(sample_records(), fail_times=2)
    sleeps: list[float] = []
    result = SCRIPT.fetch_metadata_with_retry(
        index, [VECTOR_A], sleep=sleeps.append
    )
    assert VECTOR_A in result
    assert index.fetch_calls == 3
    assert sleeps == [SCRIPT.FETCH_BACKOFF_SEC, SCRIPT.FETCH_BACKOFF_SEC]


def test_fetch_stops_after_three_failures():
    index = FlakyFetchIndex(sample_records(), fail_times=10)
    try:
        SCRIPT.fetch_metadata_with_retry(
            index, [VECTOR_A], sleep=lambda _delay: None
        )
    except SCRIPT.FilenameFixError as exc:
        assert "Fetch failed after 3 tries" in str(exc)
    else:
        raise AssertionError("Expected FilenameFixError after three fetch failures")
    assert index.fetch_calls == 3


def test_fetch_all_metadata_keeps_input_id_order():
    records = [
        SCRIPT.AudioRecord(
            f"audio||Treasures||Talk {index_number}||hash||0",
            OLD_KEY,
            "Treasures",
            f"Talk {index_number}",
        )
        for index_number in range(45)
    ]
    reversed_ids = list(reversed([record.vector_id for record in records]))
    fetched = SCRIPT.fetch_all_metadata(
        FakeIndex(records), reversed_ids, sleep=lambda _delay: None
    )
    assert list(fetched.keys()) == reversed_ids


def test_apply_pinecone_error_names_the_backup_for_rollback(tmp_path: Path):
    backup_path = SCRIPT.write_backup(tmp_path, sample_records())
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
        SCRIPT.apply_remap(
            UpdateFailIndex(sample_records()),
            rows,
            sample_records(),
            backup_path,
        )
    except SCRIPT.FilenameFixError as exc:
        message = str(exc)
        assert "Apply stopped" in message
        assert f"Run --rollback with {backup_path}" in message
    else:
        raise AssertionError("Expected FilenameFixError after a Pinecone error")
