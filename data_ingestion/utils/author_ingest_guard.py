"""Guard blank authors before a chunk is written to Pinecone.

An empty or whitespace author is not replaced with a default name.
Whitespace-only values become blank. The author field is omitted.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


def is_blank_author(value: Any) -> bool:
    """Return True when value is an empty or whitespace string."""
    return isinstance(value, str) and not value.strip()


def prepare_ingest_author(
    author: Any,
    *,
    library: str | None = None,
    document_id: str | None = None,
    url: str | None = None,
) -> str | None:
    """Return a usable author, or None when the value is blank.

    None stays None and does not log. An empty or whitespace string
    logs a warning and returns None. The function does not invent a name.
    """
    if author is None:
        return None
    if is_blank_author(author):
        logger.warning(
            "Blank author on ingest. library=%s document=%s url=%s",
            library or "(unknown)",
            document_id or "(unknown)",
            url or "(unknown)",
        )
        return None
    if not isinstance(author, str):
        return str(author)
    return author


def apply_author_guard_to_metadata(
    metadata: dict[str, Any],
    *,
    vector_id: str | None = None,
) -> dict[str, Any]:
    """Omit a blank author from metadata. Do not invent a fallback name."""
    if "author" not in metadata:
        return metadata
    library = metadata.get("library")
    prepared = prepare_ingest_author(
        metadata.get("author"),
        library=library if isinstance(library, str) else None,
        document_id=vector_id,
        url=_document_url(metadata),
    )
    if prepared is None:
        metadata.pop("author", None)
    else:
        metadata["author"] = prepared
    return metadata


def apply_author_guard_to_vectors(
    vectors: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Apply the blank-author guard to each vector metadata dict."""
    for vector in vectors:
        metadata = vector.get("metadata")
        if isinstance(metadata, dict):
            vector_id = vector.get("id")
            apply_author_guard_to_metadata(
                metadata,
                vector_id=vector_id if isinstance(vector_id, str) else None,
            )
    return vectors


def _document_url(metadata: dict[str, Any]) -> str | None:
    for key in ("url", "source"):
        value = metadata.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return None
