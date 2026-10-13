"""Shared rules for archive, search, and pagination pages.

A visible byline on those pages belongs to one teaser, not to the page.
The crawler applies these rules only when site config sets
skip_listing_pages to true. The flag is off by default. The byline
cleanup script and the listing delete script use the same rules for
ananda.org.
"""

from __future__ import annotations

import re
from urllib.parse import parse_qs, urlparse

SKIP_LISTING_PAGES_KEY = "skip_listing_pages"


def listing_skips_enabled(config: dict | None) -> bool:
    """Return True when the site config opts into listing-page skips."""
    if not config:
        return False
    return bool(config.get(SKIP_LISTING_PAGES_KEY))


_PAGE_OF_PAGES = re.compile(r"\bpage\s+\d+\s+of\s+\d+\b", re.IGNORECASE)
_AUTHOR_AT = re.compile(r",\s*author at\b", re.IGNORECASE)
_SEARCHED_FOR = re.compile(r"\byou searched for\b", re.IGNORECASE)
_AUTHOR_PATH = re.compile(r"(^|/)author(/|$)")
_PAGE_PATH = re.compile(r"(^|/)page/\d+(/|$)")
_SEARCH_PATH = re.compile(r"(^|/)search(/|$)")
# Page 1 of these archives has no "Page N of M" and no /page/ segment.
_LISTING_TITLE_PREFIXES = (
    "blogs and letters",
    "healing prayers blog",
    "questions and answers:",
)


def is_listing_page(title: str, url: str) -> bool:
    """Return True for archive, search, and pagination pages."""
    normalized_title = re.sub(r"\s+", " ", title or "").strip()
    lowered = normalized_title.lower()
    if (
        _PAGE_OF_PAGES.search(lowered)
        or _AUTHOR_AT.search(lowered)
        or _SEARCHED_FOR.search(lowered)
    ):
        return True
    if any(lowered.startswith(prefix) for prefix in _LISTING_TITLE_PREFIXES):
        return True
    return url_is_listing(url)


def url_is_listing(url: str) -> bool:
    """Return True when the URL path or query marks a listing page."""
    if not url:
        return False
    parsed = urlparse(url if "://" in url else f"https://{url}")
    path = parsed.path.lower()
    if (
        _AUTHOR_PATH.search(path)
        or _PAGE_PATH.search(path)
        or _SEARCH_PATH.search(path)
    ):
        return True
    return "s" in parse_qs(parsed.query)
