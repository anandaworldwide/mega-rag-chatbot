"""Tests for the audio access-level fix. Synthetic keys and a fake index only."""

from __future__ import annotations

import hashlib
import importlib.util
from argparse import Namespace
from datetime import UTC, datetime
from pathlib import Path

import pytest

from data_ingestion.audio_video.audio_access_level_fix import (
    TARGET_ACCESS_LEVEL,
    TARGET_REQUIRED_ACCESS_LEVEL,
    AccessLevelFixError,
    AudioAccessRecord,
    apply_file_limit,
    assert_out_dir_outside_repo,
    build_plan_rows,
    compare_live_plan_with_report,
    filter_records_by_required_level,
    has_library_mismatch,
    mask_secrets,
    new_backup_path,
    parse_keys,
    plan_rows_from_report,
    read_jsonl,
    rollback_hint,
    update_rows,
)
from data_ingestion.tests.strict_fake_index import (
    EncodedVectorIdError,
    StrictFakeIndex,
    is_percent_encoded_vector_id,
)

REPO_ROOT = Path(__file__).resolve().parents[2]


def load_script_module():
    """Load the script from bin/. Do not import fix_audio_filenames."""
    script_path = REPO_ROOT / "bin" / "fix_audio_access_level.py"
    spec = importlib.util.spec_from_file_location("fix_audio_access_level", script_path)
    if spec is None or spec.loader is None:
        raise AssertionError("Could not load fix_audio_access_level.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SCRIPT = load_script_module()

SHARED_FAKE_INDEX_SHA256 = (
    "2d7537c5d42768c2646749f6d490804f9fe92fca84d6c2a936048bdb2ef4b536"
)


def _fetched_ids(index: StrictFakeIndex) -> list[str]:
    """Return every id passed to fetch, in call order."""
    return [vector_id for call in index.fetch_calls for vector_id in call]


def assert_no_encoded_ids(index: StrictFakeIndex) -> None:
    """Fail when fetch, update, or rollback sent a percent-encoded id."""
    for vector_id in _fetched_ids(index):
        assert not is_percent_encoded_vector_id(vector_id)
    for vector_id, _metadata in index.updates:
        assert not is_percent_encoded_vector_id(vector_id)
    assert index.encoded_ids == []


def _meta(
    filename: str,
    library: str = "Treasures",
    access_level: str = "public",
    required_access_level: int = 0,
    **extra,
) -> dict:
    metadata = {
        "type": "audio",
        "filename": filename,
        "library": library,
        "access_level": access_level,
        "required_access_level": required_access_level,
        "title": extra.pop("title", "Talk A"),
        "author": extra.pop("author", "Test Author"),
        "text": extra.pop("text", "synthetic chunk text"),
    }
    metadata.update(extra)
    return metadata


def _vector(
    vector_id: str,
    filename: str,
    library: str = "Treasures",
    access_level: str = "public",
    required_access_level: int = 0,
    **extra,
) -> dict:
    return {
        vector_id: {
            "metadata": _meta(
                filename,
                library=library,
                access_level=access_level,
                required_access_level=required_access_level,
                **extra,
            ),
            "values": [0.1, 0.2],
        }
    }


def _multi_chunk_index() -> StrictFakeIndex:
    """One file with three chunks, plus a second file and a skip file."""
    vectors = {}
    talk_a = "treasures/talk-a.mp3"
    talk_b = "treasures/talk-b.mp3"
    talk_c = "treasures/talk-c.mp3"
    for index in range(3):
        vectors.update(
            _vector(
                f"audio||Treasures||audio||Talk A||Test Author||aaa111||{index}",
                talk_a,
                title="Talk A",
            )
        )
    vectors.update(
        _vector(
            "audio||Treasures||audio||Talk B||Test Author||bbb222||0",
            talk_b,
            title="Talk B",
        )
    )
    vectors.update(
        _vector(
            "audio||Treasures||audio||Talk C||Test Author||ccc333||0",
            talk_c,
            access_level="kriyaban",
            required_access_level=200,
            title="Talk C",
        )
    )
    vectors.update(
        _vector(
            "audio||Other Library||audio||Talk D||Test Author||ddd444||0",
            "other/talk-d.mp3",
            library="Other Library",
            title="Talk D",
        )
    )
    return StrictFakeIndex(vectors)


def _write_keys(path: Path, names: list[str]) -> Path:
    path.write_text("\n".join(names) + "\n", encoding="utf-8")
    return path


def _args(
    tmp_path: Path,
    keys_file: Path | None,
    *,
    apply: bool = False,
    rollback: str | None = None,
    verify_only: str | None = None,
    limit: int | None = None,
    library: str = "Treasures",
    out_dir: Path | None = None,
) -> Namespace:
    return Namespace(
        site="ananda",
        keys_file=keys_file,
        library=library,
        apply=apply,
        rollback=rollback,
        verify_only=verify_only,
        limit=limit,
        out_dir=out_dir or (tmp_path / "out"),
        index_name="fake-index",
    )


def _run(args: Namespace, index: StrictFakeIndex, **kwargs) -> int:
    return SCRIPT.run(
        args,
        index,
        repo_root=REPO_ROOT,
        pause_seconds=0,
        sleep_fn=lambda _seconds: None,
        now=kwargs.get("now", datetime(2026, 10, 24, 22, 0, 0, tzinfo=UTC)),
    )


def test_modules_do_not_import_filename_fix():
    helper = (
        REPO_ROOT / "data_ingestion" / "audio_video" / "audio_access_level_fix.py"
    ).read_text(encoding="utf-8")
    script = (REPO_ROOT / "bin" / "fix_audio_access_level.py").read_text(
        encoding="utf-8"
    )
    for text in (helper, script):
        assert "fix_audio_filenames" not in text
        assert "audio_filename_fix" not in text


def test_parse_keys_skips_comments_and_duplicates():
    text = (
        "# note\ntreasures/talk-a.mp3\n\ntreasures/talk-a.mp3\ntreasures/talk-b.mp3\n"
    )
    assert parse_keys(text) == ["treasures/talk-a.mp3", "treasures/talk-b.mp3"]


def test_helper_and_script_do_not_define_vector_id_encoding():
    helper = (
        REPO_ROOT / "data_ingestion" / "audio_video" / "audio_access_level_fix.py"
    ).read_text(encoding="utf-8")
    script = (REPO_ROOT / "bin" / "fix_audio_access_level.py").read_text(
        encoding="utf-8"
    )
    for text in (helper, script):
        assert "encode_vector_id" not in text
        assert "percent-encode" not in text.lower() or "Do not percent-encode" in text
        assert "quote(" not in text
        assert "%20" not in text


def test_mask_secrets_redacts_key_like_strings():
    assert "[secret]" in mask_secrets("PINECONE_API_KEY=abc123")
    assert "AKIA" not in mask_secrets("AKIA0123456789ABCDEF extra")


def test_out_dir_inside_repo_is_refused():
    with pytest.raises(AccessLevelFixError, match="outside the repository"):
        assert_out_dir_outside_repo(REPO_ROOT / "tmp-out", REPO_ROOT)


def test_backup_path_is_never_overwritten(tmp_path: Path):
    when = datetime(2026, 10, 24, 22, 1, 0, tzinfo=UTC)
    first = new_backup_path(tmp_path, when)
    first.write_text("{}\n", encoding="utf-8")
    second = new_backup_path(tmp_path, when)
    assert first != second
    assert not second.exists()


def test_build_plan_includes_every_chunk_of_a_file():
    records = [
        AudioAccessRecord.from_metadata(
            f"audio||Treasures||audio||Talk A||Test Author||aaa111||{index}",
            _meta("treasures/talk-a.mp3"),
        )
        for index in range(3)
    ]
    rows = build_plan_rows(records, ["treasures/talk-a.mp3"], "Treasures")
    assert len(update_rows(rows)) == 3
    assert {row.vector_id for row in rows} == {
        f"audio||Treasures||audio||Talk A||Test Author||aaa111||{index}"
        for index in range(3)
    }


def test_already_200_uses_all_records_before_limit():
    records = [
        AudioAccessRecord.from_metadata(
            "audio||Treasures||audio||Talk A||Test Author||aaa111||0",
            _meta("treasures/talk-a.mp3"),
        ),
        AudioAccessRecord.from_metadata(
            "audio||Treasures||audio||Talk C||Test Author||ccc333||0",
            _meta(
                "treasures/talk-c.mp3",
                access_level="kriyaban",
                required_access_level=200,
            ),
        ),
    ]
    full = build_plan_rows(
        records, ["treasures/talk-a.mp3", "treasures/talk-c.mp3"], "Treasures"
    )
    limited = apply_file_limit(full, 1)
    assert [row.filename for row in update_rows(limited)] == ["treasures/talk-a.mp3"]
    assert any(row.result == "already_200" for row in limited)


def test_library_mismatch_is_detected_from_all_records():
    records = [
        AudioAccessRecord.from_metadata(
            "audio||Other Library||audio||Talk D||Test Author||ddd444||0",
            _meta("treasures/talk-d.mp3", library="Other Library"),
        )
    ]
    rows = build_plan_rows(records, ["treasures/talk-d.mp3"], "Treasures")
    assert has_library_mismatch(rows)


def test_level_filter_helper_splits_level_0_and_level_200():
    records = [
        _meta("treasures/talk-a.mp3", required_access_level=0),
        _meta(
            "treasures/talk-c.mp3",
            access_level="kriyaban",
            required_access_level=200,
        ),
    ]
    level_0 = filter_records_by_required_level(records, 0)
    level_200 = filter_records_by_required_level(records, 200)
    assert [item["filename"] for item in level_0] == ["treasures/talk-a.mp3"]
    assert [item["filename"] for item in level_200] == [
        "treasures/talk-a.mp3",
        "treasures/talk-c.mp3",
    ]


def test_dry_run_writes_report_and_does_not_write_index(tmp_path: Path):
    index = _multi_chunk_index()
    keys = _write_keys(
        tmp_path / "keys.txt",
        ["treasures/talk-a.mp3", "treasures/talk-b.mp3", "treasures/talk-c.mp3"],
    )
    assert _run(_args(tmp_path, keys), index) == 0
    assert index.updates == []
    assert_no_encoded_ids(index)
    report = read_jsonl(tmp_path / "out" / "access-level-fix-report.jsonl")
    talk_a = [row for row in report if row["filename"] == "treasures/talk-a.mp3"]
    assert len(talk_a) == 3
    assert {row["id"] for row in talk_a} == {
        f"audio||Treasures||audio||Talk A||Test Author||aaa111||{index}"
        for index in range(3)
    }
    for row in talk_a:
        assert row["old_access_level"] == "public"
        assert row["old_required_access_level"] == 0
        assert row["new_access_level"] == TARGET_ACCESS_LEVEL
        assert row["new_required_access_level"] == TARGET_REQUIRED_ACCESS_LEVEL


def test_apply_changes_only_the_two_access_fields(tmp_path: Path, capsys):
    index = _multi_chunk_index()
    keys = _write_keys(
        tmp_path / "keys.txt",
        ["treasures/talk-a.mp3", "treasures/talk-b.mp3"],
    )
    assert _run(_args(tmp_path, keys), index) == 0
    assert _run(_args(tmp_path, keys, apply=True), index) == 0
    captured = capsys.readouterr()
    assert "Files: 2" in captured.out
    assert "Vectors: 4" in captured.out
    first = index.vectors["audio||Treasures||audio||Talk A||Test Author||aaa111||0"]
    metadata = first["metadata"]
    assert metadata["access_level"] == TARGET_ACCESS_LEVEL
    assert metadata["required_access_level"] == TARGET_REQUIRED_ACCESS_LEVEL
    assert isinstance(metadata["required_access_level"], int)
    assert metadata["title"] == "Talk A"
    assert metadata["author"] == "Test Author"
    assert metadata["text"] == "synthetic chunk text"
    assert metadata["filename"] == "treasures/talk-a.mp3"
    assert metadata["library"] == "Treasures"
    assert first["values"] == [0.1, 0.2]
    assert_no_encoded_ids(index)


def test_apply_updates_every_chunk_of_a_file(tmp_path: Path):
    index = _multi_chunk_index()
    keys = _write_keys(tmp_path / "keys.txt", ["treasures/talk-a.mp3"])
    assert _run(_args(tmp_path, keys), index) == 0
    assert _run(_args(tmp_path, keys, apply=True), index) == 0
    for chunk in range(3):
        metadata = index.vectors[
            f"audio||Treasures||audio||Talk A||Test Author||aaa111||{chunk}"
        ]["metadata"]
        assert metadata["access_level"] == TARGET_ACCESS_LEVEL
        assert metadata["required_access_level"] == 200


def test_already_200_is_skipped(tmp_path: Path):
    index = _multi_chunk_index()
    keys = _write_keys(
        tmp_path / "keys.txt",
        ["treasures/talk-a.mp3", "treasures/talk-c.mp3"],
    )
    assert _run(_args(tmp_path, keys), index) == 0
    assert _run(_args(tmp_path, keys, apply=True), index) == 0
    skipped = index.vectors["audio||Treasures||audio||Talk C||Test Author||ccc333||0"]
    assert skipped["metadata"]["required_access_level"] == 200
    updated_ids = {vector_id for vector_id, _meta in index.updates}
    assert "audio||Treasures||audio||Talk C||Test Author||ccc333||0" not in updated_ids


def test_library_mismatch_is_refused(tmp_path: Path):
    index = _multi_chunk_index()
    keys = _write_keys(tmp_path / "keys.txt", ["other/talk-d.mp3"])
    with pytest.raises(AccessLevelFixError, match="different library"):
        _run(_args(tmp_path, keys, library="Treasures"), index)
    assert index.updates == []
    with pytest.raises(AccessLevelFixError, match="different library"):
        _run(_args(tmp_path, keys, library="Treasures", apply=True), index)


def test_apply_without_report_is_refused(tmp_path: Path):
    index = _multi_chunk_index()
    keys = _write_keys(tmp_path / "keys.txt", ["treasures/talk-a.mp3"])
    with pytest.raises(AccessLevelFixError, match="Dry-run report is missing"):
        _run(_args(tmp_path, keys, apply=True), index)
    assert index.updates == []


def test_count_mismatch_is_refused(tmp_path: Path):
    index = _multi_chunk_index()
    keys = _write_keys(tmp_path / "keys.txt", ["treasures/talk-a.mp3"])
    assert _run(_args(tmp_path, keys), index) == 0
    index.vectors.update(
        _vector(
            "audio||Treasures||audio||Talk A||Test Author||aaa111||9",
            "treasures/talk-a.mp3",
        )
    )
    with pytest.raises(AccessLevelFixError, match="does not match the dry-run report"):
        _run(_args(tmp_path, keys, apply=True), index)
    assert index.updates == []


def test_plan_difference_is_refused(tmp_path: Path):
    report_rows = plan_rows_from_report(
        [
            {
                "id": "audio||Treasures||audio||Talk A||Test Author||aaa111||0",
                "filename": "treasures/talk-a.mp3",
                "library": "Treasures",
                "old_access_level": "public",
                "old_required_access_level": 0,
                "new_access_level": TARGET_ACCESS_LEVEL,
                "new_required_access_level": TARGET_REQUIRED_ACCESS_LEVEL,
                "result": "update",
            }
        ]
    )
    live_rows = plan_rows_from_report(
        [
            {
                "id": "audio||Treasures||audio||Talk A||Test Author||aaa111||1",
                "filename": "treasures/talk-a.mp3",
                "library": "Treasures",
                "old_access_level": "public",
                "old_required_access_level": 0,
                "new_access_level": TARGET_ACCESS_LEVEL,
                "new_required_access_level": TARGET_REQUIRED_ACCESS_LEVEL,
                "result": "update",
            }
        ]
    )
    with pytest.raises(AccessLevelFixError, match="Live plan does not match"):
        compare_live_plan_with_report(live_rows, report_rows, {"treasures/talk-a.mp3"})


def test_canary_then_full_apply_writes_two_backups_and_rollback_restores(
    tmp_path: Path,
):
    index = _multi_chunk_index()
    keys = _write_keys(
        tmp_path / "keys.txt",
        ["treasures/talk-a.mp3", "treasures/talk-b.mp3"],
    )
    out_dir = tmp_path / "out"
    assert _run(_args(tmp_path, keys, out_dir=out_dir), index) == 0
    _run(
        _args(tmp_path, keys, apply=True, limit=1, out_dir=out_dir),
        index,
        now=datetime(2026, 10, 24, 22, 10, 0, tzinfo=UTC),
    )
    first_backups = list(out_dir.glob("access-level-fix-backup-*.jsonl"))
    assert len(first_backups) == 1
    canary_backup = first_backups[0]
    talk_a = index.vectors["audio||Treasures||audio||Talk A||Test Author||aaa111||0"]
    talk_b = index.vectors["audio||Treasures||audio||Talk B||Test Author||bbb222||0"]
    assert talk_a["metadata"]["required_access_level"] == 200
    assert talk_b["metadata"]["required_access_level"] == 0

    _run(
        _args(tmp_path, keys, apply=True, out_dir=out_dir),
        index,
        now=datetime(2026, 10, 24, 22, 11, 0, tzinfo=UTC),
    )
    backups = sorted(out_dir.glob("access-level-fix-backup-*.jsonl"))
    assert len(backups) == 2
    assert canary_backup.exists()
    assert canary_backup.read_text(encoding="utf-8") != ""
    assert talk_b["metadata"]["required_access_level"] == 200

    for backup in reversed(backups):
        _run(_args(tmp_path, None, rollback=str(backup), out_dir=out_dir), index)
    assert_no_encoded_ids(index)
    assert talk_a["metadata"]["access_level"] == "public"
    assert talk_a["metadata"]["required_access_level"] == 0
    assert talk_b["metadata"]["access_level"] == "public"
    assert talk_b["metadata"]["required_access_level"] == 0


def test_rollback_restores_old_values_from_backup(tmp_path: Path):
    index = _multi_chunk_index()
    keys = _write_keys(tmp_path / "keys.txt", ["treasures/talk-a.mp3"])
    assert _run(_args(tmp_path, keys), index) == 0
    assert _run(_args(tmp_path, keys, apply=True), index) == 0
    backups = list((tmp_path / "out").glob("access-level-fix-backup-*.jsonl"))
    assert len(backups) == 1
    backup_rows = read_jsonl(backups[0])
    assert len(backup_rows) == 3
    for row in backup_rows:
        assert row["old_access_level"] == "public"
        assert row["old_required_access_level"] == 0
        assert "id" in row
    _run(_args(tmp_path, None, rollback=str(backups[0])), index)
    for chunk in range(3):
        metadata = index.vectors[
            f"audio||Treasures||audio||Talk A||Test Author||aaa111||{chunk}"
        ]["metadata"]
        assert metadata["access_level"] == "public"
        assert metadata["required_access_level"] == 0


def test_verify_failure_prints_rollback_hint(tmp_path: Path, capsys):
    index = _multi_chunk_index()
    keys = _write_keys(tmp_path / "keys.txt", ["treasures/talk-a.mp3"])
    assert _run(_args(tmp_path, keys), index) == 0

    original_update = index.update

    def update_without_change(id: str, set_metadata: dict):
        if is_percent_encoded_vector_id(id):
            raise EncodedVectorIdError(
                "Vector id contains a percent-encoded byte. Use the raw id."
            )
        index.updates.append((id, dict(set_metadata)))

    index.update = update_without_change  # type: ignore[method-assign]
    with pytest.raises(AccessLevelFixError, match="run --rollback with"):
        _run(_args(tmp_path, keys, apply=True), index)
    captured = capsys.readouterr()
    assert "run --rollback with" in captured.out
    backups = list((tmp_path / "out").glob("access-level-fix-backup-*.jsonl"))
    assert backups
    assert rollback_hint(backups[0]) in captured.out
    index.update = original_update  # type: ignore[method-assign]


def test_verify_only_counts_ids_that_still_have_old_values(tmp_path: Path, capsys):
    index = _multi_chunk_index()
    keys = _write_keys(tmp_path / "keys.txt", ["treasures/talk-a.mp3"])
    assert _run(_args(tmp_path, keys), index) == 0
    report = tmp_path / "out" / "access-level-fix-report.jsonl"
    with pytest.raises(AccessLevelFixError, match="Verify-only failed"):
        _run(_args(tmp_path, None, verify_only=str(report)), index)
    before = capsys.readouterr()
    assert "Ids that still have the old values: 3" in before.out

    assert _run(_args(tmp_path, keys, apply=True), index) == 0
    capsys.readouterr()
    assert _run(_args(tmp_path, None, verify_only=str(report)), index) == 0
    after = capsys.readouterr()
    assert "Ids with new values: 3" in after.out
    assert "Ids that still have the old values: 0" in after.out


def test_changed_records_leave_level_0_filter_and_match_level_200(tmp_path: Path):
    index = _multi_chunk_index()
    keys = _write_keys(tmp_path / "keys.txt", ["treasures/talk-a.mp3"])
    assert _run(_args(tmp_path, keys), index) == 0
    assert _run(_args(tmp_path, keys, apply=True), index) == 0
    live = [
        payload["metadata"]
        for vector_id, payload in index.vectors.items()
        if payload["metadata"].get("filename") == "treasures/talk-a.mp3"
    ]
    assert filter_records_by_required_level(live, 0) == []
    assert len(filter_records_by_required_level(live, 200)) == 3


def test_script_refuses_out_dir_inside_repo(tmp_path: Path):
    index = _multi_chunk_index()
    keys = _write_keys(tmp_path / "keys.txt", ["treasures/talk-a.mp3"])
    args = _args(tmp_path, keys, out_dir=REPO_ROOT / "tmp-access-out")
    with pytest.raises(AccessLevelFixError, match="outside the repository"):
        _run(args, index)


def test_fake_index_does_not_find_encoded_ids():
    raw = "audio||Treasures||audio||Talk A||Test Author||aaa111||0"
    encoded = "audio||Treasures||audio||Talk%20A||Test%20Author||aaa111||0"
    index = StrictFakeIndex(_vector(raw, "treasures/talk-a.mp3"))
    found = SCRIPT.fetch_batch(index, [encoded])
    assert found == {}
    assert encoded in index.encoded_ids


def test_fake_index_rejects_encoded_id_on_update():
    raw = "audio||Treasures||audio||Talk A||Test Author||aaa111||0"
    encoded = "audio||Treasures||audio||Talk%20A||Test%20Author||aaa111||0"
    index = StrictFakeIndex(_vector(raw, "treasures/talk-a.mp3"))
    with pytest.raises(EncodedVectorIdError, match="percent-encoded"):
        index.update(id=encoded, set_metadata={"access_level": "kriyaban"})
    assert index.vectors[raw]["metadata"]["access_level"] == "public"


def test_fetch_update_and_rollback_fail_if_encoded_ids_are_sent(tmp_path: Path):
    index = _multi_chunk_index()
    keys = _write_keys(tmp_path / "keys.txt", ["treasures/talk-a.mp3"])
    assert _run(_args(tmp_path, keys), index) == 0
    assert _run(_args(tmp_path, keys, apply=True), index) == 0
    backups = list((tmp_path / "out").glob("access-level-fix-backup-*.jsonl"))
    _run(_args(tmp_path, None, rollback=str(backups[0])), index)
    spaced = [vector_id for vector_id in _fetched_ids(index) if " " in vector_id]
    assert spaced
    assert_no_encoded_ids(index)
    report = read_jsonl(tmp_path / "out" / "access-level-fix-report.jsonl")
    talk_a = [row for row in report if row["filename"] == "treasures/talk-a.mp3"]
    assert all(" " in row["id"] and "%20" not in row["id"] for row in talk_a)
    backup_rows = read_jsonl(backups[0])
    assert all(" " in row["id"] and "%20" not in row["id"] for row in backup_rows)


def test_fetch_metadata_keeps_input_id_order():
    ids = [
        f"audio||Treasures||audio||Talk {number}||Test Author||h{number:03d}||0"
        for number in range(40)
    ]
    vectors: dict[str, dict] = {}
    for vector_id in ids:
        vectors.update(_vector(vector_id, "treasures/talk-order.mp3"))
    index = StrictFakeIndex(vectors)
    fetched = SCRIPT.fetch_metadata(
        index, list(reversed(ids)), sleep_fn=lambda _s: None
    )
    assert list(fetched.keys()) == list(reversed(ids))
    assert all(
        not is_percent_encoded_vector_id(vector_id) for vector_id in _fetched_ids(index)
    )
    assert max(len(call) for call in index.fetch_calls) <= SCRIPT.FETCH_BATCH


def test_fetch_retries_a_failed_batch_then_succeeds():
    raw = "audio||Treasures||audio||Talk A||Test Author||aaa111||0"
    index = StrictFakeIndex(_vector(raw, "treasures/talk-a.mp3"))
    index.next_fetch_errors = [
        RuntimeError("transient fetch error"),
        RuntimeError("transient fetch error"),
    ]
    sleeps: list[float] = []
    found = SCRIPT.fetch_metadata(index, [raw], sleep_fn=sleeps.append)
    assert raw in found
    assert len(sleeps) == 2
    assert sleeps == [SCRIPT.FETCH_BACKOFF_SECONDS, SCRIPT.FETCH_BACKOFF_SECONDS * 2]


def test_fetch_stops_after_three_failed_tries():
    raw = "audio||Treasures||audio||Talk A||Test Author||aaa111||0"
    index = StrictFakeIndex(_vector(raw, "treasures/talk-a.mp3"))
    index.next_fetch_errors = [RuntimeError("transient fetch error") for _ in range(10)]
    with pytest.raises(AccessLevelFixError, match="Fetch failed after 3 tries"):
        SCRIPT.fetch_metadata(index, [raw], sleep_fn=lambda _seconds: None)
    assert len(index.next_fetch_errors) == 7


def test_shared_strict_fake_index_file_is_byte_identical():
    digest = hashlib.sha256(
        Path(__file__).with_name("strict_fake_index.py").read_bytes()
    ).hexdigest()
    assert digest == SHARED_FAKE_INDEX_SHA256
