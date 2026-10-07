"""Walk named Notion roots and upsert Luca wiki vectors."""

from __future__ import annotations

import json
import logging
import os
from collections import deque
from collections.abc import Callable
from dataclasses import asdict, dataclass
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
    neutralize_model_tokens,
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
DEFAULT_PROGRESS_DIR = Path(__file__).resolve().parent / ".progress"
CONTINUE_COMMAND = (
    "caffeinate -i uv run python data_ingestion/bin/ingest_cli.py "
    "notion --site ananda --continue"
)


def continue_reminder() -> str:
    """Tell the operator how to resume after an unexpected stop."""
    return (
        "If the command saved progress, run this after you fix the problem: "
        + CONTINUE_COMMAND
    )


class NotionRunProgress:
    """Local resume file for one wiki run. This is not the S3 state file."""

    def __init__(self, directory: Path) -> None:
        self.directory = directory
        self.meta_path = directory / "ananda-meta.json"
        self.pages_path = directory / "ananda-pages.jsonl"
        self._stored_ids = {page.page_id for page in self._read_pages().values()}

    def exists(self) -> bool:
        return self.meta_path.is_file()

    def clear(self) -> None:
        for path in (self.meta_path, self.pages_path):
            if path.is_file():
                path.unlink()
        self._stored_ids.clear()

    def load(self) -> dict[str, Any] | None:
        meta = self._read_meta()
        if meta is None:
            return None
        meta["pages"] = self._read_pages()
        return meta

    def save_walk(self, snapshot: dict[str, Any], phase: str = "walk") -> None:
        self.directory.mkdir(parents=True, exist_ok=True)
        for page in snapshot["pages"].values():
            self._append_page(page)
        self._write_meta(
            {
                "library": LIBRARY_NAME,
                "phase": phase,
                "mode": "rechunk" if phase == "rechunk" else "walk",
                "pending": list(snapshot["pending"]),
                "queued": list(snapshot["queued"]),
                "visited": list(snapshot["visited"]),
                "seen_databases": list(snapshot["seen_databases"]),
                "skipped": [asdict(item) for item in snapshot["skipped"]],
                "empty_ids": list(snapshot["empty_ids"]),
                "completed": [],
            }
        )
        logger.info(
            "Saved progress phase=%s pages=%s pending=%s",
            phase,
            len(snapshot["pages"]),
            len(snapshot["pending"]),
        )

    def mark_upsert(self, completed: list[str]) -> None:
        meta = self._read_meta() or {}
        meta["phase"] = "upsert"
        meta["completed"] = completed
        meta["pending"] = []
        self._write_meta(meta)

    def note_completed(self, page_id: str) -> None:
        meta = self._read_meta() or {}
        completed = [str(item) for item in meta.get("completed") or []]
        if page_id not in completed:
            completed.append(page_id)
        meta["phase"] = "upsert"
        meta["completed"] = completed
        self._write_meta(meta)
        logger.debug("Saved progress phase=upsert completed=%s", len(completed))

    def _append_page(self, page: WikiPage) -> None:
        if page.page_id in self._stored_ids:
            return
        with self.pages_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(asdict(page), sort_keys=True) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        self._stored_ids.add(page.page_id)

    def _read_pages(self) -> dict[str, WikiPage]:
        pages: dict[str, WikiPage] = {}
        if not self.pages_path.is_file():
            return pages
        for line in self.pages_path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                item = json.loads(line)
            except json.JSONDecodeError:
                logger.warning("Skipped a truncated wiki progress line")
                continue
            if isinstance(item, dict) and item.get("page_id"):
                page = WikiPage(
                    page_id=str(item["page_id"]),
                    title=str(item.get("title") or ""),
                    url=str(item.get("url") or ""),
                    last_edited_time=str(item.get("last_edited_time") or ""),
                    text=str(item.get("text") or ""),
                )
                pages[page.page_id] = page
        return pages

    def _read_meta(self) -> dict[str, Any] | None:
        if not self.meta_path.is_file():
            return None
        payload = json.loads(self.meta_path.read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            raise SystemExit("Notion wiki progress file is not a JSON object")
        if payload.get("library") != LIBRARY_NAME:
            raise SystemExit(
                f"Notion wiki progress library is {payload.get('library')!r}, "
                f"expected {LIBRARY_NAME!r}"
            )
        return payload

    def _write_meta(self, payload: dict[str, Any]) -> None:
        self.directory.mkdir(parents=True, exist_ok=True)
        payload["library"] = LIBRARY_NAME
        temporary = self.meta_path.with_suffix(".json.tmp")
        temporary.write_text(
            json.dumps(payload, indent=2, sort_keys=True),
            encoding="utf-8",
        )
        temporary.replace(self.meta_path)


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


def walk_roots(
    notion: NotionWikiClient,
    roots: list[WikiRoot],
    *,
    resume: dict[str, Any] | None = None,
    on_checkpoint: Callable[[dict[str, Any]], None] | None = None,
) -> WikiWalk:
    """Collect the root pages and their descendant pages. Skip archived pages."""
    if resume is None:
        pending: deque[str] = deque()
        queued: set[str] = set()
        for root in roots:
            _enqueue(pending, queued, root.page_id)
        visited: set[str] = set()
        seen_databases: set[str] = set()
        pages: dict[str, WikiPage] = {}
        skipped: list[SkippedNotionObject] = []
        empty_ids: list[str] = []
    else:
        pending = deque(str(item) for item in resume.get("pending") or [])
        queued = {str(item) for item in resume.get("queued") or []}
        visited = {str(item) for item in resume.get("visited") or []}
        seen_databases = {str(item) for item in resume.get("seen_databases") or []}
        pages = dict(resume.get("pages") or {})
        skipped = list(resume.get("skipped") or [])
        empty_ids = [str(item) for item in resume.get("empty_ids") or []]
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
        if on_checkpoint is not None:
            on_checkpoint(
                _walk_snapshot(
                    pending, queued, visited, seen_databases, pages, skipped, empty_ids
                )
            )
    return WikiWalk(pages, tuple(skipped), len(empty_ids))


def refresh_known_pages(
    notion: NotionWikiClient,
    page_ids: list[str],
    *,
    resume: dict[str, Any] | None = None,
    on_checkpoint: Callable[[dict[str, Any]], None] | None = None,
) -> WikiWalk:
    """Fetch stored page ids. Do not follow child pages or databases."""
    if resume is None:
        pending: deque[str] = deque()
        queued: set[str] = set()
        for raw_id in page_ids:
            _enqueue(pending, queued, raw_id)
        visited: set[str] = set()
        pages: dict[str, WikiPage] = {}
        skipped: list[SkippedNotionObject] = []
        empty_ids: list[str] = []
    else:
        pending = deque(str(item) for item in resume.get("pending") or [])
        queued = {str(item) for item in resume.get("queued") or []}
        visited = {str(item) for item in resume.get("visited") or []}
        pages = dict(resume.get("pages") or {})
        skipped = list(resume.get("skipped") or [])
        empty_ids = [str(item) for item in resume.get("empty_ids") or []]
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
            notion,
            page_id,
            pending,
            queued,
            set(),
            skipped,
            empty_ids,
            follow_links=False,
        )
        if page is not None:
            pages[page_id] = page
        if on_checkpoint is not None:
            on_checkpoint(
                _walk_snapshot(pending, queued, visited, set(), pages, skipped, empty_ids)
            )
    return WikiWalk(pages, tuple(skipped), len(empty_ids))


