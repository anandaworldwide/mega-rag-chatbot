"""Unit tests for the Pinecone author cleanup script."""

import importlib.util
import os
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest
from pinecone.exceptions import PineconeApiException


def load_script_module():
    """Load the script module directly from the bin directory."""
    script_path = Path(__file__).resolve().parents[1] / "bin" / "clean_pinecone_authors.py"
    spec = importlib.util.spec_from_file_location("clean_pinecone_authors", script_path)
    if spec is None or spec.loader is None:
        raise AssertionError("Could not load clean_pinecone_authors.py")

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SCRIPT_MODULE = load_script_module()
NO_WAIT_LIMITER = SCRIPT_MODULE.FilterUpdateRateLimiter(min_interval_sec=0)


class TestAuthorEqFilter:
    def test_builds_exact_author_filter(self):
        assert SCRIPT_MODULE._author_eq_filter("Gyandev McCord") == {
            "author": {"$eq": "Gyandev McCord"}
        }


class TestFilterUpdateRateLimiter:
    def test_waits_between_calls(self):
        limiter = SCRIPT_MODULE.FilterUpdateRateLimiter(min_interval_sec=0.1)
        limiter._last_call_at = 100.0
        with patch.object(SCRIPT_MODULE.time, "monotonic", return_value=100.05):
            with patch.object(SCRIPT_MODULE.time, "sleep") as sleep_mock:
                limiter.wait()
        sleep_mock.assert_called_once()
        assert sleep_mock.call_args.args[0] == pytest.approx(0.05)


class TestFilterUpdateRetry:
    def test_retries_on_http_429(self):
        index = Mock()
        index.update.side_effect = [
            PineconeApiException(status=429),
            SimpleNamespace(matched_records=7),
        ]
        limiter = NO_WAIT_LIMITER

        with patch.object(SCRIPT_MODULE.time, "sleep") as sleep_mock:
            response = SCRIPT_MODULE._filter_update(
                index,
                limiter,
                filter={"author": {"$eq": "Devi Novak"}},
                set_metadata={"author": "Nayaswami Devi Novak"},
                dry_run=True,
            )

        assert response.matched_records == 7
        assert index.update.call_count == 2
        sleep_mock.assert_called_once()


class TestQueryAuthorVectorIds:
    @patch.dict(os.environ, {"OPENAI_EMBEDDINGS_DIMENSION": "3072"}, clear=False)
    def test_queries_without_values_or_metadata(self):
        index = Mock()
        index.query.return_value = SimpleNamespace(
            matches=[
                SimpleNamespace(id="vec-1"),
                SimpleNamespace(id="vec-2"),
            ]
        )

        ids = SCRIPT_MODULE._query_author_vector_ids(index, "Gyandev McCord", top_k=2)

        assert ids == ["vec-1", "vec-2"]
        index.query.assert_called_once_with(
            vector=[0.0] * 3072,
            top_k=2,
            filter={"author": {"$eq": "Gyandev McCord"}},
            include_metadata=False,
            include_values=False,
        )


class TestCountVectorsByAuthor:
    def test_uses_filter_dry_run(self):
        index = Mock()
        index.update.return_value = SimpleNamespace(matched_records=42)

        count = SCRIPT_MODULE._count_vectors_by_author(
            index, "Devi Novak", NO_WAIT_LIMITER
        )

        assert count == 42
        index.update.assert_called_once_with(
            filter={"author": {"$eq": "Devi Novak"}},
            set_metadata={"author": "Devi Novak"},
            dry_run=True,
        )


class TestBulkReplaceAuthorMetadata:
    def test_replaces_all_matching_vectors_via_filter(self):
        index = Mock()
        index.update.side_effect = [
            SimpleNamespace(matched_records=150),
            SimpleNamespace(matched_records=0),
        ]

        updated = SCRIPT_MODULE._bulk_replace_author_metadata(
            index, "Devi Novak", "Nayaswami Devi Novak", NO_WAIT_LIMITER
        )

        assert updated == 150
        assert index.update.call_count == 2
        index.update.assert_called_with(
            filter={"author": {"$eq": "Devi Novak"}},
            set_metadata={"author": "Nayaswami Devi Novak"},
        )

    def test_loops_until_no_matches_remain(self):
        index = Mock()
        index.update.side_effect = [
            SimpleNamespace(matched_records=100_000),
            SimpleNamespace(matched_records=25),
            SimpleNamespace(matched_records=0),
        ]

        updated = SCRIPT_MODULE._bulk_replace_author_metadata(
            index, "Jyotish Novak", "Nayaswami Jyotish Novak", NO_WAIT_LIMITER
        )

        assert updated == 100_025
        assert index.update.call_count == 3


class TestFindAndReplaceAuthors:
    def test_dry_run_counts_with_filter_and_fetches_samples(self):
        index = Mock()
        index.update.return_value = SimpleNamespace(matched_records=2)
        index.query.return_value = SimpleNamespace(
            matches=[SimpleNamespace(id="vec-1"), SimpleNamespace(id="vec-2")]
        )
        index.fetch.return_value = SimpleNamespace(
            vectors={
                "vec-1": SimpleNamespace(metadata={"author": "Gyandev McCord"}),
                "vec-2": SimpleNamespace(metadata={"author": "Gyandev McCord"}),
            }
        )

        stats = SCRIPT_MODULE.find_and_replace_authors(
            index,
            ["Gyandev McCord"],
            "Nayaswami Gyandev McCord",
            dry_run=True,
            sample_size=2,
            rate_limiter=NO_WAIT_LIMITER,
        )

        assert stats == {"Gyandev McCord": 2}
        index.fetch.assert_called_once_with(ids=["vec-1", "vec-2"])
        assert index.update.call_count == 1
        index.update.assert_called_with(
            filter={"author": {"$eq": "Gyandev McCord"}},
            set_metadata={"author": "Gyandev McCord"},
            dry_run=True,
        )

    def test_live_mode_uses_bulk_filter_update(self):
        index = Mock()
        index.update.side_effect = [
            SimpleNamespace(matched_records=3),
            SimpleNamespace(matched_records=0),
        ]

        stats = SCRIPT_MODULE.find_and_replace_authors(
            index,
            ["Gyandev McCord"],
            "Nayaswami Gyandev McCord",
            dry_run=False,
            rate_limiter=NO_WAIT_LIMITER,
        )

        assert stats == {"Gyandev McCord": 3}
        index.query.assert_not_called()
