"""Unit tests for the Pinecone access-level tagging script."""

import importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock


def load_script_module():
    """Load the script module directly from the bin directory."""
    script_path = (
        Path(__file__).resolve().parents[2] / "bin" / "tag_access_level_vectors.py"
    )
    spec = importlib.util.spec_from_file_location(
        "tag_access_level_vectors", script_path
    )
    if spec is None or spec.loader is None:
        raise AssertionError("Could not load tag_access_level_vectors.py")

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SCRIPT_MODULE = load_script_module()
MatchCriteria = SCRIPT_MODULE.MatchCriteria
MatchedVector = SCRIPT_MODULE.MatchedVector
AccessLevelVectorTagger = SCRIPT_MODULE.AccessLevelVectorTagger
build_argument_parser = SCRIPT_MODULE.build_argument_parser
build_sample_vector_payload = SCRIPT_MODULE.build_sample_vector_payload
get_vector_source = SCRIPT_MODULE.get_vector_source
get_update_candidates = SCRIPT_MODULE.get_update_candidates
summarize_sources = SCRIPT_MODULE.summarize_sources


class TestMatchCriteria:
    """Tests for metadata matching behavior."""

    def test_matches_metadata_case_insensitive(self):
        criteria = MatchCriteria(
            title_contains="rubaiyat",
            author_contains="yogananda",
            library_contains="ananda library",
        )

        metadata = {
            "title": "The Rubaiyat of Omar Khayyam",
            "author": "Paramhansa Yogananda",
            "library": "Ananda Library",
        }

        assert criteria.matches_metadata(metadata) is True

    def test_matches_metadata_requires_all_specified_filters(self):
        criteria = MatchCriteria(
            title_contains="rubaiyat",
            filename_contains="rubaiyat.pdf",
        )

        metadata = {
            "title": "The Rubaiyat of Omar Khayyam",
            "filename": "other-book.pdf",
        }

        assert criteria.matches_metadata(metadata) is False

    def test_matches_metadata_rejects_empty_filter_set(self):
        criteria = MatchCriteria()

        try:
            criteria.matches_metadata({"title": "Anything"})
        except ValueError as exc:
            assert "At least one match filter is required" in str(exc)
        else:
            raise AssertionError("Expected ValueError when no filters are provided")

    def test_matches_vector_supports_prefix_filter(self):
        criteria = MatchCriteria(
            vector_id_prefix="text||Ananda Library||db||6. Preparation for Kriya Yoga::"
        )

        assert (
            criteria.matches_vector(
                "text||Ananda Library||db||6. Preparation for Kriya Yoga:: 1. Aum||x||y||0",
                {},
            )
            is True
        )
        assert (
            criteria.matches_vector(
                "text||Ananda Library||db||Different Title||x||y||0",
                {},
            )
            is False
        )


class TestSamplePayload:
    """Tests for sample vector rendering."""

    def test_build_sample_vector_payload_includes_expected_fields(self):
        matched_vector = MatchedVector(
            vector_id="text||Ananda Library||book.pdf||Rubaiyat||Yogananda||abcd1234||0",
            metadata={
                "title": "The Rubaiyat of Omar Khayyam",
                "author": "Paramhansa Yogananda",
                "library": "Ananda Library",
                "source": "https://example.com/rubaiyat",
                "filename": "books/rubaiyat.pdf",
                "access_level": "public",
                "text": "A" * 300,
            },
        )

        payload = build_sample_vector_payload(matched_vector, sample_text_chars=25)

        assert payload["vector_id"] == matched_vector.vector_id
        assert payload["title"] == "The Rubaiyat of Omar Khayyam"
        assert payload["current_access_level"] == "public"
        assert payload["source"] == "https://example.com/rubaiyat"
        assert payload["filename"] == "books/rubaiyat.pdf"
        assert payload["text_preview"] == ("A" * 25) + "..."

    def test_get_vector_source_falls_back_to_no_source_label(self):
        matched_vector = MatchedVector(vector_id="vec-1", metadata={})

        assert get_vector_source(matched_vector) == "(no source)"

    def test_summarize_sources_groups_and_sorts_counts(self):
        matches = [
            MatchedVector(
                vector_id="vec-1",
                metadata={"source": "https://example.com/source-a"},
            ),
            MatchedVector(
                vector_id="vec-2",
                metadata={"source": "https://example.com/source-b"},
            ),
            MatchedVector(
                vector_id="vec-3",
                metadata={"source": "https://example.com/source-a"},
            ),
            MatchedVector(vector_id="vec-4", metadata={}),
        ]

        assert summarize_sources(matches) == [
            ("https://example.com/source-a", 2),
            ("(no source)", 1),
            ("https://example.com/source-b", 1),
        ]


