"""Unit tests for the live-index byline date cleanup script."""

import importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest


def load_script_module():
    script_path = (
        Path(__file__).resolve().parents[1] / "bin" / "strip_pinecone_byline_dates.py"
    )
    spec = importlib.util.spec_from_file_location(
        "strip_pinecone_byline_dates", script_path
    )
    if spec is None or spec.loader is None:
        raise AssertionError("Could not load strip_pinecone_byline_dates.py")

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SCRIPT = load_script_module()


class TestResolveLiveIndexName:
    def test_uses_pinecone_index_name(self):
        env = {
            "PINECONE_INDEX_NAME": "ananda-2025-06-19--3-large",
            "PINECONE_INGEST_INDEX_NAME": "ananda-2026-09-26--3-large",
        }
        assert SCRIPT.resolve_live_index_name(env) == "ananda-2025-06-19--3-large"

    def test_does_not_fall_back_to_ingest_index(self):
        env = {"PINECONE_INGEST_INDEX_NAME": "ananda-2026-09-26--3-large"}
        with pytest.raises(SystemExit, match="PINECONE_INDEX_NAME"):
            SCRIPT.resolve_live_index_name(env)

    def test_refuses_when_live_and_ingest_names_match(self):
        env = {
            "PINECONE_INDEX_NAME": "shared-index",
            "PINECONE_INGEST_INDEX_NAME": "shared-index",
        }
        with pytest.raises(SystemExit, match="PINECONE_INGEST_INDEX_NAME"):
            SCRIPT.resolve_live_index_name(env)

    def test_allow_flag_accepts_matching_names(self):
        env = {
            "PINECONE_INDEX_NAME": "shared-index",
            "PINECONE_INGEST_INDEX_NAME": "shared-index",
        }
        assert (
            SCRIPT.resolve_live_index_name(env, allow_ingest_index=True)
            == "shared-index"
        )


class TestAuthorLibraryFilter:
    def test_scopes_author_update_to_one_library(self):
        assert SCRIPT.author_library_filter(
            "Nayaswami Devi March 10, 2023", "ananda.org"
        ) == {
            "$and": [
                {"author": {"$eq": "Nayaswami Devi March 10, 2023"}},
                {"library": {"$eq": "ananda.org"}},
            ]
        }


class TestCrawlerIdPrefix:
    def test_builds_ananda_org_web_prefix(self):
        assert SCRIPT.crawler_id_prefix("ananda.org") == "text||ananda.org||web||"
        assert SCRIPT.crawler_id_prefix("www.ananda.org") == "text||ananda.org||web||"


class TestListingPage:
    def test_pagination_title_is_a_listing(self):
        assert SCRIPT.is_listing_page(
            "Blogs and Letters - Page 10 of 41 - Nayaswami Jyotish",
            "https://www.ananda.org/jyotish-and-devi/page/10/",
        )

    def test_author_archive_title_is_a_listing(self):
        assert SCRIPT.is_listing_page(
            "Asha Nayaswami, Author at Ananda",
            "https://www.ananda.org/author/asha/",
        )

    def test_search_title_and_query_url_are_listings(self):
        assert SCRIPT.is_listing_page(
            "You searched for kriyananda - Page 20 of 26",
            "https://www.ananda.org/?s=kriyananda",
        )
        assert SCRIPT.is_listing_page(
            "Some page",
            "https://www.ananda.org/search/kriyananda/",
        )

    def test_page_one_archive_titles_are_listings(self):
        assert SCRIPT.is_listing_page(
            "Blogs and Letters - Nayaswami Jyotish and Nayaswami Devi",
            "https://www.ananda.org/jyotish-and-devi/",
        )
        assert SCRIPT.is_listing_page(
            "Healing Prayers Blog | Let God's Healing Power Flow",
            "https://www.ananda.org/healing-prayers/",
        )

    def test_article_title_is_not_a_listing(self):
        assert not SCRIPT.is_listing_page(
            "Yogananda's Views on Hatha Yoga",
            "https://www.ananda.org/blog/yoganandas-views-on-hatha-yoga/",
        )


class TestClassifyDatedAuthor:
    def test_listing_page_clears_author(self):
        assert SCRIPT.classify_dated_author(
            "Nayaswami Devi March 10, 2023",
            "Blogs and Letters - Page 10 of 41 - Nayaswami Jyotish",
            "https://www.ananda.org/jyotish-and-devi/page/10/",
            "ananda-public",
        ) == ("", "listing")

    def test_article_keeps_canonical_author(self):
        assert SCRIPT.classify_dated_author(
            "Nayaswami Gyandev September 20, 2010",
            "Yogananda's Views on Hatha Yoga",
            "https://www.ananda.org/blog/yoganandas-views-on-hatha-yoga/",
            "ananda-public",
        ) == ("Nayaswami Gyandev McCord", "article")

    def test_undated_author_is_left_alone(self):
        assert (
            SCRIPT.classify_dated_author(
                "Maitri Jones",
                "A real article",
                "https://www.ananda.org/blog/example/",
                "ananda-public",
            )
            is None
        )


class TestCollectDatedAuthors:
    def test_omits_listing_pages_and_keeps_articles(self):
        index = Mock()
        index.list.return_value = [
            [
                "text||ananda.org||web||article||Yoganandas Views||abc||0",
                "text||ananda.org||web||list||Blogs and Letters||def||0",
                "text||ananda.org||web||other||Maitri Jones||ghi||0",
                "text||ananda.org||web||skip||Crystal||jkl||0",
            ]
        ]
        index.fetch.return_value = SimpleNamespace(
            vectors={
                "text||ananda.org||web||article||Yoganandas Views||abc||0": SimpleNamespace(
                    metadata={
                        "author": "Nayaswami Gyandev September 20, 2010",
                        "library": "ananda.org",
                        "title": "Yogananda's Views on Hatha Yoga",
                        "url": "https://www.ananda.org/blog/yoganandas-views-on-hatha-yoga/",
                    }
                ),
                "text||ananda.org||web||list||Blogs and Letters||def||0": SimpleNamespace(
                    metadata={
                        "author": "Nayaswami Devi March 10, 2023",
                        "library": "ananda.org",
                        "title": "Blogs and Letters - Page 10 of 41 - Nayaswami Jyotish",
                        "url": "https://www.ananda.org/jyotish-and-devi/page/10/",
                    }
                ),
                "text||ananda.org||web||other||Maitri Jones||ghi||0": SimpleNamespace(
                    metadata={"author": "Maitri Jones", "library": "ananda.org"}
                ),
                "text||ananda.org||web||skip||Crystal||jkl||0": SimpleNamespace(
                    metadata={
                        "author": "Someone March 1, 2020",
                        "library": "crystalclarity.com",
                    }
                ),
            }
        )

        plans, scanned = SCRIPT.collect_dated_authors(
            index, "text||ananda.org||web||", "ananda.org", "ananda-public"
        )

        by_author = {plan.author: plan for plan in plans}
        assert scanned == 4
        assert by_author["Nayaswami Devi March 10, 2023"].replacement == ""
        assert by_author["Nayaswami Devi March 10, 2023"].reason == "listing"
        assert by_author["Nayaswami Gyandev September 20, 2010"].replacement == (
            "Nayaswami Gyandev McCord"
        )
        assert by_author["Nayaswami Gyandev September 20, 2010"].reason == "article"
        assert "Maitri Jones" not in by_author
        assert "Someone March 1, 2020" not in by_author
        index.list.assert_called_once_with(prefix="text||ananda.org||web||")
