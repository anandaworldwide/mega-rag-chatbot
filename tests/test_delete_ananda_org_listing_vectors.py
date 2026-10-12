"""Unit tests for the ananda.org listing-vector delete script."""

import importlib.util
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest


def load_script_module():
    script_path = (
        Path(__file__).resolve().parents[1]
        / "bin"
        / "delete_ananda_org_listing_vectors.py"
    )
    spec = importlib.util.spec_from_file_location(
        "delete_ananda_org_listing_vectors", script_path
    )
    if spec is None or spec.loader is None:
        raise AssertionError("Could not load delete_ananda_org_listing_vectors.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


SCRIPT = load_script_module()


def _match(vector_id, url, title, author_state, metadata=None):
    return SCRIPT.ListingMatch(
        vector_id=vector_id,
        url=url,
        title=title,
        author_state=author_state,
        metadata=metadata or {},
    )


class TestClassifyListingAuthor:
    def test_blank_missing_and_teaser(self):
        assert SCRIPT.classify_listing_author({"author": ""}) == "blank"
        assert SCRIPT.classify_listing_author({"author": "   "}) == "blank"
        assert SCRIPT.classify_listing_author({}) == "missing"
        assert SCRIPT.classify_listing_author({"author": None}) == "missing"
        assert SCRIPT.classify_listing_author({"author": "Asha Nayaswami"}) == "teaser"


class TestListingScanCounts:
    def test_counts_vectors_and_distinct_urls_by_author_state(self):
        scan = SCRIPT.ListingScan(
            matches=[
                _match("a", "https://www.ananda.org/author/asha/", "A", "blank"),
                _match("b", "https://www.ananda.org/author/asha/", "A", "blank"),
                _match("c", "https://www.ananda.org/author/prakash/", "B", "teaser"),
                _match("d", "https://www.ananda.org/healing-prayers/", "C", "missing"),
            ]
        )
        assert scan.vector_count == 4
        assert len(scan.urls) == 3
        breakdown = scan.counts_by_author_state()
        assert breakdown["blank"] == {"vectors": 2, "urls": 1}
        assert breakdown["teaser"] == {"vectors": 1, "urls": 1}
        assert breakdown["missing"] == {"vectors": 1, "urls": 1}


class TestCollectListingVectors:
    def test_selects_all_listing_pages_any_author_state(self):
        index = Mock()
        index.list.return_value = [
            [
                "text||ananda.org||web||list-blank||0",
                "text||ananda.org||web||list-teaser||0",
                "text||ananda.org||web||list-missing||0",
                "text||ananda.org||web||article||0",
            ]
        ]
        index.fetch.return_value = SimpleNamespace(
            vectors={
                "text||ananda.org||web||list-blank||0": SimpleNamespace(
                    metadata={
                        "library": "ananda.org",
                        "author": "",
                        "title": "Asha Nayaswami, Author at Ananda",
                        "url": "https://www.ananda.org/author/asha/",
                    }
                ),
                "text||ananda.org||web||list-teaser||0": SimpleNamespace(
                    metadata={
                        "library": "ananda.org",
                        "author": "Nayaswami Devi",
                        "title": "Blogs and Letters - Nayaswami Jyotish and Nayaswami Devi",
                        "url": "https://www.ananda.org/jyotish-and-devi/blog",
                    }
                ),
                "text||ananda.org||web||list-missing||0": SimpleNamespace(
                    metadata={
                        "library": "ananda.org",
                        "title": "Healing Prayers Blog | Let God's Healing Power Flow",
                        "url": "https://www.ananda.org/healing-prayers/",
                    }
                ),
                "text||ananda.org||web||article||0": SimpleNamespace(
                    metadata={
                        "library": "ananda.org",
                        "author": "Nayaswami Devi",
                        "title": "Yogananda's Views on Hatha Yoga",
                        "url": "https://www.ananda.org/blog/yoganandas-views-on-hatha-yoga/",
                    }
                ),
            }
        )

        scan = SCRIPT.collect_listing_vectors(
            index, "text||ananda.org||web||", "ananda.org"
        )
        states = {match.author_state for match in scan.matches}
        ids = {match.vector_id for match in scan.matches}
        assert scan.scanned == 4
        assert scan.vector_count == 3
        assert states == {"blank", "teaser", "missing"}
        assert "text||ananda.org||web||article||0" not in ids


class TestBackupPath:
    def test_refuses_path_inside_repo(self, tmp_path):
        inside = tmp_path / "repo" / "backup.json"
        inside.parent.mkdir()
        with pytest.raises(SystemExit, match="outside the repository"):
            SCRIPT.assert_backup_path_outside_repo(inside, repo_root=tmp_path / "repo")

    def test_accepts_path_outside_repo(self, tmp_path):
        repo = tmp_path / "repo"
        repo.mkdir()
        outside = tmp_path / "outside" / "backup.json"
        SCRIPT.assert_backup_path_outside_repo(outside, repo_root=repo)

    def test_write_backup_omits_chunk_text(self, tmp_path):
        backup = tmp_path / "outside" / "backup.json"
        scan = SCRIPT.ListingScan(
            matches=[
                _match(
                    "vec-1",
                    "https://www.ananda.org/author/asha/",
                    "Asha Nayaswami, Author at Ananda",
                    "blank",
                    metadata={
                        "author": "",
                        "text": "do-not-store",
                        "library": "ananda.org",
                    },
                )
            ]
        )
        SCRIPT.write_backup(backup, scan, "test-index", "ananda.org")
        payload = json.loads(backup.read_text(encoding="utf-8"))
        assert payload["vector_count"] == 1
        assert payload["vectors"][0]["id"] == "vec-1"
        assert "text" not in payload["vectors"][0]["metadata"]

    def test_apply_refuses_without_complete_backup(self):
        matches = [_match("vec-1", "https://example", "T", "blank")]
        with pytest.raises(SystemExit, match="Backup is not complete"):
            SCRIPT.assert_backup_covers_matches({"vectors": []}, matches)

    def test_apply_accepts_complete_backup(self):
        matches = [_match("vec-1", "https://example", "T", "blank")]
        SCRIPT.assert_backup_covers_matches({"vectors": [{"id": "vec-1"}]}, matches)
