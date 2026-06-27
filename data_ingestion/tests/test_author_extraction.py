"""Tests for author extraction from crawled HTML."""

import json
import unittest

from bs4 import BeautifulSoup

from data_ingestion.crawler.author_extraction import (
    extract_author_from_html,
    is_article_page,
)

ARTICLE_DATALAYER = (
    '<script>var dataLayer_content = {"pagePostType":"post",'
    '"pagePostType2":"single-post"};</script>'
)


def article_html(head: str = "", body: str = "") -> str:
    """Wrap HTML fragments in a single blog-post page shell."""
    return (
        f"<html><head>{ARTICLE_DATALAYER}{head}</head>"
        f'<body class="wp-singular single single-post postid-1">{body}</body></html>'
    )


class TestAuthorExtraction(unittest.TestCase):
    def test_is_article_page_detects_single_post_body_class(self):
        html = '<html><body class="single single-post"></body></html>'
        soup = BeautifulSoup(html, "html.parser")
        self.assertTrue(is_article_page(soup, html))

    def test_is_article_page_rejects_homepage(self):
        html = """
        <html><head>
          <meta name="author" content="Nabha Cosley" />
          <script>var dataLayer_content = {"pagePostType":"frontpage"};</script>
        </head><body class="home page"></body></html>
        """
        soup = BeautifulSoup(html, "html.parser")
        self.assertFalse(is_article_page(soup, html))

    def test_extracts_visible_byline(self):
        html = article_html(
            body='<div class="ananda-x-entry-subtitle">by Maitri Jones</div>'
        )
        self.assertEqual(
            extract_author_from_html(html, site_id="ananda-public"),
            "Maitri Jones",
        )

    def test_prefers_visible_byline_over_meta(self):
        html = article_html(
            head='<meta name="author" content="Ananda Sangha Worldwide" />',
            body='<div class="ananda-x-entry-subtitle">by Tyagi Shivendra</div>',
        )
        self.assertEqual(
            extract_author_from_html(html, site_id="ananda-public"),
            "Tyagi Shivendra",
        )

    def test_extracts_json_ld_author(self):
        schema = {
            "@context": "https://schema.org",
            "@graph": [
                {
                    "@type": "Article",
                    "author": {"name": "Tyagi Jayadev"},
                }
            ],
        }
        html = article_html(
            head=f'<script type="application/ld+json">{json.dumps(schema)}</script>'
        )
        self.assertEqual(
            extract_author_from_html(html, site_id="ananda-public"),
            "Tyagi Jayadev",
        )

    def test_extracts_meta_author_when_no_byline(self):
        html = article_html(head='<meta name="author" content="Tyagi Jayadev" />')
        self.assertEqual(
            extract_author_from_html(html, site_id="ananda-public"),
            "Tyagi Jayadev",
        )

    def test_ignores_site_wide_org_meta_author(self):
        html = article_html(
            head='<meta name="author" content="Ananda Sangha Worldwide" />'
        )
        self.assertIsNone(
            extract_author_from_html(html, site_id="ananda-public"),
        )

    def test_returns_none_for_homepage_even_with_meta_author(self):
        html = """
        <html><head>
          <meta name="author" content="Nabha Cosley" />
          <script>var dataLayer_content = {"pagePostType":"frontpage"};</script>
        </head><body class="home page">
          <div class="ananda-x-entry-subtitle">AUDIO ONLY</div>
          <h1>Welcome</h1>
        </body></html>
        """
        self.assertIsNone(extract_author_from_html(html, site_id="ananda-public"))

    def test_extracts_static_page_byline_without_post_type(self):
        html = """
        <html><head>
          <meta name="author" content="steve" />
          <script>var dataLayer_content = {"pagePostType":"page",
          "pagePostType2":"single-page"};</script>
        </head><body class="page">
          <div class="ananda-x-entry-subtitle">by Nayaswami Bharat</div>
          <p>Article body</p>
        </body></html>
        """
        self.assertEqual(
            extract_author_from_html(html, site_id="ananda-public"),
            "Nayaswami Bharat",
        )

    def test_extracts_ask_page_byline(self):
        html = """
        <html><head>
          <meta name="author" content="Ananda Sangha Worldwide" />
          <script>var dataLayer_content = {"pagePostType":"ask",
          "pagePostType2":"single-ask"};</script>
        </head><body class="single single-ask">
          <div class="h4 h-author mtn">
            By <a href="https://www.ananda.org/author/jayadev/"> Tyagi Jayadev</a>
          </div>
          <p>Answer body</p>
        </body></html>
        """
        self.assertEqual(
            extract_author_from_html(html, site_id="ananda-public"),
            "Tyagi Jayadev",
        )

    def test_ignores_rel_author_without_by_prefix(self):
        html = article_html(
            body='<span rel="author">Editorial Team</span><p>Article body</p>'
        )
        self.assertIsNone(extract_author_from_html(html, site_id="ananda-public"))

    def test_extracts_rel_author_with_by_prefix(self):
        html = article_html(
            body='<a rel="author" href="/author/jayadev/">by Tyagi Jayadev</a>'
        )
        self.assertEqual(
            extract_author_from_html(html, site_id="ananda-public"),
            "Tyagi Jayadev",
        )

    def test_returns_none_for_navigation_page_with_meta_author(self):
        html = """
        <html><head>
          <meta name="author" content="steve" />
          <script>var dataLayer_content = {"pagePostType":"page"};</script>
        </head><body class="page"><h1>Meditation</h1></body></html>
        """
        self.assertIsNone(extract_author_from_html(html, site_id="ananda-public"))

    def test_returns_none_for_yogapedia_entry_with_meta_author(self):
        html = """
        <html><head>
          <meta name="author" content="Nabha Cosley" />
          <script>var dataLayer_content = {"pagePostType":"yogapedia",
          "pagePostType2":"single-yogapedia"};</script>
        </head><body class="single-yogapedia"><p>Definition</p></body></html>
        """
        self.assertIsNone(extract_author_from_html(html, site_id="ananda-public"))

    def test_returns_none_when_no_author_present(self):
        html = article_html(body="<p>No author here.</p>")
        self.assertIsNone(extract_author_from_html(html, site_id="ananda-public"))

    def test_ignores_body_text_starting_with_by(self):
        html = article_html(
            body="<article><p>By the practice of meditation, you will find peace.</p></article>"
        )
        self.assertIsNone(extract_author_from_html(html, site_id="ananda-public"))

    def test_returns_none_for_navigation_page_with_article_json_ld(self):
        schema = {
            "@context": "https://schema.org",
            "@type": "Article",
            "author": {"name": "Nabha Cosley"},
        }
        html = f"""
        <html><head>
          <meta name="author" content="Nabha Cosley" />
          <script type="application/ld+json">{json.dumps(schema)}</script>
          <script>var dataLayer_content = {{"pagePostType":"page"}};</script>
        </head><body class="page"><h1>Meditation</h1></body></html>
        """
        self.assertIsNone(extract_author_from_html(html, site_id="ananda-public"))

    def test_detects_article_via_datalayer_only(self):
        html = f"""
        <html><head>{ARTICLE_DATALAYER}
          <meta name="author" content="Tyagi Jayadev" />
        </head><body class="page"><p>Article body</p></body></html>
        """
        self.assertEqual(
            extract_author_from_html(html, site_id="ananda-public"),
            "Tyagi Jayadev",
        )


