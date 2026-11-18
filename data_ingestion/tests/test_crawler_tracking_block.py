"""The crawler's browser must not load analytics or ad-tracking scripts."""

import pytest

from data_ingestion.crawler.browser import _is_blocked_request

BLOCKED_URLS = [
    "https://www.ananda.org/wp-content/plugins/pixelyoursite/dist/scripts/public.js?ver=11.4.5",
    "https://www.ananda.org/wp-json/pys-facebook/v1/event",
    "https://connect.facebook.net/en_US/fbevents.js",
    "https://www.facebook.com/tr/?id=123&ev=PageView",
    "https://www.googletagmanager.com/gtm.js?id=GTM-XXXX",
    "https://www.google-analytics.com/g/collect?v=2",
    "https://region1.analytics.google.com/g/collect?v=2",
]

ALLOWED_URLS = [
    "https://www.ananda.org/meditation/",
    "https://www.ananda.org/wp-content/themes/ananda/js/menu.js",
    "https://www.ananda.org/wp-includes/js/jquery/jquery.min.js",
    "https://www.ananda.org/wp-json/wp/v2/pages",
]


@pytest.mark.parametrize("url", BLOCKED_URLS)
def test_tracking_requests_are_blocked(url):
    assert _is_blocked_request("script", url)


@pytest.mark.parametrize("url", ALLOWED_URLS)
def test_site_requests_are_allowed(url):
    assert not _is_blocked_request("script", url)
    assert not _is_blocked_request("document", url)


@pytest.mark.parametrize("resource_type", ["image", "media", "font", "stylesheet"])
def test_nonessential_resource_types_still_blocked(resource_type):
    assert _is_blocked_request(resource_type, "https://www.ananda.org/a-file")