class TestUpdateCandidates:
    """Tests for identifying vectors that still need updates."""

    def test_get_update_candidates_skips_already_tagged_vectors(self):
        matches = [
            MatchedVector(vector_id="vec-1", metadata={"access_level": "public"}),
            MatchedVector(vector_id="vec-2", metadata={"access_level": "kriyaban"}),
            MatchedVector(vector_id="vec-3", metadata={}),
        ]

        candidates = get_update_candidates(matches, "kriyaban")

        assert [candidate.vector_id for candidate in candidates] == ["vec-1", "vec-3"]


class TestCliArguments:
    """Tests for command-line argument requirements."""

    def test_access_level_argument_is_required(self):
        parser = build_argument_parser()

        try:
            parser.parse_args(["--site", "ananda", "--title-contains", "Rubaiyat"])
        except SystemExit as exc:
            assert exc.code == 2
        else:
            raise AssertionError("Expected SystemExit when --access-level is missing")


class TestAccessLevelVectorTagger:
    """Tests for the generic access-level tagger class."""

    def test_tagger_stores_target_access_level(self):
        tagger = AccessLevelVectorTagger(
            index=object(),
            index_name="test-index",
            criteria=MatchCriteria(title_contains="Rubaiyat"),
            target_access_level="minister",
            fetch_batch_size=20,
            list_batch_size=100,
            use_id_cache=False,
            refresh_id_cache=False,
        )

        assert tagger.target_access_level == "minister"

    def test_find_matches_uses_vector_id_prefix_for_listing(self):
        prefix = "text||Ananda Library||db||6. Preparation for Kriya Yoga::"
        matching_id = f"{prefix} 1. Aum Technique||Unknown||374b19d8||37"
        index = Mock()
        index.describe_index_stats.return_value = SimpleNamespace(total_vector_count=1)
        index.list.return_value = iter([[matching_id]])
        index.fetch.return_value = SimpleNamespace(
            vectors={
                matching_id: SimpleNamespace(
                    metadata={
                        "title": "6. Preparation for Kriya Yoga:: 1. Aum Technique",
                        "library": "Ananda Library",
                    }
                )
            }
        )

        tagger = AccessLevelVectorTagger(
            index=index,
            index_name="ananda-test-index",
            criteria=MatchCriteria(vector_id_prefix=prefix),
            target_access_level="kriyaban",
            fetch_batch_size=20,
            list_batch_size=100,
            use_id_cache=False,
            refresh_id_cache=False,
        )

        matches = tagger.find_matches()

        index.list.assert_called_once_with(limit=100, prefix=prefix)
        assert [match.vector_id for match in matches] == [matching_id]

    def test_collect_candidate_ids_uses_local_cache(self, tmp_path):
        prefix = "text||Ananda Library||db||6. Preparation for Kriya Yoga::"
        matching_id = f"{prefix} 1. Aum Technique||Unknown||374b19d8||37"
        index = Mock()

        tagger = AccessLevelVectorTagger(
            index=index,
            index_name="ananda-test-index",
            criteria=MatchCriteria(vector_id_prefix=prefix),
            target_access_level="kriyaban",
            fetch_batch_size=20,
            list_batch_size=100,
            use_id_cache=True,
            refresh_id_cache=False,
        )
        tagger._get_cache_dir = lambda: tmp_path  # type: ignore[method-assign]

        index.list.return_value = iter([[matching_id]])
        first_ids = tagger._collect_candidate_ids()
        second_ids = tagger._collect_candidate_ids()

        assert first_ids == [matching_id]
        assert second_ids == [matching_id]
        index.list.assert_called_once_with(limit=100, prefix=prefix)
