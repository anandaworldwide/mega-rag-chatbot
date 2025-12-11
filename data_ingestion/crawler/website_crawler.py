#! /usr/bin/env python
#
# This script is a web crawler designed to scrape content from a specified domain and store it in a Pinecone index.
# It uses Playwright for browser automation and BeautifulSoup for HTML parsing.
# The crawler maintains state using a SQLite database and can resume from where it left off.
# It filters out unwanted URLs and media files, focusing on text content.
# The script also handles exit signals gracefully, committing database changes before shutting down.
#
# Command line arguments:
#   --site: Site ID for environment variables (e.g., ananda-public).
#           Loads config from crawler_config/[site]-config.json and .env.[site]. REQUIRED.
#   --retry-failed: Retry URLs marked as 'permanent' failed in the database.
#   --fresh-start: Delete the existing SQLite database and start from a clean slate.
#   -c, --clear-vectors: Clear existing web content vectors for this site before crawling.
#   --stop-after: Stop crawling after processing this many pages (useful for testing).
#   --debug: Enable debug mode with detailed logging and page screenshots.
#
# Example usage:
#   website_crawler.py --site ananda-public
#   website_crawler.py --site ananda-public --retry-failed
#   website_crawler.py --site ananda-public --clear-vectors
#   website_crawler.py --site ananda-public --stop-after 5
#   website_crawler.py --site ananda-public --debug

# Standard library imports
import argparse
import csv
import gc
import hashlib
import json
import logging
import os
import random
import re
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time
import traceback
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING, Any
from urllib.parse import urlparse, urlunparse
from urllib.robotparser import RobotFileParser

if TYPE_CHECKING:
    pass

# Third party imports
from bs4 import BeautifulSoup
from dotenv import load_dotenv
from playwright.sync_api import TimeoutError as PlaywrightTimeout
from playwright.sync_api import sync_playwright
from readability import Document

# Optional imports (may not be available in all environments)
try:
    import psutil
except ImportError:
    psutil = None

# Additional imports for specific functionality
import threading
from contextlib import suppress

from langchain_openai import OpenAIEmbeddings

# OpenAI imports for rate limit handling (used for fallback checks)
try:
    import openai
except ImportError:
    # Fallback for when openai is not available
    openai = None

# Import shared utility
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from utils.pinecone_utils import (
    clear_library_vectors,
    create_pinecone_index_if_not_exists,
    generate_vector_id,
    get_pinecone_client,
    get_pinecone_ingest_index_name,
)
from utils.progress_utils import is_exiting, setup_signal_handlers
from utils.text_splitter_utils import SpacyTextSplitter

# Configure logging with timestamps (will be updated in main() if debug mode)
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s"
)

# Suppress INFO messages from the underlying HTTP library (often httpx)
httpx_logger = logging.getLogger("httpx")
httpx_logger.setLevel(logging.WARNING)

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


class HealthMonitor:
    """Monitors crawler health and triggers restarts if wedged."""

    def __init__(self, crawler):
        self.crawler = crawler
        self.last_progress_time = time.time()
        self.browser = None
        self.page = None

    def update_progress(self):
        """Update the last progress timestamp."""
        self.last_progress_time = time.time()

    def set_browser(self, browser, page):
        """Set the current browser and page for health checks."""
        self.browser = browser
        self.page = page

    def check_health(self):
        """Perform health check and return True if healthy, False if wedged."""
        try:
            # Check if we've made progress recently
            time_since_progress = time.time() - self.last_progress_time
            if time_since_progress > HEALTH_WEDGE_TIMEOUT:
                logging.warning(
                    f"No progress in {time_since_progress:.0f} seconds, crawler may be wedged"
                )
                return False

            # Note: Browser responsiveness check removed due to threading issues
            # Playwright browser operations must be performed on the main thread
            # The health monitor runs in a separate thread, so we can't safely check browser state

            # Check system resources - be lenient for bounded execution
            if psutil:
                memory = psutil.virtual_memory()
                available_gb = memory.available / 1024**3

                # Only restart for truly critical memory situations in bounded execution
                if (
                    memory.percent > 98 or available_gb < 0.2
                ):  # Very critical thresholds
                    logging.warning(
                        f"Critical memory situation: {memory.percent:.1f}% used ({available_gb:.1f}GB available)"
                    )
                    return False

                # Be more lenient with CPU for bounded execution
                cpu_percent = psutil.cpu_percent(interval=1)
                if cpu_percent > 95:  # Only restart if CPU is extremely high
                    logging.warning(f"Critical CPU usage: {cpu_percent}%")
                    return False

            return True

        except Exception as e:
            logging.error(f"Health check error: {e}")
            return False

    def start_monitoring(self):
        """Start the health monitoring thread."""

        def monitor_loop():
            while True:
                time.sleep(HEALTH_CHECK_INTERVAL)
                if not self.check_health():
                    logging.error("Health check failed - triggering restart by exiting")
                    os._exit(2)  # Exit with code 2 to signal daemon restart

        thread = threading.Thread(target=monitor_loop, daemon=True)
        thread.start()
        logging.info("Health monitoring started")


# --- Configuration Loading ---
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
        logging.info(f"Loaded configuration from {config_file}")
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
    return url


