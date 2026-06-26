#!/usr/bin/env python3
"""Fetch pages and print extracted author names for manual verification."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from urllib.request import Request, urlopen

# Support running from repo root or crawler directory.
CRAWLER_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = CRAWLER_DIR.parents[1]
for path in (str(REPO_ROOT), str(CRAWLER_DIR)):
    if path not in sys.path:
        sys.path.insert(0, path)

try:
    from data_ingestion.crawler.author_extraction import extract_author_from_html
except ImportError:
    from author_extraction import extract_author_from_html  # type: ignore[import-not-found]

DEFAULT_URLS = (
    "https://www.ananda.org/blog/yoga-after-a-hip-replacement-by-maitri-jones/",
    "https://www.ananda.org/blog/how-meditation-changed-my-life-2/",
    "https://www.ananda.org/blog/the-spiritual-eye/",
    "https://www.ananda.org/blog/hospice-yogananda-meditation/",
    "https://www.ananda.org/",
    "https://www.ananda.org/blog/",
    "https://www.ananda.org/meditation/",
    "https://www.ananda.org/yogapedia/aparaprakriti/",
)

USER_AGENT = (
    "Mozilla/5.0 (compatible; AnandaCrawlerAuthorTest/1.0; +https://www.ananda.org)"
)


def fetch_html(url: str) -> str:
    request = Request(url, headers={"User-Agent": USER_AGENT})
    with urlopen(request, timeout=30) as response:
        return response.read().decode("utf-8", errors="replace")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Fetch ananda.org pages and print extracted author names."
    )
    parser.add_argument(
        "--site",
        required=True,
        help="Site ID for author normalization (for example, ananda-public)",
    )
    parser.add_argument(
        "--url",
        action="append",
        dest="urls",
        help="URL to test. Repeat for multiple URLs.",
    )
    args = parser.parse_args()

    urls = args.urls or list(DEFAULT_URLS)
    print(f"Testing author extraction for site '{args.site}'")
    print("-" * 72)

    found = 0
    for url in urls:
        try:
            html = fetch_html(url)
            author = extract_author_from_html(html, site_id=args.site)
        except Exception as exc:
            print(f"FAIL  {url}")
            print(f"      error: {exc}")
            continue

        if author:
            found += 1
            print(f"FOUND {url}")
            print(f"      author: {author}")
        else:
            print(f"NONE  {url}")

    print("-" * 72)
    print(f"Authors found on {found}/{len(urls)} pages")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
