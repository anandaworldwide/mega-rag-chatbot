"""Walk named Notion roots and upsert Luca wiki vectors."""

from __future__ import annotations

import json
import logging
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from botocore.exceptions import ClientError

from data_ingestion.notion.blocks import (
    LIBRARY_NAME,
    SOURCE_LOCATION,
    SyncPlan,
    assert_library_is_luca_only,
    build_chunk_metadata,
    collect_child_refs,
    normalize_page_id,
    page_has_indexable_text,
    page_plain_text,
    page_title,
    plan_sync,
)
from data_ingestion.notion.client import NotionWikiClient, NotionWikiError
from data_ingestion.utils.ingest_s3_layout import NOTION_WIKI_STATE_KEY
from data_ingestion.utils.pinecone_utils import (
    batch_upsert_vectors,
    generate_vector_id,
)

logger = logging.getLogger(__name__)

DEFAULT_ROOTS_PATH = (
    Path(__file__).resolve().parents[2]
    / "data_ingestion"
    / "notion"
    / "wiki_roots.json"
)


@dataclass(frozen=True)
class WikiRoot:
    """One named page that bounds the ingest."""

    name: str
    page_id: str


@dataclass(frozen=True)
class WikiPage:
    """One page ready to chunk."""

    page_id: str
    title: str
    url: str
    last_edited_time: str
    text: str


@dataclass(frozen=True)
class SkippedNotionObject:
    """A page or database the integration could not read."""

    kind: str
    object_id: str
    parent_title: str
    message: str


@dataclass(frozen=True)
class WikiWalk:
    """Pages read in this walk, plus objects the integration could not read."""

    pages: dict[str, WikiPage]
    skipped: tuple[SkippedNotionObject, ...]
    empty_count: int = 0


def load_roots(path: Path) -> list[WikiRoot]:
    """Read named roots. An empty list is an operator error."""
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise SystemExit(f"Wiki roots file is missing: {path}") from error
    except json.JSONDecodeError as error:
        raise SystemExit(f"Wiki roots file is not valid JSON: {path}") from error
    entries = payload.get("roots") if isinstance(payload, dict) else None
    if not isinstance(entries, list) or not entries:
        raise SystemExit(
            f"Add at least one named root to {path}. Each entry needs name and page_id."
        )
    roots: list[WikiRoot] = []
    seen: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict):
            raise SystemExit(f"Each root in {path} must be an object")
        name = str(entry.get("name") or "").strip()
        raw_id = str(entry.get("page_id") or "").strip()
        if not name or not raw_id:
            raise SystemExit(f"Each root in {path} needs name and page_id")
        page_id = normalize_page_id(raw_id)
        if page_id in seen:
            raise SystemExit(f"Duplicate wiki root page id: {page_id}")
        seen.add(page_id)
        roots.append(WikiRoot(name=name, page_id=page_id))
    return roots


def walk_roots(notion: NotionWikiClient, roots: list[WikiRoot]) -> WikiWalk:
    """Collect the root pages and their descendant pages. Skip archived pages."""
    pending: deque[str] = deque()
    queued: set[str] = set()
    for root in roots:
        _enqueue(pending, queued, root.page_id)
    visited: set[str] = set()
    seen_databases: set[str] = set()
    pages: dict[str, WikiPage] = {}
    skipped: list[SkippedNotionObject] = []
    empty_ids: list[str] = []
    while pending:
        page_id = pending.popleft()
        if page_id in visited:
            continue
        visited.add(page_id)
        logger.info(
            "Fetch page %s (read=%s pending=%s)",
            page_id,
            len(pages),
            len(pending),
        )
        page = _read_page(
            notion, page_id, pending, queued, seen_databases, skipped, empty_ids
        )
        if page is not None:
            pages[page_id] = page
    return WikiWalk(pages, tuple(skipped), len(empty_ids))


def _enqueue(pending: deque[str], queued: set[str], raw_id: str) -> None:
    """Add a page id once. Repeat links do not grow the queue."""
    page_id = normalize_page_id(raw_id)
    if page_id in queued:
        return
    queued.add(page_id)
    pending.append(page_id)