class WebsiteCrawler:
    def __init__(
        self,
        site_id: str,
        site_config: dict,
        retry_failed: bool = False,
        debug: bool = False,
        skip_db_init: bool = False,
        skip_robots_init: bool = False,
        dry_run: bool = False,
    ):
        self.site_id = site_id
        self.config = site_config
        self.debug = debug
        self.dry_run = dry_run
        self.domain = self.config["domain"]
        self.start_url = ensure_scheme(self.domain)  # Start URL is now just the domain
        self.skip_patterns = self.config.get("skip_patterns", [])
        self.crawl_frequency_days = self.config.get("crawl_frequency_days", 14)
        self.crawl_delay_seconds = self.config.get("crawl_delay_seconds", 1)

        # CSV mode configuration
        self.csv_export_url = self.config.get("csv_export_url")
        self.csv_modified_days_threshold = self.config.get(
            "csv_modified_days_threshold", 1
        )
        self.csv_mode_enabled = bool(self.csv_export_url)

        # Track if we've completed initial full crawl
        self.initial_crawl_completed = False

        if self.debug:
            logging.info(
                "Debug mode enabled - detailed logging and screenshots will be saved"
            )

        # Initialize robots.txt parser with 24-hour caching (skip for tests)
        self.robots_url = f"{self.start_url.rstrip('/')}/robots.txt"
        self.robots_parser = None
        self.robots_cache_timestamp = None
        self.robots_cache_duration_hours = 24
        if not skip_robots_init:
            self._load_robots_txt()

        # Initialize text splitter lazily to avoid loading spaCy models in tests
        self._text_splitter = None

        # Initialize embeddings lazily to avoid API calls in tests
        self._embeddings = None
        self._embedding_model_name = None

        # Initialize health monitor
        self.health_monitor = HealthMonitor(self)

        # Set up SQLite database for crawl queue (skip for tests)
        self.conn: sqlite3.Connection | None = None
        self.cursor: sqlite3.Cursor | None = None
        self.db_file: Path | None = None
        self.current_processing_url: str | None = None
        self._rate_limit_exit: bool = False

        if not skip_db_init:
            self._init_database()

            # Handle --retry-failed flag
            if retry_failed:
                self.retry_failed_urls()

            # Run initialization logic
            self._run_initialization_logic()

    def _init_database(self):
        """Initialize SQLite database - separated for testability."""
        # Support DATA_DIR environment variable for EFS mounts (cloud deployment)
        data_dir = os.getenv("DATA_DIR")
        db_dir = Path(data_dir) / "db" if data_dir else Path(__file__).parent / "db"
        db_dir.mkdir(parents=True, exist_ok=True)
        self.db_file = db_dir / f"crawler_queue_{self.site_id}.db"
        self.conn = sqlite3.connect(str(self.db_file))
        self.conn.row_factory = sqlite3.Row  # Allow dictionary-like access to rows
        self.cursor = self.conn.cursor()

        # Create crawl_queue table if it doesn't exist
        self.cursor.execute("""
        CREATE TABLE IF NOT EXISTS crawl_queue (
            url TEXT PRIMARY KEY,
            last_crawl TIMESTAMP,
            next_crawl TIMESTAMP,
            crawl_frequency INTEGER,
            content_hash TEXT,
            last_error TEXT,
            status TEXT DEFAULT 'pending',
            retry_count INTEGER DEFAULT 0,
            retry_after TIMESTAMP,
            failure_type TEXT,
            priority INTEGER DEFAULT 0,
            modified_date TIMESTAMP
        )""")

        # Create CSV tracking table if it doesn't exist
        self.cursor.execute("""
        CREATE TABLE IF NOT EXISTS csv_tracking (
            id INTEGER PRIMARY KEY,
            initial_crawl_completed BOOLEAN DEFAULT 0,
            last_check_time TEXT,
            last_error TEXT
        )""")

        # Create removal log table to track processed removals and prevent redundant work
        self.cursor.execute("""
        CREATE TABLE IF NOT EXISTS removal_log (
            url TEXT PRIMARY KEY,
            removed_at TEXT NOT NULL
        )""")

        self.conn.commit()

    def _ensure_db_initialized(self) -> None:
        """Ensure database is initialized. Raises RuntimeError if not."""
        if self.cursor is None or self.conn is None:
            raise RuntimeError("Database not initialized. Call _init_database() first.")
        # Type narrowing for Pyright
        assert self.cursor is not None
        assert self.conn is not None

    @property
    def text_splitter(self):
        """Lazy initialization of text splitter to avoid loading spaCy models in tests."""
        if self._text_splitter is None:
            # Historical: 1000 chars (~250 tokens) with 200 chars (~50 tokens, 20% overlap)
            self._text_splitter = SpacyTextSplitter(
                chunk_size=250,  # Historical web content chunk size
                chunk_overlap=50,  # Historical 20% overlap
            )
        return self._text_splitter

    @property
    def embeddings(self):
        """Lazy initialization of embeddings to avoid API calls in tests."""
        if self._embeddings is None:
            model_name = os.getenv("OPENAI_INGEST_EMBEDDINGS_MODEL")
            if not model_name:
                raise ValueError(
                    "OPENAI_INGEST_EMBEDDINGS_MODEL environment variable not set"
                )
            self._embedding_model_name = model_name
            self._embeddings = OpenAIEmbeddings(model=model_name, chunk_size=1000)
        return self._embeddings

    def _run_initialization_logic(self):
        """Run the initialization logic to check if start URL should be added."""
        # Check if database is completely empty (no URLs at all)
        # Only seed with start URL if this is a fresh database with no crawl history
        self._ensure_db_initialized()
        assert self.cursor is not None
        assert self.conn is not None
        self.cursor.execute("SELECT COUNT(*) FROM crawl_queue")
        total_count = self.cursor.fetchone()[0]

        if total_count == 0:
            logging.info(f"Database is empty. Seeding with start URL: {self.start_url}")
            self.add_url_to_queue(self.start_url, priority=1)
            self.conn.commit()
        else:
            # Check how many URLs are available for crawling for informational purposes
            self.cursor.execute("""
            SELECT COUNT(*) FROM crawl_queue 
            WHERE (
                (status = 'pending' AND (retry_after IS NULL OR retry_after <= datetime('now'))) 
                OR 
                (status = 'visited' AND next_crawl <= datetime('now'))
            )
            """)
            available_count = self.cursor.fetchone()[0]

            logging.info(
                f"Database contains {total_count} URLs total, {available_count} available for crawling"
            )

    def close(self):
        """Close database connection and print chunking metrics"""
        # Print chunking metrics summary before closing (only if splitter was ever initialized)
        if self._text_splitter is not None:
            logging.info("=== WEBSITE CRAWLER CHUNKING METRICS ===")
            self._text_splitter.metrics.print_summary()

        if hasattr(self, "conn") and self.conn:
            self.conn.close()

    def _is_robots_cache_expired(self) -> bool:
        """Check if robots.txt cache has expired (24 hours)."""
        if self.robots_cache_timestamp is None:
            return True

        cache_age = datetime.now() - self.robots_cache_timestamp
        return cache_age > timedelta(hours=self.robots_cache_duration_hours)

    def _load_robots_txt(self):
        """Load or reload robots.txt with caching."""
        try:
            self.robots_parser = RobotFileParser()
            self.robots_parser.set_url(self.robots_url)
            self.robots_parser.read()
            self.robots_cache_timestamp = datetime.now()
        except Exception as e:
            logging.error(f"Could not load robots.txt from {self.robots_url}: {e}")
            # Set to None to indicate robots.txt couldn't be loaded
            self.robots_parser = None
            self.robots_cache_timestamp = None

    def _ensure_robots_cache_fresh(self):
        """Ensure robots.txt cache is fresh, reload if expired."""
        if self._is_robots_cache_expired():
            logging.info("Robots.txt cache expired, reloading...")
            self._load_robots_txt()

    def add_url_to_queue(
        self, url: str, priority: int = 0, modified_date: str | None = None
    ):
        """Add URL to crawl queue if not already present, or update priority if higher"""
        self._ensure_db_initialized()
        assert self.cursor is not None
        assert self.conn is not None
        normalized_url = self.normalize_url(url)

        try:
            # First check if URL already exists
            self.cursor.execute(
                "SELECT status, priority, next_crawl, modified_date FROM crawl_queue WHERE url = ?",
                (normalized_url,),
            )
            existing = self.cursor.fetchone()

            if existing:
                (
                    existing_status,
                    existing_priority,
                    next_crawl,
                    existing_modified_date,
                ) = existing

                logging.debug(f"add_url_to_queue for {url}:")
                logging.debug(f"  - Existing status: {existing_status}")
                logging.debug(
                    f"  - Existing priority: {existing_priority}, new priority: {priority}"
                )
                logging.debug(f"  - Next crawl: {next_crawl}")
                logging.debug(f"  - Existing modified date: {existing_modified_date}")
                logging.debug(f"  - New modified date: {modified_date}")

                # If new priority is higher, update it and reset next_crawl for immediate processing
                if priority > existing_priority:
                    self.cursor.execute(
                        """
                        UPDATE crawl_queue 
                        SET priority = ?, next_crawl = datetime('now'), status = 'pending', modified_date = ?
                        WHERE url = ?
                        """,
                        (priority, modified_date, normalized_url),
                    )
                    logging.debug("  - Decision: updated_priority")
                    return "updated_priority"
                # If modified date is provided and different from existing, update it
                elif modified_date and modified_date != existing_modified_date:
                    self.cursor.execute(
                        """
                        UPDATE crawl_queue 
                        SET modified_date = ?, next_crawl = datetime('now'), status = 'pending'
                        WHERE url = ?
                        """,
                        (modified_date, normalized_url),
                    )
                    logging.debug("  - Decision: updated_modified_date")
                    return "updated_modified_date"
                else:
                    logging.debug("  - Decision: exists_lower_priority")
                    return "exists_lower_priority"
            else:
                # Insert new URL
                self.cursor.execute(
                    """
                    INSERT INTO crawl_queue 
                    (url, next_crawl, crawl_frequency, status, priority, modified_date) 
                    VALUES (?, datetime('now'), ?, 'pending', ?, ?)
                    """,
                    (
                        normalized_url,
                        self.crawl_frequency_days,
                        priority,
                        modified_date,
                    ),
                )
                logging.debug(f"add_url_to_queue for {url}: inserted new URL")
                return "inserted"

        except Exception as e:
            logging.error(f"Error adding URL to queue: {e}")
            return "error"

    def retry_failed_urls(self):
        """Reset failed URLs to pending status for retry"""
        self._ensure_db_initialized()
        assert self.cursor is not None
        assert self.conn is not None
        try:
            self.cursor.execute("""
            UPDATE crawl_queue 
            SET status = 'pending', next_crawl = datetime('now'), 
                last_error = NULL, retry_count = 0,
                retry_after = NULL, failure_type = NULL
            WHERE status = 'failed' 
            AND (failure_type = 'permanent' OR failure_type IS NULL)
            """)
            self.conn.commit()
            logging.info(
                f"Reset {self.cursor.rowcount} previously failed URLs for retry"
            )
        except Exception as e:
            logging.error(f"Error retrying failed URLs: {e}")

    def is_url_visited(self, url: str) -> bool:
        """Check if URL has already been successfully visited"""
        self._ensure_db_initialized()
        assert self.cursor is not None
        normalized_url = self.normalize_url(url)
        self.cursor.execute(
            "SELECT status FROM crawl_queue WHERE url = ? AND status = 'visited'",
            (normalized_url,),
        )
        return bool(self.cursor.fetchone())

    def is_url_in_database(self, url: str) -> bool:
        """Check if URL is already in the database (regardless of status)"""
        self._ensure_db_initialized()
        assert self.cursor is not None
        normalized_url = self.normalize_url(url)
        self.cursor.execute(
            "SELECT url FROM crawl_queue WHERE url = ?",
            (normalized_url,),
        )
        return bool(self.cursor.fetchone())

    def get_next_url_to_crawl(self) -> str | None:
        """Get the next URL to crawl from the queue"""
        self._ensure_db_initialized()
        assert self.cursor is not None
        assert self.conn is not None
        try:
            # Get URLs that are due for crawling, including visited URLs due for re-crawling
            # and pending URLs, respecting retry_after for temporary failures
            self.cursor.execute("""
            SELECT url FROM crawl_queue 
            WHERE (
                (status = 'pending' AND (retry_after IS NULL OR retry_after <= datetime('now'))) 
                OR 
                (status = 'visited' AND next_crawl <= datetime('now'))
            )
            ORDER BY 
                priority DESC,           -- Highest priority first
                status = 'pending' DESC,  -- Prioritize pending URLs first
                last_crawl IS NULL DESC,  -- Then new URLs
                retry_count ASC,         -- Then URLs with fewer retries
                next_crawl ASC,          -- Then URLs due longest ago
                url ASC                  -- Finally alphabetical for consistency
            LIMIT 1
            """)
            result = self.cursor.fetchone()
            if result:
                url = result[0]
                # If this is a visited URL due for re-crawling, reset it to pending
                self.cursor.execute(
                    "SELECT status FROM crawl_queue WHERE url = ?",
                    (self.normalize_url(url),),
                )
                status_result = self.cursor.fetchone()
                if status_result and status_result[0] == "visited":
                    logging.info(f"Re-crawling due URL: {url}")
                    self.cursor.execute(
                        """
                        UPDATE crawl_queue 
                        SET status = 'pending', next_crawl = datetime('now')
                        WHERE url = ?
                    """,
                        (self.normalize_url(url),),
                    )
                    self.conn.commit()
                return url
            return None
        except Exception as e:
            logging.error(f"Error getting next URL to crawl: {e}")
            return None

    def _handle_404_retry_logic(
        self, normalized_url: str, error_msg: str, now: str
    ) -> bool:
        """Handle 404 retry logic. Returns True if URL was processed, False if not a 404."""
        if not error_msg or "404" not in error_msg:
            return False

        self._ensure_db_initialized()
        assert self.cursor is not None
        # This is a 404 error - handle retry logic
        retry_count = 0
        self.cursor.execute(
            "SELECT retry_count FROM crawl_queue WHERE url = ?",
            (normalized_url,),
        )
        result = self.cursor.fetchone()
        if result and result[0] is not None:
            retry_count = result[0] + 1

        max_retries = 3  # Allow 3 retries for 404s

        if retry_count <= max_retries:
            # Set up retry with exponential backoff: 1hr, 6hr, 24hr
            hours_to_wait = [1, 6, 24][min(retry_count - 1, 2)]
            retry_after = (datetime.now() + timedelta(hours=hours_to_wait)).strftime(
                "%Y-%m-%d %H:%M:%S"
            )

            self.cursor.execute(
                """
                UPDATE crawl_queue 
                SET status = 'pending', last_error = ?, retry_count = ?, 
                    retry_after = ?, failure_type = '404_retriable', next_crawl = ?
                WHERE url = ?
                """,
                (
                    f"{error_msg} [retry {retry_count}/{max_retries}]",
                    retry_count,
                    retry_after,
                    retry_after,
                    normalized_url,
                ),
            )
            logging.info(
                f"404 error for {normalized_url}, scheduling retry {retry_count}/{max_retries} in {hours_to_wait} hours"
            )
        else:
            # Retry exhausted - mark as deleted for Pinecone cleanup
            self.cursor.execute(
                """
                UPDATE crawl_queue 
                SET status = 'deleted', last_crawl = ?, last_error = ?, content_hash = 'needs_pinecone_cleanup',
                    retry_count = ?, failure_type = '404_permanent'
                WHERE url = ?
                """,
                (
                    now,
                    f"{error_msg} [404 confirmed after {max_retries} retries]",
                    retry_count,
                    normalized_url,
                ),
            )
            logging.info(
                f"404 error for {normalized_url} confirmed after {max_retries} retries, marking for Pinecone cleanup"
            )

        return True

    def _handle_temporary_failure_retry(
        self, normalized_url: str, error_msg: str
    ) -> bool:
        """Handle temporary failure retry logic. Returns True if retry was set up, False for permanent failure."""
        self._ensure_db_initialized()
        assert self.cursor is not None
        # Check for typical temporary failure patterns
        temporary_patterns = [
            "timeout",
            "timed out",
            "connection",
            "reset",
            "refused",
            "network",
            "unreachable",
            "server error",
            "5",
            "503",
            "502",
            "overloaded",
            "too many requests",
            "429",
            "temporarily",
            "try again",
        ]

        is_temporary = False
        if error_msg:
            error_lower = error_msg.lower()
            is_temporary = any(pattern in error_lower for pattern in temporary_patterns)

        if not is_temporary:
            return False

        # Handle temporary failure retry logic
        retry_count = 0
        self.cursor.execute(
            "SELECT retry_count FROM crawl_queue WHERE url = ?",
            (normalized_url,),
        )
        result = self.cursor.fetchone()
        if result and result[0] is not None:
            retry_count = result[0] + 1

        # Exponential backoff: wait longer between retries
        # Cap at 10 retries (retry_count starts at 1 for first retry)
        if retry_count <= 10:
            # 5min, 15min, 1hr, 4hr, 12hr, 24hr, 48hr, 72hr, 96hr, 120hr
            minutes_to_wait = 5 * (3 ** min(retry_count, 9))
            retry_after = (
                datetime.now() + timedelta(minutes=minutes_to_wait)
            ).strftime("%Y-%m-%d %H:%M:%S")

            self.cursor.execute(
                """
                UPDATE crawl_queue 
                SET status = 'pending', last_error = ?, retry_count = ?, 
                    retry_after = ?, failure_type = 'temporary', next_crawl = ?
                WHERE url = ?
                """,
                (
                    f"{error_msg} [retry {retry_count}/10]",
                    retry_count,
                    retry_after,
                    retry_after,
                    normalized_url,
                ),
            )
            logging.info(
                f"Temporary failure for {normalized_url}, retry {retry_count}/10 in {minutes_to_wait} minutes"
            )
            return True
        else:
            # Retry exhausted - fall through to permanent failure
            self.cursor.execute(
                """
                UPDATE crawl_queue 
                SET status = 'failed', last_error = ?, retry_count = ?, failure_type = 'permanent'
                WHERE url = ?
                """,
                (
                    f"{error_msg} [retry exhausted after 10 attempts]",
                    retry_count,
                    normalized_url,
                ),
            )
            logging.info(
                f"Retry exhausted for {normalized_url}, marking as permanently failed"
            )
            return True

    def mark_url_status(
        self,
        url: str,
        status: str,
        error_msg: str | None = None,
        content_hash: str | None = None,
    ):
        """Update URL status in the database"""
        self._ensure_db_initialized()
        assert self.cursor is not None
        assert self.conn is not None
        normalized_url = self.normalize_url(url)
        now = datetime.now().isoformat()

        try:
            if status == "visited":
                # Calculate next crawl time based on frequency with 12% jitter
                next_crawl = self._calculate_next_crawl_with_jitter(
                    self.crawl_frequency_days
                ).isoformat()
                self.cursor.execute(
                    """
                UPDATE crawl_queue 
                SET status = ?, last_crawl = ?, next_crawl = ?, content_hash = ?,
                    retry_count = 0, retry_after = NULL, failure_type = NULL, priority = 0
                WHERE url = ?
                """,
                    (status, now, next_crawl, content_hash, normalized_url),
                )
            elif status == "deleted":
                # Mark URL as deleted - no next crawl time needed
                if self.dry_run:
                    logging.info(
                        f"[DRY RUN] Would mark URL as deleted: {normalized_url}"
                    )
                else:
                    self.cursor.execute(
                        """
                    UPDATE crawl_queue 
                    SET status = ?, last_crawl = ?, next_crawl = NULL, content_hash = ?, last_error = ?,
                        retry_count = 0, retry_after = NULL, failure_type = NULL, priority = 0
                    WHERE url = ?
                    """,
                        (
                            status,
                            now,
                            content_hash or "deleted",
                            error_msg,
                            normalized_url,
                        ),
                    )
            elif status == "failed":
                # Try 404 retry logic first
                if self._handle_404_retry_logic(normalized_url, error_msg or "", now):
                    pass  # 404 retry logic handled it
                # Try temporary failure retry logic
                elif self._handle_temporary_failure_retry(
                    normalized_url, error_msg or ""
                ):
                    pass  # Temporary failure retry logic handled it
                else:
                    # Permanent failure, don't retry automatically
                    self.cursor.execute(
                        """
                    UPDATE crawl_queue 
                    SET status = ?, last_crawl = ?, last_error = ?, 
                        retry_count = 0, retry_after = NULL, failure_type = 'permanent'
                    WHERE url = ?
                    """,
                        (status, now, error_msg, normalized_url),
                    )
                    logging.info(f"Permanent failure for {url}: {error_msg}")
            else:
                # Other status updates (like setting to 'pending')
                self.cursor.execute(
                    """
                UPDATE crawl_queue 
                SET status = ?, last_crawl = ? 
                WHERE url = ?
                """,
                    (status, now, normalized_url),
                )

            self.conn.commit()
            return True
        except Exception as e:
            logging.error(f"Error updating URL status: {e}")
            return False

    def commit_db_changes(self):
        """Commit any pending database changes"""
        self._ensure_db_initialized()
        assert self.conn is not None
        try:
            self.conn.commit()
            logging.debug("Database changes committed")
            return True
        except Exception as e:
            logging.error(f"Error committing database changes: {e}")
            return False

    def get_queue_stats(self) -> dict:
        """Get statistics about the crawl queue"""
        self._ensure_db_initialized()
        assert self.cursor is not None
        stats = {
            "pending": 0,
            "visited": 0,
            "failed": 0,
            "deleted": 0,
            "total": 0,
            "pending_retry": 0,  # URLs waiting to be retried
            "avg_retry_count": 0,  # Average retry count for URLs with retries
            "high_priority": 0,  # URLs with priority > 0
        }
        try:
            # Get counts by status
            self.cursor.execute("""
            SELECT status, COUNT(*) as count 
            FROM crawl_queue 
            GROUP BY status
            """)
            for row in self.cursor.fetchall():
                status, count = row["status"], row["count"]
                if status in stats:
                    stats[status] = count
                stats["total"] += count

            # Count pending URLs with retry_after in the future
            self.cursor.execute("""
            SELECT COUNT(*) FROM crawl_queue 
            WHERE status = 'pending' 
            AND retry_after IS NOT NULL 
            AND retry_after > datetime('now')
            """)
            stats["pending_retry"] = self.cursor.fetchone()[0]

            # Count high priority URLs
            self.cursor.execute("""
            SELECT COUNT(*) FROM crawl_queue 
            WHERE priority > 0
            """)
            stats["high_priority"] = self.cursor.fetchone()[0]

            # Get average retry count for URLs with retries
            self.cursor.execute("""
            SELECT AVG(retry_count) as avg_retries 
            FROM crawl_queue 
            WHERE retry_count > 0
            """)
            avg_result = self.cursor.fetchone()
            if avg_result and avg_result[0]:
                stats["avg_retry_count"] = round(avg_result[0], 1)

            # Count by failure type
            self.cursor.execute("""
            SELECT failure_type, COUNT(*) as count 
            FROM crawl_queue 
            WHERE failure_type IS NOT NULL
            GROUP BY failure_type
            """)
            for row in self.cursor.fetchall():
                failure_type, count = row["failure_type"], row["count"]
                if failure_type:
                    stats[f"{failure_type}_failures"] = count

            return stats
        except Exception as e:
            logging.error(f"Error getting queue stats: {e}")
            return stats

    def get_failed_urls(self) -> list[tuple[str, str]]:
        """Get list of failed URLs with error messages"""
        self._ensure_db_initialized()
        assert self.cursor is not None
        failed_urls = []
        try:
            self.cursor.execute("""
            SELECT url, last_error 
            FROM crawl_queue 
            WHERE status = 'failed'
            ORDER BY last_crawl DESC
            """)
            failed_urls = [
                (row["url"], row["last_error"] or "Unknown error")
                for row in self.cursor.fetchall()
            ]
            return failed_urls
        except Exception as e:
            logging.error(f"Error getting failed URLs: {e}")
            return []

    def normalize_url(self, url: str) -> str:
        """Normalize URL for comparison."""
        parsed = urlparse(url)
        # Strip www and fragments, but preserve query parameters
        normalized = parsed.netloc.replace("www.", "") + parsed.path.rstrip("/")
        if parsed.query:
            normalized += "?" + parsed.query
        return normalized.lower()

    def _is_wordpress_login_redirect(self, final_url: str, original_url: str) -> bool:
        """Check if we were redirected to a WordPress login page."""
        # Check if the final URL is a WordPress login page
        return "/wp-login.php" in final_url

    def should_skip_url(self, url: str) -> bool:
        """Check if URL should be skipped based on patterns"""
        # Check standard skip patterns
        if any(re.search(pattern, url) for pattern in self.skip_patterns):
            return True

        # Check for calendar/export URLs that serve non-HTML content
        parsed = urlparse(url)
        query_params = parsed.query.lower()

        # Skip URLs with calendar/export parameters
        calendar_params = ["ical", "ical=1", "export", "format=ical", "format=ics"]
        if any(param in query_params for param in calendar_params):
            logging.debug(f"Skipping calendar/export URL: {url}")
            return True

        return False

    def is_valid_url(self, url: str) -> bool:
        """Check if URL should be crawled."""
        try:
            parsed = urlparse(url)
            domain = parsed.netloc.replace("www.", "")
            path = parsed.path.lower()

            # Only follow links from the same domain
            if domain != self.domain:
                logging.debug(f"Skipping external domain: {domain}")
                return False

            # Check robots.txt compliance (refresh cache if needed)
            self._ensure_robots_cache_fresh()
            if self.robots_parser:
                if not self.robots_parser.can_fetch(USER_AGENT, url):
                    logging.debug(f"Robots.txt disallows crawling: {url}")
                    return False
            else:
                # If robots.txt couldn't be loaded, log warning but continue
                logging.debug(
                    f"No robots.txt loaded, proceeding with caution for: {url}"
                )

            # Skip non-http(s) URLs
            if parsed.scheme not in ["http", "https"]:
                return False

            # Skip media files and other non-HTML content
            skip_extensions = [
                ".jpg",
                ".jpeg",
                ".png",
                ".gif",
                ".svg",
                ".pdf",
                ".doc",
                ".docx",
                ".xls",
                ".xlsx",
                ".zip",
                ".rar",
                ".mp3",
                ".mp4",
                ".m4a",  # Added missing audio format
                ".wav",  # Added missing audio format
                ".aac",  # Added missing audio format
                ".avi",
                ".mov",
                ".wmv",
                ".flv",
                ".webp",
                ".rss",
                ".xml",  # Added feed types
                ".ico",  # Favicon files
                ".css",  # Stylesheet files
                ".js",  # JavaScript files
                ".woff",
                ".woff2",
                ".ttf",
                ".eot",  # Font files
            ]
            # Check for media extensions and common non-HTML paths
            if (
                any(path.endswith(ext) for ext in skip_extensions)
                or "/feed/" in path
                or "/wp-content/uploads/" in path
                or "/wp-includes/" in path
                or "/wp-admin/" in path
            ):
                logging.debug(f"Skipping non-HTML content: {url}")
                return False

            # Skip anchor-only URLs or root path (already handled by crawler logic, but explicit check is fine)
            if not parsed.path or parsed.path == "/":
                # Allow root path only if it's the start URL, otherwise usually redundant
                # Note: Crawler logic might already handle this implicitly by checking visited_urls
                # Let's keep it simple: if path is empty or just '/', consider invalid for *discovery*
                # The start URL case is handled separately at the beginning.
                logging.debug(f"Skipping root or anchor-only URL: {url}")
                return False

            return True
        except Exception as e:
            logging.debug(f"Invalid URL {url}: {e}")
            return False

    def _log_debug_content_info(self, html_content: str, soup: BeautifulSoup) -> None:
        """Log debug information about HTML content and elements to be removed."""
        logging.debug(f"Cleaning HTML content (length: {len(html_content)})")
        logging.debug(f"HTML content preview (first 500 chars): {html_content[:500]}")

        # Debug: Check what elements we're removing
        elements_to_remove = soup.select(
            "header, footer, nav, script, style, iframe, .sidebar"
        )
        logging.debug(
            f"Found {len(elements_to_remove)} elements to remove: {[elem.name for elem in elements_to_remove[:10]]}"
        )

    def _log_content_selectors_debug(self, soup: BeautifulSoup) -> None:
        """Log debug information about content selectors found."""
        if not self.debug:
            return

        content_selectors = [
            "main",
            "article",
            ".content",
            "#content",
            ".entry-content",
            ".main-content",
            ".post-content",
        ]

        for selector in content_selectors:
            found_elements = soup.select(selector)
            if found_elements:
                logging.debug(
                    f"Found {len(found_elements)} elements with selector '{selector}'"
                )
                for i, elem in enumerate(found_elements[:3]):  # Show first 3
                    preview_text = elem.get_text(separator=" ", strip=True)[:100]
                    logging.debug(f"  Element {i + 1} preview: {preview_text}")

    def _extract_main_content(self, soup: BeautifulSoup) -> str:
        """Extract text from main content areas."""
        main_content = soup.select_one(
            "main, article, .content, #content, .entry-content, .main-content, .post-content"
        )

        if main_content:
            text = main_content.get_text(separator=" ", strip=True)
            logging.debug(
                f"Extracted text from main content area (length: {len(text)})"
            )
            return text

        return ""

    def _log_page_structure_debug(self, soup: BeautifulSoup) -> None:
        """Log debug information about page structure."""
        body = soup.body
        if body:
            all_text = body.get_text(separator=" ", strip=True)
            logging.debug(f"Raw body text length: {len(all_text)}")
            logging.debug(f"Raw body text preview: {all_text[:200]}")

            # Check for common content containers
            common_containers = [
                "div",
                ".container",
                ".wrapper",
                "#main",
                ".site-content",
            ]
            for container in common_containers:
                elements = soup.select(container)
                if elements:
                    logging.debug(f"Found {len(elements)} '{container}' elements")

    def _extract_with_readability(self, html_content: str) -> str:
        """Extract content using readability library as fallback."""
        try:
            doc = Document(html_content)
            summary_html = doc.summary()

            logging.debug(f"Readability summary HTML length: {len(summary_html)}")
            logging.debug(f"Readability summary preview: {summary_html[:300]}")

            # Parse the summary HTML back into BeautifulSoup to extract text
            summary_soup = BeautifulSoup(summary_html, "html.parser")
            text = summary_soup.get_text(separator=" ", strip=True)

            logging.debug(f"Readability extracted text length: {len(text)}")
            return text

        except Exception as e:
            logging.error(f"Readability fallback failed: {e}")
            return ""

    def _extract_body_fallback(self, soup: BeautifulSoup) -> str:
        """Extract text from body as final fallback."""
        body_content = soup.body
        if body_content:
            text = body_content.get_text(separator=" ", strip=True)
            logging.debug(f"Body fallback text length: {len(text)}")
            return text
        return ""

    def _log_final_debug_info(self, text: str, soup: BeautifulSoup) -> None:
        """Log final debug information about extraction results."""
        if not text:
            logging.warning("No content extracted after fallback attempts")
            # Final debug: show the raw HTML structure - only in debug mode since this is expensive
            if self.debug and soup.body:
                logging.debug("HTML body structure (tags only):")
                for elem in soup.body.find_all(True)[:20]:  # First 20 elements
                    attrs = dict(elem.attrs) if elem.attrs else {}
                    logging.debug(f"  <{elem.name} {attrs}>")
        else:
            logging.debug(f"Extracted text length: {len(text)}")
            logging.debug(f"Final text preview: {text[:200]}")

    def clean_content(self, html_content: str) -> str:
        """Clean HTML content and extract main text."""
        soup = BeautifulSoup(html_content, "html.parser")

        # Log debug info and remove unwanted elements
        self._log_debug_content_info(html_content, soup)

        elements_to_remove = soup.select(
            "header, footer, nav, script, style, iframe, .sidebar"
        )
        for element in elements_to_remove:
            element.decompose()

        # Debug content selectors
        self._log_content_selectors_debug(soup)

        # Try to extract from main content areas first
        text = self._extract_main_content(soup)

        # If no main content found and we have HTML, try fallback methods
        if not text and html_content:
            logging.warning(
                "No specific content area found, attempting readability fallback"
            )

            # Log page structure for debugging
            self._log_page_structure_debug(soup)

            # Try readability extraction
            text = self._extract_with_readability(html_content)

            # If readability failed, try body fallback
            if not text:
                text = self._extract_body_fallback(soup)

        # Normalize whitespace
        text = re.sub(r"\s+", " ", text).strip()

        # Log final results
        self._log_final_debug_info(text, soup)

        return text

    async def reveal_nav_items(self, page):
        """Reveal all navigation menu items by triggering hover events"""
        try:
            # Click all menu toggles
            await page.click("button.menu-toggle", timeout=1000)

            # Find all top-level nav items
            nav_items = await page.query_selector_all("li.menu-item-has-children")

            for item in nav_items:
                try:
                    # Hover over each nav item to reveal submenus
                    await item.hover()
                    await page.wait_for_timeout(500)  # Wait for animation

                    # Click to expand if needed (some menus might need click instead of hover)
                    await item.click()
                    await page.wait_for_timeout(500)
                except Exception as e:
                    logging.debug(f"Error revealing menu item: {e}")
                    continue

        except Exception as e:
            logging.debug(f"Error in reveal_nav_items: {e}")

    def _validate_response(self, response, url: str) -> tuple[bool, Exception | None]:
        """Validate page response and return (should_continue, exception)."""
        if not response:
            logging.error(f"Failed to get response object from {url}")
            return False, Exception("No response object")

        if response.status >= 400:
            error_msg = f"HTTP {response.status}"
            logging.error(f"{error_msg} error for {url}")
            return False, Exception(error_msg)

        content_type = response.header_value("content-type")
        if content_type and not content_type.lower().startswith("text/html"):
            logging.info(f"Skipping non-HTML content ({content_type}) at {url}")
            self.mark_url_status(url, "visited", content_hash="non_html")
            return False, None  # None indicates successful skip, not error

        # Additional check: if URL changed significantly (like to a media file), skip it
        final_url = response.url
        if final_url != url:
            final_path = final_url.lower()
            media_extensions = [
                ".jpg",
                ".jpeg",
                ".png",
                ".gif",
                ".svg",
                ".webp",
                ".avif",
                ".heic",
                ".pdf",
                ".mp3",
                ".mp4",
                ".avi",
                ".mov",
                ".webm",
                ".mkv",
                ".zip",
                ".doc",
                ".docx",
            ]
            if any(final_path.endswith(ext) for ext in media_extensions):
                logging.info(f"Skipping media redirect: {url} -> {final_url}")
                self.mark_url_status(url, "visited", content_hash="media_redirect")
                return False, None

        return True, None

    def _check_for_media_redirect(self, page, url: str) -> tuple[bool, str]:
        """Check if page was redirected to a media file. Returns (is_redirect, final_url)."""
        final_url = page.url
        if final_url != url:
            logging.debug(f"URL redirected from {url} to {final_url}")

            # Check if final URL looks like a media file
            final_path = final_url.lower()
            media_extensions = [
                ".jpg",
                ".jpeg",
                ".png",
                ".gif",
                ".svg",
                ".pdf",
                ".mp3",
                ".mp4",
                ".avi",
                ".mov",
                ".zip",
                ".doc",
                ".docx",
            ]
            if any(final_path.endswith(ext) for ext in media_extensions):
                logging.info(f"Skipping media file redirect: {url} -> {final_url}")
                self.mark_url_status(url, "visited", content_hash="media_redirect")
                return True, final_url

        return False, final_url

    def _wait_for_page_ready(self, page, url: str) -> None:
        """Wait for page to be ready with appropriate selectors and timeouts."""
        # Progressive timeout strategy for better reliability
        body_timeout = 30000  # Increased from 15s to 30s for slow-loading pages

        # Add small delay between requests to be more respectful to the server
        time.sleep(1.0)  # 1 second delay between page requests

        # First check if page is in a reasonable load state
        try:
            load_state = page.evaluate("() => document.readyState")
            logging.debug(f"Page load state for {url}: {load_state}")
        except Exception as state_e:
            logging.warning(f"Could not check page load state for {url}: {state_e}")

        try:
            # First try to wait for body with longer timeout
            page.wait_for_selector("body", timeout=body_timeout)
            logging.debug(f"Body selector found for {url}")

        except Exception as e:
            # If body fails, try fallback selectors for problematic pages
            logging.debug(
                f"Body selector failed for {url}, trying fallback selectors: {e}"
            )

            try:
                # Try html element as fallback
                page.wait_for_selector("html", timeout=10000)
                logging.debug(f"HTML selector fallback successful for {url}")
            except Exception:
                # If both fail, check content type and handle gracefully
                with suppress(Exception):
                    content_type = page.evaluate(
                        "() => document.contentType || document.mimeType || ''"
                    )
                    if content_type and not content_type.startswith("text/html"):
                        logging.info(
                            f"Skipping non-HTML content ({content_type}): {url}"
                        )
                        self.mark_url_status(
                            url, "visited", content_hash="non_html_content"
                        )
                        raise Exception(
                            f"Non-HTML content detected: {content_type}"
                        ) from None

                # Re-raise with more informative message
                logging.warning(f"Failed to find body or html selector for {url}: {e}")
                raise Exception(f"Page structure detection failed: {e}") from e

    def _validate_content_presence(self, page, url: str) -> None:
        """Validate that the page has meaningful content."""
        # Check if the body has meaningful content (only if we got this far)
        try:
            body_text = page.evaluate(
                "() => document.body ? document.body.textContent.trim() : ''"
            )
            if not body_text or len(body_text) < 10:  # Very minimal content
                logging.info(f"Skipping page with empty/minimal body content: {url}")
                self.mark_url_status(url, "visited", content_hash="empty_content")
                raise Exception("Empty or minimal body content")
        except Exception as content_e:
            logging.warning(f"Failed to check body content for {url}: {content_e}")
            # Don't fail the whole crawl for content checking issues
            pass

    def _expand_menus(self, page, url: str) -> None:
        """Handle menu expansion for better link discovery."""
        try:
            # Count menu items before expansion
            menu_count = page.evaluate(
                "() => document.querySelectorAll('.menu-item-has-children').length"
            )
            logging.debug(
                f"Found {menu_count} menu items with children before expansion"
            )

            page.evaluate("""() => {
                document.querySelectorAll('.menu-item-has-children:not(.active)').forEach((item) => {
                    if (!item.closest('.sub-menu')) { 
                        item.classList.add('active');
                        const submenu = item.querySelector(':scope > .sub-menu'); 
                        if (submenu) {
                            submenu.style.display = 'block';
                            submenu.style.visibility = 'visible';
                            submenu.style.opacity = '1';
                        }
                    }
                });
            }""")

            active_count = page.evaluate(
                "() => document.querySelectorAll('.menu-item-has-children.active').length"
            )
            logging.debug(f"Activated {active_count} menu items")

        except Exception as menu_e:
            logging.debug(f"Non-critical menu handling failed for {url}: {menu_e}")

    def _extract_links(self, page, url: str) -> list[str]:
        """Extract and filter valid links from the page."""
        # Debug link extraction step by step
        logging.debug("Starting link extraction...")
        total_links = page.evaluate("() => document.querySelectorAll('a').length")
        href_links = page.evaluate("() => document.querySelectorAll('a[href]').length")
        logging.debug(
            f"Found {total_links} total <a> tags, {href_links} with href attributes"
        )

        links = page.evaluate(
            """() => Array.from(document.querySelectorAll('a[href]')).map(a => a.href).filter(href => href && !href.endsWith('#') && !href.includes('/#'))"""
        )

        logging.debug(f"Extracted {len(links)} links after filtering anchors")
        if links:
            logging.debug(f"First 10 links: {links[:10]}")

        valid_links = [link for link in links if self.is_valid_url(link)]

        logging.debug(f"Valid links after domain/pattern filtering: {len(valid_links)}")
        if valid_links:
            logging.debug(f"First 5 valid links: {valid_links[:5]}")

        if len(links) != len(valid_links):
            logging.debug(
                f"Filtered out {len(links) - len(valid_links)} external/invalid links"
            )

        return valid_links

    def _extract_title_and_content(self, page, url: str) -> tuple[str, str]:
        """Extract title and HTML content from the page."""
        title = page.title() or "No Title Found"
        logging.debug(f"Page title: {title}")

        html_content = page.content()
        logging.debug(f"Raw HTML content length: {len(html_content)}")

        clean_text = self.clean_content(html_content)
        logging.debug(f"Cleaned text length: {len(clean_text)}")

        # Take screenshot in debug mode
        if self.debug:
            try:
                screenshot_path = f"debug_screenshot_{self.site_id}_{url.replace('https://', '').replace('/', '_')}.png"
                page.screenshot(path=screenshot_path)
                logging.debug(f"Screenshot saved to {screenshot_path}")
            except Exception as screenshot_e:
                logging.debug(f"Screenshot failed: {screenshot_e}")

        return title, clean_text

    def _create_page_content(
        self, url: str, title: str, clean_text: str, schemed_valid_links: list[str]
    ) -> tuple[PageContent | None, list[str]]:
        """Create final PageContent object and return with links."""
        if not clean_text.strip() and title == "No Title Found":
            logging.warning(f"No content or title extracted from {url}")
            return None, schemed_valid_links

        page_content = PageContent(
            url=url,
            title=title,
            content=clean_text,
            metadata={"type": "text", "source": url},
        )

        logging.debug(
            f"Created PageContent object with {len(clean_text)} chars of content and {len(schemed_valid_links)} valid links"
        )

        return page_content, schemed_valid_links

    def _extract_page_content(
        self, page, url: str
    ) -> tuple[PageContent | None, list[str]]:
        """Extract content and links from page."""
        logging.debug(f"Starting content extraction for {url}")

        # Check for media file redirects
        is_media_redirect, final_url = self._check_for_media_redirect(page, url)
        if is_media_redirect:
            return None, []

        # Wait for page to be ready
        self._wait_for_page_ready(page, url)

        # Validate content presence
        self._validate_content_presence(page, url)

        # Handle menu expansion
        self._expand_menus(page, url)

        # Extract and filter links
        valid_links = self._extract_links(page, url)

        # Extract title and content
        title, clean_text = self._extract_title_and_content(page, url)

        # Process links with schemes
        schemed_valid_links = [ensure_scheme(link) for link in valid_links]

        # Create final page content object
        return self._create_page_content(url, title, clean_text, schemed_valid_links)

    def _handle_crawl_exception(self, e: Exception, url: str) -> tuple[bool, bool]:
        """Handle exceptions during crawling. Returns (restart_needed, should_retry)."""
        if isinstance(e, PlaywrightTimeout):
            logging.warning(
                f"Timeout error crawling {url}: {e}. Flagging for browser restart."
            )
            return True, False

        error_str = str(e)
        if "Target page, context or browser has been closed" in error_str:
            logging.warning(
                f"Target closed error for {url}: {e}. Flagging for browser restart."
            )
            return True, False

        if "playwright" in repr(e).lower() and (
            "NS_ERROR_ABORT" in error_str
            or "Navigation failed because browser has disconnected" in error_str
        ):
            logging.warning(
                f"Browser/Navigation error encountered for {url}: {e}. Flagging for browser restart."
            )
            return True, False

        if isinstance(e, RuntimeError) and "no running event loop" in error_str:
            logging.error(
                f"Caught 'no running event loop' error for {url}. Flagging for browser restart."
            )
            return True, False

        # For other unexpected errors, log and stop retrying this URL
        logging.error(f"Unexpected error crawling {url}: {e}")
        logging.error(traceback.format_exc())
        return False, False

    def crawl_page(
        self, browser, page, url: str
    ) -> tuple[PageContent | None, list[str], bool]:
        """Crawl a single page and return content, links, and restart flag."""
        retries = 2
        last_exception = None
        restart_needed = False

        url = ensure_scheme(url)

        while retries > 0:
            try:
                logging.debug(
                    f"Attempting to navigate to {url} (Attempts left: {retries})"
                )
                page.set_default_timeout(30000)

                response = page.goto(url, wait_until="commit")

                # Check if we were redirected to a WordPress login page
                final_url = page.url
                if self._is_wordpress_login_redirect(final_url, url):
                    logging.info(
                        f"Ignoring WordPress login redirect: {url} -> {final_url}"
                    )
                    self.mark_url_status(
                        url, "visited", content_hash="wp_login_redirect"
                    )
                    # Create a special marker content to signal successful handling
                    wp_redirect_content = PageContent(
                        url=url,
                        title="WordPress Login Redirect",
                        content="",  # Empty content
                        metadata={
                            "type": "wp_login_redirect",
                            "source": url,
                            "final_url": final_url,
                        },
                    )
                    return wp_redirect_content, [], False

                should_continue, exception = self._validate_response(response, url)
                if not should_continue:
                    if exception is None:  # Successful skip (non-HTML content)
                        return None, [], False
                    last_exception = exception
                    retries = 0
                    continue

                content, links = self._extract_page_content(page, url)
                return content, links, False

            except Exception as e:
                restart_needed, should_retry = self._handle_crawl_exception(e, url)
                last_exception = e

                if restart_needed or not should_retry:
                    retries = 0
                elif retries > 1:
                    retries -= 1
                    logging.info(f"Waiting 5s before next retry for {url}...")
                    time.sleep(5)
                else:
                    retries = 0

        if not restart_needed:
            error_message = (
                str(last_exception)
                if last_exception
                else "Unknown error during crawl attempt"
            )
            logging.error(
                f"Giving up on {url} after exhausting retries or encountering fatal error. Last error: {last_exception}"
            )

            # Mark as failed and let the retry logic in mark_url_status handle 404s
            self.mark_url_status(url, "failed", error_message)

        return None, [], restart_needed

    def create_embeddings(
        self, chunks: list[str], url: str, page_title: str
    ) -> list[dict]:
        """Create embeddings for text chunks using shared embeddings instance."""
        vectors = []

        for i, chunk in enumerate(chunks):
            vector = self.embeddings.embed_query(chunk)
            chunk_id = generate_vector_id(
                library_name=self.domain,
                title=page_title,
                chunk_index=i,
                source_location="web",
                source_identifier=url,
                content_type="text",
                author=None,  # Web content typically doesn't have individual authors
                chunk_text=chunk,
            )

            chunk_metadata = {
                "type": "text",
                "url": url,
                "source": url,
                "title": page_title,
                "library": self.domain,
                "text": chunk,
                "chunk_index": i,
                "total_chunks": len(chunks),
                "crawl_timestamp": datetime.now().isoformat(),
            }

            vectors.append(
                {"id": chunk_id, "values": vector, "metadata": chunk_metadata}
            )

            logging.debug(
                f"Vector {i + 1}/{len(chunks)} - ID: {chunk_id} - Preview: {chunk[:100]}..."
            )

        return vectors

    def get_urls_pending_pinecone_deletion(self) -> list[str]:
        """Get URLs marked as 'deleted' that need Pinecone cleanup."""
        self._ensure_db_initialized()
        assert self.cursor is not None
        try:
            self.cursor.execute(
                "SELECT url FROM crawl_queue WHERE status = 'deleted' AND content_hash != 'pinecone_cleaned'"
            )
            results = self.cursor.fetchall()
            return [row[0] for row in results] if results else []
        except Exception as e:
            logging.error(f"Error fetching URLs pending Pinecone deletion: {e}")
            return []

    def mark_pinecone_cleanup_complete(self, url: str) -> bool:
        """Mark that Pinecone cleanup has been completed for a URL."""
        self._ensure_db_initialized()
        assert self.cursor is not None
        assert self.conn is not None
        try:
            normalized_url = self.normalize_url(url)
            self.cursor.execute(
                "UPDATE crawl_queue SET content_hash = 'pinecone_cleaned' WHERE url = ?",
                (normalized_url,),
            )
            self.conn.commit()
            return True
        except Exception as e:
            logging.error(f"Error marking Pinecone cleanup complete for {url}: {e}")
            return False

    def remove_url_from_pinecone(self, pinecone_index, url: str) -> int:
        """
        Remove all vectors for a specific URL from Pinecone using precise metadata queries.

        Args:
            pinecone_index: Pinecone index instance
            url: URL to remove from Pinecone

        Returns:
            Number of vectors successfully deleted (or would be deleted in dry-run mode)
        """
        deleted_count = 0

        try:
            # Query Pinecone to find all vectors with this URL in metadata
            # Use a dummy vector for the query (we only care about metadata filtering)
            # Get vector dimension from environment
            vector_dimension = int(os.getenv("OPENAI_EMBEDDING_DIMENSION", 3072))
            dummy_vector = [0.0] * vector_dimension

            # Normalize URL for consistent matching (same as our query scripts)
            normalized_url = self.normalize_url(url)
            logging.debug(
                f"Querying Pinecone for vectors with normalized URL: {normalized_url}"
            )

            # Query with metadata filter to find vectors for this URL
            # Try both 'url' and 'source' fields since the metadata structure may vary
            query_response = pinecone_index.query(
                vector=dummy_vector,
                filter={"$or": [{"url": normalized_url}, {"source": normalized_url}]},
                top_k=1000,  # Get up to 1000 matching vectors (should be more than enough for one page)
                include_metadata=True,
                include_values=False,  # We don't need the vector values
            )

            if not query_response.matches:
                logging.info(f"No vectors found in Pinecone for URL: {url}")
                return 0

            # Extract vector IDs from the matches
            vector_ids = [match.id for match in query_response.matches]
            logging.info(f"Found {len(vector_ids)} vectors to delete for URL: {url}")

            if vector_ids:
                # Delete vectors in batches of 100 (Pinecone batch limit)
                batch_size = 100
                for i in range(0, len(vector_ids), batch_size):
                    batch_ids = vector_ids[i : i + batch_size]
                    try:
                        if self.dry_run:
                            logging.info(
                                f"[DRY RUN] Would delete batch of {len(batch_ids)} vectors for URL: {url}"
                            )
                            logging.debug(
                                f"[DRY RUN] Vector IDs: {batch_ids[:3]}{'...' if len(batch_ids) > 3 else ''}"
                            )
                        else:
                            pinecone_index.delete(ids=batch_ids)
                            logging.debug(
                                f"Deleted batch of {len(batch_ids)} vectors for URL: {url}"
                            )
                        deleted_count += len(batch_ids)
                    except Exception as e:
                        logging.error(
                            f"Failed to delete vector batch for URL {url}: {e}"
                        )
                        # Continue with remaining batches
                        continue

                logging.info(
                    f"Successfully deleted {deleted_count} vectors for URL: {url}"
                )

        except Exception as e:
            logging.error(f"Error removing URL from Pinecone {url}: {e}")
            # Return partial count if some deletions succeeded

        return deleted_count

    def should_process_content(self, url: str, current_hash: str) -> bool:
        self._ensure_db_initialized()
        assert self.cursor is not None
        """Check if content has changed and should be processed"""
        self.cursor.execute(
            "SELECT content_hash FROM crawl_queue WHERE url = ?",
            (self.normalize_url(url),),
        )
        result = self.cursor.fetchone()

        # If never seen before or hash has changed, process it
        return bool(not result or not result[0] or result[0] != current_hash)

    def parse_csv_date(self, date_str: str) -> datetime | None:
        """Parse CSV date format like '2025-07-13 12:45:35' to datetime object"""
        try:
            # Handle format "2025-07-13 12:45:35" - ISO-like format
            return datetime.strptime(date_str, "%Y-%m-%d %H:%M:%S")
        except ValueError:
            try:
                # Try alternative format without seconds "2025-07-13 12:45"
                return datetime.strptime(date_str, "%Y-%m-%d %H:%M")
            except ValueError:
                try:
                    # Try legacy format "7/12/25 8:45" - assuming MM/DD/YY HH:MM
                    return datetime.strptime(date_str, "%m/%d/%y %H:%M")
                except ValueError:
                    logging.warning(f"Could not parse CSV date: {date_str}")
                    return None

    def _establish_csv_session(self, page) -> bool:
        """Establish session by visiting main site. Returns True if successful."""
        try:
            main_response = page.goto(
                self.start_url, timeout=15000, wait_until="networkidle"
            )

            if main_response and main_response.status < 400:
                # Wait for session setup with timeout handling
                try:
                    page.wait_for_timeout(2000)
                except Exception as wait_error:
                    logging.warning(f"Timeout during session setup wait: {wait_error}")
                return True
            else:
                logging.warning(
                    f"Failed to establish session: HTTP {main_response.status if main_response else 'No response'}"
                )
                return False
        except PlaywrightTimeout as timeout_error:
            logging.warning(
                f"Session establishment timeout after 15 seconds: {timeout_error}"
            )
            return False
        except Exception as e:
            logging.warning(f"Session establishment failed: {e}")
            return False

    def _create_download_handler(self, download_info: dict):
        """Create and return a download handler function."""

        def handle_download(download):
            try:
                # Save to temporary path and read content
                with tempfile.NamedTemporaryFile(mode="w+b", delete=False) as tmp_file:
                    download.save_as(tmp_file.name)
                    tmp_file.seek(0)
                    with open(tmp_file.name, encoding="utf-8") as f:
                        download_info["content"] = f.read()
                    # Clean up temp file
                    os.unlink(tmp_file.name)
            except Exception as e:
                download_info["error"] = str(e)
                logging.error(f"Error handling download: {e}")

        return handle_download

    def _extract_page_content_csv(self, page) -> str:
        """Extract content from CSV page if no download occurred."""
        content = page.content()

        # Try to get the raw text content instead of HTML
        try:
            text_content = page.evaluate(
                "() => document.body.textContent || document.body.innerText || ''"
            )
            if text_content.strip() and "," in text_content:
                return text_content
            else:
                # Fallback to page content and extract from HTML
                soup = BeautifulSoup(content, "html.parser")
                return soup.get_text()
        except Exception:
            # If text extraction fails, use HTML content as fallback
            return content

    def _navigate_to_csv_url(self, page, download_info: dict) -> None:
        """Navigate to CSV URL and handle download/content extraction with proper timeout handling."""
        # Ensure download_info dict has required keys initialized
        if "content" not in download_info:
            download_info["content"] = None
        if "error" not in download_info:
            download_info["error"] = None

        try:
            # Navigate with explicit timeout and error handling
            response = page.goto(
                self.csv_export_url, timeout=30000, wait_until="networkidle"
            )

            # Check response status
            if response and response.status >= 400:
                raise Exception(f"HTTP {response.status} error when accessing CSV URL")

            # If we get here without download, try to get page content
            if not download_info["content"] and not download_info["error"]:
                # Wait a moment for potential download with timeout
                try:
                    page.wait_for_timeout(3000)
                except Exception as wait_error:
                    logging.warning(f"Timeout during download wait: {wait_error}")

                if not download_info["content"]:
                    download_info["content"] = self._extract_page_content_csv(page)

        except PlaywrightTimeout as timeout_error:
            # Handle Playwright timeouts specifically
            raise Exception(
                f"Navigation timeout after 30 seconds: {timeout_error}"
            ) from timeout_error
        except Exception as e:
            if "Download is starting" in str(e):
                # This is expected - wait for download to complete with timeout
                try:
                    page.wait_for_timeout(5000)
                except Exception as download_wait_error:
                    logging.warning(
                        f"Timeout during download completion wait: {download_wait_error}"
                    )
            else:
                # Re-raise with more context
                raise Exception(f"Navigation failed: {e}") from e

    def _parse_csv_content(self, content: str) -> list[dict]:
        """Parse CSV content and return list of dictionaries."""
        if not content or not content.strip():
            raise Exception("Empty response from CSV URL")

        csv_reader = csv.DictReader(content.splitlines())
        csv_data = list(csv_reader)

        if not csv_data:
            raise Exception("No data rows found in CSV")

        return csv_data

    def download_csv_data(self, browser=None) -> list[dict] | None:
        """Download and parse CSV data using existing Playwright browser context with retry logic"""
        if not self.csv_export_url:
            return None

        if not browser:
            logging.error("No browser context provided for CSV download")
            return None

        max_retries = 3
        for attempt in range(max_retries):
            try:
                logging.info(
                    f"Downloading CSV data with existing browser from: {self.csv_export_url} (attempt {attempt + 1}/{max_retries})"
                )

                # Create a new page in the existing browser context
                page = browser.new_page()
                page.set_extra_http_headers({"User-Agent": USER_AGENT})
                # Set default timeout to prevent indefinite hangs
                page.set_default_timeout(30000)  # 30 seconds

                try:
                    # Establish session with timeout
                    session_established = self._establish_csv_session(page)
                    if not session_established:
                        raise Exception("Failed to establish session with main site")

                    # Set up download handling
                    download_info = {"content": None, "error": None}
                    handle_download = self._create_download_handler(download_info)
                    page.on("download", handle_download)

                    # Navigate to CSV URL and handle download/content with timeout
                    self._navigate_to_csv_url(page, download_info)

                    # Check for errors and validate content
                    if download_info["error"]:
                        raise Exception(f"Download error: {download_info['error']}")

                    # Parse CSV content
                    if download_info["content"] is None:
                        raise Exception("No content downloaded from CSV URL")
                    csv_data = self._parse_csv_content(download_info["content"])

                    self.update_csv_tracking(success=True)
                    logging.info(
                        f"Successfully downloaded and parsed CSV data with {len(csv_data)} rows"
                    )
                    return csv_data

                finally:
                    try:
                        page.close()
                    except Exception as close_error:
                        logging.warning(
                            f"Error closing CSV download page: {close_error}"
                        )

            except Exception as e:
                error_msg = f"CSV download attempt {attempt + 1} failed: {e}"
                logging.error(error_msg)

                # If this is the last attempt, update tracking and return None
                if attempt == max_retries - 1:
                    self.update_csv_tracking(
                        csv_error=f"All {max_retries} CSV download attempts failed. Last error: {e}"
                    )
                    return None
                else:
                    # Wait before retry (exponential backoff)
                    retry_delay = min(30, 5 * (2**attempt))  # 5s, 10s, 20s max
                    logging.info(f"Retrying CSV download in {retry_delay} seconds...")
                    time.sleep(retry_delay)
                    continue

        return None

    def _validate_csv_row(self, row: dict) -> tuple[str, datetime, str] | None:
        """Validate CSV row and return (url, modified_date, action) tuple or None if invalid."""
        try:
            url = row.get("URL", "").strip()
            modified_date_str = row.get("Modified Date", "").strip()
            action = row.get("Required Action", "").strip().lower()

            if not url or not modified_date_str or not action:
                return None

            # Validate action values (case-insensitive)
            if action not in ["add/update", "remove"]:
                logging.warning(
                    f"Invalid action '{action}' for URL {url}. Expected 'Add/Update' or 'remove'"
                )
                return None

            # Parse modified date
            modified_date = self.parse_csv_date(modified_date_str)
            if not modified_date:
                return None

            return url, modified_date, action
        except Exception:
            return None

    def _should_process_csv_url(
        self, url: str, modified_date: datetime, cutoff_date: datetime
    ) -> tuple[bool, str]:
        """Check if CSV URL should be processed. Returns (should_process, skip_reason)."""
        self._ensure_db_initialized()
        assert self.cursor is not None
        # Check if modified within threshold
        if modified_date < cutoff_date:
            return False, "skipped_date"

        # Ensure URL has scheme
        full_url = ensure_scheme(url)

        # Check if URL should be crawled
        if not self.is_valid_url(full_url) or self.should_skip_url(full_url):
            logging.debug(f"Skipping CSV URL due to validation/skip rules: {full_url}")
            return False, "skipped_validation"

        # Check if URL exists in database and if last crawl is more recent than modified date
        normalized_url = self.normalize_url(full_url)
        self.cursor.execute(
            """
            SELECT last_crawl, modified_date 
            FROM crawl_queue 
            WHERE url = ?
            """,
            (normalized_url,),
        )
        existing = self.cursor.fetchone()

        if existing:
            last_crawl, existing_modified_date = existing

            # Debug logging for decision process
            logging.debug(f"CSV URL check for {full_url}:")
            logging.debug(f"  - Last crawl: {last_crawl}")
            logging.debug(f"  - Existing modified date: {existing_modified_date}")
            logging.debug(f"  - CSV modified date: {modified_date.isoformat()}")

            # If we have a last crawl date, check if it's more recent than the modified date
            if last_crawl:
                try:
                    last_crawl_dt = datetime.fromisoformat(last_crawl)
                    # If last crawl is more recent than modified date, skip it
                    if last_crawl_dt > modified_date:
                        logging.debug(
                            f"  - Decision: SKIP (last crawl {last_crawl} is more recent than modified date {modified_date.isoformat()})"
                        )
                        return False, "skipped_already_current"
                except ValueError:
                    # If we can't parse the date, proceed with processing
                    pass

            logging.debug(
                "  - Decision: PROCESS (last crawl is older than modified date or no crawl date)"
            )
        else:
            logging.debug(f"CSV URL check for {full_url}: NEW URL - will process")

        return True, ""

    def _process_single_csv_row(
        self, row: dict, cutoff_date: datetime, stats: dict, pinecone_index=None
    ) -> None:
        """Process a single CSV row and update stats."""
        try:
            # Validate CSV row
            validation_result = self._validate_csv_row(row)
            if not validation_result:
                return

            url, modified_date, action = validation_result
            full_url = ensure_scheme(url)

            if action == "remove":
                self._handle_csv_removal(full_url, stats, pinecone_index)
            else:
                self._handle_csv_add_update(
                    full_url, row, modified_date, cutoff_date, stats
                )

        except Exception as e:
            stats["error"] += 1
            logging.warning(f"Error processing CSV row {row}: {e}")

    def _handle_csv_removal(
        self, full_url: str, stats: dict, pinecone_index=None
    ) -> None:
        """Handle removal action for CSV row."""
        self._ensure_db_initialized()
        assert self.cursor is not None
        assert self.conn is not None
        normalized_url = self.normalize_url(full_url)

        # Check if we've already processed this removal
        self.cursor.execute(
            "SELECT 1 FROM removal_log WHERE url = ?", (normalized_url,)
        )
        if self.cursor.fetchone():
            logging.debug(f"Removal already processed, skipping: {full_url}")
            stats["skipped_already_removed"] = (
                stats.get("skipped_already_removed", 0) + 1
            )
            return

        logging.info(f"Processing removal for URL: {full_url}")

        # Remove from Pinecone if index is provided
        deleted_vectors = 0
        if pinecone_index:
            deleted_vectors = self.remove_url_from_pinecone(pinecone_index, full_url)
            if deleted_vectors > 0:
                logging.info(
                    f"Removed {deleted_vectors} vectors from Pinecone for URL: {full_url}"
                )
            else:
                logging.info(f"No vectors found in Pinecone for URL: {full_url}")
        else:
            logging.warning(
                f"No Pinecone index provided for removal of URL: {full_url}"
            )

        # Mark as deleted in database (ignore if URL doesn't exist)
        self.cursor.execute(
            "SELECT url FROM crawl_queue WHERE url = ?", (normalized_url,)
        )
        if self.cursor.fetchone():
            self.mark_url_status(full_url, "deleted")
            stats["removed_from_db"] = stats.get("removed_from_db", 0) + 1
            logging.info(f"Marked URL as deleted in database: {full_url}")
        else:
            logging.info(f"URL not found in database (ignoring): {full_url}")

        # Record this removal in the log to prevent reprocessing
        self.cursor.execute(
            "INSERT OR REPLACE INTO removal_log (url, removed_at) VALUES (?, datetime('now'))",
            (normalized_url,),
        )
        self.conn.commit()
        logging.debug(f"Recorded removal in log: {full_url}")

        stats["removed"] = stats.get("removed", 0) + 1

    def _handle_csv_add_update(
        self,
        full_url: str,
        row: dict,
        modified_date: datetime,
        cutoff_date: datetime,
        stats: dict,
    ) -> None:
        """Handle add/update action for CSV row."""
        self._ensure_db_initialized()
        assert self.cursor is not None
        assert self.conn is not None
        # Check if URL should be processed
        should_process, skip_reason = self._should_process_csv_url(
            row.get("URL", "").strip(), modified_date, cutoff_date
        )
        if not should_process:
            stats[skip_reason] += 1

            # If URL is being skipped due to validation/skip rules, remove it from database
            if skip_reason == "skipped_validation":
                normalized_url = self.normalize_url(full_url)

                # Check if URL exists in database
                self.cursor.execute(
                    "SELECT url FROM crawl_queue WHERE url = ?", (normalized_url,)
                )
                if self.cursor.fetchone():
                    # Remove the URL from database
                    self.cursor.execute(
                        "DELETE FROM crawl_queue WHERE url = ?", (normalized_url,)
                    )
                    logging.debug(f"Removed invalid URL from database: {full_url}")
                    stats["removed_from_db"] = stats.get("removed_from_db", 0) + 1

            return

        # Add to queue with high priority and modified date
        modified_date_str = modified_date.isoformat()
        result = self.add_url_to_queue(
            full_url, priority=10, modified_date=modified_date_str
        )
        stats[result] += 1

        if result in ["inserted", "updated_priority", "updated_modified_date"]:
            modified_date_str = row.get("Modified Date", "").strip()
            logging.debug(
                f"CSV URL {result}: {full_url} (modified: {modified_date_str})"
            )

    def _create_csv_processing_messages(self, stats: dict) -> list[str]:
        """Create concise logging messages for CSV processing results."""
        messages = []

        # Build list of message templates and their conditions
        message_templates = self._get_csv_message_templates(stats)

        # Process each template and add to messages if condition is met
        for _, count, message_template in message_templates:
            if count > 0:
                messages.append(message_template)

        return messages

    def _get_csv_message_templates(self, stats: dict) -> list[tuple[str, int, str]]:
        """Get message templates for CSV processing results."""
        templates = [
            (
                "inserted",
                stats["inserted"],
                f"{stats['inserted']} new URLs added to queue",
            ),
            (
                "updated_priority",
                stats["updated_priority"],
                f"{stats['updated_priority']} existing URLs updated with higher priority",
            ),
            (
                "updated_modified_date",
                stats["updated_modified_date"],
                f"{stats['updated_modified_date']} existing URLs updated with newer modified date",
            ),
            (
                "exists_lower_priority",
                stats["exists_lower_priority"],
                f"{stats['exists_lower_priority']} URLs already in queue with equal/higher priority",
            ),
            (
                "skipped_date",
                stats["skipped_date"],
                f"{stats['skipped_date']} URLs skipped (not modified within {self.csv_modified_days_threshold} days)",
            ),
            (
                "skipped_already_current",
                stats["skipped_already_current"],
                f"{stats['skipped_already_current']} URLs skipped (already crawled after modification date)",
            ),
            (
                "removed",
                stats["removed"],
                f"{stats['removed']} URLs removed from Pinecone and marked as deleted",
            ),
            (
                "skipped_already_removed",
                stats.get("skipped_already_removed", 0),
                f"{stats.get('skipped_already_removed', 0)} URLs skipped (already removed previously)",
            ),
            ("error", stats["error"], f"{stats['error']} URLs had processing errors"),
        ]

        # Handle special case for skipped_validation
        if stats["skipped_validation"] > 0:
            removed_count = stats.get("removed_from_db", 0)
            if removed_count > 0:
                validation_msg = f"{stats['skipped_validation']} URLs skipped (validation/skip rules), {removed_count} removed from database"
            else:
                validation_msg = f"{stats['skipped_validation']} URLs skipped (validation/skip rules)"
            templates.append(
                ("skipped_validation", stats["skipped_validation"], validation_msg)
            )

        return templates

    def _log_csv_processing_results(self, stats: dict, total_processed: int) -> None:
        """Log CSV processing results in a concise format."""
        messages = self._create_csv_processing_messages(stats)

        # Log results concisely
        if messages:
            logging.info("CSV processing results: " + ", ".join(messages))
        else:
            logging.info("CSV processing results: No URLs processed")

        if total_processed > 0:
            logging.info(f"Total URLs ready for processing: {total_processed}")

    def process_csv_data(self, csv_data: list[dict], pinecone_index=None) -> int:
        """Process CSV data and add modified URLs to queue with high priority"""
        self._ensure_db_initialized()
        assert self.conn is not None
        if not csv_data:
            return 0

        cutoff_date = datetime.now() - timedelta(days=self.csv_modified_days_threshold)

        # Track different outcomes
        stats = {
            "inserted": 0,
            "updated_priority": 0,
            "updated_modified_date": 0,
            "exists_lower_priority": 0,
            "skipped_date": 0,
            "skipped_validation": 0,
            "skipped_already_current": 0,
            "removed": 0,
            "error": 0,
        }

        # Process each CSV row
        for row in csv_data:
            self._process_single_csv_row(row, cutoff_date, stats, pinecone_index)

        # Commit database changes (including any URL removals)
        self.conn.commit()

        # Calculate total processed and log results
        total_processed = (
            stats["inserted"]
            + stats["updated_priority"]
            + stats["updated_modified_date"]
        )
        self._log_csv_processing_results(stats, total_processed)

        return total_processed

    def update_csv_tracking(self, csv_error: str | None = None, success: bool = False):
        """Update CSV tracking table with latest status and timestamp"""
        self._ensure_db_initialized()
        assert self.cursor is not None
        assert self.conn is not None
        try:
            current_time = datetime.now().isoformat()

            # Get or create tracking record
            self.cursor.execute("SELECT id FROM csv_tracking LIMIT 1")
            tracking_record = self.cursor.fetchone()

            if tracking_record:
                self.cursor.execute(
                    """
                    UPDATE csv_tracking 
                    SET last_check_time = ?, last_error = ?
                    WHERE id = ?
                    """,
                    (current_time, csv_error, tracking_record[0]),
                )
            else:
                self.cursor.execute(
                    """
                    INSERT INTO csv_tracking 
                    (last_check_time, last_error, initial_crawl_completed)
                    VALUES (?, ?, 1)
                    """,
                    (current_time, csv_error),
                )

            self.conn.commit()

            if csv_error:
                logging.error(f"CSV processing failed: {csv_error}")
            elif success:
                logging.debug(f"CSV tracking updated: last check at {current_time}")

        except Exception as e:
            logging.error(f"Error updating CSV tracking: {e}")

    def should_check_csv(self) -> bool:
        """Check if CSV should be processed with cooldown period to prevent frequent downloads"""
        self._ensure_db_initialized()
        assert self.cursor is not None
        if not self.csv_mode_enabled:
            return False

        # Only check CSV if initial crawl is completed
        if not self.is_initial_crawl_completed():
            return False

        # Check if enough time has passed since last CSV check (minimum 30 minutes)
        try:
            self.cursor.execute("""
                SELECT last_check_time 
                FROM csv_tracking 
                LIMIT 1
            """)
            result = self.cursor.fetchone()

            if result and result[0]:
                last_check = datetime.fromisoformat(result[0])
                time_since_last_check = datetime.now() - last_check

                # Minimum 30 minutes between CSV checks
                if time_since_last_check.total_seconds() < 30 * 60:
                    logging.debug(
                        f"CSV check skipped - only {time_since_last_check.total_seconds():.0f} seconds since last check (minimum 1800 seconds)"
                    )
                    return False

                logging.debug(
                    f"CSV check allowed - {time_since_last_check.total_seconds():.0f} seconds since last check"
                )

        except Exception as e:
            logging.error(f"Error checking CSV timing: {e}")
            # If we can't check timing, allow the check to proceed

        return True

    def mark_initial_crawl_completed(self):
        """Mark that the initial full crawl has been completed"""
        self._ensure_db_initialized()
        assert self.cursor is not None
        assert self.conn is not None
        try:
            self.cursor.execute("SELECT id FROM csv_tracking LIMIT 1")
            tracking_record = self.cursor.fetchone()

            if tracking_record:
                self.cursor.execute(
                    """
                    UPDATE csv_tracking 
                    SET initial_crawl_completed = 1
                    WHERE id = ?
                """,
                    (tracking_record[0],),
                )
            else:
                self.cursor.execute("""
                    INSERT INTO csv_tracking 
                    (initial_crawl_completed)
                    VALUES (1)
                """)

            self.conn.commit()
            self.initial_crawl_completed = True
            logging.info(
                "Marked initial crawl as completed - CSV mode will now activate"
            )

        except Exception as e:
            logging.error(f"Error marking initial crawl completed: {e}")

    def is_initial_crawl_completed(self) -> bool:
        """Check if initial crawl has been completed"""
        self._ensure_db_initialized()
        assert self.cursor is not None
        try:
            self.cursor.execute("""
                SELECT initial_crawl_completed 
                FROM csv_tracking 
                LIMIT 1
            """)
            result = self.cursor.fetchone()
            return bool(result and result[0])
        except Exception as e:
            logging.error(f"Error checking initial crawl status: {e}")
            return False

    def check_and_process_csv(self, browser=None, pinecone_index=None) -> int:
        """Check if CSV should be processed and do it if needed"""
        if not self.should_check_csv():
            return 0

        csv_data = self.download_csv_data(browser)
        if csv_data is None:
            # Still update tracking even if download failed
            self.update_csv_tracking(csv_error="Failed to download CSV data")
            return 0

        added_count = self.process_csv_data(csv_data, pinecone_index)
        self.update_csv_tracking(success=True)

        return added_count

    def _calculate_next_crawl_with_jitter(self, base_frequency_days: int) -> datetime:
        """Calculate next crawl time with 12% jitter to prevent synchronized re-crawling.

        Args:
            base_frequency_days: Base frequency in days (e.g., 25)

        Returns:
            datetime: Next crawl time with jitter applied
        """
        # Calculate 12% jitter in days
        jitter_days = base_frequency_days * 0.12

        # Apply random jitter: ±12% of base frequency
        # This means 25 days becomes 22-28 days (25 ± 3 days)
        jitter_offset = random.uniform(-jitter_days, jitter_days)

        # Calculate final frequency with jitter
        final_frequency_days = base_frequency_days + jitter_offset

        # Ensure minimum frequency of 1 day
        final_frequency_days = max(1.0, final_frequency_days)

        # Convert to timedelta and add to current time
        return datetime.now() + timedelta(days=final_frequency_days)


