from unittest.mock import Mock

import pytest

from crawler.page_processing import upsert_to_pinecone


def test_upsert_to_pinecone_raises_on_partial_batch_failure():
    index = Mock()
    index.upsert.side_effect = [None, Exception("Pinecone timeout")]
    vectors = [{"id": f"vec{i}", "values": [0.1], "metadata": {}} for i in range(150)]

    with pytest.raises(RuntimeError, match="Partial Pinecone upsert failure"):
        upsert_to_pinecone(vectors, index, "test-index")


def test_upsert_to_pinecone_succeeds_when_every_batch_lands():
    index = Mock()
    vectors = [{"id": f"vec{i}", "values": [0.1], "metadata": {}} for i in range(3)]

    upsert_to_pinecone(vectors, index, "test-index")

    assert index.upsert.call_count == 1
