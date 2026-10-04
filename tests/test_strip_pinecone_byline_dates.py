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


class TestConfirmMetadataUpdate:
    def test_empty_enter_asks_again_until_yes(self, capsys):
        answers = iter(["", "   ", "y", "yes"])

        assert SCRIPT.confirm_metadata_update(
            "live-index", lambda _prompt: next(answers)
        )

        assert capsys.readouterr().out.count("Type yes or no.") == 3

    def test_no_returns_false_without_treating_empty_as_no(self):
        answers = iter(["", "no"])

        assert (
            SCRIPT.confirm_metadata_update("live-index", lambda _prompt: next(answers))
            is False
        )


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

        plans, scanned, skipped = SCRIPT.collect_dated_authors(
            index, "text||ananda.org||web||", "ananda.org", "ananda-public"
        )

        by_author = {plan.author: plan for plan in plans}
        skipped_ids = {item.vector_id for item in skipped}
        assert scanned == 4
        assert "text||ananda.org||web||list||Blogs and Letters||def||0" in skipped_ids
        assert "Nayaswami Devi March 10, 2023" not in by_author
        assert by_author["Nayaswami Gyandev September 20, 2010"].replacement == (
            "Nayaswami Gyandev McCord"
        )
        assert by_author["Nayaswami Gyandev September 20, 2010"].reason == "article"
        assert by_author["Nayaswami Gyandev September 20, 2010"].use_filter is True
        assert "Maitri Jones" not in by_author
        assert "Someone March 1, 2020" not in by_author
        index.list.assert_called_once_with(prefix="text||ananda.org||web||")
        index.update.assert_not_called()


class TestSkipEmptyAuthor:
    def test_date_only_author_is_skipped_and_reported(self, capsys):
        vector_id = "text||ananda.org||web||article||Home||ccc||0"
        author = "Ananda Sangha Worldwide February 7, 2024"
        index = Mock()
        index.list.return_value = [[vector_id]]
        index.fetch.return_value = SimpleNamespace(
            vectors={
                vector_id: SimpleNamespace(
                    metadata={
                        "author": author,
                        "library": "ananda.org",
                        "title": "A site page",
                        "url": "https://www.ananda.org/blog/example/",
                    }
                )
            }
        )

        plans, scanned, skipped = SCRIPT.collect_dated_authors(
            index, "text||ananda.org||web||", "ananda.org", "ananda-public"
        )

        assert scanned == 1
        assert plans == []
        assert len(skipped) == 1
        assert skipped[0].vector_id == vector_id
        assert skipped[0].author == author
        index.update.assert_not_called()

        SCRIPT._print_skipped_empty_authors(skipped)
        output = capsys.readouterr().out
        assert f"{vector_id} skipped: author would be empty" in output

    def test_shared_author_does_not_use_a_filter_update(self):
        author = "Nayaswami Gyandev September 20, 2010"
        listing_id = "text||ananda.org||web||list||Page||aaa||0"
        article_id = "text||ananda.org||web||article||Yoga||bbb||0"
        index = Mock()
        index.list.return_value = [[listing_id, article_id]]
        index.fetch.return_value = SimpleNamespace(
            vectors={
                listing_id: SimpleNamespace(
                    metadata={
                        "author": author,
                        "library": "ananda.org",
                        "title": "Blogs and Letters - Page 2 of 4",
                        "url": "https://www.ananda.org/blog/page/2/",
                    }
                ),
                article_id: SimpleNamespace(
                    metadata={
                        "author": author,
                        "library": "ananda.org",
                        "title": "Yogananda's Views on Hatha Yoga",
                        "url": "https://www.ananda.org/blog/yoganandas-views-on-hatha-yoga/",
                    }
                ),
            }
        )

        plans, _scanned, skipped = SCRIPT.collect_dated_authors(
            index, "text||ananda.org||web||", "ananda.org", "ananda-public"
        )

        assert [item.vector_id for item in skipped] == [listing_id]
        assert len(plans) == 1
        assert plans[0].vector_ids == [article_id]
        assert plans[0].replacement == "Nayaswami Gyandev McCord"
        assert plans[0].use_filter is False

    def test_apply_skips_blank_authors_and_writes_the_canonical_name(self, capsys):
        limiter = SCRIPT.FilterUpdateRateLimiter(min_interval_sec=0)
        index = Mock()
        index.update.return_value = SimpleNamespace(matched_records=1)
        plans = [
            SCRIPT.DatedAuthorPlan(
                author="Nayaswami Gyandev September 20, 2010",
                replacement="Nayaswami Gyandev McCord",
                reason="article",
                vector_ids=["article-id"],
                use_filter=False,
            ),
            SCRIPT.DatedAuthorPlan(
                author="Ananda Sangha Worldwide February 7, 2024",
                replacement="",
                reason="site-wide",
                vector_ids=["date-only-id"],
                use_filter=False,
            ),
            SCRIPT.DatedAuthorPlan(
                author="Name March 1, 2020",
                replacement="   ",
                reason="site-wide",
                vector_ids=["whitespace-id"],
                use_filter=True,
            ),
        ]

        updated = SCRIPT.apply_plan(index, plans, "ananda.org", limiter)

        assert updated == 1
        output = capsys.readouterr().out
        assert "date-only-id skipped: author would be empty" in output
        assert "whitespace-id skipped: author would be empty" in output
        assert index.update.call_count == 1
        assert index.update.call_args.kwargs["set_metadata"] == {
            "author": "Nayaswami Gyandev McCord"
        }
        assert index.update.call_args.kwargs["id"] == "article-id"

    def test_bulk_replace_refuses_an_empty_author(self):
        limiter = SCRIPT.FilterUpdateRateLimiter(min_interval_sec=0)
        index = Mock()

        assert (
            SCRIPT._bulk_replace_author(
                index, "Dated March 1, 2020", "", "ananda.org", limiter
            )
            == 0
        )
        assert (
            SCRIPT._bulk_replace_author(
                index, "Dated March 1, 2020", "   ", "ananda.org", limiter
            )
            == 0
        )
        index.update.assert_not_called()

    def test_bulk_replace_writes_a_canonical_author(self):
        limiter = SCRIPT.FilterUpdateRateLimiter(min_interval_sec=0)
        index = Mock()
        index.update.side_effect = [
            SimpleNamespace(matched_records=2),
            SimpleNamespace(matched_records=0),
        ]

        updated = SCRIPT._bulk_replace_author(
            index,
            "Nayaswami Gyandev September 20, 2010",
            "Nayaswami Gyandev McCord",
            "ananda.org",
            limiter,
        )

        assert updated == 2
        assert index.update.call_args_list[0].kwargs["set_metadata"] == {
            "author": "Nayaswami Gyandev McCord"
        }