def sanitize_for_id(text: str) -> str:
    """Sanitize text for use in Pinecone vector IDs"""
    # Replace non-ASCII chars with ASCII equivalents
    text = text.replace("—", "-").replace("'", "'").replace('"', '"').replace('"', '"')
    # Remove any remaining non-ASCII chars
    text = "".join(c for c in text if ord(c) < 128)
    # Replace special chars with underscores, preserving spaces
    text = re.sub(r"[^a-zA-Z0-9\s-]", "_", text)
    return text


def create_chunks_from_page(page_content, text_splitter) -> list[str]:
    """Create text chunks from page content using the provided text splitter."""

    # Combine title and content with a single newline so the title remains in the
    # same paragraph as the opening content, preventing header-only chunks.
    full_text = f"{page_content.title}\n{page_content.content}"

    # Use URL as document ID for metrics tracking
    document_id = page_content.url
    chunks = text_splitter.split_text(full_text, document_id=document_id)

    logging.debug(
        f"Created {len(chunks)} chunks from page using spaCy dynamic chunking"
    )
    return chunks


def upsert_to_pinecone(vectors: list[dict], index: Any, index_name: str):
    """Upsert vectors to Pinecone index."""
    if vectors:
        batch_size = 100  # Pinecone recommends batches of 100 or less
        total_vectors = len(vectors)
        logging.debug(
            f"Upserting {total_vectors} vectors to Pinecone index '{index_name}' in batches of {batch_size}..."
        )

        for i in range(0, total_vectors, batch_size):
            batch = vectors[i : i + batch_size]
            logging.debug(
                f"Upserting batch {i // batch_size + 1}/{(total_vectors + batch_size - 1) // batch_size} (size: {len(batch)})..."
            )
            try:
                index.upsert(vectors=batch)
                if i > 2:
                    print(".", end="", flush=True)
            except Exception as e:
                error_msg = str(e)
                logging.error(f"Error upserting batch starting at index {i}: {e}")

                # Check for vector ID sanitization errors that should be treated as temporary failures
                if (
                    "Vector ID must be ASCII" in error_msg
                    or "must be ASCII" in error_msg
                ):
                    logging.warning(
                        "Vector ID sanitization error detected - this should be fixed by updated sanitization logic"
                    )
                    raise Exception(f"Vector ID sanitization error: {error_msg}") from e

                # For other errors, continue with next batch
                pass
        logging.info(f"Upsert of {total_vectors} vectors complete.")


