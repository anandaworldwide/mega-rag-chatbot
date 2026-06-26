"""Tests for author extraction from crawled HTML."""

import json
import unittest

from data_ingestion.crawler.author_extraction import extract_author_from_html


class TestAuthorExtraction(unittest.TestCase):
    def test_extracts_visible_byline(self):
        html = """
        <html><body>
          <header>
            <div class="ananda-x-entry-subtitle">by Maitri Jones</div>
          </header>
        </body></html>
        """
        self.assertEqual(
            extract_author_from_html(html, site_id="ananda-public"),
            "Maitri Jones",
        )

    def test_prefers_visible_byline_over_meta(self):
        html = """
        <html><head>
          <meta name="author" content="Ananda Sangha Worldwide" />
        </head><body>
          <div class="ananda-x-entry-subtitle">by Tyagi Shivendra</div>
        </body></html>
        """
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
        html = f"""
        <html><head>
          <script type="application/ld+json">{json.dumps(schema)}</script>
        </head><body><p>Article body</p></body></html>
        """
        self.assertEqual(
            extract_author_from_html(html, site_id="ananda-public"),
            "Tyagi Jayadev",
        )

    def test_extracts_meta_author_when_no_byline(self):
        html = """
        <html><head>
          <meta name="author" content="Tyagi Jayadev" />
        </head><body><p>Article body</p></body></html>
        """
        self.assertEqual(
            extract_author_from_html(html, site_id="ananda-public"),
            "Tyagi Jayadev",
        )

    def test_normalizes_generic_org_author(self):
        html = """
        <html><head>
          <meta name="author" content="Ananda Sangha Worldwide" />
        </head><body><p>Article body</p></body></html>
        """
        self.assertEqual(
            extract_author_from_html(html, site_id="ananda-public"),
            "Swami Kriyananda",
        )

    def test_returns_none_when_no_author_present(self):
        html = "<html><body><h1>Welcome</h1><p>No author here.</p></body></html>"
        self.assertIsNone(extract_author_from_html(html, site_id="ananda-public"))

    def test_ignores_body_text_starting_with_by(self):
        html = """
        <html><body><article>
          <p>By the practice of meditation, you will find peace.</p>
        </article></body></html>
        """
        self.assertIsNone(extract_author_from_html(html, site_id="ananda-public"))


if __name__ == "__main__":
    unittest.main()