def _walk_snapshot(
    pending: deque[str],
    queued: set[str],
    visited: set[str],
    seen_databases: set[str],
    pages: dict[str, WikiPage],
    skipped: list[SkippedNotionObject],
    empty_ids: list[str],
) -> dict[str, Any]:
    return {
        "pending": pending,
        "queued": queued,
        "visited": visited,
        "seen_databases": seen_databases,
        "pages": pages,
        "skipped": skipped,
        "empty_ids": empty_ids,
    }


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
    *,
    follow_links: bool = True,
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
    if follow_links:
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
    _put_state(
        s3_client,
        bucket,
        {page.page_id: page.last_edited_time for page in pages.values()},
    )


def remember_page(s3_client: Any, bucket: str, page: WikiPage) -> None:
    """Record one upserted page in the S3 state file."""
    pages = load_state(s3_client, bucket)
    pages[page.page_id] = page.last_edited_time
    _put_state(s3_client, bucket, pages)


def _put_state(s3_client: Any, bucket: str, pages: dict[str, str]) -> None:
    body = json.dumps(
        {"library": LIBRARY_NAME, "pages": pages},
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
    text = neutralize_model_tokens(page.text)
    if text != page.text:
        logger.debug("Rewrote model tokens in %s", page.title)
    chunks = [
        chunk
        for chunk in splitter.split_text(text, document_id=page.page_id)
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
    continue_run: bool = False,
    rechunk: bool = False,
    progress_dir: Path | None = None,
) -> SyncPlan:
    """Walk the roots, or rechunk stored pages, then upsert."""
    _reject_bad_notion_run(site, dry_run, continue_run)
    logger.info("Library: %s", LIBRARY_NAME)
    logger.info("required_access_level: 100")
    progress: NotionRunProgress | None = None
    if dry_run:
        walk = _dry_run_walk(notion, roots_path, s3_client, bucket, rechunk)
        completed: set[str] = set()
        rechunk_pages = rechunk
    else:
        progress = NotionRunProgress(progress_dir or DEFAULT_PROGRESS_DIR)
        walk, completed, rechunk_pages = _walk_for_run(
            notion,
            roots_path,
            progress,
            s3_client,
            bucket,
            continue_run=continue_run,
            rechunk=rechunk,
        )
    pages = walk.pages
    plan = _build_plan(s3_client, bucket, walk, completed, rechunk_pages)
    if dry_run:
        _log_dry_run(plan, pages)
        return plan
    if progress is None:
        raise SystemExit("Notion wiki progress was not opened")
    progress.mark_upsert(sorted(completed))

    def _note_upsert(page: WikiPage) -> None:
        remember_page(s3_client, bucket, page)
        progress.note_completed(page.page_id)

    _apply_plan(
        plan,
        pages,
        index=index,
        splitter=splitter,
        embeddings=embeddings,
        s3_client=s3_client,
        bucket=bucket,
        on_upsert=_note_upsert,
    )
    progress.clear()
    return plan


def _reject_bad_notion_run(site: str, dry_run: bool, continue_run: bool) -> None:
    if site != "ananda":
        raise SystemExit("The notion command requires --site ananda")
    assert_library_is_luca_only(LIBRARY_NAME)
    if dry_run and continue_run:
        raise SystemExit("Do not combine --continue with --dry-run.")


def _dry_run_walk(
    notion: NotionWikiClient,
    roots_path: Path,
    s3_client: Any,
    bucket: str,
    rechunk: bool,
) -> WikiWalk:
    if rechunk:
        return refresh_known_pages(notion, _stored_page_ids(s3_client, bucket))
    roots = load_roots(roots_path)
    _log_roots(roots)
    return walk_roots(notion, roots)


def _log_roots(roots: list[WikiRoot]) -> None:
    for root in roots:
        logger.info("Wiki root %s %s", root.name, root.page_id)


def _stored_page_ids(s3_client: Any, bucket: str) -> list[str]:
    page_ids = sorted(load_state(s3_client, bucket))
    if not page_ids:
        raise SystemExit("No saved Notion wiki pages to rechunk.")
    logger.info("Rechunk stored pages: %s", len(page_ids))
    return page_ids


def _build_plan(
    s3_client: Any,
    bucket: str,
    walk: WikiWalk,
    completed: set[str],
    rechunk_pages: bool,
) -> SyncPlan:
    pages = walk.pages
    previous = load_state(s3_client, bucket)
    current = {page.page_id: page.last_edited_time for page in pages.values()}
    plan = plan_sync(previous, current)
    if rechunk_pages:
        plan = SyncPlan(tuple(pages), (), plan.delete)
    if walk.skipped:
        logger.warning(
            "Skipped %s objects the integration cannot read. Deletes are off for this run.",
            len(walk.skipped),
        )
        plan = SyncPlan(plan.upsert, plan.skip, ())
    if completed:
        plan = SyncPlan(
            tuple(page_id for page_id in plan.upsert if page_id not in completed),
            plan.skip,
            plan.delete,
        )
    logger.info(
        "Wiki pages=%s upsert=%s skip=%s delete=%s inaccessible=%s empty=%s",
        len(pages),
        len(plan.upsert),
        len(plan.skip),
        len(plan.delete),
        len(walk.skipped),
        walk.empty_count,
    )
    return plan


def _walk_for_run(
    notion: NotionWikiClient,
    roots_path: Path,
    progress: NotionRunProgress,
    s3_client: Any,
    bucket: str,
    *,
    continue_run: bool,
    rechunk: bool,
) -> tuple[WikiWalk, set[str], bool]:
    if continue_run:
        return _resume_saved_run(notion, roots_path, progress, rechunk)
    _clear_stale_progress(progress, rechunk)
    if rechunk:
        walk = refresh_known_pages(
            notion,
            _stored_page_ids(s3_client, bucket),
            on_checkpoint=lambda snapshot: progress.save_walk(snapshot, "rechunk"),
        )
        return walk, set(), True
    roots = load_roots(roots_path)
    _log_roots(roots)
    walk = walk_roots(notion, roots, on_checkpoint=progress.save_walk)
    return walk, set(), False


def _clear_stale_progress(progress: NotionRunProgress, rechunk: bool) -> None:
    if not progress.exists():
        return
    if rechunk:
        logger.warning(
            "Saved progress exists. This rechunk starts from the stored page list. "
            "Use --continue to resume the saved run."
        )
    else:
        logger.warning(
            "Saved progress exists. This run starts from the first root. "
            "Use --continue to resume the saved run."
        )
    progress.clear()


def _resume_saved_run(
    notion: NotionWikiClient,
    roots_path: Path,
    progress: NotionRunProgress,
    rechunk: bool,
) -> tuple[WikiWalk, set[str], bool]:
    saved = progress.load()
    if saved is None:
        raise SystemExit(
            "No saved Notion wiki progress. Run the command without --continue."
        )
    completed = {str(item) for item in saved.get("completed") or []}
    logger.info(
        "Continue saved run phase=%s pages=%s completed=%s",
        saved.get("phase"),
        len(saved.get("pages") or {}),
        len(completed),
    )
    if saved.get("phase") == "upsert":
        return _walk_from_saved_pages(saved), completed, saved.get("mode") == "rechunk"
    if saved.get("mode") == "rechunk" or saved.get("phase") == "rechunk":
        walk = refresh_known_pages(
            notion,
            [],
            resume=_resume_payload(saved),
            on_checkpoint=lambda snapshot: progress.save_walk(snapshot, "rechunk"),
        )
        return walk, completed, True
    if rechunk:
        raise SystemExit(
            "Saved progress is a tree walk. Run --continue without --rechunk."
        )
    roots = load_roots(roots_path)
    _log_roots(roots)
    walk = walk_roots(
        notion,
        roots,
        resume=_resume_payload(saved),
        on_checkpoint=progress.save_walk,
    )
    return walk, completed, False


def _walk_from_saved_pages(saved: dict[str, Any]) -> WikiWalk:
    skipped = _skipped_from_meta(saved)
    return WikiWalk(
        dict(saved.get("pages") or {}),
        tuple(skipped),
        len(saved.get("empty_ids") or []),
    )


def _resume_payload(saved: dict[str, Any]) -> dict[str, Any]:
    return {
        "pending": saved.get("pending") or [],
        "queued": saved.get("queued") or [],
        "visited": saved.get("visited") or [],
        "seen_databases": saved.get("seen_databases") or [],
        "pages": saved.get("pages") or {},
        "skipped": _skipped_from_meta(saved),
        "empty_ids": saved.get("empty_ids") or [],
    }


def _skipped_from_meta(saved: dict[str, Any]) -> list[SkippedNotionObject]:
    skipped: list[SkippedNotionObject] = []
    for item in saved.get("skipped") or []:
        if isinstance(item, SkippedNotionObject):
            skipped.append(item)
            continue
        if isinstance(item, dict):
            skipped.append(
                SkippedNotionObject(
                    kind=str(item.get("kind") or ""),
                    object_id=str(item.get("object_id") or ""),
                    parent_title=str(item.get("parent_title") or ""),
                    message=str(item.get("message") or ""),
                )
            )
    return skipped


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
    on_upsert: Callable[[WikiPage], None] | None = None,
) -> None:
    if index is None or splitter is None or embeddings is None:
        raise SystemExit("Notion wiki ingest is missing Pinecone or embedding clients")
    _upsert_pages(plan.upsert, pages, index, splitter, embeddings, on_upsert)
    for page_id in plan.delete:
        logger.info("Delete %s", page_id)
        delete_page_vectors(index, page_id)
    save_state(s3_client, bucket, pages)
    logger.info("Saved wiki state to s3://%s/%s", bucket, NOTION_WIKI_STATE_KEY)