def parse_arguments() -> argparse.Namespace:
    """Parse command line arguments."""
    parser = argparse.ArgumentParser(
        description="Crawl a website and store in Pinecone"
    )
    parser.add_argument(
        "--site",
        required=True,  # Make site ID required
        help="Site ID for environment variables (e.g., ananda-public). Loads config from crawler_config/[site]-config.json. REQUIRED.",
    )
    parser.add_argument(
        "--retry-failed",
        action="store_true",
        help="Retry URLs marked as 'permanent' failed in the database.",
    )
    parser.add_argument(
        "--fresh-start",
        action="store_true",
        help="Delete the existing SQLite database and start from a clean slate.",
    )
    parser.add_argument(
        "-c",
        "--clear-vectors",
        action="store_true",
        help="Clear existing web content vectors for this site before crawling.",
    )
    parser.add_argument(
        "--stop-after",
        type=int,
        help="Stop crawling after processing this many pages (useful for testing).",
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Enable debug mode with detailed logging and page screenshots.",
    )
    parser.add_argument(
        "--non-interactive",
        action="store_true",
        help="Run in non-interactive mode (auto-continue on health check warnings, suitable for daemons).",
    )
    parser.add_argument(
        "--max-runtime-minutes",
        type=int,
        default=45,
        help="Maximum runtime in minutes before exiting (default: 45). Use 0 for unlimited.",
    )
    return parser.parse_args()