class TestPageProcessingAuthorPropagation(unittest.TestCase):
    def test_update_pinecone_vectors_passes_author_to_create_embeddings(self):
        from unittest.mock import MagicMock

        from data_ingestion.crawler.config import PageContent
        from data_ingestion.crawler.page_processing import (
            _process_page_content,
            _update_pinecone_vectors,
        )

        crawler = MagicMock()
        crawler.text_splitter.split_text.return_value = ["chunk one"]
        crawler.should_process_content.return_value = True
        crawler.remove_url_from_pinecone.return_value = 0
        crawler.create_embeddings.return_value = [{"id": "vec-1", "values": [], "metadata": {}}]

        content = PageContent(
            url="https://www.ananda.org/blog/example/",
            title="Example Post",
            content="Article body with enough words to chunk.",
            metadata={"type": "text", "source": "https://www.ananda.org/blog/example/", "author": "Tyagi Jayadev"},
        )

        _update_pinecone_vectors(
            crawler,
            MagicMock(),
            "test-index",
            content.url,
            ["chunk one"],
            content.title,
            author="Tyagi Jayadev",
        )
        crawler.create_embeddings.assert_called_once_with(
            ["chunk one"],
            content.url,
            content.title,
            author="Tyagi Jayadev",
        )

        crawler.reset_mock()
        crawler.create_embeddings.return_value = [{"id": "vec-1", "values": [], "metadata": {}}]

        pages_inc, restart_inc, rate_limit = _process_page_content(
            content,
            [],
            content.url,
            crawler,
            MagicMock(),
            "test-index",
        )

        self.assertEqual(pages_inc, 1)
        self.assertFalse(rate_limit)
        crawler.create_embeddings.assert_called_once_with(
            ["chunk one"],
            content.url,
            content.title,
            author="Tyagi Jayadev",
        )


if __name__ == "__main__":
    unittest.main()