def _read_page(
    notion: NotionWikiClient,
    page_id: str,
    pending: deque[str],
    queued: set[str],
    seen_databases: set[str],
    skipped: list[SkippedNotionObject],
    empty_ids: list[str],
) -> WikiPage | None:
    try:
        page = notion.get_page(page_id)
    except NotionWikiError as error:
        _skip_or_raise(error, skipped, "page", page_id, "")
        return None
    if page.get("archived") or page.get("in_trash"):
        logger.info("Skip archived page %s", page_id)
        return None
    title = page_title(page)
    logger.info("Read blocks for %s", title)
    try:
        tree = notion.block_tree(page_id)
    except NotionWikiError as error:
        _skip_or_raise(error, skipped, "page", page_id, title)
        return None
    child_pages, child_databases = collect_child_refs(tree)
    _enqueue_databases(
        notion, child_databases, title, pending, queued, seen_databases, skipped
    )
    for child_id in child_pages:
        _enqueue(pending, queued, child_id)
    if not page_has_indexable_text(page, tree):
        logger.info("Skip empty page %s", title)
        empty_ids.append(page_id)
        return None
    return WikiPage(
        page_id=page_id,
        title=title,
        url=str(page.get("url") or ""),
        last_edited_time=str(page.get("last_edited_time") or ""),
        text=page_plain_text(page, tree),
    )


def _enqueue_databases(
    notion: NotionWikiClient,
    child_databases: list[str],
    title: str,
    pending: deque[str],
    queued: set[str],
    seen_databases: set[str],
    skipped: list[SkippedNotionObject],
) -> None:
    for raw_database_id in child_databases:
        database_id = normalize_page_id(raw_database_id)
        if database_id in seen_databases:
            continue
        seen_databases.add(database_id)
        logger.info("Read database %s", database_id)
        try:
            rows = notion.query_database(database_id)
        except NotionWikiError as error:
            _skip_or_raise(error, skipped, "database", database_id, title)
            continue
        for row in rows:
            if row.get("archived") or row.get("in_trash"):
                continue
            row_id = row.get("id")
            if isinstance(row_id, str) and row_id:
                _enqueue(pending, queued, row_id)


def _skip_or_raise(
    error: NotionWikiError,
    skipped: list[SkippedNotionObject],
    kind: str,
    object_id: str,
    parent_title: str,
) -> None:
    if not _is_unreadable(error):
        raise error
    message = str(error)
    skipped.append(
        SkippedNotionObject(
            kind=kind,
            object_id=object_id,
            parent_title=parent_title,
            message=message,
        )
    )
    logger.warning(
        "Skip %s %s under %s. The integration cannot read it. %s",
        kind,
        object_id,
        parent_title or "(no parent)",
        message,
    )


def _is_unreadable(error: NotionWikiError) -> bool:
    """True when this one object can be skipped and the walk can continue."""
    if error.transient:
        return True
    if error.status_code in {403, 404}:
        return True
    if error.status_code != 400:
        return False
    message = str(error).lower()
    return "data sources accessible" in message or "could not find database" in message


def load_state(s3_client: Any, bucket: str) -> dict[str, str]:
    """Return page id to last_edited_time. A missing object means a first run."""
    try:
        response = s3_client.get_object(Bucket=bucket, Key=NOTION_WIKI_STATE_KEY)
    except ClientError as error:
        code = error.response.get("Error", {}).get("Code", "")
        if code in {"404", "NoSuchKey", "NotFound"}:
            return {}
        raise
    payload = json.loads(response["Body"].read())
    if not isinstance(payload, dict):
        raise SystemExit("Notion wiki state file is not a JSON object")
    library = payload.get("library")
    if library != LIBRARY_NAME:
        raise SystemExit(
            f"Notion wiki state library is {library!r}, expected {LIBRARY_NAME!r}"
        )
    pages = payload.get("pages") or {}
    if not isinstance(pages, dict):
        raise SystemExit("Notion wiki state pages value is not an object")
    return {str(page_id): str(edited) for page_id, edited in pages.items()}


def save_state(s3_client: Any, bucket: str, pages: dict[str, WikiPage]) -> None:
    """Write the page-id set and edit times after a successful run."""
    body = json.dumps(
        {
            "library": LIBRARY_NAME,
            "pages": {page.page_id: page.last_edited_time for page in pages.values()},
        },
        indent=2,
        sort_keys=True,
    ).encode("utf-8")
    s3_client.put_object(
        Bucket=bucket,
        Key=NOTION_WIKI_STATE_KEY,
        Body=body,
        ContentType="application/json",
    )


def delete_page_vectors(index: Any, page_id: str) -> None:
    """Remove vectors for one wiki page. The filter also requires the library."""
    assert_library_is_luca_only(LIBRARY_NAME)
    index.delete(
        filter={
            "library": {"$eq": LIBRARY_NAME},
            "notion_page_id": {"$eq": page_id},
        }
    )