def initialize_pinecone(env_file: str) -> Any | None:
    """Load environment, connect to Pinecone, and create index using shared utilities."""
    # Check if env vars already set (cloud mode) or load from file
    required_vars = ["OPENAI_API_KEY", "PINECONE_API_KEY"]
    if all(os.getenv(var) for var in required_vars):
        logging.debug("Environment variables already set (cloud mode)")
    elif os.path.exists(env_file):
        load_dotenv(env_file)
        logging.debug(f"Loaded environment from: {os.path.abspath(env_file)}")
    else:
        logging.error(
            f"Environment file {env_file} not found and required env vars not set."
        )
        print(
            f"Error: Environment file {env_file} not found and required env vars not set."
        )
        return None

    try:
        # Use shared utilities for Pinecone setup
        pinecone_client = get_pinecone_client()
        index_name = get_pinecone_ingest_index_name()

        # Create index if it doesn't exist
        create_pinecone_index_if_not_exists(pinecone_client, index_name)

        # Get the index
        pinecone_index = pinecone_client.Index(index_name)

        return pinecone_index

    except ValueError as e:
        logging.error(f"Pinecone configuration error: {e}")
        print(f"Error: {e}")
        print(f"Please check your {env_file} file.")
        return None
    except Exception as e:
        logging.error(f"Error connecting to Pinecone: {e}")
        print(f"Error connecting to Pinecone: {e}")
        return None


def _graceful_sleep(total_seconds: int, check_interval: int = 10) -> bool:
    """
    Sleep for a specified duration while periodically checking for exit signals.

    Args:
        total_seconds: Total time to sleep in seconds
        check_interval: How often to check for exit signal (default 10 seconds)

    Returns:
        bool: True if exit was requested during sleep, False if completed normally
    """
    elapsed = 0
    sleep_interrupted = False

    def signal_handler(signum, frame):
        nonlocal sleep_interrupted
        sleep_interrupted = True
        logging.info(f"Signal {signum} received during sleep, will exit soon")

    # Set up a local signal handler for this sleep session
    original_handler = signal.signal(signal.SIGINT, signal_handler)

    try:
        while elapsed < total_seconds and not sleep_interrupted:
            if is_exiting():
                logging.info(
                    f"Exit requested during sleep (slept {elapsed}/{total_seconds} seconds)"
                )
                return True

            # Sleep for the shorter of remaining time or check interval
            sleep_time = min(check_interval, total_seconds - elapsed)

            # Use a more interruptible sleep approach
            try:
                time.sleep(sleep_time)
            except KeyboardInterrupt:
                logging.info("Sleep interrupted by keyboard interrupt")
                return True

            elapsed += sleep_time

            # Additional timeout protection - if we've been sleeping much longer than expected,
            # something is wrong (e.g., system sleep/wake issues)
            if elapsed > total_seconds * 2:
                logging.warning(
                    f"Sleep duration exceeded 2x expected time ({elapsed}s vs {total_seconds}s), exiting"
                )
                return False

    finally:
        # Restore original signal handler
        signal.signal(signal.SIGINT, original_handler)

    # If we were interrupted by our local signal handler, treat it as exit requested
    if sleep_interrupted:
        logging.info("Sleep interrupted by signal, treating as exit request")
        return True

    return False


def _check_system_health() -> tuple[bool, list[str]]:
    """Perform comprehensive system health check before starting crawler.
    Returns (is_healthy, list_of_issues)."""
    issues = []

    if psutil is None:
        return True, []  # Skip health checks if psutil not available

    try:
        # Check memory - be more lenient for systems with plenty of RAM
        memory = psutil.virtual_memory()

        # Be more lenient for bounded execution - only flag critical issues that prevent operation
        # For bounded execution (45-min runs), we can tolerate higher memory usage since we'll exit soon
        available_gb = memory.available / 1024**3

        if memory.percent > 98:  # Only flag when truly critical (>98% usage)
            issues.append(
                f"Critical memory usage: {memory.percent:.1f}% used ({available_gb:.1f}GB available)"
            )
        elif available_gb < 0.2:  # Less than 200MB available - truly critical
            issues.append(f"Critically low memory available: {available_gb:.1f}GB")
        # Removed high memory pressure warning for bounded execution

        # Check disk space
        disk = psutil.disk_usage("/")
        if disk.percent > 90:
            issues.append(
                f"Low disk space: {disk.percent}% used ({disk.free / 1024**3:.1f}GB free)"
            )
        elif disk.free < 5 * 1024**3:  # Less than 5GB free
            issues.append(f"Very low disk space: {disk.free / 1024**3:.1f}GB free")

        # Check for orphaned Firefox processes
        firefox_count = 0
        for proc in psutil.process_iter(["pid", "name", "cmdline"]):
            try:
                if proc.info["name"] and "firefox" in proc.info["name"].lower():
                    firefox_count += 1
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue

        if firefox_count > 2:  # More than 2 Firefox processes might indicate issues
            issues.append(
                f"Multiple Firefox processes detected: {firefox_count} (may indicate orphaned processes)"
            )

        # Check CPU usage
        cpu_percent = psutil.cpu_percent(interval=1)
        if cpu_percent > 80:
            issues.append(f"High CPU usage: {cpu_percent}%")

    except ImportError:
        issues.append("psutil not available - cannot perform system health checks")
    except Exception as e:
        issues.append(f"Error during system health check: {e}")

    is_healthy = len(issues) == 0
    return is_healthy, issues


def _log_system_resources() -> None:
    """Log current system resource usage for debugging."""
    if psutil is None:
        return  # Skip logging if psutil not available
    try:
        # Memory info
        memory = psutil.virtual_memory()
        logging.info(
            f"System Memory: {memory.percent}% used ({memory.available / 1024**3:.1f}GB available)"
        )

        # CPU info
        cpu_percent = psutil.cpu_percent(interval=1)
        logging.info(f"CPU Usage: {cpu_percent}%")

        # Disk space
        disk = psutil.disk_usage("/")
        logging.info(
            f"Disk Space: {disk.percent}% used ({disk.free / 1024**3:.1f}GB free)"
        )

        # Process count
        process_count = len(psutil.pids())
        logging.info(f"Running Processes: {process_count}")

    except ImportError:
        logging.debug("psutil not available for system resource monitoring")
    except Exception as e:
        logging.debug(f"Error getting system resources: {e}")


def _collect_firefox_processes() -> list:
    """Collect Firefox processes with memory information."""
    if psutil is None:
        return []
    firefox_processes = []
    for proc in psutil.process_iter(["pid", "name", "cmdline", "memory_info"]):
        try:
            if proc.info["name"] and "firefox" in proc.info["name"].lower():
                firefox_processes.append(
                    {
                        "pid": proc.info["pid"],
                        "name": proc.info["name"],
                        "cmdline": proc.info["cmdline"][:3]
                        if proc.info["cmdline"]
                        else [],  # First 3 args only
                        "memory_mb": proc.info["memory_info"].rss / 1024 / 1024
                        if proc.info["memory_info"]
                        else 0,
                    }
                )
        except (psutil.NoSuchProcess, psutil.AccessDenied):  # type: ignore
            continue
    return firefox_processes


def _log_firefox_processes(firefox_processes: list) -> None:
    """Log Firefox process information, highlighting problematic ones."""
    if not firefox_processes:
        logging.info("No Firefox processes found")
        return

    # Only warn about potentially problematic Firefox processes
    problematic_processes = [
        proc
        for proc in firefox_processes
        if proc["memory_mb"] > 1000  # Over 1GB memory usage
    ]

    if problematic_processes:
        logging.warning(
            f"Found {len(problematic_processes)} potentially problematic Firefox processes:"
        )
        for proc in problematic_processes[:3]:  # Show first 3 problematic ones
            logging.warning(
                f"  PID {proc['pid']}: High memory usage "
                f"(Memory: {proc['memory_mb']:.1f}MB) "
                f"CMD: {' '.join(proc['cmdline'][:2])}"
            )
    else:
        # Normal Firefox processes - log at INFO level
        logging.info(f"Found {len(firefox_processes)} Firefox processes (normal):")
        for proc in firefox_processes[:3]:  # Show first 3
            logging.info(
                f"  PID {proc['pid']}: {proc['name']} "
                f"(Memory: {proc['memory_mb']:.1f}MB)"
            )


def _collect_playwright_processes() -> list:
    """Collect Playwright and Node.js process PIDs."""
    if psutil is None:
        return []
    playwright_processes = []
    for proc in psutil.process_iter(["pid", "name", "cmdline"]):
        try:
            if proc.info["name"] and (
                "playwright" in proc.info["name"].lower()
                or "node" in proc.info["name"].lower()
            ):
                playwright_processes.append(proc.info["pid"])
        except (psutil.NoSuchProcess, psutil.AccessDenied):  # type: ignore
            continue
    return playwright_processes


def _log_playwright_processes(playwright_processes: list) -> None:
    """Log Playwright/Node process information."""
    if not playwright_processes:
        return

    logging.info(
        f"Found {len(playwright_processes)} Playwright/Node processes before cleanup: {playwright_processes[:10]}"
    )
    if len(playwright_processes) > 5:
        logging.warning(
            f"High number of Playwright/Node processes detected ({len(playwright_processes)}). "
            "This may indicate cleanup issues or high crawler activity. "
            f"PIDs: {playwright_processes[:10]}{'...' if len(playwright_processes) > 10 else ''}"
        )


def _log_process_diagnostics() -> None:
    """Log detailed process diagnostics, especially Firefox-related processes."""
    try:
        # Log Firefox processes
        firefox_processes = _collect_firefox_processes()
        _log_firefox_processes(firefox_processes)

        # Log Playwright processes
        playwright_processes = _collect_playwright_processes()
        _log_playwright_processes(playwright_processes)

    except ImportError:
        logging.debug("psutil not available for process diagnostics")
    except Exception as e:
        logging.debug(f"Error in process diagnostics: {e}")


def _should_skip_process(proc, current_pid: int) -> bool:
    """Check if a process should be skipped from cleanup."""
    return (
        proc.info["pid"] == current_pid
        or not (proc.info["name"] and "firefox" in proc.info["name"].lower())
        or not proc.info["cmdline"]
    )


def _is_playwright_firefox_process(cmdline_str: str) -> bool:
    """Check if command line indicates a Playwright Firefox process."""
    # Must be headless (automated)
    if "-headless" not in cmdline_str:
        return False

    # Must have Playwright-specific arguments
    playwright_indicators = [
        "-juggler-pipe",  # Playwright's communication pipe
        "playwright",  # Direct Playwright reference
        "sync_playwright",  # Playwright's sync API
    ]

    if not any(indicator in cmdline_str for indicator in playwright_indicators):
        return False

    # Must have a temporary profile (not user's permanent profile)
    has_temp_profile = (
        "/tmp/" in cmdline_str
        or "/var/folders/" in cmdline_str  # macOS temp dirs
        or "-profile" in cmdline_str
        and (
            "playwright" in cmdline_str.lower()
            or "tmp" in cmdline_str.lower()
            or "temp" in cmdline_str.lower()
        )
    )

    return has_temp_profile


def _is_process_old_enough(proc) -> tuple[bool, float]:
    """Check if process is old enough to be considered orphaned."""
    if not proc.info["create_time"]:
        return False, 0

    process_age = time.time() - proc.info["create_time"]

    if process_age <= CLEANUP_AGE_SECONDS:  # 10 minutes
        return False, process_age

    return True, process_age


def _is_resource_usage_high(proc) -> tuple[bool, float, float]:
    """Check if process has high resource usage indicating it's problematic."""
    if psutil is None:
        return False, 0.0, 0.0
    try:
        cpu_percent = proc.cpu_percent(interval=0.1)
        memory_mb = proc.memory_info().rss / 1024 / 1024

        is_high_usage = cpu_percent > 50 or memory_mb > 500
        return is_high_usage, cpu_percent, memory_mb
    except (psutil.NoSuchProcess, psutil.AccessDenied):  # type: ignore
        return False, 0, 0


def _terminate_process_safely(proc) -> bool:
    """Safely terminate a process with SIGTERM then SIGKILL if needed."""
    try:
        proc.send_signal(signal.SIGTERM)
        time.sleep(2)  # Give more time to terminate gracefully

        if proc.is_running():
            logging.warning(
                f"Process {proc.info['pid']} didn't respond to SIGTERM, using SIGKILL"
            )
            proc.kill()

        return True
    except Exception as kill_e:
        logging.debug(f"Error killing process {proc.info['pid']}: {kill_e}")
        return False


