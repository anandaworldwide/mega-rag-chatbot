"""Tests for --clear-vectors in audio ingest.

These tests mock Pinecone. They make no live or paid calls.
Vector IDs are synthetic. They hold no library text.
"""

from argparse import Namespace
from unittest.mock import Mock, patch

from data_ingestion.audio_video.transcribe_and_ingest_media import (
    _setup_vector_clearing,
)
from data_ingestion.tests.strict_fake_index import StrictFakeIndex
from data_ingestion.utils.pinecone_utils import clear_library_vectors

LIBRARY_X = "Library X"
LIBRARY_Y = "Library Y"
LIST_PAGE_SIZE = 100


class ClearingFakeIndex(StrictFakeIndex):
    """Fake Pinecone index with list pagination and delete by id."""

    def __init__(self, records=None, *, namespace: str = ""):
        super().__init__(records, namespace=namespace)
        self.list_calls: list[dict] = []
        self.delete_calls: list[list[str]] = []
        self.list_page_counts: dict[str, int] = {}

    def list(self, prefix: str = "", limit: int = 100, **kwargs):
        """Yield id pages and record each prefix used."""
        self.list_calls.append({"prefix": prefix, "limit": limit})
        pages = list(super().list(prefix=prefix, limit=limit, **kwargs))
        self.list_page_counts[prefix] = len(pages)
        yield from pages

    def delete(self, ids=None, **kwargs):
        """Remove the given ids from the in-memory store."""
        del kwargs
        to_delete = [str(vector_id) for vector_id in (ids or [])]
        self.delete_calls.append(to_delete)
        with self._lock:
            for vector_id in to_delete:
                self.vectors.pop(vector_id, None)


def _audio_id(library: str, index: int) -> str:
    return f"audio||{library}||audio||Talk {index}||Test Author||aaa{index:03d}||0"


def _video_id(library: str, index: int) -> str:
    return f"video||{library}||video||Clip {index}||Test Author||vvv{index:03d}||0"


def _text_id(library: str, index: int) -> str:
    return f"text||{library}||pdf||Doc {index}||Test Author||ttt{index:03d}||0"


def _records_for_clear_scope() -> dict[str, dict]:
    """IDs for library X audio/video/text and library Y audio."""
    records = {}
    audio_x = [_audio_id(LIBRARY_X, index) for index in range(2)]
    video_x = [_video_id(LIBRARY_X, index) for index in range(2)]
    text_x = [_text_id(LIBRARY_X, index) for index in range(2)]
    audio_y = [_audio_id(LIBRARY_Y, index) for index in range(2)]
    for vector_id in (*audio_x, *video_x, *text_x, *audio_y):
        records[vector_id] = {"metadata": {"library": vector_id.split("||", 2)[1]}}
    return records


def _queue_for_library(library: str) -> Mock:
    ingest_queue = Mock()
    ingest_queue.get_all_items.return_value = [{"data": {"library": library}}]
    return ingest_queue


def _clear_args() -> Namespace:
    return Namespace(clear_vectors=True, override_conflicts=False)


def test_clear_vectors_deletes_audio_and_video_ids_for_library_x_only():
    """Audio and video IDs for library X go. Text X and audio Y stay."""
    index = ClearingFakeIndex(_records_for_clear_scope())
    audio_x = {_audio_id(LIBRARY_X, index) for index in range(2)}
    video_x = {_video_id(LIBRARY_X, index) for index in range(2)}
    text_x = {_text_id(LIBRARY_X, index) for index in range(2)}
    audio_y = {_audio_id(LIBRARY_Y, index) for index in range(2)}

    with patch(
        "data_ingestion.audio_video.transcribe_and_ingest_media.load_pinecone",
        return_value=index,
    ):
        _setup_vector_clearing(_clear_args(), _queue_for_library(LIBRARY_X))

    remaining = set(index.vectors)
    listed_prefixes = [call["prefix"] for call in index.list_calls]
    deleted = {vector_id for batch in index.delete_calls for vector_id in batch}

    assert audio_x | video_x <= deleted
    assert remaining.isdisjoint(audio_x | video_x)
    assert text_x <= remaining
    assert audio_y <= remaining
    assert f"audio||{LIBRARY_X}||" in listed_prefixes
    assert f"video||{LIBRARY_X}||" in listed_prefixes
    assert f"text||{LIBRARY_X}||" not in listed_prefixes


def test_clear_vectors_lists_audio_ids_across_more_than_one_page():
    """Listing must walk every page. One leftover audio ID is a failure."""
    extra_count = LIST_PAGE_SIZE + 1
    records = _records_for_clear_scope()
    paged_audio_ids = [_audio_id(LIBRARY_X, index) for index in range(2, extra_count)]
    for vector_id in paged_audio_ids:
        records[vector_id] = {"metadata": {"library": LIBRARY_X}}
    index = ClearingFakeIndex(records)

    with patch(
        "data_ingestion.audio_video.transcribe_and_ingest_media.load_pinecone",
        return_value=index,
    ):
        _setup_vector_clearing(_clear_args(), _queue_for_library(LIBRARY_X))

    audio_prefix = f"audio||{LIBRARY_X}||"
    remaining_audio_x = [
        vector_id
        for vector_id in index.vectors
        if vector_id.startswith(audio_prefix)
    ]

    assert index.list_page_counts[audio_prefix] > 1
    assert remaining_audio_x == []
    assert _text_id(LIBRARY_X, 0) in index.vectors
    assert _audio_id(LIBRARY_Y, 0) in index.vectors


def test_clear_library_vectors_media_types_do_not_list_text_prefix():
    """Direct helper call lists audio and video prefixes only."""
    index = ClearingFakeIndex(_records_for_clear_scope())

    clear_library_vectors(
        index,
        LIBRARY_X,
        ask_confirmation=False,
        content_types=("audio", "video"),
    )

    listed_prefixes = [call["prefix"] for call in index.list_calls]
    remaining = set(index.vectors)

    assert listed_prefixes == [
        f"audio||{LIBRARY_X}||",
        f"video||{LIBRARY_X}||",
    ]
    assert _audio_id(LIBRARY_X, 0) not in remaining
    assert _video_id(LIBRARY_X, 0) not in remaining
    assert _text_id(LIBRARY_X, 0) in remaining
    assert _audio_id(LIBRARY_Y, 0) in remaining