def _upsert_status(title: str) -> str:
    """One progress label. The page id stays off this line."""
    text = " ".join((title or "").split()) or "Untitled"
    if len(text) > 60:
        text = text[:57] + "..."
    return f"upsert {text}"


def _upsert_pages(
    page_ids: tuple[str, ...],
    pages: dict[str, WikiPage],
    index: Any,
    splitter: Any,
    embeddings: Any,
    on_upsert: Callable[[WikiPage], None] | None,
) -> None:
    if not page_ids:
        return
    import sys

    from tqdm import tqdm

    bar = tqdm(
        total=len(page_ids),
        desc="upsert",
        file=sys.stderr,
        leave=True,
        dynamic_ncols=True,
        bar_format="{desc} {bar} {n_fmt}/{total_fmt}",
        disable=not sys.stderr.isatty(),
    )
    try:
        for page_id in page_ids:
            page = pages[page_id]
            bar.set_description_str(_upsert_status(page.title), refresh=True)
            _upsert_page(page, index, splitter, embeddings)
            if on_upsert is not None:
                on_upsert(page)
            bar.update(1)
    finally:
        bar.close()


def _upsert_page(page: WikiPage, index: Any, splitter: Any, embeddings: Any) -> None:
    delete_page_vectors(index, page.page_id)
    vectors = build_vectors(page, splitter, embeddings)
    if not vectors:
        return
    _ok, count = batch_upsert_vectors(index, vectors, log_summary=False)
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
