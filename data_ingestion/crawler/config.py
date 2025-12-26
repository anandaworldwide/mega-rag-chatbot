"""Configuration, constants, and utility functions for the website crawler."""

import json
import logging
import os
from dataclasses import dataclass
from functools import wraps
from pathlib import Path
from typing import NamedTuple
from urllib.parse import urlparse, urlunparse

# Define User-Agent constant
USER_AGENT = "Ananda Chatbot Crawler"

# Constants
MAX_PLAYWRIGHT_FIREFOX_PROCS = 3  # Soft cap before we start force-cleaning
CLEANUP_AGE_SECONDS = 600  # 10 minutes

# Health monitoring constants
HEALTH_CHECK_INTERVAL = 300  # 5 minutes
HEALTH_WEDGE_TIMEOUT = (
    420  # 7 minutes of no progress (reasonable for 45-min bounded execution)
)


def _is_running_in_cloud() -> bool:
    """
    Heuristic: treat ECS/Fargate runs as "cloud" for log formatting.

    CloudWatch Logs already prefixes each line with a timestamp, so we avoid duplicating it.
    """
    return bool(
        os.getenv("ECS_CONTAINER_METADATA_URI_V4")
        or os.getenv("ECS_CONTAINER_METADATA_URI")
        or os.getenv("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI")
        or os.getenv("AWS_CONTAINER_CREDENTIALS_FULL_URI")
        or os.getenv("AWS_EXECUTION_ENV", "").startswith("AWS_ECS")
    )


def _configure_logging(*, debug: bool) -> None:
    is_cloud = _is_running_in_cloud()
    log_level = logging.DEBUG if debug else logging.INFO

    # CloudWatch already adds a timestamp prefix, so omit %(asctime)s in cloud.
    log_format = (
        "%(levelname)s - %(message)s"
        if is_cloud
        else "%(asctime)s - %(levelname)s - %(message)s"
    )

    # Ensure we override the module-level default handler.
    logging.basicConfig(level=log_level, format=log_format, force=True)


def load_config(site_id: str) -> dict | None:
    """Load site configuration from JSON file."""
    config_dir = Path(__file__).parent / "crawler_config"
    config_file = config_dir / f"{site_id}-config.json"
    if not config_file.exists():
        logging.error(f"Configuration file not found: {config_file}")
        return None
    try:
        with open(config_file) as f:
            config_data = json.load(f)
        # Basic validation (add more as needed)
        if "domain" not in config_data or "skip_patterns" not in config_data:
            logging.error(
                "Config file is missing required keys ('domain', 'skip_patterns')."
            )
            return None
        return config_data
    except json.JSONDecodeError as e:
        logging.error(f"Error decoding JSON from {config_file}: {e}")
        return None
    except Exception as e:
        logging.error(f"Error loading config file {config_file}: {e}")
        return None


@dataclass
class PageContent:
    url: str
    title: str
    content: str
    metadata: dict


class ContentHash:
    """Constants for content_hash field values."""

    NON_HTML = "non_html"
    NON_HTML_CONTENT = "non_html_content"
    MEDIA_REDIRECT = "media_redirect"
    WP_LOGIN_REDIRECT = "wp_login_redirect"
    PINECONE_CLEANED = "pinecone_cleaned"
    NEEDS_PINECONE_CLEANUP = "needs_pinecone_cleanup"
    EMPTY_CONTENT = "empty_content"
    NO_CONTENT = "no_content"
    DELETED = "deleted"


class Timeouts:
    """Timeout constants in milliseconds unless noted."""

    BROWSER_LAUNCH_MS = 30000
    PAGE_DEFAULT_MS = 30000
    BODY_SELECTOR_MS = 30000
    HTML_FALLBACK_MS = 10000
    NETWORK_IDLE_MS = 15000
    BROWSER_SETUP_SECONDS = 120


class CrawlIterationResult(NamedTuple):
    """Result of a single crawl loop iteration."""

    pages_processed: int
    pages_since_restart: int
    should_exit: bool
    should_restart: bool
    browser_state: tuple  # (browser, page, batch_start_time, batch_results)
    rate_limit_hit: bool


class PineconeCleanupError(Exception):
    """Raised when Pinecone cleanup fails and URL should be retried later."""

    pass


def requires_db(method):
    """Decorator to ensure database is initialized before method execution."""

    @wraps(method)
    def wrapper(self, *args, **kwargs):
        self._ensure_db_initialized()
        return method(self, *args, **kwargs)

    return wrapper


def ensure_scheme(url: str, default_scheme: str = "https") -> str:
    """Ensure a URL has a scheme, adding a default if missing."""
    parsed = urlparse(url)
    if not parsed.scheme:
        # Reconstruct with default scheme, preserving path, query, etc.
        # Handle schemeless absolute paths like 'domain.com/path'
        if not parsed.netloc and parsed.path:
            parts = parsed.path.split("/", 1)
            netloc = parts[0]
            path = "/" + parts[1] if len(parts) > 1 else ""
            parsed = parsed._replace(scheme=default_scheme, netloc=netloc, path=path)
        else:
            # Standard case
            parsed = parsed._replace(scheme=default_scheme)
    return urlunparse(parsed)
