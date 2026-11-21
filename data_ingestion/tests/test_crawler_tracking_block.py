"""The crawler's browser must not load Facebook or Google tracking scripts."""

from unittest.mock import Mock, patch

import pytest

from data_ingestion.crawler.browser import (
    _block_nonessential_resources,
    _is_blocked_request,
    _launch_browser_instance,
)

BLOCKED_URLS = [
    "https://www.ananda.org/wp-content/plugins/pixelyoursite/dist/scripts/public.js?ver=11.4.5",
    "https://www.ananda.org/wp-json/pys-facebook/v1/event",
    "https://connect.facebook.net/en_US/fbevents.js",
    "https://www.facebook.com/tr/?id=123&ev=PageView",
    "https://facebook.com/tr",
    "https://WWW.FACEBOOK.COM/tr/?id=123",
    "https://www.facebook.com/tr/",
    "https://www.facebook.com/tr/extra",
    "https://www.facebook.com./tr/",
    "https://www.googletagmanager.com./gtm.js",
    "https://www.ananda.org/es/wp-json/pys-facebook/v1/event",
    "https://stats.g.doubleclick.net/dc.js",
    "https://googleads.g.doubleclick.net/pagead/id",
    "https://static.doubleclick.net/instream/ad_status.js",
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
    "https://www.ananda.org/?s=/wp-json/pys-x",
    "https://www.ananda.org/?redirect=/wp-content/plugins/pixelyoursite",
    "https://www.ananda.org/?ref=facebook.com/tr",
    "https://www.google.com/recaptcha/api.js",
    "https://www.google.com/ccm/collectx",
    "http://[bad/tr",
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
def test_facebook_lookalikes_are_allowed(url):
    assert not _is_blocked_request("document", url)


@pytest.mark.parametrize(
    "url",
    [
        "https://notdoubleclick.net/pagead/id",
        "https://doubleclick.net.example.com/pagead/id",
        "https://www.example.com/doubleclick.net/pagead/id",
        "https://facebook.com.evil.com/tr",
        "https://google-analytics.com.evil.com/g/collect",
        "https://evilfacebook.com/tr",
    ],
)
def test_blocked_host_lookalikes_are_allowed(url):
    assert not _is_blocked_request("script", url)


@pytest.mark.parametrize(
    "url",
    [
        "https://www.google-analytics.com/g/collect",
        "https://stats.g.doubleclick.net/dc.js",
        "https://www.google-analytics.com:443/g/collect",
        "https://www.facebook.com:443/tr",
        "https://www.google-analytics.com:8080/g/collect",
        "https://www.facebook.com:8080/tr",
        "https://WWW.GOOGLE-ANALYTICS.COM/g/collect",
        "https://Www.Facebook.Com/tr",
        "https://www.google-analytics.com/g/collect?v=2&tid=G-XXXX",
        "https://www.facebook.com/tr/?id=123&ev=PageView#frag",
        "https://www.google-analytics.com./g/collect",
        "https://www.facebook.com./tr",
    ],
)
def test_tracking_url_edge_cases_are_blocked(url):
    assert _is_blocked_request("script", url)


@pytest.mark.parametrize(
    "url",
    [
        "https://facebook.com.evil.com:443/tr",
        "https://google-analytics.com.evil.com:8080/g/collect",
        "https://Facebook.Com.Evil.Com/tr",
        "https://www.ananda.org/page?next=https://facebook.com/tr",
        "https://www.ananda.org/page#https://www.google-analytics.com/g/collect",
        "https://facebook.com.evil.com./tr",
    ],
)
def test_lookalike_and_site_url_edge_cases_are_allowed(url):
    assert not _is_blocked_request("script", url)
    assert not _is_blocked_request("document", url)


def _capture_handler():
    """Install the block on a mock page and return the route handler."""
    page = Mock()
    _block_nonessential_resources(page)
    page.route.assert_called_once()
    pattern, handler = page.route.call_args.args
    assert pattern == "**/*"
    return handler


def _mock_route(resource_type, url):
    route = Mock()
    route.request.resource_type = resource_type
    route.request.url = url
    return route


def test_route_handler_aborts_facebook_pixel():
    route = _mock_route("script", "https://www.facebook.com/tr/?id=123&ev=PageView")
    _capture_handler()(route)
    route.abort.assert_called_once()
    route.continue_.assert_not_called()


def test_route_handler_allows_site_page():
    route = _mock_route("document", "https://www.ananda.org/meditation/")
    _capture_handler()(route)
    route.continue_.assert_called_once()
    route.abort.assert_not_called()


def test_launch_disables_beacons():
    playwright = Mock()
    page = playwright.firefox.launch.return_value.new_page.return_value
    page.evaluate.return_value = "browser_ready"
    with patch("data_ingestion.crawler.browser._block_nonessential_resources"):
        _launch_browser_instance(playwright, 30000, 0, 1)
    prefs = playwright.firefox.launch.call_args.kwargs["firefox_user_prefs"]
    assert prefs["beacon.enabled"] is False
