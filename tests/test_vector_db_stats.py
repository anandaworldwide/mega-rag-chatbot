"""Unit tests for blank authors in bin/vector_db_stats.py."""

import importlib.util
from collections import Counter
from pathlib import Path
from types import SimpleNamespace


def load_script_module():
    script_path = Path(__file__).resolve().parents[1] / "bin" / "vector_db_stats.py"
    spec = importlib.util.spec_from_file_location("vector_db_stats", script_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SCRIPT = load_script_module()


def count(records):
    stats = {"author": Counter(), "library": Counter(), "type": Counter()}
    docs = {}
    blank = 0
    for i, metadata in enumerate(records):
        blank += SCRIPT.process_vector_metadata(
            f"id-{i}", SimpleNamespace(metadata=metadata), stats, docs
        )
    return stats, docs, blank


MIXED = [
    {"author": "Swami Kriyananda", "library": "Ananda", "type": "text"},
    {"author": "Swami Kriyananda", "library": "Ananda", "type": "text"},
    {"author": "Nayaswami Devi", "library": "Ananda", "type": "audio"},
    {"author": "", "library": "Ananda", "type": "text"},
    {"author": "   ", "library": "Ananda", "type": "text"},
    {"library": "Ananda", "type": "text"},
]


def test_blank_authors_are_not_counted():
    stats, _, blank = count(MIXED)
    assert blank == 2
    assert "" not in stats["author"]
    assert "   " not in stats["author"]
    assert stats["author"] == Counter({"Swami Kriyananda": 2, "Nayaswami Devi": 1})


def test_other_counts_match_the_old_behavior():
    stats, _, _ = count(MIXED)
    # Every chunk still counts toward library and type.
    assert stats["library"] == Counter({"Ananda": 6})
    assert stats["type"] == Counter({"text": 5, "audio": 1})
    # The author total is the same as when blank authors were not present.
    without_blank = [m for m in MIXED if m.get("author", "").strip()]
    old_stats, _, _ = count(without_blank)
    assert stats["author"] == old_stats["author"]


def test_no_unknown_author_label():
    stats, _, _ = count(MIXED)
    assert not any("unknown" in key.lower() for key in stats["author"])


def test_drop_blank_keys_removes_only_blank_keys(capsys):
    counts = {"": 3, " ": 1, "Swami Kriyananda": 2, "whole_library": 6}
    assert SCRIPT.drop_blank_keys(counts, "authors") == {
        "Swami Kriyananda": 2,
        "whole_library": 6,
    }
    assert "blank key" in capsys.readouterr().out


def test_fetch_warns_with_the_blank_author_count(capsys):
    vectors = {f"id-{i}": SimpleNamespace(metadata=m) for i, m in enumerate(MIXED)}

    class Index:
        def fetch(self, ids):
            return SimpleNamespace(vectors={i: vectors[i] for i in ids})

    stats = {"author": Counter(), "library": Counter(), "type": Counter()}
    SCRIPT.fetch_and_process_metadata(Index(), list(vectors), stats, {})
    out = capsys.readouterr().out
    assert "Warning: 2 chunks have a blank author." in out
