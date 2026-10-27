"""Tests for Pinecone fetch lag in filename verify. Data is synthetic."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

from data_ingestion.tests.strict_fake_index import StrictFakeIndex

REPO_ROOT = Path(__file__).resolve().parents[2]
OLD_KEY = "treasures/Talk A.mp3"
NEW_KEY = "treasures/album/Talk A.mp3"
VECTOR_A = "audio||Treasures||Talk A||hash||0"
VECTOR_B = "audio||Treasures||Talk A||hash||1"


def load_script_module():
    """Load the script from bin/."""
    script_path = REPO_ROOT / "bin" / "fix_audio_filenames.py"
    spec = importlib.util.spec_from_file_location(
        "fix_audio_filenames_verify", script_path
    )
    if spec is None or spec.loader is None:
        raise AssertionError("Could not load fix_audio_filenames.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


SCRIPT = load_script_module()


def sample_records() -> list[SCRIPT.AudioRecord]:
    return [
        SCRIPT.AudioRecord(VECTOR_A, OLD_KEY, "Treasures", "Talk A"),
        SCRIPT.AudioRecord(VECTOR_B, OLD_KEY, "Treasures", "Talk A"),
    ]


def index_records(
    filename: str,
) -> dict[str, dict]:
    return {
        VECTOR_A: {
            "metadata": {
                "filename": filename,
                "library": "Treasures",
                "title": "Talk A",
                "type": "audio",
            }
        },
        VECTOR_B: {
            "metadata": {
                "filename": filename,
                "library": "Treasures",
                "title": "Talk A",
                "type": "audio",
            }
        },
    }


class LaggingFetchIndex(StrictFakeIndex):
    """Return a stale filename for the first N fetches."""

    def __init__(self, records, *, stale_filename: str, stale_fetches: int = 2):
        super().__init__(records)
        self.stale_filename = stale_filename
        self.stale_fetches = stale_fetches

    def fetch(self, ids=None, namespace=None, **kwargs):
        result = super().fetch(ids=ids, namespace=namespace, **kwargs)
        if len(self.fetch_calls) <= self.stale_fetches:
            for vector in result.vectors.values():
                if vector.metadata is not None:
                    vector.metadata["filename"] = self.stale_filename
        return result


class NeverMatchIndex(StrictFakeIndex):
    """Fetch always returns a filename that does not match."""

    def fetch(self, ids=None, namespace=None, **kwargs):
        result = super().fetch(ids=ids, namespace=namespace, **kwargs)
        for vector in result.vectors.values():
            if vector.metadata is not None:
                vector.metadata["filename"] = "wrong"
        return result


class ShortFetchIndex(StrictFakeIndex):
    """Fetch drops one id so the vector count changes."""

    def fetch(self, ids=None, namespace=None, **kwargs):
        result = super().fetch(ids=ids, namespace=namespace, **kwargs)
        if result.vectors:
            drop_id = next(iter(result.vectors))
            result.vectors.pop(drop_id)
        return result


def apply_row() -> SCRIPT.RemapRow:
    return SCRIPT.RemapRow(
        old_key=OLD_KEY,
        new_key=NEW_KEY,
        rule="R1",
        result="ok",
        vector_count=2,
        vector_ids=[VECTOR_A, VECTOR_B],
    )


def test_apply_succeeds_when_fetch_lags_then_matches(tmp_path: Path, capsys):
    backup_path = SCRIPT.write_backup(tmp_path, sample_records())
    index = LaggingFetchIndex(
        index_records(OLD_KEY), stale_filename=OLD_KEY, stale_fetches=2
    )
    sleeps: list[float] = []

    updated = SCRIPT.apply_remap(
        index,
        [apply_row()],
        sample_records(),
        backup_path,
        interval=5,
        limit=120,
        sleep=sleeps.append,
    )

    output = capsys.readouterr().out
    assert updated == 2
    assert index.vectors[VECTOR_A]["metadata"]["filename"] == NEW_KEY
    assert index.vectors[VECTOR_B]["metadata"]["filename"] == NEW_KEY
    assert len(index.fetch_calls) == 3
    assert sleeps == [5, 5]
    assert "Verify matched after 10 seconds." in output


def test_verify_fails_after_limit_when_fetch_never_matches():
    index = NeverMatchIndex(index_records(NEW_KEY))
    sleeps: list[float] = []

    with pytest.raises(SCRIPT.FilenameFixError) as exc_info:
        SCRIPT.verify_filenames(
            index,
            [VECTOR_A, VECTOR_B],
            NEW_KEY,
            interval=5,
            limit=10,
            sleep=sleeps.append,
        )

    message = str(exc_info.value)
    assert "Verify failed. Filename does not match." in message
    assert "Waited 10 seconds." in message
    assert len(index.fetch_calls) == 3
    assert sleeps == [5, 5]


def test_rollback_succeeds_when_fetch_lags_then_matches(tmp_path: Path, capsys):
    backup_path = SCRIPT.write_backup(tmp_path, sample_records())
    index = LaggingFetchIndex(
        index_records(NEW_KEY), stale_filename=NEW_KEY, stale_fetches=2
    )
    sleeps: list[float] = []

    restored = SCRIPT.rollback_from_backup(
        index,
        backup_path,
        interval=5,
        limit=120,
        sleep=sleeps.append,
    )

    output = capsys.readouterr().out
    assert restored == 2
    assert index.vectors[VECTOR_A]["metadata"]["filename"] == OLD_KEY
    assert index.vectors[VECTOR_B]["metadata"]["filename"] == OLD_KEY
    assert len(index.fetch_calls) == 3
    assert sleeps == [5, 5]
    assert "Verify matched after 10 seconds." in output


def test_vector_count_change_fails_with_no_retry():
    index = ShortFetchIndex(index_records(NEW_KEY))
    sleeps: list[float] = []

    with pytest.raises(SCRIPT.FilenameFixError) as exc_info:
        SCRIPT.verify_filenames(
            index,
            [VECTOR_A, VECTOR_B],
            NEW_KEY,
            interval=5,
            limit=120,
            sleep=sleeps.append,
        )

    assert str(exc_info.value) == "Verify failed. Vector count changed."
    assert len(index.fetch_calls) == 1
    assert sleeps == []
