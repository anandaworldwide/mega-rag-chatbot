#!/usr/bin/env python3
"""Fetch pages and print extracted author names for manual verification."""

from __future__ import annotations

import argparse
import random
import sys
import xml.etree.ElementTree as ET
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

SITEMAP_NS = {"sm": "http://www.sitemaps.org/schemas/sitemap/0.9"}

# Fixed index/navigation pages always included in mixed samples.
INDEX_URLS = (
    "https://www.ananda.org/",
    "https://www.ananda.org/blog/",
    "https://www.ananda.org/meditation/",
)

# Sitemap paths and how many random URLs to draw from each for a mixed sample.
SAMPLE_SOURCES = (
    ("post-sitemap3.xml", "blog"),
    ("page-sitemap.xml", "page"),
    ("yogapedia-sitemap.xml", "yogapedia"),
    ("ask-sitemap4.xml", "ask"),
)


def fetch_text(url: str) -> str:
    request = Request(url, headers={"User-Agent": USER_AGENT})
    with urlopen(request, timeout=30) as response:
        return response.read().decode("utf-8", errors="replace")


def fetch_html(url: str) -> str:
    return fetch_text(url)


def fetch_sitemap_urls(sitemap_path: str) -> list[str]:
    """Return all page URLs listed in a Yoast sitemap file."""
    xml = fetch_text(f"https://www.ananda.org/{sitemap_path}")
    root = ET.fromstring(xml)
    return [loc.text for loc in root.findall(".//sm:loc", SITEMAP_NS) if loc.text]


def build_mixed_sample(count: int, seed: int | None = None) -> list[tuple[str, str]]:
    """
    Build a random mixed sample of blog and non-blog pages.

    Returns list of (url, category) tuples. Always includes index/navigation
    pages, then fills remaining slots from blog posts, static pages, yogapedia,
    and ask pages.
    """
    rng = random.Random(seed)
    selected: list[tuple[str, str]] = [(url, "index") for url in INDEX_URLS]
    seen = {url for url, _ in selected}

    if count <= len(selected):
        return selected[:count]

    remaining = count - len(selected)
    per_source = max(1, remaining // len(SAMPLE_SOURCES))
    extras: list[tuple[str, str]] = []

    for sitemap_path, category in SAMPLE_SOURCES:
        try:
            pool = [url for url in fetch_sitemap_urls(sitemap_path) if url not in seen]
        except Exception as exc:
            print(f"Warning: could not load {sitemap_path}: {exc}", file=sys.stderr)
            continue
        if not pool:
            continue
        pick_count = min(per_source, len(pool))
        for url in rng.sample(pool, pick_count):
            extras.append((url, category))
            seen.add(url)

    selected.extend(extras)

    if len(selected) < count:
        # Top up from blog posts if we came up short.
        try:
            blog_pool = [
                url
                for url in fetch_sitemap_urls("post-sitemap3.xml")
                if url not in seen
            ]
            need = count - len(selected)
            for url in rng.sample(blog_pool, min(need, len(blog_pool))):
                selected.append((url, "blog"))
                seen.add(url)
        except Exception:
            pass

    rng.shuffle(selected[3:])  # Keep index pages first for readability.
    return selected[:count]


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
    parser.add_argument(
        "--sample",
        type=int,
        metavar="N",
        help=(
            "Test N randomly chosen pages with a mix of blog posts and "
            "non-blog pages (index, static pages, yogapedia, ask)."
        ),
    )
    parser.add_argument(
        "--seed",
        type=int,
        help="Random seed for --sample (optional, for reproducible runs).",
    )
    args = parser.parse_args()

    if args.urls and args.sample:
        parser.error("Use either --url or --sample, not both.")

    labeled_urls: list[tuple[str, str | None]]
    if args.sample:
        labeled_urls = build_mixed_sample(args.sample, seed=args.seed)
    elif args.urls:
        labeled_urls = [(url, None) for url in args.urls]
    else:
        labeled_urls = [(url, None) for url in DEFAULT_URLS]

    print(f"Testing author extraction for site '{args.site}'")
    if args.sample:
        print(f"Random mixed sample of {len(labeled_urls)} pages")
        if args.seed is not None:
            print(f"Seed: {args.seed}")
    print("-" * 72)

    found = 0
    for url, category in labeled_urls:
        category_label = f" [{category}]" if category else ""
        try:
            html = fetch_html(url)
            author = extract_author_from_html(html, site_id=args.site)
        except Exception as exc:
            print(f"FAIL  {url}{category_label}")
            print(f"      error: {exc}")
            continue

        if author:
            found += 1
            print(f"FOUND {url}{category_label}")
            print(f"      author: {author}")
        else:
            print(f"NONE  {url}{category_label}")

    print("-" * 72)
    print(f"Authors found on {found}/{len(labeled_urls)} pages")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
