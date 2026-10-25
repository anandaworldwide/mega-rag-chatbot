"""Contract tests for the shared strict fake Pinecone index."""

import pytest

from data_ingestion.tests.strict_fake_index import (
    EncodedVectorIdError,
    StrictFakeIndex,
)


def test_fetch_treats_percent_encoded_id_as_not_found():
    raw_id = "audio||Treasures||audio||Talk A||Test Author||aaa||0"
    index = StrictFakeIndex({raw_id: {"filename": "treasures/Talk A.mp3"}})

    result = index.fetch(ids=[raw_id.replace(" ", "%20")])

    assert result.namespace == ""
    assert result.usage is None
    assert result.vectors == {}
    assert result["vectors"] == {}
    assert index.encoded_ids == [raw_id.replace(" ", "%20")]


def test_fetch_returns_pinecone_8_1_0_shape_for_raw_id():
    raw_id = "audio||Treasures||audio||Talk A||Test Author||aaa||0"
    index = StrictFakeIndex(
        {raw_id: {"metadata": {"filename": "treasures/Talk A.mp3"}, "values": [0.1]}}
    )

    result = index.fetch(ids=[raw_id])
    vector = result.vectors[raw_id]

    assert vector.id == raw_id
    assert vector.values == [0.1]
    assert vector.metadata == {"filename": "treasures/Talk A.mp3"}
    assert vector.sparse_values is None
    assert vector["metadata"]["filename"] == "treasures/Talk A.mp3"
    assert result["namespace"] == ""


def test_update_rejects_percent_encoded_id():
    raw_id = "audio||Treasures||audio||Talk A||Test Author||aaa||0"
    index = StrictFakeIndex({raw_id: {"filename": "treasures/Talk A.mp3"}})

    encoded_id = raw_id.replace(" ", "%20")
    with pytest.raises(EncodedVectorIdError, match="percent-encoded"):
        index.update(id=encoded_id, set_metadata={"filename": "new.mp3"})

    assert index.vectors[raw_id]["metadata"]["filename"] == "treasures/Talk A.mp3"
    assert index.updates == []


def test_update_merges_metadata_for_raw_id():
    raw_id = "audio||Treasures||audio||Talk A||Test Author||aaa||0"
    index = StrictFakeIndex(
        {raw_id: {"filename": "treasures/Talk A.mp3", "library": "Treasures"}}
    )

    index.update(id=raw_id, set_metadata={"filename": "treasures/album/Talk A.mp3"})

    assert index.vectors[raw_id]["metadata"] == {
        "filename": "treasures/album/Talk A.mp3",
        "library": "Treasures",
    }
    assert index.updates == [(raw_id, {"filename": "treasures/album/Talk A.mp3"})]
