"""The crawler's browser must not load analytics or ad-tracking scripts."""

from unittest.mock import Mock

import pytest

from data_ingestion.crawler.browser import (
    _block_nonessential_resources,
    _is_blocked_request,
)

BLOCKED_URLS = [
    "https://www.ananda.org/wp-content/plugins/pixelyoursite/dist/scripts/public.js?ver=11.4.5",
    "https://www.ananda.org/wp-json/pys-facebook/v1/event",
    "https://connect.facebook.net/en_US/fbevents.js",
    "https://www.facebook.com/tr/?id=123&ev=PageView",
    "https://facebook.com/tr",
    "https://WWW.FACEBOOK.COM/tr/?id=123",
    "https://www.facebook.com/tr/",
    "https://stats.g.doubleclick.net/dc.js",
    "https://www.google.com/ccm/collect?tid=1",
    "https://www.googleadservices.com/pagead/conversion.js",
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


@pytest.mark.parametrize(
    "url",
    [
        "https://www.facebook.com/travel",
        "https://www.facebook.com/track",
        "https://www.facebook.com/training",
        "https://notfacebook.com/tr",
        "https://evilfacebook.com/tr",
    ],
)
def test_facebook_lookalike_paths_are_allowed(url):
    assert not _is_blocked_request("document", url)


def test_route_handler_aborts_facebook_pixel():
    page = Mock()
    handler = {}

    def capture_route(pattern, callback):
        handler["callback"] = callback

    page.route.side_effect = capture_route
    _block_nonessential_resources(page)
    page.route.assert_called_once_with("**/*", handler["callback"])

    route = Mock()
    route.request.resource_type = "script"
    route.request.url = "https://www.facebook.com/tr/?id=123&ev=PageView"
    handler["callback"](route)
    route.abort.assert_called_once()
    route.continue_.assert_not_called()


def test_route_handler_allows_site_page():
    page = Mock()
    handler = {}

    def capture_route(pattern, callback):
        handler["callback"] = callback

    page.route.side_effect = capture_route
    _block_nonessential_resources(page)

    route = Mock()
    route.request.resource_type = "document"
    route.request.url = "https://www.ananda.org/meditation/"
    handler["callback"](route)
    route.continue_.assert_called_once()
    route.abort.assert_not_called()
