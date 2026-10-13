"""Tests for the blank-author ingest guard."""

import logging

from data_ingestion.utils.author_ingest_guard import (
    apply_author_guard_to_metadata,
    apply_author_guard_to_vectors,
    is_blank_author,
    prepare_ingest_author,
)
from data_ingestion.utils.pinecone_utils import batch_upsert_vectors


class TestIsBlankAuthor:
    def test_empty_and_whitespace_are_blank(self):
        assert is_blank_author("")
        assert is_blank_author("   ")
        assert is_blank_author("\t\n")

    def test_none_and_name_are_not_blank(self):
        assert not is_blank_author(None)
        assert not is_blank_author("Nayaswami Devi")


class TestPrepareIngestAuthor:
    def test_none_stays_none_without_warning(self, caplog):
        caplog.set_level(logging.WARNING)
        assert prepare_ingest_author(None, library="ananda.org") is None
        assert "Blank author" not in caplog.text

    def test_empty_logs_and_returns_none(self, caplog):
        caplog.set_level(logging.WARNING)
        assert (
            prepare_ingest_author(
                "",
                library="ananda.org",
                document_id="doc-1",
                url="https://www.ananda.org/author/asha/",
            )
            is None
        )
        assert "Blank author on ingest" in caplog.text
        assert "ananda.org" in caplog.text
        assert "doc-1" in caplog.text
        assert "https://www.ananda.org/author/asha/" in caplog.text

    def test_whitespace_becomes_blank(self, caplog):
        caplog.set_level(logging.WARNING)
        assert prepare_ingest_author("   ", library="Ananda Library") is None
        assert "Blank author on ingest" in caplog.text

    def test_does_not_invent_a_fallback_name(self):
        assert prepare_ingest_author("", library="ananda.org") is None
        assert prepare_ingest_author("  ", library="ananda.org") is None

    def test_keeps_a_real_author(self):
        assert (
            prepare_ingest_author("Nayaswami Devi", library="ananda.org")
            == "Nayaswami Devi"
        )


class TestApplyAuthorGuardToMetadata:
    def test_omits_blank_author_field(self, caplog):
        caplog.set_level(logging.WARNING)
        metadata = {
            "author": "  ",
            "library": "ananda.org",
            "url": "https://www.ananda.org/author/asha/",
        }
        apply_author_guard_to_metadata(metadata, vector_id="vec-1")
        assert "author" not in metadata
        assert "vec-1" in caplog.text

    def test_leaves_missing_author_alone(self, caplog):
        caplog.set_level(logging.WARNING)
        metadata = {"library": "Ananda Family Wiki", "source": "https://example"}
        apply_author_guard_to_metadata(metadata, vector_id="wiki-1")
        assert "author" not in metadata
        assert "Blank author" not in caplog.text


class TestApplyAuthorGuardToVectors:
    def test_upsert_helper_omits_whitespace_author(self):
        vectors = [
            {
                "id": "id-1",
                "values": [0.1],
                "metadata": {
                    "author": "\t",
                    "library": "Crystal Clarity",
                    "source": "https://example/book",
                },
            }
        ]
        apply_author_guard_to_vectors(vectors)
        assert "author" not in vectors[0]["metadata"]


class TestBatchUpsertAppliesGuard:
    def test_batch_upsert_omits_blank_author(self):
        index = type("Index", (), {})()
        captured = []

        def upsert(vectors):
            captured.extend(vectors)

        index.upsert = upsert
        batch_upsert_vectors(
            index,
            [
                {
                    "id": "id-1",
                    "values": [0.1],
                    "metadata": {
                        "author": "",
                        "library": "ananda.org",
                        "url": "https://www.ananda.org/author/asha/",
                    },
                }
            ],
            log_summary=False,
        )
        assert captured
        assert "author" not in captured[0]["metadata"]