def _collect_playwright_firefox_processes(current_pid: int) -> list:
    """Collect all Playwright Firefox processes for analysis.

    Returns:
        List of process dictionaries with metadata for analysis.
    """
    if psutil is None:
        return []
    playwright_firefox_procs = []
    for proc in psutil.process_iter(["pid", "name", "cmdline", "create_time"]):
        try:
            # Skip our own process and non-Firefox processes
            if _should_skip_process(proc, current_pid):
                continue

            cmdline_str = " ".join(proc.info["cmdline"])

            # Check if this is a Playwright Firefox process
            if not _is_playwright_firefox_process(cmdline_str):
                continue

            # Collect this Playwright Firefox process for analysis
            is_old_enough, process_age = _is_process_old_enough(proc)
            is_high_usage, cpu_percent, memory_mb = _is_resource_usage_high(proc)

            playwright_firefox_procs.append(
                {
                    "proc": proc,
                    "pid": proc.info["pid"],
                    "age": process_age,
                    "is_old": is_old_enough,
                    "is_high_usage": is_high_usage,
                    "cpu_percent": cpu_percent,
                    "memory_mb": memory_mb,
                }
            )

        except (psutil.NoSuchProcess, psutil.AccessDenied, AttributeError):
            continue

    return playwright_firefox_procs


def _select_processes_to_kill(playwright_firefox_procs: list) -> list:
    """Select which Playwright Firefox processes should be terminated.

    Args:
        playwright_firefox_procs: List of process dictionaries from collection phase.

    Returns:
        List of processes that should be terminated.
    """
    processes_to_kill = []

    # Kill processes that are old enough OR have high resource usage
    for pf_proc in playwright_firefox_procs:
        if pf_proc["is_old"] or pf_proc["is_high_usage"]:
            processes_to_kill.append(pf_proc)

    # If we still have too many Playwright Firefox processes, kill the oldest ones
    if len(playwright_firefox_procs) > MAX_PLAYWRIGHT_FIREFOX_PROCS:
        # Sort by age (oldest first) and add excess processes to kill list
        sorted_procs = sorted(
            playwright_firefox_procs, key=lambda x: x["age"], reverse=True
        )
        excess_count = len(playwright_firefox_procs) - MAX_PLAYWRIGHT_FIREFOX_PROCS

        for pf_proc in sorted_procs[:excess_count]:
            if pf_proc not in processes_to_kill:
                processes_to_kill.append(pf_proc)
                logging.warning(
                    f"Adding Firefox process to kill list due to soft cap exceeded: "
                    f"PID {pf_proc['pid']} (age: {pf_proc['age']:.0f}s)"
                )

    return processes_to_kill


def _terminate_selected_processes(processes_to_kill: list) -> int:
    """Terminate the selected processes and return count of successful terminations.

    Args:
        processes_to_kill: List of process dictionaries to terminate.

    Returns:
        Number of successfully terminated processes.
    """
    orphaned_count = 0

    for pf_proc in processes_to_kill:
        if pf_proc["is_high_usage"]:
            logging.warning(
                f"Killing high-usage Playwright Firefox process (PID: {pf_proc['pid']}) - "
                f"CPU: {pf_proc['cpu_percent']:.1f}%, Memory: {pf_proc['memory_mb']:.1f}MB, "
                f"Age: {pf_proc['age']:.0f}s"
            )
        else:
            logging.warning(
                f"Killing old/excess Playwright Firefox process (PID: {pf_proc['pid']}, "
                f"age: {pf_proc['age']:.0f}s, CPU: {pf_proc['cpu_percent']:.1f}%, "
                f"Memory: {pf_proc['memory_mb']:.1f}MB)"
            )

        if _terminate_process_safely(pf_proc["proc"]):
            orphaned_count += 1
            logging.info(f"Successfully terminated Firefox process {pf_proc['pid']}")

    return orphaned_count


def _is_nodejs_process_eligible_for_cleanup(
    proc_info, current_pid: int, min_age_override: int | None = None
) -> tuple[bool, str]:
    """Check if a Node.js process should be cleaned up.

    Returns (should_cleanup, cmdline_str) tuple.
    """
    if proc_info["pid"] == current_pid:
        return False, ""  # Skip our own process

    if not proc_info["name"] or "node" not in proc_info["name"].lower():
        return False, ""  # Only Node.js processes

    # Check if process is old enough (reduced from 10 to 5 minutes for more aggressive cleanup)
    age_seconds = time.time() - proc_info["create_time"]
    min_age_seconds = (
        min_age_override if min_age_override else 300
    )  # Use override or default to 5 minutes
    if age_seconds < min_age_seconds:
        return False, ""  # Too young, might be legitimate

    # Check command line for Playwright indicators
    cmdline_str = " ".join(proc_info["cmdline"] or [])
    playwright_indicators = [
        "playwright",
        "juggler",
        "sync_playwright",
        "playwright-core",
    ]

    is_playwright_related = any(
        indicator in cmdline_str for indicator in playwright_indicators
    )

    return is_playwright_related, cmdline_str


def _terminate_nodejs_process(proc, pid: int, cmdline_str: str) -> bool:
    """Terminate a Node.js process, returning True if successful."""
    try:
        age_seconds = time.time() - proc.create_time()
        logging.info(
            f"Killing orphaned Node.js process (PID: {pid}, "
            f"age: {age_seconds:.0f}s, cmd: {cmdline_str[:100]}...)"
        )
        proc.terminate()
        # Give it 5 seconds to terminate gracefully
        proc.wait(timeout=5.0)
        return True
    except psutil.TimeoutExpired:  # type: ignore
        # Force kill if it doesn't terminate gracefully
        proc.kill()
        logging.warning(f"Force-killed stubborn Node.js process {pid}")
        return True
    except Exception as kill_error:
        logging.warning(f"Error killing Node.js process {pid}: {kill_error}")
        return False


def _cleanup_orphaned_nodejs_processes(current_pid: int) -> int:
    """Clean up orphaned Node.js processes that appear to be Playwright-related.

    This is more aggressive than Firefox cleanup since Node.js processes are harder to identify.
    We target processes that are:
    1. Named 'node' or 'nodejs'
    2. Old enough (10+ minutes) to be considered orphaned
    3. Have command lines suggesting Playwright usage

    Returns the number of processes cleaned up.
    """
    try:
        orphaned_count = 0

        # First, check if we have too many Playwright processes
        playwright_procs = _collect_playwright_processes()
        if len(playwright_procs) > 5:  # Lower threshold for aggressive cleanup
            logging.warning(
                f"Found {len(playwright_procs)} Playwright/Node processes - "
                f"performing aggressive cleanup"
            )
            # Be more aggressive with cleanup when we have too many processes
            # Kill ALL playwright processes except the most recent ones
            min_age_override = 30  # Kill processes older than 30 seconds
        else:
            min_age_override = None

        if psutil is not None:
            for proc in psutil.process_iter(["pid", "name", "cmdline", "create_time"]):
                try:
                    should_cleanup, cmdline_str = (
                        _is_nodejs_process_eligible_for_cleanup(
                            proc.info, current_pid, min_age_override
                        )
                    )

                    if should_cleanup and _terminate_nodejs_process(
                        proc, proc.info["pid"], cmdline_str
                    ):
                        orphaned_count += 1

                except (psutil.NoSuchProcess, psutil.AccessDenied):  # type: ignore
                    continue  # Process disappeared or access denied

        return orphaned_count

    except ImportError:
        logging.debug("psutil not available for Node.js cleanup")
        return 0
    except Exception as e:
        logging.warning(f"Error during Node.js process cleanup: {e}")
        return 0


def _cleanup_orphaned_processes() -> None:
    """Clean up orphaned Playwright processes from previous crawler sessions.

    This function targets:
    1. Firefox processes with Playwright-specific arguments (headless, temp profiles)
    2. Node.js processes that appear to be Playwright-related (orphaned from crashes)
    3. Processes that are old enough (10+ minutes) OR exceed soft limits

    This should NOT affect normal Firefox browsers or legitimate Node.js applications.
    """
    if psutil is None:
        return
    try:
        current_pid = os.getpid()  # Our current process ID
        total_cleaned = 0

        # Step 1: Clean up Firefox processes (existing logic)
        playwright_firefox_procs = _collect_playwright_firefox_processes(current_pid)
        processes_to_kill = _select_processes_to_kill(playwright_firefox_procs)
        firefox_cleaned = _terminate_selected_processes(processes_to_kill)
        total_cleaned += firefox_cleaned

        # Step 2: Clean up orphaned Node.js processes that appear Playwright-related
        node_cleaned = _cleanup_orphaned_nodejs_processes(current_pid)
        total_cleaned += node_cleaned

        # Report results with more detail
        if total_cleaned > 0:
            logging.info(
                f"Cleaned up {total_cleaned} total orphaned processes "
                f"({firefox_cleaned} Firefox, {node_cleaned} Node.js)"
            )
            # Log remaining process counts after cleanup
            remaining_firefox = len(_collect_playwright_firefox_processes(current_pid))
            remaining_nodejs = len(_collect_playwright_processes())
            if remaining_firefox > 0 or remaining_nodejs > 0:
                logging.info(
                    f"Processes remaining after cleanup: {remaining_firefox} Firefox, {remaining_nodejs} Node.js"
                )
            time.sleep(3)  # Give system more time to fully clean up
        else:
            logging.debug("No orphaned Playwright processes found")

    except ImportError:
        logging.debug("psutil not available for orphaned process cleanup")
    except Exception as e:
        logging.debug(f"Error in orphaned process cleanup: {e}")


def _setup_browser_with_timeout(p, timeout_seconds: int = 120) -> tuple:
    """Setup browser with timeout to prevent indefinite hangs.

    Note: We pass a longer timeout to Playwright itself rather than
    using threading/signals to avoid conflicts with Playwright's greenlets.
    """
    # Convert seconds to milliseconds for Playwright
    timeout_ms = timeout_seconds * 1000
    return _setup_browser(p, timeout_ms=timeout_ms)


def _setup_browser(p, timeout_ms: int = 60000) -> tuple:
    """Setup and return browser and page with retry logic and resource cleanup."""
    max_retries = 3
    base_delay = 15  # seconds - increased delay for better recovery
    browser = None  # Initialize for type safety

    for attempt in range(max_retries):
        try:
            # Enhanced resource monitoring before browser launch
            if attempt == 0:
                logging.info("=== BROWSER LAUNCH DIAGNOSTICS ===")
                logging.info("System resources before browser launch:")
                _log_system_resources()
                _log_process_diagnostics()
                logging.info("==================================")

            # Force garbage collection before browser launch to free memory
            gc.collect()

            # Check memory availability before attempting browser launch
            if psutil:
                memory = psutil.virtual_memory()
                available_gb = memory.available / (1024**3)
                if available_gb < 1.5:  # Need at least 1.5GB for browser launch
                    logging.warning(
                        f"Low memory available ({available_gb:.1f}GB), "
                        f"performing aggressive cleanup"
                    )
                    # More aggressive garbage collection
                    gc.collect(2)  # Full collection
                    time.sleep(2)  # Give OS time to reclaim memory

            # Kill any orphaned Firefox processes before launching new one
            _cleanup_orphaned_processes()

            # Always add a small delay after cleanup to let ports/resources free up
            time.sleep(3)

            # Add increased delay between attempts to let system recover
            if attempt > 0:
                delay = base_delay * (
                    2 ** (attempt - 1)
                )  # Exponential backoff: 15s, 30s
                logging.warning(
                    f"Browser launch attempt {attempt + 1}/{max_retries} failed. "
                    f"Waiting {delay}s before retry..."
                )
                logging.info("System resources before retry:")
                _log_system_resources()
                _log_process_diagnostics()
                time.sleep(delay)

            logging.info(
                f"Launching Firefox browser (timeout: {timeout_ms / 1000:.0f}s, attempt {attempt + 1}/{max_retries})..."
            )

            # Use a shorter timeout for browser launch to avoid hanging
            # The timeout_ms is for overall operation, but browser launch should be faster
            launch_timeout = min(30000, timeout_ms)  # Max 30 seconds for browser launch

            # Browser launch - note: args are for Chromium, not Firefox
            # Firefox uses firefox_user_prefs for configuration
            browser = p.firefox.launch(
                headless=True,
                firefox_user_prefs={
                    "media.volume_scale": "0.0",
                    "dom.disable_beforeunload": True,
                    "browser.sessionstore.resume_from_crash": False,
                    "browser.tabs.warnOnClose": False,
                    "browser.tabs.warnOnCloseOtherTabs": False,
                },
                timeout=launch_timeout,
            )

            page = browser.new_page()
            page.set_extra_http_headers({"User-Agent": USER_AGENT})

            # Test that browser is actually responsive
            try:
                test_result = page.evaluate("() => 'browser_ready'")
                if test_result != "browser_ready":
                    raise Exception("Browser launched but not responsive to JavaScript")
            except Exception as test_e:
                logging.warning(
                    f"Browser launched but failed responsiveness test: {test_e}"
                )
                with suppress(Exception):
                    browser.close()
                raise Exception(f"Browser not responsive: {test_e}") from test_e

            logging.info("Browser launched successfully and passed responsiveness test")
            return browser, page

        except Exception as e:
            error_msg = (
                f"Browser launch attempt {attempt + 1}/{max_retries} failed: {e}"
            )
            logging.warning(error_msg)

            # Log additional diagnostic information on failure
            error_str_lower = str(e).lower()
            if "timeout" in error_str_lower:
                logging.warning("Browser launch timed out - this may indicate:")
                logging.warning("  - Insufficient system memory or CPU resources")
                logging.warning(
                    "  - Previous browser processes not properly cleaned up"
                )
                logging.warning("  - System under heavy load")
                _log_process_diagnostics()
            elif (
                "connection" in error_str_lower
                or "closed while reading" in error_str_lower
            ):
                logging.warning(
                    "Browser connection failed - this may indicate network issues or driver instability"
                )
                # Add small delay to let network recover
                time.sleep(2)
            elif (
                "no space left on device" in error_str_lower
                or "disk" in error_str_lower
            ):
                logging.error(
                    "Disk space issue detected - browser launch cannot proceed"
                )
                raise Exception(
                    "Critical disk space issue - manual intervention required"
                ) from e

            if attempt == max_retries - 1:
                # Final attempt failed - provide comprehensive error info
                logging.error("=== CRITICAL BROWSER LAUNCH FAILURE ===")
                logging.error(
                    f"All {max_retries} browser launch attempts failed. Last error: {e}"
                )
                logging.error("Troubleshooting recommendations:")
                logging.error("1. Check system resources (memory, CPU, disk space)")
                logging.error(
                    "2. Kill any orphaned Firefox processes: pkill -f firefox"
                )
                logging.error(
                    "3. Update Playwright browsers: playwright install firefox"
                )
                logging.error("4. Restart the system if resources are exhausted")
                logging.error("5. Run with --debug flag for more detailed diagnostics")
                logging.error("======================================")
                raise Exception(
                    f"Browser launch failed after {max_retries} attempts: {e}"
                ) from e

            # Enhanced cleanup of any partially created browser instances
            try:
                if browser:
                    logging.debug("Cleaning up partially created browser instance")
                    browser.close()
            except Exception as cleanup_e:
                logging.debug(f"Error during browser cleanup: {cleanup_e}")

    # Should never reach here due to exception above, but for type safety
    raise Exception("Unexpected error in browser setup")


def _handle_browser_restart(
    p,
    page,
    browser,
    pages_since_restart: int,
    batch_results: list,
    batch_start_time: float,
    crawler: WebsiteCrawler,
) -> tuple:
    """Handle browser restart logic and stats calculation with enhanced resource management."""
    batch_attempts = len(batch_results)
    batch_successes = batch_results.count(True)
    batch_success_rate = (
        (batch_successes / batch_attempts * 100) if batch_attempts > 0 else 0
    )

    batch_elapsed_time = time.time() - batch_start_time
    pages_per_minute = (
        (pages_since_restart / batch_elapsed_time * 60)
        if batch_elapsed_time > 0
        else float("inf")
    )

    stats = crawler.get_queue_stats()
    completion_pct = round(
        stats["visited"] / stats["total"] * 100 if stats["total"] > 0 else 0
    )
    stats_message = (
        f"\n--- Stats at {pages_since_restart} page boundary ---\n"
        f"- Processing {pages_per_minute:.1f} pages/minute (last {pages_since_restart} pages)\n"
        f"- Database: {stats['visited']} visited, {stats['pending']} pending, {stats['failed']} failed ({stats['total']} total URLs)\n"
        f"- Crawl completion: {completion_pct}% of all URLs processed\n"
        f"- Session success rate: {round(batch_success_rate)}% (last {batch_attempts} attempts)\n"
        f"- Queue: {stats['pending_retry']} awaiting retry, {stats['high_priority']} high priority\n"
        f"- Average retries per URL with retries: {stats['avg_retry_count']}\n"
        f"--- End Stats ---"
    )
    for line in stats_message.split("\n"):
        logging.info(line)

    logging.info(
        f"Restarting browser after {pages_since_restart} pages (or due to error)..."
    )

    # Enhanced browser cleanup with timeout protection and process killing
    cleanup_start = time.time()
    cleanup_success = False

    try:
        # First try graceful shutdown
        if page and not page.is_closed():
            logging.debug("Closing page...")
            try:
                page.close()
            except Exception as page_close_err:
                logging.warning(f"Page close failed, proceeding: {page_close_err}")

        if browser and browser.is_connected():
            logging.debug("Closing browser...")
            try:
                browser.close()
            except Exception as browser_close_err:
                logging.warning(
                    f"Browser close failed, proceeding: {browser_close_err}"
                )

        cleanup_success = True
        cleanup_time = time.time() - cleanup_start
        logging.debug(f"Browser cleanup completed successfully in {cleanup_time:.1f}s")

    except Exception as close_err:
        cleanup_time = time.time() - cleanup_start
        logging.warning(
            f"Error during graceful browser cleanup (after {cleanup_time:.1f}s): {close_err}"
        )
        cleanup_success = False

    # If graceful cleanup failed or we're being extra thorough, kill Firefox processes
    if not cleanup_success:
        logging.warning("Graceful cleanup failed, attempting force cleanup...")
        _cleanup_orphaned_processes()

    # Add delay to let system resources recover after cleanup
    recovery_delay = 10  # Increased delay for better recovery
    logging.info(
        f"Waiting {recovery_delay}s for system resource recovery after browser cleanup..."
    )
    time.sleep(recovery_delay)

    # Log system state after cleanup
    logging.info("System state after browser cleanup:")
    _log_system_resources()
    _log_process_diagnostics()

    # Use enhanced browser setup with retry logic and timeout
    try:
        browser, page = _setup_browser_with_timeout(p, timeout_seconds=120)
        logging.info("Browser restarted successfully.")
        return browser, page, time.time(), []
    except Exception as restart_err:
        logging.error(
            f"Critical error: Browser restart failed completely: {restart_err}"
        )
        # Re-raise the exception to be handled by the main loop
        raise


