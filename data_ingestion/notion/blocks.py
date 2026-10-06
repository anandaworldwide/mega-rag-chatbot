"""Plain text and Pinecone metadata for Notion wiki pages."""

from __future__ import annotations

import re
from dataclasses import dataclass

LIBRARY_NAME = "Ananda Family Wiki"
ACCESS_LEVEL = "disciple"
REQUIRED_ACCESS_LEVEL = 100
VIVEK_LIBRARIES = frozenset({"ananda.org", "Crystal Clarity"})
SOURCE_LOCATION = "notion"

_SKIP_BLOCK_TYPES = frozenset(
    {
        "image",
        "file",
        "pdf",
        "video",
        "audio",
        "embed",
        "bookmark",
        "link_preview",
        "link_to_page",
        "unsupported",
        "divider",
        "breadcrumb",
        "table_of_contents",
    }
)
_CHILD_BLOCK_TYPES = frozenset({"child_page", "child_database"})
_PAGE_ID_RE = re.compile(
    r"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12})"
)
_COMPACT_ID_RE = re.compile(r"([0-9a-fA-F]{32})")


@dataclass(frozen=True)
class SyncPlan:
    """Page ids to write, leave in place, or remove."""

    upsert: tuple[str, ...]
    skip: tuple[str, ...]
    delete: tuple[str, ...]


def assert_library_is_luca_only(library_name: str = LIBRARY_NAME) -> None:
    """Refuse a library name that Vivek already retrieves."""
    if library_name in VIVEK_LIBRARIES:
        raise ValueError(f"Refusing Vivek library name: {library_name}")


def normalize_page_id(value: str) -> str:
    """Return a dashed Notion page id from an id or a page URL."""
    text = value.strip()
    dashed = _PAGE_ID_RE.search(text)
    if dashed:
        raw = dashed.group(1).replace("-", "").lower()
    else:
        compact = _COMPACT_ID_RE.search(text)
        if compact is None:
            raise ValueError(f"Invalid Notion page id: {value}")
        raw = compact.group(1).lower()
    return f"{raw[0:8]}-{raw[8:12]}-{raw[12:16]}-{raw[16:20]}-{raw[20:32]}"


def rich_text_plain(rich_text: list | None) -> str:
    """Join Notion rich text objects into one string."""
    if not rich_text:
        return ""
    return "".join(
        item.get("plain_text", "") for item in rich_text if isinstance(item, dict)
    )


def page_title(page: dict) -> str:
    """Read the title property from a Notion page."""
    properties = page.get("properties") or {}
    for prop in properties.values():
        if isinstance(prop, dict) and prop.get("type") == "title":
            title = rich_text_plain(prop.get("title")).strip()
            return title or "Untitled"
    return "Untitled"


def properties_plain(page: dict) -> str:
    """Render non-title page properties as lines of text."""
    lines: list[str] = []
    properties = page.get("properties") or {}
    for name, prop in properties.items():
        if not isinstance(prop, dict) or prop.get("type") == "title":
            continue
        value = _property_plain(prop).strip()
        if value:
            lines.append(f"{name}: {value}")
    return "\n".join(lines)


def collect_child_refs(blocks: list[dict]) -> tuple[list[str], list[str]]:
    """Return child page ids and child database ids in this block tree."""
    pages: list[str] = []
    databases: list[str] = []
    for block in blocks:
        block_type = block.get("type")
        if block_type == "child_page":
            pages.append(block["id"])
        elif block_type == "child_database":
            databases.append(block["id"])
        else:
            child_pages, child_databases = collect_child_refs(
                block.get("children") or []
            )
            pages.extend(child_pages)
            databases.extend(child_databases)
    return pages, databases


def blocks_to_text(blocks: list[dict]) -> str:
    """Convert a Notion block tree to plain text. Skip files and embeds."""
    lines: list[str] = []
    for block in blocks:
        line = _block_line(block)
        if line:
            lines.append(line)
        block_type = block.get("type")
        if block_type not in _CHILD_BLOCK_TYPES:
            child_text = blocks_to_text(block.get("children") or [])
            if child_text:
                lines.append(child_text)
    return "\n".join(lines).strip()


_DETAIL_PROPERTY_TYPES = frozenset({"rich_text", "url", "email", "phone_number"})


def page_has_indexable_text(page: dict, blocks: list[dict]) -> bool:
    """True when the page has body text or a text property.

    A title, status, or assignee is not enough. Empty task cards stay out.
    """
    if blocks_to_text(blocks):
        return True
    properties = page.get("properties") or {}
    for prop in properties.values():
        if not isinstance(prop, dict):
            continue
        if prop.get("type") not in _DETAIL_PROPERTY_TYPES:
            continue
        if _property_plain(prop).strip():
            return True
    return False


