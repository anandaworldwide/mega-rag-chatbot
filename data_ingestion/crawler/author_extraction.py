"""Extract author names from crawled HTML pages."""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from bs4 import BeautifulSoup

try:
    from data_ingestion.utils.author_normalization import normalize_author
except ImportError:
    from utils.author_normalization import normalize_author  # type: ignore[import-not-found]

logger = logging.getLogger(__name__)

BYLINE_PATTERN = re.compile(r"^by\s+(.+)$", re.IGNORECASE)

BYLINE_SELECTORS = (
    ".ananda-x-entry-subtitle",
    ".entry-subtitle",
    ".post-subtitle",
    ".byline",
    ".author-name",
    "[rel='author']",
)

ARTICLE_SCHEMA_TYPES = frozenset(
    {"Article", "BlogPosting", "NewsArticle", "WebPage", "CreativeWork"}
)


def _parse_byline(text: str) -> str | None:
    """Parse 'by Author Name' text into an author name."""
    match = BYLINE_PATTERN.match(text.strip())
    if not match:
        return None
    author = match.group(1).strip()
    return author or None


def _author_from_schema_item(author_value: Any) -> str | None:
    """Extract an author name from a schema.org author field."""
    if isinstance(author_value, dict):
        name = author_value.get("name")
        return name.strip() if isinstance(name, str) and name.strip() else None

    if isinstance(author_value, list):
        for item in author_value:
            name = _author_from_schema_item(item)
            if name:
                return name
        return None

    if isinstance(author_value, str):
        return author_value.strip() or None

    return None


def _extract_json_ld_author(soup: BeautifulSoup) -> str | None:
    """Extract author from JSON-LD Article metadata."""
    for script in soup.find_all("script", type="application/ld+json"):
        raw = script.string or script.get_text()
        if not raw or not raw.strip():
            continue
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            logger.debug("Skipping invalid JSON-LD block while extracting author")
            continue

        items: list[Any]
        if isinstance(data, list):
            items = data
        elif isinstance(data, dict):
            graph = data.get("@graph")
            items = graph if isinstance(graph, list) else [data]
        else:
            continue

        for item in items:
            if not isinstance(item, dict):
                continue
            schema_type = item.get("@type")
            if isinstance(schema_type, list):
                is_article = any(t in ARTICLE_SCHEMA_TYPES for t in schema_type)
            else:
                is_article = schema_type in ARTICLE_SCHEMA_TYPES
            if not is_article:
                continue
            author = _author_from_schema_item(item.get("author"))
            if author:
                return author

    return None


def _extract_meta_author(soup: BeautifulSoup) -> str | None:
    """Extract author from HTML meta tags."""
    for attrs in ({"name": "author"}, {"class": "swiftype", "name": "author"}):
        meta = soup.find("meta", attrs=attrs)
        if meta and meta.get("content"):
            content = meta["content"].strip()
            if content:
                return content
    return None


def _extract_visible_byline(soup: BeautifulSoup) -> str | None:
    """Extract author from visible byline elements such as 'by Author Name'."""
    for selector in BYLINE_SELECTORS:
        for element in soup.select(selector):
            text = element.get_text(" ", strip=True)
            author = _parse_byline(text)
            if author:
                return author
            if selector == "[rel='author']" and text:
                return text
    return None


def extract_author_from_soup(
    soup: BeautifulSoup, site_id: str | None = None
) -> str | None:
    """
    Extract and normalize an author name from parsed HTML.

  Priority:
    1. Visible byline elements (for example, '.ananda-x-entry-subtitle')
    2. JSON-LD Article author metadata
    3. HTML meta author tags
    """
    for extractor in (
        _extract_visible_byline,
        _extract_json_ld_author,
        _extract_meta_author,
    ):
        author = extractor(soup)
        if author:
            normalized = normalize_author(author, site_id)
            if normalized != "Unknown":
                return normalized

    return None


def extract_author_from_html(
    html_content: str, site_id: str | None = None
) -> str | None:
    """Extract an author name from raw HTML content."""
    if not html_content or not html_content.strip():
        return None

    soup = BeautifulSoup(html_content, "html.parser")
    return extract_author_from_soup(soup, site_id=site_id)