def build_vectors(page: WikiPage, splitter: Any, embeddings: Any) -> list[dict]:
    """Chunk and embed one page. An empty page yields no vectors."""
    if not page.text.strip():
        return []
    chunks = [
        chunk
        for chunk in splitter.split_text(page.text, document_id=page.page_id)
        if chunk and chunk.strip()
    ]
    if not chunks:
        return []
    vectors_values = embeddings.embed_texts(chunks)
    if len(vectors_values) != len(chunks):
        raise RuntimeError(f"Embedding count mismatch for page {page.page_id}")
    vectors: list[dict] = []
    total = len(chunks)
    for index, (chunk, values) in enumerate(zip(chunks, vectors_values, strict=True)):
        metadata = build_chunk_metadata(
            title=page.title,
            url=page.url,
            page_id=page.page_id,
            chunk=chunk,
            chunk_index=index,
            total_chunks=total,
        )
        vectors.append(
            {
                "id": generate_vector_id(
                    library_name=LIBRARY_NAME,
                    title=page.title,
                    chunk_index=index,
                    source_location=SOURCE_LOCATION,
                    source_identifier=page.page_id,
                    content_type="text",
                    chunk_text=chunk,
                ),
                "values": values,
                "metadata": metadata,
            }
        )
    return vectors


def run_notion_wiki(
    *,
    site: str,
    dry_run: bool,
    roots_path: Path,
    notion: NotionWikiClient,
    index: Any | None,
    s3_client: Any,
    bucket: str,
    splitter: Any | None = None,
    embeddings: Any | None = None,
) -> SyncPlan:
    """Walk the roots, then upsert changed pages on the shared index."""
    if site != "ananda":
        raise SystemExit("The notion command requires --site ananda")
    assert_library_is_luca_only(LIBRARY_NAME)
    logger.info("Library: %s", LIBRARY_NAME)
    logger.info("required_access_level: 100")
    roots = load_roots(roots_path)
    for root in roots:
        logger.info("Wiki root %s %s", root.name, root.page_id)
    walk = walk_roots(notion, roots)
    pages = walk.pages
    previous = load_state(s3_client, bucket)
    current = {page.page_id: page.last_edited_time for page in pages.values()}
    plan = plan_sync(previous, current)
    if walk.skipped:
        logger.warning(
            "Skipped %s objects the integration cannot read. Deletes are off for this run.",
            len(walk.skipped),
        )
        plan = SyncPlan(plan.upsert, plan.skip, ())
    logger.info(
        "Wiki pages=%s upsert=%s skip=%s delete=%s inaccessible=%s empty=%s",
        len(pages),
        len(plan.upsert),
        len(plan.skip),
        len(plan.delete),
        len(walk.skipped),
        walk.empty_count,
    )
    if dry_run:
        _log_dry_run(plan, pages)
        return plan
    _apply_plan(
        plan,
        pages,
        index=index,
        splitter=splitter,
        embeddings=embeddings,
        s3_client=s3_client,
        bucket=bucket,
    )
    return plan


def _log_dry_run(plan: SyncPlan, pages: dict[str, WikiPage]) -> None:
    for page_id in plan.upsert:
        logger.info("dry-run upsert %s %s", page_id, pages[page_id].title)
    for page_id in plan.delete:
        logger.info("dry-run delete %s", page_id)
    logger.info("Dry run: no Pinecone or S3 writes")


def _apply_plan(
    plan: SyncPlan,
    pages: dict[str, WikiPage],
    *,
    index: Any | None,
    splitter: Any | None,
    embeddings: Any | None,
    s3_client: Any,
    bucket: str,
) -> None:
    if index is None or splitter is None or embeddings is None:
        raise SystemExit("Notion wiki ingest is missing Pinecone or embedding clients")
    for page_id in plan.upsert:
        _upsert_page(pages[page_id], index, splitter, embeddings)
    for page_id in plan.delete:
        logger.info("Delete %s", page_id)
        delete_page_vectors(index, page_id)
    save_state(s3_client, bucket, pages)
    logger.info("Saved wiki state to s3://%s/%s", bucket, NOTION_WIKI_STATE_KEY)


def _upsert_page(page: WikiPage, index: Any, splitter: Any, embeddings: Any) -> None:
    logger.info("Upsert %s %s", page.page_id, page.title)
    delete_page_vectors(index, page.page_id)
    vectors = build_vectors(page, splitter, embeddings)
    if not vectors:
        return
    _ok, count = batch_upsert_vectors(index, vectors)
    if count != len(vectors):
        raise SystemExit(
            f"Pinecone upsert wrote {count} of {len(vectors)} vectors "
            f"for {page.page_id}. State file was not updated."
        )


def default_splitter() -> Any:
    """Build the text splitter only when a real ingest needs it."""
    from data_ingestion.utils.text_splitter_utils import SpacyTextSplitter

    return SpacyTextSplitter(log_summary_on_split=False)


def default_embeddings() -> Any:
    """Build the ingest embedding client."""
    from data_ingestion.utils.embeddings_utils import OpenAIEmbeddings

    return OpenAIEmbeddings()