def _process_page_content(
    content,
    new_links: list,
    url: str,
    crawler: WebsiteCrawler,
    pinecone_index,
    index_name: str,
) -> tuple[int, int, bool]:
    """Process page content and return (pages_processed_increment, pages_since_restart_increment)."""
    if not content:
        # Check if this URL was already marked as successfully skipped (non-HTML content)
        crawler._ensure_db_initialized()
        assert crawler.cursor is not None
        crawler.cursor.execute(
            "SELECT status, content_hash FROM crawl_queue WHERE url = ?",
            (crawler.normalize_url(url),),
        )
        result = crawler.cursor.fetchone()

        if (
            result
            and result[0] == "visited"
            and result[1] in ["non_html", "non_html_content"]
        ):
            # This was already successfully processed as non-HTML content
            logging.debug(f"Non-HTML content already processed: {url}")
            return 1, 1, False  # Count as successful processing

        # Otherwise, this is a genuine failure
        error_msg = f"No content extracted from {url}"
        crawler.mark_url_status(url, "failed", error_msg)
        return 0, 0, False

    # Handle special cases (WordPress login redirects, etc.)
    if (
        hasattr(content, "metadata")
        and content.metadata.get("type") == "wp_login_redirect"
    ):
        # WordPress login redirect was already handled and marked as visited
        # Return small increment to avoid triggering browser restart (restart_inc == 0 and pages_inc == 0)
        logging.debug(
            f"Skipping content processing for WordPress login redirect: {url}"
        )
        return (
            0,
            1,
            False,
        )  # No pages processed, but increment restart counter to avoid browser restart

    try:
        chunks = create_chunks_from_page(content, crawler.text_splitter)
        if chunks:
            content_hash = hashlib.sha256(content.content.encode()).hexdigest()

            if crawler.should_process_content(url, content_hash):
                embeddings = crawler.create_embeddings(chunks, url, content.title)
                upsert_to_pinecone(embeddings, pinecone_index, index_name)
                logging.debug(f"Successfully processed and upserted: {url}")
                logging.debug(
                    f"Created {len(chunks)} chunks, {len(embeddings)} embeddings."
                )
            else:
                logging.info(
                    f"Content unchanged for {url}, skipping embeddings creation"
                )

            crawler.mark_url_status(url, "visited", content_hash=content_hash)
        else:
            crawler.mark_url_status(url, "visited", content_hash="no_content")
            logging.warning(f"No content chunks created for {url}")

        # Add new links to queue
        for link in new_links:
            if (
                crawler.is_valid_url(link)
                and not crawler.should_skip_url(link)
                and not crawler.is_url_in_database(link)
            ):
                crawler.add_url_to_queue(link)

        return (
            1,
            1,
            False,
        )  # Increment both counters for successful processing, no rate limit hit

    except Exception as e:
        # Log exception type for debugging
        logging.debug(f"Exception type: {type(e).__name__}")

        # Check for rate limit errors by message content (more reliable than exception type)
        error_message = str(e).lower()
        is_rate_limit = (
            "rate limit" in error_message
            or "rate_limit_exceeded" in error_message
            or "requests per day" in error_message
            or "429" in error_message
        )

        if is_rate_limit:
            logging.warning(f"OpenAI rate limit reached for {url}: {e}")
            logging.warning(
                "Stopping current crawl round and sleeping for 1 hour due to rate limit"
            )
            crawler.mark_url_status(
                url, "pending", f"Rate limit hit - will retry after sleep: {str(e)}"
            )
            # Set flag on crawler to indicate rate limit exit
            crawler._rate_limit_exit = True
            return 0, 0, True  # Return rate_limit_hit flag

        logging.error(f"Failed to process page content {url}: {e}")
        logging.error(traceback.format_exc())
        crawler.mark_url_status(
            url, "failed", f"Failed during content processing: {str(e)}"
        )
        return 0, 0, False


def _cleanup_browser(page, browser) -> None:
    """Clean up browser resources."""
    if not is_exiting():
        logging.info("Closing browser cleanly...")
        try:
            if "page" in locals() and page and not page.is_closed():
                page.close()
            if "browser" in locals() and browser and browser.is_connected():
                browser.close()
                logging.info("Browser closed.")
        except Exception as e:
            logging.warning(f"Error during clean browser close: {e}")
    else:
        logging.info(
            "Exit requested via signal, skipping potentially blocking browser close."
        )


def _handle_url_processing(
    url: str, crawler: WebsiteCrawler, browser, page
) -> tuple[tuple, bool]:
    """Handle URL processing setup and skip checks. Returns ((content, links, restart_needed), should_skip)."""
    crawler.current_processing_url = url
    logging.info(f"Processing page: {url}")

    if crawler.should_skip_url(url):
        logging.info(f"Skipping URL based on skip patterns: {url}")
        crawler.mark_url_status(url, "failed", "Skipped by pattern rule")
        crawler.current_processing_url = None
        return (None, [], False), True  # Return empty results and should_skip=True

    content, new_links, restart_needed = crawler.crawl_page(browser, page, url)

    if restart_needed:
        logging.warning(f"Browser restart requested after attempting {url}.")
        crawler.mark_url_status(url, "pending")
        crawler.current_processing_url = None

    return (
        content,
        new_links,
        restart_needed,
    ), False  # Return actual results and should_skip=False


def _should_stop_crawling(stop_after: int | None, pages_processed: int) -> bool:
    """Check if crawling should stop due to page limit."""
    if stop_after and pages_processed >= stop_after:
        logging.info(f"Reached stop limit of {stop_after} pages. Stopping crawl.")
        return True
    return False


def _process_crawl_iteration(
    url: str,
    crawler: WebsiteCrawler,
    browser,
    page,
    pinecone_index,
    index_name: str,
) -> tuple[int, int, bool]:
    """Process a single crawl iteration. Returns (pages_inc, restart_inc, should_continue)."""
    (content, new_links, restart_needed), should_skip = _handle_url_processing(
        url, crawler, browser, page
    )

    if should_skip:
        # URL was skipped (404, etc) - don't restart browser for this
        return 0, 1, False  # Increment restart counter but don't process

    if restart_needed:
        return 0, 0, False  # Signal restart needed

    if is_exiting():
        logging.info(
            "Exit requested after crawling page, stopping before processing/saving."
        )
        return 0, 0, True  # Signal exit

    pages_inc, restart_inc, rate_limit_hit = _process_page_content(
        content, new_links, url, crawler, pinecone_index, index_name
    )

    # Handle rate limit - don't exit, just return with rate limit flag
    if rate_limit_hit:
        # Don't signal exit - we want to sleep and continue, not exit the script
        return 0, 0, False  # Continue normally, rate limit will be handled in main loop

    crawler.commit_db_changes()

    if is_exiting():
        logging.info("Exit requested after saving checkpoint, stopping loop.")
        return 0, 0, True  # Signal exit

    # Rate limiting: Sleep between requests to be respectful to the server
    if pages_inc > 0:  # Only delay if page was successfully processed
        delay = crawler.crawl_delay_seconds
        if delay > 0:
            logging.debug(f"Rate limiting: sleeping for {delay} seconds")
            time.sleep(delay)

    return pages_inc, restart_inc, False  # Continue normally


def _initialize_crawl_loop(
    args: argparse.Namespace, crawler: WebsiteCrawler
) -> tuple[str | None, int, int, int, list, float]:
    """Initialize crawl loop variables and return setup values."""
    index_name = os.getenv("PINECONE_INGEST_INDEX_NAME")
    if not index_name:
        logging.error(
            "PINECONE_INGEST_INDEX_NAME not found in environment during loop start."
        )
        return None, 0, 0, 0, [], 0.0

    pages_processed = 0
    pages_since_restart = 0
    batch_results = []
    batch_start_time = time.time()
    PAGES_PER_RESTART = 50
    stop_after = args.stop_after

    if stop_after:
        logging.info(f"Will stop crawling after processing {stop_after} pages")

    stats = crawler.get_queue_stats()
    pending_ready = stats["pending"] - stats.get("pending_retry", 0)
    logging.info(
        f"Initial queue stats: {stats['pending']} pending ({pending_ready} ready, {stats.get('pending_retry', 0)} waiting for retry), "
        f"{stats['visited']} visited, {stats['failed']} failed"
    )

    return (
        index_name,
        pages_processed,
        pages_since_restart,
        PAGES_PER_RESTART,
        batch_results,
        batch_start_time,
    )


def _handle_initial_crawl_completion(crawler: WebsiteCrawler) -> None:
    """Handle marking initial crawl as completed if needed."""
    if crawler.csv_mode_enabled and not crawler.is_initial_crawl_completed():
        stats = crawler.get_queue_stats()
        if stats["pending"] == 0:  # No more pending URLs
            crawler.mark_initial_crawl_completed()
            logging.info("Initial crawl completed - CSV mode now active")


def _process_pinecone_deletions(crawler: WebsiteCrawler, pinecone_index) -> int:
    """Process pending Pinecone deletions for 404'd URLs. Returns count of URLs processed."""
    if not pinecone_index:
        return 0

    pending_urls = crawler.get_urls_pending_pinecone_deletion()
    if not pending_urls:
        return 0

    processed_count = 0
    for url in pending_urls:
        try:
            deleted_vectors = crawler.remove_url_from_pinecone(pinecone_index, url)
            if deleted_vectors >= 0:  # Success (even if 0 vectors found)
                crawler.mark_pinecone_cleanup_complete(url)
                processed_count += 1
                logging.info(
                    f"Pinecone cleanup completed for 404'd URL: {url} ({deleted_vectors} vectors removed)"
                )
            else:
                logging.warning(f"Failed to clean up Pinecone vectors for {url}")
        except Exception as e:
            logging.error(f"Error processing Pinecone deletion for {url}: {e}")
            continue

    if processed_count > 0:
        logging.info(f"Processed Pinecone deletions for {processed_count} URLs")

    return processed_count


def _process_csv_updates(
    crawler: WebsiteCrawler, browser, pinecone_index=None
) -> str | None:
    """Process CSV updates and return URL if found, None otherwise."""
    if not crawler.csv_mode_enabled:
        return None

    try:
        # Check browser health before CSV processing
        if not _is_browser_healthy(browser):
            logging.warning(
                "Browser appears unhealthy before CSV processing, but continuing with existing browser"
            )
            # Note: We don't restart the browser here as it's managed by the main loop
            # The main loop will handle browser restarts as needed

        csv_added_count = crawler.check_and_process_csv(browser, pinecone_index)
        if csv_added_count > 0:
            logging.info(
                f"CSV check added {csv_added_count} URLs to high-priority queue"
            )
            # Re-check for URLs after CSV processing - process them immediately
            url = crawler.get_next_url_to_crawl()
            if url:
                logging.info(f"Found CSV URL to process immediately: {url}")
                return url
            else:
                logging.info("CSV check completed but no URLs ready for processing")
    except Exception as e:
        logging.error(f"Error during CSV check: {e}")
        # Check if the error suggests browser issues
        if any(
            keyword in str(e).lower()
            for keyword in ["browser", "connection", "timeout", "disconnected"]
        ):
            logging.warning(
                "CSV error appears to be browser-related - main loop should consider browser restart"
            )

    return None


def _is_browser_healthy(browser) -> bool:
    """Check if browser is healthy and responsive."""
    if not browser:
        return False

    try:
        # Check if browser is still connected
        if not browser.is_connected():
            logging.warning("Browser is not connected")
            return False

        # Try to get browser contexts (lightweight operation)
        contexts = browser.contexts
        if not contexts:
            logging.warning("Browser has no contexts")
            return False

        return True
    except Exception as e:
        logging.warning(f"Browser health check failed: {e}")
        return False


def _handle_no_url_processing(
    crawler: WebsiteCrawler,
    browser,
    page,
    pages_processed: int,
    pages_since_restart: int,
    batch_start_time: float,
    batch_results: list,
    start_time: float,
    max_runtime_seconds: float,
    pinecone_index=None,
) -> tuple[int, int, bool, bool, tuple, bool]:
    """Handle the case when no URL is available for processing."""
    # Check if we should mark initial crawl as completed
    _handle_initial_crawl_completion(crawler)

    # Process pending Pinecone deletions for 404'd URLs (high priority)
    _process_pinecone_deletions(crawler, pinecone_index)

    # Check for CSV updates before going to sleep (high priority)
    csv_url = _process_csv_updates(crawler, browser, pinecone_index)
    if csv_url:
        # Found URL from CSV, signal to continue with normal processing
        # The caller will call get_next_url_to_crawl() again to get the CSV URL
        return (
            pages_processed,
            pages_since_restart,
            False,
            False,
            (browser, page, batch_start_time, batch_results),
            False,  # Not a rate limit exit
        )

    # Check if we have enough time left to make sleeping worthwhile
    elapsed_time = time.time() - start_time
    time_remaining = max_runtime_seconds - elapsed_time
    sleep_duration = 60 * 60  # 1 hour

    if time_remaining < sleep_duration + (
        5 * 60
    ):  # Need at least 5 minutes after sleep
        logging.info(
            f"No URLs ready for processing, but insufficient time remaining ({time_remaining:.0f}s) "
            f"for 1-hour sleep. Exiting gracefully."
        )
        return (
            pages_processed,
            pages_since_restart,
            True,  # Exit gracefully
            False,
            (browser, page, batch_start_time, batch_results),
            False,  # Not a rate limit exit
        )

    # Only sleep if we still don't have a URL to process
    logging.info("No URLs ready for processing. Sleeping for one hour...\n\n")
    exit_requested = _graceful_sleep(sleep_duration)
    if exit_requested:
        logging.info("Exit was requested during sleep")
        return (
            pages_processed,
            pages_since_restart,
            True,
            False,
            (browser, page, batch_start_time, batch_results),
            False,  # Not a rate limit exit
        )

    logging.info("Sleep completed - continuing loop...")

    # CRITICAL FIX: Refresh database connection after long sleep
    # SQLite connections can become stale after extended periods
    try:
        # Test the connection with a simple query
        crawler._ensure_db_initialized()
        assert crawler.cursor is not None
        crawler.cursor.execute("SELECT 1")
        crawler.cursor.fetchone()
    except Exception as e:
        logging.warning(f"Database connection stale after sleep, refreshing: {e}")
        try:
            # Close the old connection
            if hasattr(crawler, "conn") and crawler.conn:
                crawler.conn.close()

            # Recreate the connection
            crawler.conn = sqlite3.connect(str(crawler.db_file))
            crawler.conn.row_factory = sqlite3.Row
            crawler.cursor = crawler.conn.cursor()
            logging.info("Database connection refreshed successfully")
        except Exception as refresh_error:
            logging.error(f"Failed to refresh database connection: {refresh_error}")

    return (
        pages_processed,
        pages_since_restart,
        False,
        False,
        (browser, page, batch_start_time, batch_results),
        False,  # Not a rate limit exit
    )


def _handle_browser_restart_check(
    pages_since_restart: int,
    PAGES_PER_RESTART: int,
    p,
    page,
    browser,
    batch_results: list,
    batch_start_time: float,
    crawler: WebsiteCrawler,
    pages_processed: int,
) -> tuple[int, int, bool, bool, tuple, bool] | None:
    """Handle browser restart if needed."""
    if pages_since_restart >= PAGES_PER_RESTART:
        browser, page, batch_start_time, batch_results = _handle_browser_restart(
            p,
            page,
            browser,
            pages_since_restart,
            batch_results,
            batch_start_time,
            crawler,
        )
        return (
            pages_processed,
            0,
            False,
            True,
            (browser, page, batch_start_time, batch_results),
            False,  # Not a rate limit exit
        )
    return None  # No restart needed


def _handle_crawl_loop_iteration(
    crawler: WebsiteCrawler,
    browser,
    page,
    pinecone_index,
    index_name: str,
    stop_after: int | None,
    pages_processed: int,
    pages_since_restart: int,
    PAGES_PER_RESTART: int,
    batch_results: list,
    batch_start_time: float,
    p,
    start_time: float,
    max_runtime_seconds: float,
) -> tuple[int, int, bool, bool, tuple, bool]:
    """Handle a single iteration of the crawl loop.

    Returns:
        tuple: (pages_processed, pages_since_restart, should_exit, should_restart, (browser, page, batch_start_time, batch_results), rate_limit_hit)
    """
    if _should_stop_crawling(stop_after, pages_processed):
        return (
            pages_processed,
            pages_since_restart,
            True,
            False,
            (browser, page, batch_start_time, batch_results),
            False,  # Not a rate limit exit
        )

    url = crawler.get_next_url_to_crawl()
    if not url:
        return _handle_no_url_processing(
            crawler,
            browser,
            page,
            pages_processed,
            pages_since_restart,
            batch_start_time,
            batch_results,
            start_time,
            max_runtime_seconds,
            pinecone_index,
        )

    # Check if browser restart is needed
    restart_result = _handle_browser_restart_check(
        pages_since_restart,
        PAGES_PER_RESTART,
        p,
        page,
        browser,
        batch_results,
        batch_start_time,
        crawler,
        pages_processed,
    )
    if restart_result:
        return restart_result

    pages_inc, restart_inc, should_exit = _process_crawl_iteration(
        url, crawler, browser, page, pinecone_index, index_name
    )

    # Update health monitor progress if we processed a page
    if pages_inc > 0:
        crawler.health_monitor.update_progress()

    # Check if rate limit was hit (separate from should_exit)
    rate_limit_exit = getattr(crawler, "_rate_limit_exit", False)
    if rate_limit_exit:
        # Reset the flag for next iteration
        crawler._rate_limit_exit = False
        return (
            pages_processed,
            pages_since_restart,
            False,  # Don't exit the script
            False,
            (browser, page, batch_start_time, batch_results),
            True,  # Rate limit flag
        )

    if should_exit:
        return (
            pages_processed,
            pages_since_restart,
            True,
            False,
            (browser, page, batch_start_time, batch_results),
            False,  # Not a rate limit exit
        )

    if restart_inc == 0 and pages_inc == 0:  # Restart needed
        browser, page, batch_start_time, batch_results = _handle_browser_restart(
            p,
            page,
            browser,
            pages_since_restart,
            batch_results,
            batch_start_time,
            crawler,
        )
        return (
            pages_processed,
            0,
            False,
            True,
            (browser, page, batch_start_time, batch_results),
            False,  # Not a rate limit exit
        )

    pages_processed += pages_inc
    pages_since_restart += restart_inc
    batch_results.append(pages_inc > 0)

    return (
        pages_processed,
        pages_since_restart,
        False,
        False,
        (browser, page, batch_start_time, batch_results),
        False,  # Not a rate limit exit
    )


def _handle_rate_limit_sleep(start_time: float, max_runtime_seconds: float) -> bool:
    """Handle rate limit sleep and return True if exit was requested or time would be wasted."""
    sleep_duration = 60 * 60  # 1 hour
    elapsed_time = time.time() - start_time
    time_remaining = max_runtime_seconds - elapsed_time

    # If we don't have enough time left for meaningful work after sleeping, exit instead
    if time_remaining < sleep_duration + (
        5 * 60
    ):  # Need at least 5 minutes after sleep
        logging.warning(
            f"Rate limit detected but insufficient time remaining ({time_remaining:.0f}s) "
            f"for 1-hour sleep + work. Exiting gracefully."
        )
        return False  # Signal normal completion, not exit request

    logging.warning("Rate limit detected - sleeping for 1 hour before continuing...")
    exit_requested = _graceful_sleep(sleep_duration)
    if exit_requested:
        logging.info("Exit was requested during rate limit sleep")
        return True
    logging.info("Rate limit sleep completed - resuming crawl...")
    return False


