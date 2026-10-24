"""Tests for the audio and video Pinecone filename conflict guard."""

import logging

import pytest

from data_ingestion.audio_video.pinecone_utils import (
    apply_filename_conflict_guard,
    store_in_pinecone,
)
from data_ingestion.tests.strict_fake_index import StrictFakeIndex
from data_ingestion.utils.pinecone_utils import generate_vector_id


def _chunk(text, start=0.0, end=1.0):
    return {"text": text, "start": start, "end": end}


def _audio_vector_id(text, chunk_index=0, title="Talk A"):
    return generate_vector_id(
        library_name="Treasures",
        title=title,
        chunk_index=chunk_index,
        source_location="audio",
        source_identifier="public/audio/treasures/album/Talk A.mp3",
        content_type="audio",
        author="Test Author",
        chunk_text=text,
    )


def _index_with_stored(filename_by_id):
    return StrictFakeIndex(
        {
            vector_id: {"filename": filename}
            for vector_id, filename in filename_by_id.items()
        }
    )


def test_store_skips_audio_chunk_when_stored_filename_differs(caplog):
    conflict_text = "same spoken text"
    other_text = "other spoken text"
    conflict_id = _audio_vector_id(conflict_text, chunk_index=0)
    index = _index_with_stored({conflict_id: "treasures/Talk A.mp3"})
    caplog.set_level(logging.INFO)

    skipped_count = store_in_pinecone(
        index,
        [_chunk(conflict_text), _chunk(other_text)],
        [[0.1, 0.2], [0.3, 0.4]],
        author="Test Author",
        library_name="Treasures",
        title="Talk A",
        content_type="audio",
        source_identifier="public/audio/treasures/album/Talk A.mp3",
    )

    assert skipped_count == 1
    assert len(index.upserts) == 1
    written = index.upserts[0]
    assert len(written) == 1
    assert written[0]["id"] != conflict_id
    assert written[0]["metadata"]["filename"] == "treasures/album/Talk A.mp3"
    assert "Skip audio vector write" in caplog.text
    assert "--allow-filename-change" in caplog.text
    assert conflict_id in caplog.text
    assert "treasures/Talk A.mp3" in caplog.text
    assert "treasures/album/Talk A.mp3" in caplog.text
    assert "1 of 2 chunks skipped" in caplog.text


def test_store_writes_audio_chunk_when_stored_filename_matches():
    text = "same spoken text"
    vector_id = _audio_vector_id(text)
    index = _index_with_stored({vector_id: "treasures/album/Talk A.mp3"})

    skipped_count = store_in_pinecone(
        index,
        [_chunk(text)],
        [[0.1, 0.2]],
        author="Test Author",
        library_name="Treasures",
        title="Talk A",
        content_type="audio",
        source_identifier="public/audio/treasures/album/Talk A.mp3",
    )

    assert skipped_count == 0
    assert len(index.upserts) == 1
    written = index.upserts[0]
    assert len(written) == 1
    assert written[0]["id"] == vector_id
    assert written[0]["metadata"]["filename"] == "treasures/album/Talk A.mp3"


def test_filename_guard_does_not_apply_to_text_content():
    text = "same library text"
    id_a = generate_vector_id(
        library_name="Ananda Library",
        title="Essay",
        chunk_index=0,
        source_location="web",
        source_identifier="https://example.com/path-a",
        content_type="text",
        author="Test Author",
        chunk_text=text,
    )
    id_b = generate_vector_id(
        library_name="Ananda Library",
        title="Essay",
        chunk_index=0,
        source_location="web",
        source_identifier="https://example.com/path-b",
        content_type="text",
        author="Test Author",
        chunk_text=text,
    )
    assert id_a == id_b

    vectors = [
        {
            "id": id_b,
            "values": [0.1],
            "metadata": {"filename": "path-b"},
        }
    ]
    index = _index_with_stored({id_a: "path-a"})

    kept = apply_filename_conflict_guard(vectors, index, "text")

    assert kept == vectors
    assert index.fetch_calls == []


def test_allow_filename_change_writes_audio_chunk_when_filename_differs():
    text = "same spoken text"
    vector_id = _audio_vector_id(text)
    index = _index_with_stored({vector_id: "treasures/Talk A.mp3"})

    skipped_count = store_in_pinecone(
        index,
        [_chunk(text)],
        [[0.1, 0.2]],
        author="Test Author",
        library_name="Treasures",
        title="Talk A",
        content_type="audio",
        source_identifier="public/audio/treasures/album/Talk A.mp3",
        allow_filename_change=True,
    )

    assert skipped_count == 0
    assert len(index.upserts) == 1
    written = index.upserts[0]
    assert len(written) == 1
    assert written[0]["id"] == vector_id
    assert written[0]["metadata"]["filename"] == "treasures/album/Talk A.mp3"
    assert index.fetch_calls == []


def test_store_writes_nothing_when_filename_fetch_raises():
    text = "same spoken text"
    index = StrictFakeIndex()
    index.next_fetch_errors = [RuntimeError("pinecone fetch failed")]

    with pytest.raises(RuntimeError, match="pinecone fetch failed"):
        store_in_pinecone(
            index,
            [_chunk(text)],
            [[0.1, 0.2]],
            author="Test Author",
            library_name="Treasures",
            title="Talk A",
            content_type="audio",
            source_identifier="public/audio/treasures/album/Talk A.mp3",
        )

    assert index.upserts == []