def page_plain_text(page: dict, blocks: list[dict]) -> str:
    """Combine the title, properties, and block text for one page."""
    parts: list[str] = []
    title = page_title(page)
    if title and title != "Untitled":
        parts.append(title)
    properties = properties_plain(page)
    if properties:
        parts.append(properties)
    body = blocks_to_text(blocks)
    if body:
        parts.append(body)
    return "\n\n".join(parts).strip()


def build_chunk_metadata(
    *,
    title: str,
    url: str,
    page_id: str,
    chunk: str,
    chunk_index: int,
    total_chunks: int,
) -> dict:
    """Metadata for one wiki chunk. The library name stays off Vivek."""
    assert_library_is_luca_only(LIBRARY_NAME)
    return {
        "type": "text",
        "url": url,
        "source": url,
        "title": title,
        "library": LIBRARY_NAME,
        "text": chunk,
        "access_level": ACCESS_LEVEL,
        "required_access_level": REQUIRED_ACCESS_LEVEL,
        "notion_page_id": page_id,
        "chunk_index": chunk_index,
        "total_chunks": total_chunks,
    }


def plan_sync(previous: dict[str, str], current: dict[str, str]) -> SyncPlan:
    """Compare saved edit times with the current walk."""
    upsert: list[str] = []
    skip: list[str] = []
    for page_id, edited in current.items():
        if previous.get(page_id) == edited:
            skip.append(page_id)
        else:
            upsert.append(page_id)
    delete = [page_id for page_id in previous if page_id not in current]
    return SyncPlan(tuple(upsert), tuple(skip), tuple(delete))


_HEADING_PREFIX = {
    "heading_1": "# ",
    "heading_2": "## ",
    "heading_3": "### ",
    "bulleted_list_item": "- ",
    "numbered_list_item": "1. ",
    "quote": "> ",
}


def _block_line(block: dict) -> str:
    block_type = block.get("type") or ""
    if block_type in _SKIP_BLOCK_TYPES or block_type in _CHILD_BLOCK_TYPES:
        return ""
    if block_type == "table":
        return _table_text(block)
    payload = block.get(block_type) or {}
    if not isinstance(payload, dict):
        return ""
    if block_type == "to_do":
        return _todo_line(payload)
    if block_type == "equation":
        return str(payload.get("expression") or "").strip()
    text = rich_text_plain(payload.get("rich_text")).strip()
    if not text:
        return ""
    prefix = _HEADING_PREFIX.get(block_type, "")
    return f"{prefix}{text}"


def _todo_line(payload: dict) -> str:
    mark = "x" if payload.get("checked") else " "
    text = rich_text_plain(payload.get("rich_text")).strip()
    return f"[{mark}] {text}".strip()


def _table_text(block: dict) -> str:
    rows: list[str] = []
    for child in block.get("children") or []:
        if child.get("type") != "table_row":
            continue
        cells = (child.get("table_row") or {}).get("cells") or []
        rows.append(" | ".join(rich_text_plain(cell).strip() for cell in cells))
    return "\n".join(row for row in rows if row)


def _property_plain(prop: dict) -> str:
    prop_type = prop.get("type")
    if prop_type == "rich_text":
        return rich_text_plain(prop.get("rich_text"))
    if prop_type == "multi_select":
        return _multi_select_plain(prop)
    if prop_type in ("url", "email", "phone_number"):
        return str(prop.get(prop_type) or "")
    if prop_type == "date":
        return _date_plain(prop)
    if prop_type == "formula":
        return _formula_plain(prop)
    return _simple_property_plain(prop, prop_type)


def _multi_select_plain(prop: dict) -> str:
    names = [
        item.get("name", "")
        for item in prop.get("multi_select") or []
        if isinstance(item, dict)
    ]
    return ", ".join(name for name in names if name)


def _date_plain(prop: dict) -> str:
    date = prop.get("date") or {}
    start = date.get("start") or ""
    end = date.get("end") or ""
    if start and end:
        return f"{start} to {end}"
    return str(start)


def _formula_plain(prop: dict) -> str:
    formula = prop.get("formula") or {}
    if formula.get("type") == "string":
        return str(formula.get("string") or "")
    if formula.get("type") == "number" and formula.get("number") is not None:
        return str(formula["number"])
    return ""


def _simple_property_plain(prop: dict, prop_type: str | None) -> str:
    if prop_type == "select":
        return str((prop.get("select") or {}).get("name") or "")
    if prop_type == "status":
        return str((prop.get("status") or {}).get("name") or "")
    if prop_type == "number" and prop.get("number") is not None:
        return str(prop["number"])
    if prop_type == "checkbox":
        return "yes" if prop.get("checkbox") else ""
    return ""
