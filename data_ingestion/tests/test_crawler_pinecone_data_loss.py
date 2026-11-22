"""Regression tests for crawler Pinecone data-loss bugs.

These tests mock Pinecone, OpenAI, and network I/O. They make no live calls.
"""

from types import SimpleNamespace
from unittest.mock import MagicMock

from data_ingestion.crawler.config import PageContent
from data_ingestion.crawler.crawl_loop import _process_pinecone_deletions
from data_ingestion.crawler.page_processing import _process_page_content
from data_ingestion.crawler.website_crawler import WebsiteCrawler

SITE_CONFIG = {
    "domain": "example.com",
    "skip_patterns": [],
    "crawl_frequency_days": 7,
}


class RemainingVectorIndex:
    """In-memory Pinecone stand-in. Query returns remaining IDs, capped at top_k."""

    def __init__(self, ids: list[str]):
        self.remaining = set(ids)
        self.query_vectors: list[list[float]] = []
        self.deleted_batches: list[list[str]] = []
        self.upserts: list[list] = []

    def query(self, vector=None, filter=None, top_k=1000, **kwargs):
        self.query_vectors.append(list(vector or []))
        page = list(self.remaining)[:top_k]
        return SimpleNamespace(matches=[SimpleNamespace(id=vid) for vid in page])

    def delete(self, ids=None, **kwargs):
        batch = list(ids or [])
        self.deleted_batches.append(batch)
        for vid in batch:
            self.remaining.discard(vid)

    def upsert(self, vectors=None, **kwargs):
        self.upserts.append(list(vectors or []))


class FailingDeleteIndex:
    """Query finds vectors, but every delete raises."""

    def query(self, vector=None, filter=None, top_k=1000, **kwargs):
        return SimpleNamespace(matches=[SimpleNamespace(id="old-1")])

    def delete(self, ids=None, **kwargs):
        raise RuntimeError("pinecone delete failed")

    def upsert(self, vectors=None, **kwargs):
        raise AssertionError("upsert should not be called")


def _page_content(url: str, n_chunks: int = 101) -> PageContent:
    return PageContent(
        url=url,
        title="Example Page",
        content="Article body with enough words to chunk. " * 20,
        metadata={"type": "text", "source": url},
    )


def _visited_status_calls(crawler) -> list:
    return [
        call
        for call in crawler.mark_url_status.call_args_list
        if call.args and len(call.args) >= 2 and call.args[1] == "visited"
    ]


def _crawler_for_vectors(tmp_path, monkeypatch, *, with_db: bool) -> WebsiteCrawler:
    monkeypatch.setenv("OPENAI_INGEST_EMBEDDINGS_MODEL", "text-embedding-ada-002")
    monkeypatch.setenv("OPENAI_API_KEY", "test-api-key")
    monkeypatch.setenv("OPENAI_INGEST_EMBEDDINGS_DIMENSION", "12")
    monkeypatch.setenv("OPENAI_EMBEDDING_DIMENSION", "99")
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    return WebsiteCrawler(
        "test-site",
        SITE_CONFIG,
        skip_db_init=not with_db,
        skip_robots_init=True,
    )


def test_failed_upsert_batch_leaves_url_not_visited_and_keeps_old_vectors():
    """A failed upsert batch must not mark the URL visited or delete old vectors."""
    url = "https://example.com/article"
    n_chunks = 101
    crawler = MagicMock()
    crawler.skip_listing_pages = False
    crawler.text_splitter.split_text.return_value = [
        f"chunk {i}" for i in range(n_chunks)
    ]
    crawler.should_process_content.return_value = True
    crawler.remove_url_from_pinecone.return_value = 3
    crawler.create_embeddings.return_value = [
        {"id": f"new-{i}", "values": [0.1], "metadata": {"url": url}}
        for i in range(n_chunks)
    ]

    pinecone_index = MagicMock()
    pinecone_index.upsert.side_effect = [None, RuntimeError("upsert batch failed")]

    _process_page_content(
        _page_content(url, n_chunks),
        [],
        url,
        crawler,
        pinecone_index,
        "test-index",
    )

    assert _visited_status_calls(crawler) == []
    crawler.remove_url_from_pinecone.assert_not_called()
    pinecone_index.delete.assert_not_called()


def test_delete_pages_through_more_than_1000_matches(tmp_path, monkeypatch):
    """A URL with more than 1000 vectors must delete every match, not only the first page."""
    crawler = _crawler_for_vectors(tmp_path, monkeypatch, with_db=False)
    all_ids = [f"vec-{i}" for i in range(1105)]
    index = RemainingVectorIndex(all_ids)

    deleted_count = crawler.remove_url_from_pinecone(
        index, "https://example.com/long-page"
    )

    assert deleted_count == 1105
    assert index.remaining == set()
    deleted_ids = [vid for batch in index.deleted_batches for vid in batch]
    assert sorted(deleted_ids) == sorted(all_ids)


def test_query_vector_dimension_comes_from_ingest_env_var(tmp_path, monkeypatch):
    """Dummy query vectors must use OPENAI_INGEST_EMBEDDINGS_DIMENSION, not a hard-coded size."""
    crawler = _crawler_for_vectors(tmp_path, monkeypatch, with_db=False)
    index = RemainingVectorIndex(["vec-a"])

    crawler.remove_url_from_pinecone(index, "https://example.com/dim-page")

    assert index.query_vectors
    assert all(len(vector) == 12 for vector in index.query_vectors)
    assert all(len(vector) != 99 for vector in index.query_vectors)
    assert all(len(vector) != 3072 for vector in index.query_vectors)


def test_failed_delete_leaves_cleanup_not_complete(tmp_path, monkeypatch):
    """A failed Pinecone delete must not mark 404 cleanup complete."""
    crawler = _crawler_for_vectors(tmp_path, monkeypatch, with_db=True)
    url = "https://example.com/gone"
    crawler.add_url_to_queue(url)
    crawler.mark_url_status(url, "deleted", "HTTP 404")
    index = FailingDeleteIndex()

    processed_count = _process_pinecone_deletions(crawler, index)

    assert processed_count == 0
    pending = crawler.get_urls_pending_pinecone_deletion()
    assert crawler.normalize_url(url) in pending
    assert crawler.cursor is not None
    crawler.cursor.execute(
        "SELECT content_hash FROM crawl_queue WHERE url = ?",
        (crawler.normalize_url(url),),
    )
    row = crawler.cursor.fetchone()
    assert row is not None
    assert row["content_hash"] != "pinecone_cleaned"
    crawler.close()