def _handle_crawl_loop_exception(e: Exception) -> None:
    """Handle exceptions in the main crawl loop."""
    if is_exiting():
        logging.info(
            "Exit signal received during operation, shutting down without detailed error reporting."
        )
    else:
        logging.error(f"Browser or main loop error: {e}")
        logging.error(traceback.format_exc())


def _check_runtime_limits(
    start_time: float,
    max_runtime_seconds: float,
    args: argparse.Namespace,
    pages_processed: int,
) -> bool:
    """Check if we've exceeded max runtime. Returns True if should exit."""
    elapsed_time = time.time() - start_time
    if elapsed_time >= max_runtime_seconds:
        logging.info(
            f"Reached maximum runtime of {args.max_runtime_minutes} minutes, exiting cleanly"
        )
        logging.info(f"Processed {pages_processed} pages in {elapsed_time:.1f} seconds")
        return True
    return False


def _initialize_crawler_runtime(args: argparse.Namespace) -> tuple[float, float]:
    """Initialize runtime tracking variables."""
    start_time = time.time()
    max_runtime_seconds = (
        args.max_runtime_minutes * 60 if args.max_runtime_minutes > 0 else float("inf")
    )
    return start_time, max_runtime_seconds


def _log_crawler_completion(start_time: float, pages_processed: int) -> None:
    """Log final crawler session statistics."""
    final_elapsed = time.time() - start_time
    logging.info("=== CRAWLER SESSION COMPLETE ===")
    logging.info(
        f"Total runtime: {final_elapsed:.1f} seconds ({final_elapsed / 60:.1f} minutes)"
    )
    logging.info(f"Pages processed: {pages_processed}")
    if pages_processed > 0:
        pages_per_minute = pages_processed / (final_elapsed / 60)
        logging.info(f"Pages per minute: {pages_per_minute:.2f}")
    logging.info("=================================")


def _cleanup_browser_resources(browser) -> None:
    """Clean up browser resources safely."""
    try:
        if browser and not browser.is_connected():
            logging.info("Browser already closed or not connected")
        elif browser:
            logging.info("Closing browser in final cleanup...")
            browser.close()
            time.sleep(2)  # Give browser time to close cleanly
            logging.info("Browser closed successfully")
        else:
            logging.debug("No browser to close")
    except Exception as cleanup_error:
        logging.warning(f"Error during browser cleanup: {cleanup_error}")


def _setup_crawler_browser(crawler: WebsiteCrawler, p) -> tuple:
    """Set up browser and health monitoring for crawler."""
    browser, page = _setup_browser_with_timeout(p, timeout_seconds=120)
    crawler.health_monitor.set_browser(browser, page)
    crawler.health_monitor.start_monitoring()
    return browser, page


def _unpack_crawler_setup(setup_result, args):
    """Unpack crawler setup results and return configured variables."""
    (
        index_name,
        pages_processed,
        pages_since_restart,
        PAGES_PER_RESTART,
        batch_results,
        batch_start_time,
    ) = setup_result
    stop_after = args.stop_after
    return (
        index_name,
        pages_processed,
        pages_since_restart,
        PAGES_PER_RESTART,
        batch_results,
        batch_start_time,
        stop_after,
    )


def _run_crawler_main_loop(
    crawler,
    browser,
    page,
    pinecone_index,
    index_name,
    stop_after,
    pages_processed,
    pages_since_restart,
    PAGES_PER_RESTART,
    batch_results,
    batch_start_time,
    p,
    start_time,
    max_runtime_seconds,
    args,
):
    """Run the main crawler loop and return final page count."""
    while not is_exiting():
        if _check_runtime_limits(
            start_time, max_runtime_seconds, args, pages_processed
        ):
            return pages_processed

        (
            pages_processed,
            pages_since_restart,
            should_exit,
            should_restart,
            (browser, page, batch_start_time, batch_results),
            rate_limit_hit_flag,
        ) = _handle_crawl_loop_iteration(
            crawler,
            browser,
            page,
            pinecone_index,
            index_name,
            stop_after,
            pages_processed,
            pages_since_restart,
            PAGES_PER_RESTART,
            batch_results,
            batch_start_time,
            p,
            start_time,
            max_runtime_seconds,
        )

        if should_exit:
            break

        if should_restart:
            continue

        # Handle rate limit - sleep for 1 hour and continue
        if rate_limit_hit_flag:
            if _handle_rate_limit_sleep(start_time, max_runtime_seconds):
                break
            continue

    crawler.current_processing_url = None
    return pages_processed


def _handle_crawler_error(e: Exception) -> None:
    """Categorize and log crawler errors with appropriate recovery suggestions."""
    error_str = str(e).lower()
    error_type = type(e).__name__

    # Browser launch failures - most critical
    if (
        "browser launch failed" in error_str
        or "timeout" in error_str
        or "BrowserType.launch" in error_str
    ):
        logging.error("=== CRITICAL BROWSER LAUNCH FAILURE ===")
        logging.error(f"Error: {e}")
        logging.error("This indicates a fundamental browser setup issue.")
        logging.error("IMMEDIATE ACTION REQUIRED:")
        logging.error("1. Check system resources (memory, CPU, disk):")
        _log_system_resources()
        _log_process_diagnostics()
        logging.error("2. Kill any orphaned Firefox processes:")
        logging.error("   pkill -f firefox")
        logging.error("3. Update Playwright browsers:")
        logging.error("   playwright install firefox")
        logging.error("4. If system is resource-starved, restart it")
        logging.error("5. Run with --debug flag for more diagnostics")
        logging.error("======================================")

    # Database connectivity issues
    elif "database" in error_str or "connection" in error_str:
        logging.error("=== DATABASE CONNECTIVITY ISSUE ===")
        logging.error(f"Error: {e}")
        logging.error("Check database connection and credentials")
        logging.error("==================================")

    # Network connectivity issues
    elif "network" in error_str or "connection" in error_str or "timeout" in error_str:
        logging.error("=== NETWORK CONNECTIVITY ISSUE ===")
        logging.error(f"Error: {e}")
        logging.error("Check internet connection and target site availability")
        logging.error("=====================================")

    # Memory/resource exhaustion
    elif "memory" in error_str or "out of memory" in error_str:
        logging.error("=== MEMORY EXHAUSTION DETECTED ===")
        logging.error(f"Error: {e}")
        logging.error("System is running out of memory")
        logging.error("Consider reducing batch sizes or adding more RAM")
        logging.error("==================================")

    # Generic errors
    else:
        logging.error(f"=== UNEXPECTED ERROR ({error_type}) ===")
        logging.error(f"Error: {e}")
        logging.error("This is an unexpected error that needs investigation")
        logging.error("========================================")


def run_crawl_loop(
    crawler: WebsiteCrawler,
    pinecone_index: Any,
    args: argparse.Namespace,
    lock_file: str | None = None,
):
    """Run the main crawling loop with graceful exception handling and bounded execution."""
    start_time, max_runtime_seconds = _initialize_crawler_runtime(args)

    setup_result = _initialize_crawl_loop(args, crawler)
    if setup_result[0] is None:  # index_name is None, error occurred
        return

    (
        index_name,
        pages_processed,
        pages_since_restart,
        PAGES_PER_RESTART,
        batch_results,
        batch_start_time,
        stop_after,
    ) = _unpack_crawler_setup(setup_result, args)

    with sync_playwright() as p:
        browser, page = _setup_crawler_browser(crawler, p)

        # Only create lock file after successful browser setup
        if lock_file:
            logging.info("Browser setup successful, creating lock file")
            with open(lock_file, "w") as f:
                f.write(str(os.getpid()))

        try:
            pages_processed = _run_crawler_main_loop(
                crawler,
                browser,
                page,
                pinecone_index,
                index_name,
                stop_after,
                pages_processed,
                pages_since_restart,
                PAGES_PER_RESTART,
                batch_results,
                batch_start_time,
                p,
                start_time,
                max_runtime_seconds,
                args,
            )

        except SystemExit:
            logging.info("Received exit signal, shutting down crawler loop.")
        except Exception as e:
            _handle_crawler_error(e)

        finally:
            # Final cleanup
            _cleanup_browser_resources(browser)
            _cleanup_orphaned_processes()
            _log_crawler_completion(start_time, pages_processed)

    if pages_processed == 0:
        logging.warning("No pages were crawled successfully in this run.")
    logging.info(f"Completed processing {pages_processed} pages during this run.")


def handle_fresh_start(args: argparse.Namespace) -> None:
    """Handle --fresh-start flag by deleting existing database."""
    if not args.fresh_start:
        return

    # Support DATA_DIR environment variable for EFS mounts (cloud deployment)
    data_dir = os.getenv("DATA_DIR")
    if data_dir:
        db_dir = Path(data_dir) / "db"
    else:
        script_dir = Path(__file__).resolve().parent
        db_dir = script_dir / "db"
    db_file_to_delete = db_dir / f"crawler_queue_{args.site}.db"

    if db_file_to_delete.exists():
        # Add verification step with default No
        print("\n⚠️  WARNING: Fresh start will delete the existing database file:")
        print(f"   {db_file_to_delete}")
        print(
            f"   This will remove all crawl history, queue state, and CSV tracking data for site '{args.site}'."
        )

        response = input("\nProceed with deletion? [y/N]: ").strip().lower()

        # Default to "no" if empty response, only proceed with explicit yes
        if not response or response not in ["y", "yes"]:
            print("Fresh start cancelled.")
            logging.info("Fresh start cancelled by user.")
            sys.exit(0)

        try:
            os.remove(db_file_to_delete)
            print("✅ Successfully deleted database file for fresh start.")
            logging.info(
                f"Successfully deleted database file for fresh start: {db_file_to_delete}"
            )
        except OSError as e:
            logging.error(f"Error deleting database file {db_file_to_delete}: {e}")
            print(
                f"❌ Error: Could not delete database file {db_file_to_delete} for fresh start. Please check permissions or delete manually. Exiting."
            )
            sys.exit(1)
    else:
        logging.info(
            f"--fresh-start specified, but no existing database file found at {db_file_to_delete}. Proceeding with new database."
        )


def handle_clear_vectors(
    args: argparse.Namespace,
    pinecone_index: Any,
    domain: str,
    crawler: WebsiteCrawler,
) -> None:
    """Handle --clear-vectors flag by clearing existing vectors."""
    if not args.clear_vectors:
        return

    try:
        logging.info(f"Clearing existing web content vectors for domain '{domain}'...")
        success = clear_library_vectors(
            pinecone_index, domain, dry_run=False, ask_confirmation=True
        )
        if not success:
            logging.error("Vector clearing was cancelled or failed.")
            crawler.close()
            sys.exit(1)
        logging.info("Vector clearing completed successfully.")
    except Exception as e:
        logging.error(f"Error clearing vectors: {e}")
        crawler.close()
        sys.exit(1)


def cleanup_and_exit(crawler: WebsiteCrawler | None) -> None:
    """Perform final cleanup and exit with appropriate code."""
    if crawler:
        logging.info("Performing final database commit and cleanup...")
        crawler.commit_db_changes()
        crawler.close()

    if is_exiting():
        logging.info("Exiting script now due to signal request.")
        exit_code = 1
    else:
        logging.info("Script finished normally.")
        exit_code = 0

    sys.exit(exit_code)


def _setup_logging_and_config(args: argparse.Namespace) -> dict:
    """Setup logging and load site configuration."""
    # Configure logging level based on debug flag
    if args.debug:
        logging.getLogger().setLevel(logging.DEBUG)
        logging.info("Debug mode enabled - detailed logging activated")

    # Load Site Configuration
    site_config = load_config(args.site)
    if not site_config:
        print(
            f"Error: Failed to load configuration for site '{args.site}'. See logs for details."
        )
        sys.exit(1)

    return site_config


def _setup_environment_and_paths(
    args: argparse.Namespace, site_config: dict
) -> tuple[str, str, str]:
    """Setup environment and return domain, start_url, env_file."""
    # Environment File
    script_dir = Path(__file__).resolve().parent
    project_root = script_dir.parent.parent
    env_file = project_root / f".env.{args.site}"

    handle_fresh_start(args)

    env_file_str = str(env_file)
    logging.info(
        f"Will load environment variables from: {os.path.abspath(env_file_str)}"
    )

    # Get Domain & Start URL from Config
    domain = site_config.get("domain")
    if not domain:
        logging.error(
            f"Domain not found in configuration for site '{args.site}'. Exiting."
        )
        print(
            f"Error: Domain not found in configuration for site '{args.site}'. Exiting."
        )
        sys.exit(1)
    start_url = ensure_scheme(domain)
    logging.info(f"Configured domain: {domain}")

    return domain, start_url, env_file_str


def _perform_system_health_check(args) -> None:
    """Perform system health check and handle critical issues."""
    logging.info("Performing pre-flight system health check...")
    is_healthy, issues = _check_system_health()

    if not is_healthy:
        logging.warning("=== SYSTEM HEALTH CHECK FAILED ===")
        for issue in issues:
            logging.warning(f"  - {issue}")
        logging.warning("These issues may cause browser launch failures.")
        logging.warning("Consider addressing them before proceeding.")
        logging.warning("====================================")

        # For critical issues, ask user if they want to continue
        critical_issues = [
            i
            for i in issues
            if any(
                keyword in i.lower()
                for keyword in [
                    "critical memory",
                    "very low memory",
                    "low disk",
                    "very low disk",
                    "multiple firefox",
                ]
            )
        ]
        if critical_issues:
            print("\n⚠️  CRITICAL SYSTEM ISSUES DETECTED:")
            for issue in critical_issues:
                print(f"  - {issue}")
            print("\nThese issues are likely to cause browser launch failures.")
            # Check if running in non-interactive mode (for daemons)
            if hasattr(args, "non_interactive") and args.non_interactive:
                print(
                    "Running in non-interactive mode - continuing despite health issues."
                )
                logging.warning(
                    "Non-interactive mode: Continuing despite critical system health issues: %s",
                    "; ".join(critical_issues),
                )
            else:
                try:
                    response = input("Continue anyway? [y/N]: ").strip().lower()
                    if response not in ["y", "yes"]:
                        print("Crawler startup cancelled due to system health issues.")
                        logging.info(
                            "Crawler startup cancelled by user due to system health issues."
                        )
                        sys.exit(1)
                except EOFError:
                    # Handle case where input is not available (e.g., when run as daemon)
                    print("No interactive input available - continuing automatically.")
                    logging.warning(
                        "No interactive input available: Continuing despite critical system health issues: %s",
                        "; ".join(critical_issues),
                    )
    else:
        logging.info("System health check passed - proceeding with crawler startup")


def _initialize_crawler_and_services(
    args: argparse.Namespace, site_config: dict, env_file_str: str
) -> tuple[WebsiteCrawler, Any, str]:
    """Initialize crawler, Pinecone, and handle clear vectors."""
    # Load environment variables - check if already set (cloud mode) or load from file
    required_vars = ["OPENAI_API_KEY", "PINECONE_API_KEY"]
    if all(os.getenv(var) for var in required_vars):
        logging.info("Environment variables already set (cloud mode)")
    elif os.path.exists(env_file_str):
        load_dotenv(env_file_str)
        logging.debug(f"Loaded environment from: {os.path.abspath(env_file_str)}")
    else:
        print(
            f"Error: Environment file {env_file_str} not found and required env vars not set."
        )
        sys.exit(1)

    domain = site_config.get("domain")
    crawler = WebsiteCrawler(
        site_id=args.site,
        site_config=site_config,
        retry_failed=args.retry_failed,
        debug=args.debug,
    )

    env_file = Path(env_file_str)
    pinecone_index = initialize_pinecone(str(env_file))
    if not pinecone_index:
        crawler.close()
        sys.exit(1)

    if domain is None:
        logging.error("Domain not found in site config")
        crawler.close()
        sys.exit(1)

    handle_clear_vectors(args, pinecone_index, domain, crawler)

    return crawler, pinecone_index, domain


def _execute_crawler(
    crawler: WebsiteCrawler,
    pinecone_index: Any,
    args: argparse.Namespace,
    start_url: str,
    lock_file: str | None = None,
) -> None:
    """Execute the main crawler logic with proper error handling."""
    try:
        logging.info(f"Starting crawl of {start_url} for site '{args.site}'")
        if crawler.csv_mode_enabled:
            logging.debug(
                f"CSV mode enabled - will check {crawler.csv_export_url} once per hour when system wakes up"
            )
            logging.debug(
                f"CSV modified threshold: {crawler.csv_modified_days_threshold} days"
            )
        else:
            logging.info("CSV mode disabled - no CSV export URL configured")
        run_crawl_loop(crawler, pinecone_index, args, lock_file)
    except SystemExit:
        logging.info("Exiting due to SystemExit signal.")
    except Exception as e:
        if is_exiting():
            logging.info("Exit signal received, suppressing detailed error output.")
        else:
            logging.error(f"Unexpected error in main execution: {e}")
            logging.error(traceback.format_exc())


def main():
    args = parse_arguments()

    # Setup phase
    site_config = _setup_logging_and_config(args)
    domain, start_url, env_file_str = _setup_environment_and_paths(args, site_config)

    setup_signal_handlers()
    _perform_system_health_check(args)

    # File locking to prevent multiple instances - check for existing lock first
    lock_file = f"/tmp/crawler_{args.site}.lock"
    if os.path.exists(lock_file):
        try:
            with open(lock_file) as f:
                old_pid = int(f.read().strip())
            # Check if the PID is still running
            result = subprocess.run(
                ["ps", "-p", str(old_pid)], capture_output=True, text=True
            )
            if result.returncode == 0:
                print(
                    f"Crawler for site '{args.site}' already running (PID {old_pid}), exiting"
                )
                logging.info(
                    f"Crawler for site '{args.site}' already running (PID {old_pid}), exiting"
                )
                sys.exit(1)
            else:
                print(f"Removing stale lock file from dead process (PID {old_pid})")
                logging.info(
                    f"Removing stale lock file from dead process (PID {old_pid})"
                )
                os.remove(lock_file)
        except (ValueError, OSError) as e:
            print(f"Error reading lock file, removing it: {e}")
            logging.warning(f"Error reading lock file, removing it: {e}")
            with suppress(OSError):
                os.remove(lock_file)

    crawler = None
    try:
        # Initialization phase - test that everything works before creating lock
        crawler, pinecone_index, domain = _initialize_crawler_and_services(
            args, site_config, env_file_str
        )

        # Execution phase - pass lock_file to create it only after browser setup
        _execute_crawler(crawler, pinecone_index, args, start_url, lock_file)

    finally:
        # Remove lock file
        if os.path.exists(lock_file):
            os.remove(lock_file)
        cleanup_and_exit(crawler)


if __name__ == "__main__":
    main()
