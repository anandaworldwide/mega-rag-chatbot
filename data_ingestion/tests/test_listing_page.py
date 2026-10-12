"""Tests for shared listing-page rules."""

import json
import re
from pathlib import Path

from data_ingestion.crawler.listing_page import is_listing_page, url_is_listing

CONFIG_PATH = (
    Path(__file__).resolve().parents[1]
    / "crawler"
    / "crawler_config"
    / "ananda-public-config.json"
)


class TestIsListingPage:
    def test_pagination_title_is_a_listing(self):
        assert is_listing_page(
            "Blogs and Letters - Page 10 of 41 - Nayaswami Jyotish",
            "https://www.ananda.org/jyotish-and-devi/page/10/",
        )

    def test_author_archive_title_is_a_listing(self):
        assert is_listing_page(
            "Asha Nayaswami, Author at Ananda",
            "https://www.ananda.org/author/asha/",
        )

    def test_search_title_and_query_url_are_listings(self):
        assert is_listing_page(
            "You searched for kriyananda - Page 20 of 26",
            "https://www.ananda.org/?s=kriyananda",
        )
        assert is_listing_page(
            "Some page",
            "https://www.ananda.org/search/kriyananda/",
        )

    def test_page_one_archive_titles_are_listings(self):
        assert is_listing_page(
            "Blogs and Letters - Nayaswami Jyotish and Nayaswami Devi",
            "https://www.ananda.org/jyotish-and-devi/",
        )
        assert is_listing_page(
            "Healing Prayers Blog | Let God's Healing Power Flow",
            "https://www.ananda.org/healing-prayers/",
        )

    def test_article_title_is_not_a_listing(self):
        assert not is_listing_page(
            "Yogananda's Views on Hatha Yoga",
            "https://www.ananda.org/blog/yoganandas-views-on-hatha-yoga/",
        )


class TestUrlIsListing:
    def test_author_path(self):
        assert url_is_listing("https://www.ananda.org/author/asha/")

    def test_blog_pagination_path(self):
        assert url_is_listing("https://www.ananda.org/jyotish-and-devi/blog/page/10")

    def test_ask_category_pagination_path(self):
        assert url_is_listing("https://www.ananda.org/ask-category/meditation/page/53")

    def test_search_query(self):
        assert url_is_listing("https://www.ananda.org/?s=kriyananda")

    def test_article_url_is_not_a_listing(self):
        assert not url_is_listing(
            "https://www.ananda.org/blog/yoganandas-views-on-hatha-yoga/"
        )


class TestAnandaPublicSkipPatterns:
    def test_config_has_listing_skip_patterns(self):
        config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        patterns = config["skip_patterns"]
        compiled = [re.compile(pattern) for pattern in patterns]

        def matches(text: str) -> bool:
            return any(pattern.search(text) for pattern in compiled)

        assert matches("/author/asha/")
        assert matches("/jyotish-and-devi/blog/page/10")
        assert matches("/ask-category/meditation/page/53")
        assert matches("?s=kriyananda")
        assert not matches("/blog/yoganandas-views-on-hatha-yoga/")
