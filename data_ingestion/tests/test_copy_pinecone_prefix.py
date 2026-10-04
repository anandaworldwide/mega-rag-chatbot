"""Copy one Pinecone ID prefix from the live index into the shadow index."""

from types import SimpleNamespace

import pytest

from data_ingestion.bin.copy_pinecone_prefix import (
    BATCH_SIZE,
    copy_prefix,
    ids_from_list_page,
    resolve_index_names,
    vector_to_upsert,
)


def test_resolve_index_names_uses_live_as_source_and_ingest_as_target(monkeypatch):
    monkeypatch.setenv("PINECONE_INDEX_NAME", "ananda-2025-06-19--3-large")
    monkeypatch.setenv("PINECONE_INGEST_INDEX_NAME", "ananda-2026-09-26--3-large")

    source, target = resolve_index_names(None, None)

    assert source == "ananda-2025-06-19--3-large"
    assert target == "ananda-2026-09-26--3-large"


def test_resolve_index_names_refuses_the_same_name(monkeypatch):
    monkeypatch.setenv("PINECONE_INDEX_NAME", "same-index")
    monkeypatch.setenv("PINECONE_INGEST_INDEX_NAME", "same-index")

    with pytest.raises(SystemExit, match="same name"):
        resolve_index_names(None, None)


def test_ids_from_list_page_accepts_strings_and_objects():
    page = ["text||ananda.org||web||a", SimpleNamespace(id="text||ananda.org||web||b")]

    assert ids_from_list_page(page) == [
        "text||ananda.org||web||a",
        "text||ananda.org||web||b",
    ]


def test_dry_run_lists_both_indexes_and_does_not_upsert():
    source = _FakeIndex(["id-1", "id-2"])
    target = _FakeIndex(["id-9"])

    counts = copy_prefix(source, target, "text||ananda.org||web||", apply=False)

    assert counts == {"source": 2, "upserted": 0, "target": 1}
    assert source.fetches == []
    assert target.upserts == []
    assert source.list_prefix == "text||ananda.org||web||"


def test_apply_upserts_values_and_metadata_in_batches_of_100():
    ids = [f"text||ananda.org||web||{i}" for i in range(BATCH_SIZE + 1)]
    source = _FakeIndex(ids)
    target = _FakeIndex([])

    counts = copy_prefix(source, target, "text||ananda.org||web||", apply=True)

    assert counts["source"] == BATCH_SIZE + 1
    assert counts["upserted"] == BATCH_SIZE + 1
    assert counts["target"] == BATCH_SIZE + 1
    assert [len(batch) for batch in target.upserts] == [BATCH_SIZE, 1]
    assert target.upserts[0][0] == {
        "id": ids[0],
        "values": [0.1, 0.2],
        "metadata": {"library": "ananda.org"},
    }


def test_vector_to_upsert_rejects_a_record_with_no_values():
    with pytest.raises(SystemExit, match="no values"):
        vector_to_upsert("id-1", {"metadata": {"library": "ananda.org"}})


class _FakeIndex:
    def __init__(self, ids: list[str]):
        self.ids = list(ids)
        self.list_prefix = None
        self.fetches = []
        self.upserts = []

    def list(self, prefix, limit):
        self.list_prefix = prefix
        for start in range(0, len(self.ids), limit):
            yield self.ids[start : start + limit]

    def fetch(self, ids):
        self.fetches.append(ids)
        vectors = {
            vector_id: SimpleNamespace(
                values=[0.1, 0.2],
                metadata={"library": "ananda.org"},
                sparse_values=None,
            )
            for vector_id in ids
        }
        return SimpleNamespace(vectors=vectors)

    def upsert(self, vectors):
        self.upserts.append(vectors)
        for record in vectors:
            if record["id"] not in self.ids:
                self.ids.append(record["id"])
