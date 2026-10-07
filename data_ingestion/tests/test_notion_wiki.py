"""Tests for the Ananda family wiki ingest."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from types import SimpleNamespace

import pytest
import requests
from botocore.exceptions import ClientError

from data_ingestion.bin.ingest_cli import _run_notion_command, main
from data_ingestion.notion.blocks import (
    LIBRARY_NAME,
    assert_library_is_luca_only,
    blocks_to_text,
    build_chunk_metadata,
    collect_child_refs,
    neutralize_model_tokens,
    normalize_page_id,
    page_has_indexable_text,
    page_plain_text,
    plan_sync,
)
from data_ingestion.notion.client import NotionWikiClient, NotionWikiError
from data_ingestion.notion.sync import (
    WikiPage,
    _upsert_status,
    build_vectors,
    load_roots,
    run_notion_wiki,
    walk_roots,
)
from data_ingestion.utils.ingest_s3_layout import NOTION_WIKI_STATE_KEY

ROOT = Path(__file__).resolve().parents[2]
PAGE_A = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
PAGE_B = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff"
PAGE_C = "cccccccc-dddd-4eee-8fff-000000000000"
DB_ID = "dddddddd-eeee-4fff-8000-111111111111"
DB_ID_2 = "eeeeeeee-ffff-4000-8000-222222222222"


def _page(page_id: str, title: str, edited: str, **extra) -> dict:
    payload = {
        "id": page_id,
        "url": f"https://www.notion.so/{page_id.replace('-', '')}",
        "archived": False,
        "last_edited_time": edited,
        "properties": {
            "Name": {
                "type": "title",
                "title": [{"plain_text": title}],
            },
            "Status": {"type": "select", "select": {"name": "Current"}},
        },
    }
    payload.update(extra)
    return payload


def _paragraph(text: str, block_id: str = "p") -> dict:
    return {
        "id": block_id,
        "type": "paragraph",
        "has_children": False,
        "paragraph": {"rich_text": [{"plain_text": text}]},
        "children": [],
    }


class _Response:
    def __init__(self, status: int, payload: dict, headers: dict | None = None):
        self.status_code = status
        self._payload = payload
        self.headers = headers or {}
        self.text = json.dumps(payload)

    def json(self) -> dict:
        return self._payload


class _MissingS3:
    def __init__(self) -> None:
        self.puts: list[dict] = []

    def get_object(self, **_kwargs):
        raise ClientError(
            {"Error": {"Code": "NoSuchKey", "Message": "missing"}}, "GetObject"
        )

    def put_object(self, **kwargs):
        self.puts.append(kwargs)


class _Index:
    def __init__(self) -> None:
        self.deletes: list[dict] = []
        self.batches: list[list] = []

    def delete(self, filter=None):
        self.deletes.append(filter)

    def upsert(self, vectors):
        self.batches.append(vectors)


class _Splitter:
    def split_text(self, text: str, document_id: str | None = None) -> list[str]:
        return [text]


class _Embeddings:
    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        return [[0.1, 0.2] for _text in texts]


class _Notion:
    def __init__(self, pages: dict, trees: dict, databases: dict | None = None):
        self.pages = pages
        self.trees = trees
        self.databases = databases or {}

    def get_page(self, page_id: str) -> dict:
        return self.pages[page_id]

    def block_tree(self, page_id: str) -> list[dict]:
        return self.trees.get(page_id, [])

    def query_database(self, database_id: str) -> list[dict]:
        return self.databases.get(database_id, [])


def test_blocks_to_text_skips_files_and_keeps_structure():
    blocks = [
        _paragraph("Hello"),
        {
            "id": "img",
            "type": "image",
            "image": {"caption": [{"plain_text": "secret file"}]},
            "children": [],
        },
        {
            "id": "h",
            "type": "heading_2",
            "heading_2": {"rich_text": [{"plain_text": "Section"}]},
            "children": [],
        },
        {
            "id": "q",
            "type": "quote",
            "quote": {"rich_text": [{"plain_text": "A quote"}]},
            "children": [],
        },
        {
            "id": "toggle",
            "type": "toggle",
            "toggle": {"rich_text": [{"plain_text": "More"}]},
            "children": [_paragraph("Inside")],
        },
        {
            "id": "table",
            "type": "table",
            "table": {},
            "children": [
                {
                    "id": "row",
                    "type": "table_row",
                    "table_row": {
                        "cells": [
                            [{"plain_text": "Left"}],
                            [{"plain_text": "Right"}],
                        ]
                    },
                    "children": [],
                }
            ],
        },
        {
            "id": PAGE_B,
            "type": "child_page",
            "child_page": {"title": "Child title"},
            "children": [_paragraph("Do not inline")],
        },
    ]
    text = blocks_to_text(blocks)
    assert "Hello" in text
    assert "## Section" in text
    assert "> A quote" in text
    assert "More" in text
    assert "Inside" in text
    assert "Left | Right" in text
    assert "secret file" not in text
    assert "Do not inline" not in text
    assert "Child title" not in text
    pages, databases = collect_child_refs(blocks)
    assert pages == [PAGE_B]
    assert databases == []


def test_page_plain_text_includes_properties():
    page = _page(PAGE_A, "Home", "2026-01-01T00:00:00.000Z")
    text = page_plain_text(page, [_paragraph("Body")])
    assert text.startswith("Home")
    assert "Status: Current" in text
    assert "Body" in text


def test_chunk_metadata_is_disciple_and_luca_only():
    metadata = build_chunk_metadata(
        title="Home",
        url="https://www.notion.so/home",
        page_id=PAGE_A,
        chunk="Body",
        chunk_index=0,
        total_chunks=1,
    )
    assert metadata["library"] == "Ananda Family Wiki"
    assert metadata["type"] == "text"
    assert metadata["source"] == "https://www.notion.so/home"
    assert metadata["access_level"] == "disciple"
    assert metadata["required_access_level"] == 100
    assert metadata["notion_page_id"] == PAGE_A
    assert metadata["text"] == "Body"
    with pytest.raises(ValueError, match="Vivek"):
        assert_library_is_luca_only("ananda.org")
    with pytest.raises(ValueError, match="Vivek"):
        assert_library_is_luca_only("Crystal Clarity")


def test_normalize_page_id_accepts_url_and_compact_id():
    compact = PAGE_A.replace("-", "")
    assert normalize_page_id(PAGE_A) == PAGE_A
    assert normalize_page_id(compact) == PAGE_A
    assert (
        normalize_page_id(f"https://anandafamily.notion.site/Home-{compact}") == PAGE_A
    )


def test_unreadable_database_does_not_stop_the_walk():
    notion = _Notion(
        pages={
            PAGE_A: _page(PAGE_A, "Visitor Info", "t1"),
            PAGE_B: _page(PAGE_B, "Visible row", "t2"),
        },
        trees={
            PAGE_A: [
                _paragraph("Visitor notes"),
                {
                    "id": DB_ID,
                    "type": "child_database",
                    "child_database": {"title": "Hidden"},
                    "children": [],
                },
                {
                    "id": DB_ID_2,
                    "type": "child_database",
                    "child_database": {"title": "Visible"},
                    "children": [],
                },
            ],
            PAGE_B: [_paragraph("Row body")],
        },
        databases={
            DB_ID_2: [_page(PAGE_B, "Visible row", "t2")],
        },
    )

    def query_database(database_id: str) -> list[dict]:
        if database_id == DB_ID:
            raise NotionWikiError(
                "Notion API 404 for /databases/hidden/query: object_not_found",
                status_code=404,
            )
        return notion.databases.get(database_id, [])

    notion.query_database = query_database
    walk = walk_roots(notion, [SimpleNamespace(name="Root", page_id=PAGE_A)])
    assert set(walk.pages) == {PAGE_A, PAGE_B}
    assert walk.skipped[0].kind == "database"
    assert walk.skipped[0].object_id == DB_ID
    assert walk.skipped[0].parent_title == "Visitor Info"


def test_hidden_data_source_does_not_stop_the_walk():
    notion = _Notion(
        pages={PAGE_A: _page(PAGE_A, "Harvest Festival 2023", "t1")},
        trees={
            PAGE_A: [
                _paragraph("Festival notes"),
                {
                    "id": DB_ID,
                    "type": "child_database",
                    "child_database": {"title": "Schedule"},
                    "children": [],
                },
            ]
        },
    )

    def query_database(database_id: str) -> list[dict]:
        raise NotionWikiError(
            "Notion API 400 for /databases/x/query: does not contain any data sources accessible by this API bot.",
            status_code=400,
        )

    notion.query_database = query_database
    walk = walk_roots(notion, [SimpleNamespace(name="Root", page_id=PAGE_A)])
    assert set(walk.pages) == {PAGE_A}
    assert walk.skipped[0].kind == "database"
    assert walk.skipped[0].parent_title == "Harvest Festival 2023"


def test_repeat_links_do_not_grow_the_queue():
    calls = {"databases": 0}
    notion = _Notion(
        pages={
            PAGE_A: _page(PAGE_A, "Root", "t1"),
            PAGE_B: _page(PAGE_B, "Child", "t2"),
        },
        trees={
            PAGE_A: [
                _paragraph("Root notes"),
                {
                    "id": PAGE_B,
                    "type": "child_page",
                    "child_page": {"title": "Child"},
                    "children": [],
                },
                {
                    "id": PAGE_B,
                    "type": "child_page",
                    "child_page": {"title": "Child again"},
                    "children": [],
                },
                {
                    "id": DB_ID,
                    "type": "child_database",
                    "child_database": {"title": "Rows"},
                    "children": [],
                },
            ],
            PAGE_B: [
                _paragraph("Child notes"),
                {
                    "id": DB_ID,
                    "type": "child_database",
                    "child_database": {"title": "Rows"},
                    "children": [],
                },
            ],
        },
        databases={DB_ID: [_page(PAGE_B, "Child", "t2")]},
    )

    def query_database(database_id: str) -> list[dict]:
        calls["databases"] += 1
        return notion.databases.get(database_id, [])

    notion.query_database = query_database
    walk = walk_roots(notion, [SimpleNamespace(name="Root", page_id=PAGE_A)])
    assert set(walk.pages) == {PAGE_A, PAGE_B}
    assert calls["databases"] == 1


def test_empty_task_cards_are_left_out():
    notion = _Notion(
        pages={
            PAGE_A: _page(PAGE_A, "Task board", "t1"),
            PAGE_B: _page(PAGE_B, "Empty card", "t2"),
            PAGE_C: _page(
                PAGE_C,
                "Card with notes",
                "t3",
                properties={
                    "Name": {
                        "type": "title",
                        "title": [{"plain_text": "Card with notes"}],
                    },
                    "Notes": {
                        "type": "rich_text",
                        "rich_text": [{"plain_text": "Call the center"}],
                    },
                },
            ),
        },
        trees={
            PAGE_A: [
                {
                    "id": DB_ID,
                    "type": "child_database",
                    "child_database": {"title": "Tasks"},
                    "children": [],
                }
            ],
            PAGE_B: [],
            PAGE_C: [],
        },
        databases={
            DB_ID: [
                _page(PAGE_B, "Empty card", "t2"),
                _page(PAGE_C, "Card with notes", "t3"),
            ]
        },
    )
    walk = walk_roots(notion, [SimpleNamespace(name="Board", page_id=PAGE_A)])
    assert set(walk.pages) == {PAGE_C}
    assert walk.empty_count == 2
    assert "Call the center" in walk.pages[PAGE_C].text


def test_upsert_status_uses_the_title():
    assert _upsert_status("UX meeting notes") == "upsert UX meeting notes"
    assert "aaaaaaaa" not in _upsert_status("UX meeting notes")
    long_title = "Notes " * 20
    assert _upsert_status(long_title).startswith("upsert Notes")
    assert _upsert_status(long_title).endswith("...")
    assert len(_upsert_status(long_title)) < 80


def test_model_token_text_is_safe_to_tokenize():
    import tiktoken

    raw = "The stop token is <|endoftext|> and <|fim_prefix|>."
    safe = neutralize_model_tokens(raw)
    assert "<|endoftext|>" not in safe
    assert "<|fim_prefix|>" not in safe
    assert "endoftext" in safe
    encoding = tiktoken.encoding_for_model("text-embedding-3-large")
    encoding.encode(safe)
    with pytest.raises(ValueError, match="endoftext"):
        encoding.encode(raw)


def test_build_vectors_rewrites_model_tokens_before_chunking():
    seen: dict[str, str] = {}

    class _RecordingSplitter:
        def split_text(self, text: str, document_id: str | None = None) -> list[str]:
            seen["text"] = text
            return ["The stop token is <| endoftext |>."]

    page = WikiPage(
        page_id=PAGE_A,
        title="Commands for OpenAI",
        url="https://www.notion.so/example",
        last_edited_time="t1",
        text="The stop token is <|endoftext|>.",
    )
    vectors = build_vectors(page, _RecordingSplitter(), _Embeddings())
    assert "<|endoftext|>" not in seen["text"]
    assert vectors


def test_page_body_text_is_indexable():
    page = _page(PAGE_A, "Guide", "t1")
    assert page_has_indexable_text(page, []) is False
    assert page_has_indexable_text(page, [_paragraph("Bring a notebook")]) is True


def test_server_error_still_stops_the_walk():
    notion = _Notion(
        pages={PAGE_A: _page(PAGE_A, "Root", "t1")},
        trees={PAGE_A: [_paragraph("Body")]},
    )

    def get_page(page_id: str) -> dict:
        raise NotionWikiError("Notion API 500 for /pages/x", status_code=500)

    notion.get_page = get_page
    with pytest.raises(NotionWikiError, match="500"):
        walk_roots(notion, [SimpleNamespace(name="Root", page_id=PAGE_A)])


def test_plan_sync_skips_unchanged_and_deletes_missing():
    plan = plan_sync(
        {PAGE_A: "t1", PAGE_B: "t2"},
        {PAGE_A: "t1", PAGE_C: "t3"},
    )
    assert plan.skip == (PAGE_A,)
    assert plan.upsert == (PAGE_C,)
    assert plan.delete == (PAGE_B,)


def test_walk_roots_follows_child_pages_and_databases_once(caplog):
    child = _page(PAGE_B, "Child", "t2")
    row = _page(PAGE_C, "Row", "t3")
    archived = _page(PAGE_A, "Old", "t0", archived=True)
    notion = _Notion(
        pages={
            PAGE_A: _page(PAGE_A, "Root", "t1"),
            PAGE_B: child,
            PAGE_C: row,
            "archived-row": archived,
        },
        trees={
            PAGE_A: [
                _paragraph("Root body"),
                {
                    "id": PAGE_B,
                    "type": "child_page",
                    "child_page": {"title": "Child"},
                    "children": [],
                },
                {
                    "id": DB_ID,
                    "type": "child_database",
                    "child_database": {"title": "Rows"},
                    "children": [],
                },
            ],
            PAGE_B: [_paragraph("Child body")],
            PAGE_C: [_paragraph("Row body")],
        },
        databases={DB_ID: [row, archived]},
    )
    with caplog.at_level(logging.INFO, logger="data_ingestion.notion.sync"):
        pages = walk_roots(
            notion, [SimpleNamespace(name="Root", page_id=PAGE_A)]
        ).pages
    assert "Fetch page" in caplog.text
    assert "Read blocks for Root" in caplog.text
    assert "Read database" in caplog.text
    assert set(pages) == {PAGE_A, PAGE_B, PAGE_C}
    assert "Child body" in pages[PAGE_B].text
    assert "Root body" in pages[PAGE_A].text
    assert "Child body" not in pages[PAGE_A].text


def test_dry_run_prints_library_and_does_not_write(caplog, tmp_path: Path):
    roots = tmp_path / "roots.json"
    roots.write_text(
        json.dumps({"roots": [{"name": "Home", "page_id": PAGE_A}]}),
        encoding="utf-8",
    )
    notion = _Notion(
        pages={PAGE_A: _page(PAGE_A, "Home", "t1")},
        trees={PAGE_A: [_paragraph("Body")]},
    )
    index = _Index()
    s3 = _MissingS3()
    with caplog.at_level(logging.INFO, logger="data_ingestion.notion.sync"):
        plan = run_notion_wiki(
            site="ananda",
            dry_run=True,
            roots_path=roots,
            notion=notion,
            index=index,
            s3_client=s3,
            bucket="ananda-chatbot",
        )
    assert "Library: Ananda Family Wiki" in caplog.text
    assert "dry-run upsert" in caplog.text
    assert "Dry run: no Pinecone or S3 writes" in caplog.text
    assert plan.upsert == (PAGE_A,)
    assert index.deletes == []
    assert index.batches == []
    assert s3.puts == []


def test_ingest_upserts_changed_pages_and_saves_state(tmp_path: Path):
    roots = tmp_path / "roots.json"
    roots.write_text(
        json.dumps({"roots": [{"name": "Home", "page_id": PAGE_A}]}),
        encoding="utf-8",
    )
    notion = _Notion(
        pages={PAGE_A: _page(PAGE_A, "Home", "t2")},
        trees={PAGE_A: [_paragraph("Body")]},
    )
    index = _Index()
    s3 = _MissingS3()
    s3.get_object = lambda **_kwargs: {
        "Body": _Body(
            json.dumps(
                {"library": LIBRARY_NAME, "pages": {PAGE_A: "t1", PAGE_B: "old"}}
            ).encode()
        )
    }
    plan = run_notion_wiki(
        site="ananda",
        dry_run=False,
        roots_path=roots,
        notion=notion,
        index=index,
        s3_client=s3,
        bucket="ananda-chatbot",
        splitter=_Splitter(),
        embeddings=_Embeddings(),
        progress_dir=tmp_path / "progress",
    )
    assert plan.upsert == (PAGE_A,)
    assert plan.delete == (PAGE_B,)
    assert index.deletes[0]["library"] == {"$eq": LIBRARY_NAME}
    assert index.deletes[0]["notion_page_id"] == {"$eq": PAGE_A}
    assert index.deletes[1]["notion_page_id"] == {"$eq": PAGE_B}
    vector = index.batches[0][0]
    assert vector["metadata"]["library"] == LIBRARY_NAME
    assert vector["metadata"]["required_access_level"] == 100
    assert vector["id"].startswith("text||Ananda Family Wiki||notion||")
    saved = json.loads(s3.puts[-1]["Body"].decode())
    assert s3.puts[-1]["Key"] == NOTION_WIKI_STATE_KEY
    assert saved["library"] == LIBRARY_NAME
    assert saved["pages"] == {PAGE_A: "t2"}


class _MemoryS3(_MissingS3):
    def get_object(self, **kwargs):
        for put in reversed(self.puts):
            if put.get("Key") == kwargs.get("Key"):
                return {"Body": _Body(put["Body"])}
        raise ClientError(
            {"Error": {"Code": "NoSuchKey", "Message": "missing"}},
            "GetObject",
        )


class _BoomEmbeddings:
    def __init__(self) -> None:
        self.calls = 0

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        self.calls += 1
        if self.calls > 1:
            raise RuntimeError("boom")
        return [[0.1, 0.2] for _text in texts]


class _CountEmbeddings:
    def __init__(self) -> None:
        self.calls = 0

    def embed_texts(self, texts: list[str]) -> list[list[float]]:
        self.calls += 1
        return [[0.1, 0.2] for _text in texts]


def _two_page_notion() -> _Notion:
    return _Notion(
        pages={
            PAGE_A: _page(PAGE_A, "Home", "t1"),
            PAGE_B: _page(PAGE_B, "Commands for OpenAI", "t2"),
        },
        trees={
            PAGE_A: [
                _paragraph("Home body"),
                {
                    "id": PAGE_B,
                    "type": "child_page",
                    "child_page": {"title": "Commands for OpenAI"},
                    "children": [],
                },
            ],
            PAGE_B: [_paragraph("Token notes")],
        },
    )


def test_failed_upsert_resumes_with_continue(tmp_path: Path):
    roots = tmp_path / "roots.json"
    roots.write_text(
        json.dumps({"roots": [{"name": "Home", "page_id": PAGE_A}]}),
        encoding="utf-8",
    )
    notion = _two_page_notion()
    progress_dir = tmp_path / "progress"
    s3 = _MemoryS3()
    with pytest.raises(RuntimeError, match="boom"):
        run_notion_wiki(
            site="ananda",
            dry_run=False,
            roots_path=roots,
            notion=notion,
            index=_Index(),
            s3_client=s3,
            bucket="ananda-chatbot",
            splitter=_Splitter(),
            embeddings=_BoomEmbeddings(),
            progress_dir=progress_dir,
        )
    saved = json.loads(s3.puts[-1]["Body"].decode())
    assert saved["pages"] == {PAGE_A: "t1"}
    meta = json.loads((progress_dir / "ananda-meta.json").read_text(encoding="utf-8"))
    assert meta["phase"] == "upsert"
    assert meta["completed"] == [PAGE_A]

    reads: list[str] = []
    real_get_page = notion.get_page

    def get_page(page_id: str) -> dict:
        reads.append(page_id)
        return real_get_page(page_id)

    notion.get_page = get_page
    embeddings = _CountEmbeddings()
    run_notion_wiki(
        site="ananda",
        dry_run=False,
        continue_run=True,
        roots_path=roots,
        notion=notion,
        index=_Index(),
        s3_client=s3,
        bucket="ananda-chatbot",
        splitter=_Splitter(),
        embeddings=embeddings,
        progress_dir=progress_dir,
    )
    assert reads == []
    assert embeddings.calls == 1
    assert not (progress_dir / "ananda-meta.json").exists()


def _seed_state(s3: _MemoryS3, pages: dict[str, str]) -> None:
    s3.puts.append(
        {
            "Key": NOTION_WIKI_STATE_KEY,
            "Body": json.dumps({"library": LIBRARY_NAME, "pages": pages}).encode(),
        }
    )


def test_rechunk_upserts_stored_pages_without_a_tree_walk(tmp_path: Path):
    notion = _Notion(
        pages={
            PAGE_A: _page(PAGE_A, "Home", "t1"),
            PAGE_B: _page(PAGE_B, "Notes", "t1"),
            PAGE_C: _page(PAGE_C, "Child", "t9"),
        },
        trees={
            PAGE_A: [
                _paragraph("Home body"),
                {
                    "id": PAGE_C,
                    "type": "child_page",
                    "child_page": {"title": "Child"},
                    "children": [],
                },
                {
                    "id": DB_ID,
                    "type": "child_database",
                    "child_database": {"title": "Tasks"},
                    "children": [],
                },
            ],
            PAGE_B: [_paragraph("Notes body")],
            PAGE_C: [_paragraph("Child body")],
        },
        databases={DB_ID: [_page(PAGE_C, "Child", "t9")]},
    )
    reads: list[str] = []
    database_reads: list[str] = []
    real_get_page = notion.get_page

    def get_page(page_id: str) -> dict:
        reads.append(page_id)
        return real_get_page(page_id)

    def query_database(database_id: str) -> list[dict]:
        database_reads.append(database_id)
        return notion.databases.get(database_id, [])

    notion.get_page = get_page
    notion.query_database = query_database
    s3 = _MemoryS3()
    _seed_state(s3, {PAGE_A: "t1", PAGE_B: "t1"})
    plan = run_notion_wiki(
        site="ananda",
        dry_run=False,
        rechunk=True,
        roots_path=tmp_path / "roots.json",
        notion=notion,
        index=_Index(),
        s3_client=s3,
        bucket="ananda-chatbot",
        splitter=_Splitter(),
        embeddings=_Embeddings(),
        progress_dir=tmp_path / "progress",
    )
    assert reads == [PAGE_A, PAGE_B]
    assert database_reads == []
    assert plan.upsert == (PAGE_A, PAGE_B)
    assert plan.skip == ()
    saved = json.loads(s3.puts[-1]["Body"].decode())
    assert saved["pages"] == {PAGE_A: "t1", PAGE_B: "t1"}
    assert not (tmp_path / "progress" / "ananda-meta.json").exists()


def test_rechunk_continue_upserts_the_remaining_page(tmp_path: Path):
    notion = _Notion(
        pages={
            PAGE_A: _page(PAGE_A, "Home", "t1"),
            PAGE_B: _page(PAGE_B, "Notes", "t1"),
        },
        trees={
            PAGE_A: [_paragraph("Home body")],
            PAGE_B: [_paragraph("Notes body")],
        },
    )
    progress_dir = tmp_path / "progress"
    s3 = _MemoryS3()
    _seed_state(s3, {PAGE_A: "t1", PAGE_B: "t1"})
    with pytest.raises(RuntimeError, match="boom"):
        run_notion_wiki(
            site="ananda",
            dry_run=False,
            rechunk=True,
            roots_path=tmp_path / "roots.json",
            notion=notion,
            index=_Index(),
            s3_client=s3,
            bucket="ananda-chatbot",
            splitter=_Splitter(),
            embeddings=_BoomEmbeddings(),
            progress_dir=progress_dir,
        )
    reads: list[str] = []
    real_get_page = notion.get_page

    def get_page(page_id: str) -> dict:
        reads.append(page_id)
        return real_get_page(page_id)

    notion.get_page = get_page
    embeddings = _CountEmbeddings()
    plan = run_notion_wiki(
        site="ananda",
        dry_run=False,
        continue_run=True,
        roots_path=tmp_path / "roots.json",
        notion=notion,
        index=_Index(),
        s3_client=s3,
        bucket="ananda-chatbot",
        splitter=_Splitter(),
        embeddings=embeddings,
        progress_dir=progress_dir,
    )
    assert reads == []
    assert embeddings.calls == 1
    assert plan.upsert == (PAGE_B,)
    assert not (progress_dir / "ananda-meta.json").exists()


def test_rechunk_without_state_exits(tmp_path: Path):
    with pytest.raises(SystemExit, match="No saved Notion wiki pages to rechunk"):
        run_notion_wiki(
            site="ananda",
            dry_run=False,
            rechunk=True,
            roots_path=tmp_path / "roots.json",
            notion=_Notion({}, {}),
            index=_Index(),
            s3_client=_MissingS3(),
            bucket="ananda-chatbot",
            splitter=_Splitter(),
            embeddings=_Embeddings(),
            progress_dir=tmp_path / "progress",
        )


def test_continue_without_progress_exits(tmp_path: Path):
    roots = tmp_path / "roots.json"
    roots.write_text(
        json.dumps({"roots": [{"name": "Home", "page_id": PAGE_A}]}),
        encoding="utf-8",
    )
    with pytest.raises(SystemExit, match="No saved Notion wiki progress"):
        run_notion_wiki(
            site="ananda",
            dry_run=False,
            continue_run=True,
            roots_path=roots,
            notion=_Notion({}, {}),
            index=_Index(),
            s3_client=_MissingS3(),
            bucket="ananda-chatbot",
            splitter=_Splitter(),
            embeddings=_Embeddings(),
            progress_dir=tmp_path / "missing-progress",
        )


def test_empty_roots_exit_after_library_name(caplog, tmp_path: Path):
    roots = tmp_path / "roots.json"
    roots.write_text('{"roots": []}', encoding="utf-8")
    with (
        caplog.at_level(logging.INFO, logger="data_ingestion.notion.sync"),
        pytest.raises(SystemExit, match="named root"),
    ):
        run_notion_wiki(
            site="ananda",
            dry_run=True,
            roots_path=roots,
            notion=_Notion({}, {}),
            index=None,
            s3_client=_MissingS3(),
            bucket="ananda-chatbot",
        )
    assert "Library: Ananda Family Wiki" in caplog.text


def test_other_site_is_rejected():
    with pytest.raises(SystemExit, match="ananda"):
        run_notion_wiki(
            site="ananda-public",
            dry_run=True,
            roots_path=ROOT / "data_ingestion/notion/wiki_roots.json",
            notion=_Notion({}, {}),
            index=None,
            s3_client=_MissingS3(),
            bucket="ananda-chatbot",
        )


def test_load_roots_rejects_duplicates(tmp_path: Path):
    path = tmp_path / "roots.json"
    path.write_text(
        json.dumps(
            {
                "roots": [
                    {"name": "One", "page_id": PAGE_A},
                    {"name": "Two", "page_id": PAGE_A},
                ]
            }
        ),
        encoding="utf-8",
    )
    with pytest.raises(SystemExit, match="Duplicate"):
        load_roots(path)


def test_notion_command_rejects_other_sites_before_env(monkeypatch):
    called: list[str] = []
    monkeypatch.setattr(
        "data_ingestion.bin.ingest_cli.load_env", lambda site: called.append(site)
    )
    with pytest.raises(SystemExit, match="ananda"):
        _run_notion_command(SimpleNamespace(site="crystal", dry_run=True, roots=None))
    assert called == []


def test_notion_dry_run_command_skips_pinecone(monkeypatch):
    monkeypatch.setenv("NOTION_WIKI_API_KEY", "test-token")
    monkeypatch.setenv("PINECONE_INGEST_INDEX_NAME", "shared-index")
    monkeypatch.setattr("data_ingestion.bin.ingest_cli.load_env", lambda _site: None)
    monkeypatch.setattr(
        "data_ingestion.bin.ingest_cli.get_bucket_name", lambda: "ananda-chatbot"
    )
    monkeypatch.setattr("data_ingestion.bin.ingest_cli.get_s3_client", lambda: object())
    seen: dict = {}

    def fake_run(**kwargs):
        seen.update(kwargs)

    monkeypatch.setattr("data_ingestion.bin.ingest_cli.run_notion_wiki", fake_run)
    monkeypatch.setattr(
        "data_ingestion.bin.ingest_cli.get_pinecone_client",
        lambda: (_ for _ in ()).throw(AssertionError("pinecone")),
    )
    _run_notion_command(SimpleNamespace(site="ananda", dry_run=True, roots=None))
    assert seen["dry_run"] is True
    assert seen["index"] is None
    assert seen["roots_path"].name == "wiki_roots.json"


def test_notion_command_prints_continue_reminder(monkeypatch, capsys):
    monkeypatch.setenv("NOTION_WIKI_API_KEY", "test-token")
    monkeypatch.setenv("PINECONE_INGEST_INDEX_NAME", "shared-index")
    monkeypatch.setattr("data_ingestion.bin.ingest_cli.load_env", lambda _site: None)
    monkeypatch.setattr(
        "data_ingestion.bin.ingest_cli.get_bucket_name", lambda: "ananda-chatbot"
    )
    monkeypatch.setattr("data_ingestion.bin.ingest_cli.get_s3_client", lambda: object())

    def fake_run(**_kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr("data_ingestion.bin.ingest_cli.run_notion_wiki", fake_run)
    with pytest.raises(SystemExit):
        _run_notion_command(
            SimpleNamespace(
                site="ananda", dry_run=True, roots=None, continue_run=False
            )
        )
    assert "--continue" in capsys.readouterr().err


def test_main_parses_notion_rechunk(monkeypatch):
    seen: dict = {}

    def fake_handler(args):
        seen["rechunk"] = args.rechunk

    monkeypatch.setattr(
        "data_ingestion.bin.ingest_cli._run_notion_command", fake_handler
    )
    main(["notion", "--site", "ananda", "--rechunk"])
    assert seen == {"rechunk": True}


def test_main_parses_notion_continue(monkeypatch):
    seen: dict = {}

    def fake_handler(args):
        seen["continue_run"] = args.continue_run

    monkeypatch.setattr(
        "data_ingestion.bin.ingest_cli._run_notion_command", fake_handler
    )
    main(["notion", "--site", "ananda", "--continue"])
    assert seen == {"continue_run": True}


def test_main_parses_notion_dry_run(monkeypatch):
    seen: dict = {}

    def fake_handler(args):
        seen["command"] = args.command
        seen["dry_run"] = args.dry_run
        seen["site"] = args.site

    monkeypatch.setattr(
        "data_ingestion.bin.ingest_cli._run_notion_command", fake_handler
    )
    main(["notion", "--site", "ananda", "--dry-run"])
    assert seen == {"command": "notion", "dry_run": True, "site": "ananda"}


def test_client_paginates_and_retries_rate_limit():
    responses = [
        _Response(429, {"message": "slow"}, headers={"Retry-After": "0"}),
        _Response(
            200,
            {
                "results": [{"id": "a"}],
                "has_more": True,
                "next_cursor": "cursor-2",
            },
        ),
        _Response(200, {"results": [{"id": "b"}], "has_more": False}),
    ]
    calls: list[dict] = []

    def transport(_method, _url, **kwargs):
        calls.append(kwargs)
        return responses.pop(0)

    client = NotionWikiClient(
        "test-token",
        transport=transport,
        min_interval_seconds=0,
        sleeper=lambda _seconds: None,
    )
    assert [item["id"] for item in client.list_block_children("page")] == ["a", "b"]
    assert calls[2]["params"]["start_cursor"] == "cursor-2"
    assert calls[0]["headers"]["Notion-Version"] == "2022-06-28"


def test_client_does_not_fetch_child_page_blocks():
    def transport(_method, url, **_kwargs):
        if url.endswith("/blocks/parent/children"):
            return _Response(
                200,
                {
                    "results": [
                        {
                            "id": PAGE_B,
                            "type": "child_page",
                            "has_children": True,
                            "child_page": {"title": "Kid"},
                        }
                    ],
                    "has_more": False,
                },
            )
        raise AssertionError(url)

    client = NotionWikiClient(
        "test-token",
        transport=transport,
        min_interval_seconds=0,
        sleeper=lambda _seconds: None,
    )
    tree = client.block_tree("parent")
    assert tree[0]["children"] == []


def test_client_retries_a_read_timeout():
    calls = {"count": 0}

    def transport(_method, _url, **_kwargs):
        calls["count"] += 1
        if calls["count"] < 3:
            raise requests.ReadTimeout("timed out")
        return _Response(200, {"id": PAGE_A, "properties": {}})

    client = NotionWikiClient(
        "test-token",
        transport=transport,
        min_interval_seconds=0,
        sleeper=lambda _seconds: None,
    )
    assert client.get_page(PAGE_A)["id"] == PAGE_A
    assert calls["count"] == 3


def test_client_gives_up_on_a_timeout_after_five_attempts():
    def transport(_method, _url, **_kwargs):
        raise requests.ConnectionError("reset")

    client = NotionWikiClient(
        "test-token",
        transport=transport,
        min_interval_seconds=0,
        sleeper=lambda _seconds: None,
    )
    with pytest.raises(NotionWikiError, match="persisted after retries") as error:
        client.get_page(PAGE_A)
    assert error.value.transient is True


def test_timeout_on_one_page_does_not_stop_the_walk():
    notion = _Notion(
        pages={
            PAGE_A: _page(PAGE_A, "Root", "t1"),
            PAGE_B: _page(PAGE_B, "Worldwide Org Chart", "t2"),
        },
        trees={
            PAGE_A: [
                _paragraph("Org notes"),
                {
                    "id": PAGE_B,
                    "type": "child_page",
                    "child_page": {"title": "Worldwide Org Chart"},
                    "children": [],
                },
            ],
            PAGE_B: [_paragraph("Chart")],
        },
    )
    real_get_page = notion.get_page

    def get_page(page_id: str) -> dict:
        if page_id == PAGE_B:
            raise NotionWikiError(
                "Notion request failed after retries",
                transient=True,
            )
        return real_get_page(page_id)

    notion.get_page = get_page
    walk = walk_roots(notion, [SimpleNamespace(name="Root", page_id=PAGE_A)])
    assert set(walk.pages) == {PAGE_A}
    assert walk.skipped[0].object_id == PAGE_B
    assert walk.skipped[0].kind == "page"


def test_client_error_does_not_include_a_retry_loop_for_404():
    def transport(_method, _url, **_kwargs):
        return _Response(404, {"message": "missing"})

    client = NotionWikiClient(
        "test-token",
        transport=transport,
        min_interval_seconds=0,
        sleeper=lambda _seconds: None,
    )
    with pytest.raises(NotionWikiError, match="404"):
        client.get_page(PAGE_A)


def test_luca_config_keeps_the_wiki_off_vivek():
    config = json.loads((ROOT / "web/site-config/config.json").read_text())
    ananda = config["ananda"]["includedLibraries"]
    public = [
        entry["name"] if isinstance(entry, dict) else entry
        for entry in config["ananda-public"]["includedLibraries"]
    ]
    assert "Ananda Family Wiki" in ananda
    assert "Ananda Family Wiki" not in public
    assert config["ananda"]["libraryMappings"]["Ananda Family Wiki"]["displayName"]
    assert "ananda.org" in public
    assert "Crystal Clarity" in public


class _Body:
    def __init__(self, data: bytes) -> None:
        self._data = data

    def read(self) -> bytes:
        return self._data
