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
import csv
import logging
import os
import random
import re
import sqlite3
import sys
import tempfile
import time
import traceback
from contextlib import suppress
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.robotparser import RobotFileParser

# Third party imports
from bs4 import BeautifulSoup
from dateutil import tz
from langchain_openai import OpenAIEmbeddings
from playwright.sync_api import TimeoutError as PlaywrightTimeout
from readability import Document

# Optional imports (may not be available in all environments)
try:
    import psutil
except ImportError:
    psutil = None

# OpenAI imports for rate limit handling (used for fallback checks)
try:
    import openai
except ImportError:
    # Fallback for when openai is not available
    openai = None

# Import shared utility
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from utils.pinecone_utils import (
    generate_vector_id,
)
from utils.text_splitter_utils import SpacyTextSplitter

# Import from crawler submodules (support both module and direct execution)
try:
    # When running as a module (python -m crawler.website_crawler)
    from .author_extraction import extract_author_from_html
    from .config import (
        USER_AGENT,
        ContentHash,
        PageContent,
        PineconeCleanupError,
        Timeouts,
        ensure_scheme,
        requires_db,
    )
    from .health import HealthMonitor
    from .lock_manager import CrawlerLockManager
except ImportError:
    # When running directly (python website_crawler.py)
    from author_extraction import extract_author_from_html  # type: ignore[import-not-found]
    from config import (  # type: ignore[import-not-found]
        USER_AGENT,
        ContentHash,
        PageContent,
        PineconeCleanupError,
        Timeouts,
        ensure_scheme,
        requires_db,
    )
    from health import HealthMonitor  # type: ignore[import-not-found]
    from lock_manager import CrawlerLockManager  # type: ignore[import-not-found]

# Import from page_processing module

# Import from process_cleanup module

# Global lock manager instance - initialized in main()
_lock_manager: CrawlerLockManager | None = None

# Global timeout constants to prevent magic numbers
DEFAULT_PAGE_TIMEOUT_MS = 30000  # 30 seconds
NETWORK_IDLE_TIMEOUT_MS = 15000  # 15 seconds for network idle
CSV_TIMEOUT_MS = 30000  # 30 seconds for CSV downloads

SQLITE_NORMALIZED_NEXT_CRAWL = "datetime(replace(substr(next_crawl,1,19),'T',' '))"
SQLITE_NORMALIZED_RETRY_AFTER = "datetime(replace(substr(retry_after,1,19),'T',' '))"

# Configure logging defaults (main() will override with _configure_logging()).
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s"
)

# Suppress INFO messages from the underlying HTTP library (often httpx)
httpx_logger = logging.getLogger("httpx")
httpx_logger.setLevel(logging.WARNING)


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
        # Core configuration
        self.site_id = site_id
        self.config = site_config
        self.debug = debug
        self.dry_run = dry_run
        self.domain = self.config["domain"]
        self.start_url = ensure_scheme(self.domain)
        self.skip_patterns = self.config.get("skip_patterns", [])
        self.crawl_frequency_days = self.config.get("crawl_frequency_days", 14)

        # Initialize subsystems
        self._init_csv_config()
        self._init_robots_config(skip_robots_init)
        self._init_lazy_loaders()
        self._init_db_state()

        # Initialize health monitor
        self.health_monitor = HealthMonitor(self)

        if self.debug:
            logging.info(
                "Debug mode enabled - detailed logging and screenshots will be saved"
            )

        if not skip_db_init:
            self._init_database()
            if retry_failed:
                self.retry_failed_urls()
            self._run_initialization_logic()

    def _init_csv_config(self) -> None:
        """Initialize CSV mode configuration from site config."""
        self.csv_export_url = self.config.get("csv_export_url")
        self.csv_modified_days_threshold = self.config.get(
            "csv_modified_days_threshold", 1
        )
        self.csv_timezone = self.config.get(
            "csv_timezone", "America/Los_Angeles"
        )  # Timezone for CSV date parsing (defaults to Pacific)
        self.csv_mode_enabled = bool(self.csv_export_url)
        self.force_csv_mode = False  # Set to True via --force-csv-mode flag
        self._csv_force_used = False  # Track if force bypass has been used once
        self._startup_csv_check_completed = False
        self.initial_crawl_completed = False

    def _init_robots_config(self, skip_init: bool) -> None:
        """Initialize robots.txt parser with 24-hour caching."""
        self.robots_url = f"{self.start_url.rstrip('/')}/robots.txt"
        self.robots_parser = None
        self.robots_cache_timestamp = None
        self.robots_cache_duration_hours = 24
        if not skip_init:
            self._load_robots_txt()

    def _init_lazy_loaders(self) -> None:
        """Initialize lazy-loaded components (text splitter, embeddings)."""
        self._text_splitter = None
        self._embeddings = None
        self._embedding_model_name = None

    def _init_db_state(self) -> None:
        """Initialize database-related state variables."""
        self.conn: sqlite3.Connection | None = None
        self.cursor: sqlite3.Cursor | None = None
        self.db_file: Path | None = None
        self._db_recovery_failed = False
        self._db_recovery_failure_reason: str | None = None
        self.current_processing_url: str | None = None
        self._rate_limit_exit: bool = False
        # Track URLs that timeout within a session to avoid retry loops
        self.session_timeout_counts: dict[str, int] = {}
        self.MAX_SESSION_TIMEOUTS = 2  # Skip URL after this many timeouts
        self.MAX_TIMEOUT_COUNTS_ENTRIES = 1000  # Max entries before cleanup
        self._last_cleanup_check = 0  # Track when we last checked for cleanup
        self._session_operation_count = 0  # Track operations for periodic cleanup
        self._total_timeouts_tracked = 0  # Monitor for memory usage

    def _init_database(self):
        """Initialize SQLite database - separated for testability."""
        # Support DATA_DIR environment variable for EFS mounts (cloud deployment)
        data_dir = os.getenv("DATA_DIR")
        db_dir = Path(data_dir) / "db" if data_dir else Path(__file__).parent / "db"
        db_dir.mkdir(parents=True, exist_ok=True)
        self.db_file = db_dir / f"crawler_queue_{self.site_id}.db"
        self.conn = sqlite3.connect(
            str(self.db_file), timeout=60.0, check_same_thread=False
        )  # 60s busy timeout for EFS latency spikes, allow cross-thread access
        self.conn.row_factory = sqlite3.Row  # Allow dictionary-like access to rows
        self.cursor = self.conn.cursor()
        self._db_recovery_failed = False
        self._db_recovery_failure_reason = None

        self._apply_sqlite_pragmas()

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

    def _apply_sqlite_pragmas(self) -> None:
        """Apply SQLite PRAGMA settings for EFS compatibility."""
        assert self.cursor is not None
        self.cursor.execute("PRAGMA journal_mode=WAL")
        journal_result = self.cursor.fetchone()
        if journal_result and journal_result[0] != "wal":
            logging.warning(
                f"Could not enable WAL mode, journal_mode is: {journal_result[0]}"
            )
        else:
            logging.debug("WAL mode enabled for database")
        self.cursor.execute("PRAGMA busy_timeout=60000")
        self.cursor.execute("PRAGMA synchronous=NORMAL")

    def _is_locking_protocol_error(self, error: Exception) -> bool:
        """Return True when SQLite reports a locking protocol fault."""
        return isinstance(error, sqlite3.OperationalError) and (
            "locking protocol" in str(error).lower()
        )

    def mark_db_recovery_failed(self, reason: str) -> None:
        """Mark the crawler session for shutdown after unrecoverable DB failure."""
        self._db_recovery_failed = True
        self._db_recovery_failure_reason = reason
        logging.critical(
            f"Database recovery failed; crawler session marked for shutdown: {reason}"
        )

    def is_db_recovery_failed(self) -> bool:
        """Check whether a fatal DB recovery failure has occurred."""
        return self._db_recovery_failed

    def get_db_recovery_failure_reason(self) -> str | None:
        """Return the fatal DB recovery failure reason, if any."""
        return self._db_recovery_failure_reason

    def recover_database_connection(self) -> bool:
        """Reconnect SQLite database and re-apply PRAGMAs after lock protocol errors."""
        if self.db_file is None:
            logging.error("Cannot recover database connection: db_file is not set")
            return False

        try:
            if self.cursor is not None:
                with suppress(Exception):
                    self.cursor.close()
            if self.conn is not None:
                with suppress(Exception):
                    self.conn.close()

            self.conn = sqlite3.connect(
                str(self.db_file), timeout=60.0, check_same_thread=False
            )
            self.conn.row_factory = sqlite3.Row
            self.cursor = self.conn.cursor()
            self._apply_sqlite_pragmas()

            self.cursor.execute("SELECT 1")
            self.cursor.fetchone()
            self._db_recovery_failed = False
            self._db_recovery_failure_reason = None
            logging.info("Recovered SQLite connection after locking protocol error")
            return True
        except Exception as recovery_error:
            logging.error(f"Failed to recover SQLite connection: {recovery_error}")
            return False

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

    @requires_db
    def _run_initialization_logic(self):
        """Run the initialization logic to check if start URL should be added."""
        # Check if database is completely empty (no URLs at all)
        # Only seed with start URL if this is a fresh database with no crawl history
        assert self.cursor is not None
        assert self.conn is not None
        self.cursor.execute("SELECT COUNT(*) FROM crawl_queue")
        total_count = self.cursor.fetchone()[0]

        if total_count == 0:
            logging.info(f"Database is empty. Seeding with start URL: {self.start_url}")
            self.add_url_to_queue(self.start_url, priority=1)
            self.conn.commit()
        else:
            # Get breakdown of what's available for crawling
            self.cursor.execute(f"""
            SELECT COUNT(*) FROM crawl_queue 
            WHERE status = 'pending' AND (retry_after IS NULL OR {SQLITE_NORMALIZED_RETRY_AFTER} <= datetime('now'))
            """)
            pending_ready = self.cursor.fetchone()[0]

            self.cursor.execute(f"""
            SELECT COUNT(*) FROM crawl_queue 
            WHERE status = 'visited' AND {SQLITE_NORMALIZED_NEXT_CRAWL} <= datetime('now')
            """)
            stale_count = self.cursor.fetchone()[0]

            available_count = pending_ready + stale_count
            logging.info(
                f"Database contains {total_count} URLs total, "
                f"{available_count} ready to process ({pending_ready} new/retry + {stale_count} stale re-crawl)"
            )

    def close(self):
        """Close database connection and print chunking metrics"""
        # Print chunking metrics summary before closing (only if splitter was ever initialized)
        if self._text_splitter is not None:
            logging.info("=== WEBSITE CRAWLER CHUNKING METRICS ===")
            self._text_splitter.metrics.print_summary()

        # Close database connection with error handling
        if hasattr(self, "conn") and self.conn:
            try:
                if self.cursor:
                    self.cursor.close()
                self.conn.close()
                logging.debug("Database connection closed successfully")
            except Exception as e:
                logging.error(f"Error closing database connection: {e}")

        # Clean up timeout tracking to prevent memory leaks
        self.session_timeout_counts.clear()
        self._total_timeouts_tracked = 0

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

    @requires_db
    def add_url_to_queue(
        self, url: str, priority: int = 0, modified_date: str | None = None
    ):
        """Add URL to crawl queue if not already present, or update priority if higher"""
        assert self.cursor is not None
        assert self.conn is not None
        # Strip tracking parameters before normalizing to avoid storing analytics cruft
        clean_url = self.strip_tracking_params(url)
        normalized_url = self.normalize_url(clean_url)

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

                # Re-activate deleted URLs regardless of priority/modified_date
                if existing_status == "deleted":
                    self.cursor.execute(
                        """
                        UPDATE crawl_queue 
                        SET priority = ?, next_crawl = datetime('now'), status = 'pending',
                            modified_date = ?, last_crawl = NULL
                        WHERE url = ?
                        """,
                        (priority, modified_date, normalized_url),
                    )
                    logging.debug("  - Decision: reactivated (was deleted)")
                    return "updated_priority"
                # If new priority is higher, update it and reset next_crawl for immediate processing
                elif priority > existing_priority:
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

    @requires_db
    def retry_failed_urls(self):
        """Reset failed URLs to pending status for retry"""
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

    @requires_db
    def is_url_visited(self, url: str) -> bool:
        """Check if URL has already been successfully visited"""
        assert self.cursor is not None
        normalized_url = self.normalize_url(url)
        self.cursor.execute(
            "SELECT status FROM crawl_queue WHERE url = ? AND status = 'visited'",
            (normalized_url,),
        )
        return bool(self.cursor.fetchone())

    @requires_db
    def is_url_in_database(self, url: str) -> bool:
        """Check if URL is already in the database (regardless of status)"""
        assert self.cursor is not None
        normalized_url = self.normalize_url(url)
        self.cursor.execute(
            "SELECT url FROM crawl_queue WHERE url = ?",
            (normalized_url,),
        )
        return bool(self.cursor.fetchone())

    @requires_db
    def get_next_url_to_crawl(self, _retried: bool = False) -> str | None:
        """Get the next URL to crawl from the queue"""
        assert self.cursor is not None
        assert self.conn is not None
        try:
            # Get URLs that are due for crawling, including visited URLs due for re-crawling
            # and pending URLs, respecting retry_after for temporary failures
            # Loop until we find a URL that doesn't match skip patterns
            max_iterations = 100  # Prevent infinite loop
            iteration = 0
            while iteration < max_iterations:
                iteration += 1
                self.cursor.execute(f"""
                SELECT url FROM crawl_queue 
                WHERE (
                    (status = 'pending' AND (retry_after IS NULL OR {SQLITE_NORMALIZED_RETRY_AFTER} <= datetime('now'))) 
                    OR 
                    (status = 'visited' AND {SQLITE_NORMALIZED_NEXT_CRAWL} <= datetime('now'))
                )
                ORDER BY 
                    priority DESC,           -- Highest priority first
                    status = 'pending' DESC,  -- Prioritize pending URLs first
                    last_crawl IS NULL DESC,  -- Then new URLs
                    retry_count ASC,         -- Then URLs with fewer retries
                    {SQLITE_NORMALIZED_NEXT_CRAWL} ASC,  -- Then URLs due longest ago
                    url ASC                  -- Finally alphabetical for consistency
                LIMIT 1
                """)
                result = self.cursor.fetchone()
                if not result:
                    return None

                url = result[0]

                # Check if URL matches skip patterns - if so, remove it from database
                skip_result = self.should_skip_url(url)
                if skip_result:
                    normalized_url = self.normalize_url(url)
                    logging.info(
                        f"Removing URL matching skip pattern from database: {url} (normalized: {normalized_url})"
                    )
                    self.cursor.execute(
                        "DELETE FROM crawl_queue WHERE url = ?", (normalized_url,)
                    )
                    self.conn.commit()
                    # Continue to next iteration to find another URL
                    continue

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

            # If we've iterated too many times, return None
            logging.warning(
                f"Reached max iterations ({max_iterations}) in get_next_url_to_crawl, stopping"
            )
            return None
        except Exception as e:
            if self._is_locking_protocol_error(e):
                if not _retried and self.recover_database_connection():
                    logging.warning(
                        "Retrying get_next_url_to_crawl after lock recovery"
                    )
                    return self.get_next_url_to_crawl(_retried=True)
                self.mark_db_recovery_failed(
                    f"get_next_url_to_crawl failed after recovery attempt: {e}"
                )
            logging.error(f"Error getting next URL to crawl: {e}")
            return None

    @requires_db
    def peek_next_url_to_crawl(self) -> str | None:
        """Return the next eligible URL without mutating queue state."""
        assert self.cursor is not None
        try:
            self.cursor.execute(
                f"""
                SELECT url FROM crawl_queue
                WHERE (
                    (status = 'pending' AND (retry_after IS NULL OR {SQLITE_NORMALIZED_RETRY_AFTER} <= datetime('now')))
                    OR
                    (status = 'visited' AND {SQLITE_NORMALIZED_NEXT_CRAWL} <= datetime('now'))
                )
                ORDER BY
                    priority DESC,
                    status = 'pending' DESC,
                    last_crawl IS NULL DESC,
                    retry_count ASC,
                    {SQLITE_NORMALIZED_NEXT_CRAWL} ASC,
                    url ASC
                LIMIT 1
                """
            )
            result = self.cursor.fetchone()
            return result[0] if result else None
        except Exception as e:
            logging.error(f"Error peeking next URL to crawl: {e}")
            return None

    @requires_db
    def _handle_404_retry_logic(
        self, normalized_url: str, error_msg: str, now: str
    ) -> bool:
        """Handle 404 retry logic. Returns True if URL was processed, False if not a 404."""
        if not error_msg or "404" not in error_msg:
            return False
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

    @requires_db
    def _handle_temporary_failure_retry(
        self, normalized_url: str, error_msg: str
    ) -> bool:
        """Handle temporary failure retry logic. Returns True if retry was set up, False for permanent failure."""
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
            "http 5",  # Match HTTP 5xx errors (was "5" which matched any digit 5 in URL)
            "500",
            "503",
            "502",
            "504",
            "overloaded",
            "too many requests",
            "429",
            "temporarily",
            "try again",
            "pinecone",  # Pinecone cleanup failures should be retried
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

    @requires_db
    def mark_url_status(
        self,
        url: str,
        status: str,
        error_msg: str | None = None,
        content_hash: str | None = None,
        _retried: bool = False,
    ):
        """Update URL status in the database"""
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
            if self._is_locking_protocol_error(e):
                if not _retried and self.recover_database_connection():
                    logging.warning("Retrying mark_url_status after lock recovery")
                    return self.mark_url_status(
                        url=url,
                        status=status,
                        error_msg=error_msg,
                        content_hash=content_hash,
                        _retried=True,
                    )
                self.mark_db_recovery_failed(
                    f"mark_url_status failed after recovery attempt: {e}"
                )
            logging.error(f"Error updating URL status: {e}")
            return False

    @requires_db
    def commit_db_changes(self):
        """Commit any pending database changes"""
        assert self.conn is not None
        try:
            self.conn.commit()
            logging.debug("Database changes committed")
            return True
        except Exception as e:
            logging.error(f"Error committing database changes: {e}")
            return False

    @requires_db
    def get_queue_stats(self, _retried: bool = False) -> dict:
        """Get statistics about the crawl queue"""
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
            "available": True,
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
            self.cursor.execute(f"""
            SELECT COUNT(*) FROM crawl_queue 
            WHERE status = 'pending' 
            AND retry_after IS NOT NULL 
            AND {SQLITE_NORMALIZED_RETRY_AFTER} > datetime('now')
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
            if self._is_locking_protocol_error(e):
                if not _retried and self.recover_database_connection():
                    logging.warning("Retrying get_queue_stats after lock recovery")
                    return self.get_queue_stats(_retried=True)
                self.mark_db_recovery_failed(
                    f"get_queue_stats failed after recovery attempt: {e}"
                )
            logging.error(f"Error getting queue stats: {e}")
            stats["available"] = False
            return stats

    @requires_db
    def all_pending_urls_have_failed(self) -> bool:
        """Check if all pending URLs have been tried at least once (retry_count >= 1).

        This is used to determine if the initial crawl is effectively complete,
        even if there are still pending URLs that are just stuck in retry loops.
        """
        assert self.cursor is not None
        try:
            # Count pending URLs that have never been tried (retry_count = 0)
            self.cursor.execute("""
                SELECT COUNT(*) FROM crawl_queue 
                WHERE status = 'pending' 
                AND retry_count = 0
            """)
            untried_count = self.cursor.fetchone()[0]

            if untried_count > 0:
                logging.debug(
                    f"Initial crawl not complete: {untried_count} pending URLs never tried"
                )
                return False

            # All pending URLs have retry_count >= 1
            return True
        except Exception as e:
            logging.error(f"Error checking pending URL retry status: {e}")
            return False

    @requires_db
    def get_failed_urls(self) -> list[tuple[str, str]]:
        """Get list of failed URLs with error messages"""
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

    def strip_tracking_params(self, url: str) -> str:
        """Remove tracking parameters from URL to normalize for storage.

        Strips common tracking parameters like Google Analytics (_ga, _gl, utm_*),
        Facebook (fbclid), etc. that don't affect page content.
        """
        parsed = urlparse(url)
        if not parsed.query:
            return url

        # Parameters to strip (tracking/analytics that don't affect content)
        tracking_prefixes = ("utm_", "_ga", "_gl", "fbclid", "gclid", "msclkid", "mc_")

        params = parse_qs(parsed.query, keep_blank_values=True)
        # Filter out tracking params
        clean_params = {
            k: v
            for k, v in params.items()
            if not k.lower().startswith(tracking_prefixes)
        }

        if clean_params:
            clean_query = urlencode(clean_params, doseq=True)
            return f"{parsed.scheme}://{parsed.netloc}{parsed.path}?{clean_query}"
        else:
            # All params were tracking params
            return f"{parsed.scheme}://{parsed.netloc}{parsed.path}"

    def normalize_url(self, url: str) -> str:
        """Normalize URL for comparison with path traversal protection."""
        parsed = urlparse(url)
        # Strip www and fragments, but preserve query parameters
        netloc = parsed.netloc.replace("www.", "")
        path = parsed.path.rstrip("/")

        # Prevent path traversal attacks in path (e.g., /../, /.., ../)
        if ".." in path or "\x00" in path:
            logging.warning(f"Path traversal attempt detected in URL: {url}")
            raise ValueError(f"Invalid URL path: {path}")

        normalized = netloc + path
        if parsed.query:
            # Check for null bytes in query (actual security risk)
            # Note: ".." in query params is NOT a path traversal risk - it's commonly
            # found in legitimate tracking params like Google Analytics _gl parameter
            if "\x00" in parsed.query:
                logging.warning(
                    f"Null byte injection attempt in query parameters: {url}"
                )
                raise ValueError(f"Invalid URL query: {parsed.query}")
            normalized += "?" + parsed.query
        return normalized.lower()

    def _is_wordpress_login_redirect(self, final_url: str, original_url: str) -> bool:
        """Check if we were redirected to a WordPress login page."""
        # Check if the final URL is a WordPress login page
        return "/wp-login.php" in final_url

    def should_skip_url(self, url: str) -> bool:
        """Check if URL should be skipped based on patterns"""
        parsed = urlparse(url)
        # Extract path for pattern matching (patterns match after domain)
        # Handle normalized URLs (without scheme) - they're stored as "domain.com/path"
        if not parsed.netloc and parsed.path:
            # This is a normalized URL - extract the path part
            # Normalized format: "domain.com/path" -> path is "/path"
            path_part = parsed.path
            # If path contains domain (normalized format), extract just the path
            if "/" in path_part and not path_part.startswith("/"):
                # Split on first "/" and take everything after domain
                parts = path_part.split("/", 1)
                path = "/" + parts[1] if len(parts) > 1 else "/"
            else:
                path = path_part if path_part.startswith("/") else "/" + path_part
        else:
            path = parsed.path

        # Check standard skip patterns against the path
        for pattern in self.skip_patterns:
            if re.search(pattern, path):
                return True

        # Check for calendar/export URLs that serve non-HTML content
        query_params = parsed.query.lower()

        # Skip URLs with calendar/export parameters
        calendar_params = ["ical", "ical=1", "export", "format=ical", "format=ics"]
        if any(param in query_params for param in calendar_params):
            logging.debug(f"Skipping calendar/export URL: {url}")
            return True

        # Skip URLs with comment reply parameters (replytocom)
        if "replytocom" in query_params:
            logging.debug(f"Skipping comment reply URL: {url}")
            return True

        # Skip WordPress logout URLs
        if "action=logout" in query_params:
            logging.debug(f"Skipping WordPress logout URL: {url}")
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
            "header, footer, nav, script, style, iframe, .sidebar, "
            "[class*='chatbot'], [id*='chatbot'], "
            "[class*='chat-widget'], [id*='chat-widget'], "
            "[class*='vivek'], [id*='vivek'], "
            "[class*='chat-window'], [id*='chat-window'], "
            ".modal, .popup, [class*='modal'], [id*='modal'], "
            "[class*='popup'], [id*='popup'], "
            "[aria-label*='chat'], [aria-label*='Chat'], "
            "[aria-label*='Vivek'], [aria-label*='vivek'], "
            "[data-chatbot], [data-chat-widget], "
            "[role='dialog'][aria-label*='chat'], [role='dialog'][aria-label*='Chat']"
        )
        for element in elements_to_remove:
            element.decompose()

        # Also remove elements with hidden inline styles (display:none, visibility:hidden)
        # This catches chatbot content that's in the DOM but hidden
        all_elements = soup.find_all(True)
        chatbot_keywords = ["chat", "vivek", "bot", "widget"]
        for element in all_elements:
            style = element.get("style", "")
            if style:
                style_lower = style.lower()
                is_hidden = (
                    "display:none" in style_lower
                    or "display: none" in style_lower
                    or "visibility:hidden" in style_lower
                    or "visibility: hidden" in style_lower
                )
                if is_hidden:
                    # Check if it's chatbot-related by checking class, id, and aria-label attributes
                    class_attr = element.get("class", [])
                    class_str = (
                        " ".join(class_attr).lower()
                        if isinstance(class_attr, list)
                        else str(class_attr).lower()
                    )
                    id_attr = element.get("id", "").lower()
                    aria_label = element.get("aria-label", "").lower()

                    if any(
                        keyword in class_str
                        or keyword in id_attr
                        or keyword in aria_label
                        for keyword in chatbot_keywords
                    ):
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

        try:
            if response.status >= 400:
                error_msg = f"HTTP {response.status}"
                logging.error(f"{error_msg} error for {url}")
                return False, Exception(error_msg)
        except AttributeError as e:
            logging.error(f"Response object missing status attribute for {url}: {e}")
            return False, Exception(f"Invalid response object: {e}")

        try:
            content_type = response.header_value("content-type")
            if content_type and not content_type.lower().startswith("text/html"):
                logging.info(f"Skipping non-HTML content ({content_type}) at {url}")
                self.mark_url_status(url, "visited", content_hash="non_html")
                return False, None  # None indicates successful skip, not error
        except (AttributeError, TypeError) as e:
            # Handle cases where header_value() fails (e.g., headers dict is None)
            logging.warning(
                f"Could not read content-type header for {url}: {e}. Assuming HTML and continuing."
            )
            # Continue as if it's HTML content

        # Additional check: if URL changed significantly (like to a media file), skip it
        try:
            final_url = response.url
        except AttributeError as e:
            logging.error(f"Response object missing url attribute for {url}: {e}")
            return False, Exception(f"Invalid response object: {e}")
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
                self.mark_url_status(
                    url, "visited", content_hash=ContentHash.MEDIA_REDIRECT
                )
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
        body_timeout = DEFAULT_PAGE_TIMEOUT_MS

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
                            url, "visited", content_hash=ContentHash.NON_HTML_CONTENT
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
                self.mark_url_status(
                    url, "visited", content_hash=ContentHash.EMPTY_CONTENT
                )
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

    def _extract_title_and_content(self, page, url: str) -> tuple[str, str, str | None]:
        """Extract title, cleaned text, and author from the page."""
        title = page.title() or "No Title Found"
        logging.debug(f"Page title: {title}")

        html_content = page.content()
        logging.debug(f"Raw HTML content length: {len(html_content)}")

        author = extract_author_from_html(html_content, site_id=self.site_id)
        if author:
            logging.debug(f"Extracted author: {author}")

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

        return title, clean_text, author

    def _create_page_content(
        self,
        url: str,
        title: str,
        clean_text: str,
        schemed_valid_links: list[str],
        author: str | None = None,
    ) -> tuple[PageContent | None, list[str]]:
        """Create final PageContent object and return with links."""
        if not clean_text.strip() and title == "No Title Found":
            logging.warning(f"No content or title extracted from {url}")
            return None, schemed_valid_links

        metadata: dict[str, str] = {"type": "text", "source": url}
        if author:
            metadata["author"] = author

        page_content = PageContent(
            url=url,
            title=title,
            content=clean_text,
            metadata=metadata,
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

        # Extract title, content, and author
        title, clean_text, author = self._extract_title_and_content(page, url)

        # Process links with schemes
        schemed_valid_links = [ensure_scheme(link) for link in valid_links]

        # Create final page content object
        return self._create_page_content(
            url, title, clean_text, schemed_valid_links, author=author
        )

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

    def _handle_none_response(self, url: str, retries: int) -> tuple[int, Exception]:
        """Handle None response from page.goto(). Returns (new_retries, exception)."""
        logging.warning(
            f"page.goto() returned None for {url} - navigation may have failed or been aborted"
        )
        exception = Exception("Navigation failed - no response object")
        retries -= 1
        if retries > 0:
            logging.info(f"Retrying {url} after None response...")
            time.sleep(5)
        return retries, exception

    def _create_wp_redirect_content(self, url: str, final_url: str) -> PageContent:
        """Create PageContent for WordPress login redirect."""
        logging.info(f"Ignoring WordPress login redirect: {url} -> {final_url}")
        self.mark_url_status(url, "visited", content_hash=ContentHash.WP_LOGIN_REDIRECT)
        return PageContent(
            url=url,
            title="WordPress Login Redirect",
            content="",
            metadata={
                "type": "wp_login_redirect",
                "source": url,
                "final_url": final_url,
            },
        )

    def crawl_page(
        self, browser, page, url: str
    ) -> tuple[PageContent | None, list[str], bool]:
        """Crawl a single page and return content, links, and restart flag."""
        retries = 2
        last_exception: Exception | None = None
        restart_needed = False
        url = ensure_scheme(url)

        while retries > 0:
            try:
                logging.debug(
                    f"Attempting to navigate to {url} (Attempts left: {retries})"
                )
                page.set_default_timeout(30000)
                response = page.goto(url, wait_until="commit")

                if response is None:
                    retries, last_exception = self._handle_none_response(url, retries)
                    continue

                final_url = page.url
                if self._is_wordpress_login_redirect(final_url, url):
                    return self._create_wp_redirect_content(url, final_url), [], False

                should_continue, exception = self._validate_response(response, url)
                if not should_continue:
                    if exception is None:
                        return None, [], False
                    last_exception = exception
                    retries = 0
                    continue

                content, links = self._extract_page_content(page, url)
                return content, links, False

            except Exception as e:
                restart_needed, should_retry = self._handle_crawl_exception(e, url)
                last_exception = e
                retries = self._update_retries_after_exception(
                    retries, restart_needed, should_retry, url
                )

        if not restart_needed:
            self._log_and_mark_failed(url, last_exception)

        return None, [], restart_needed

    def _update_retries_after_exception(
        self, retries: int, restart_needed: bool, should_retry: bool, url: str
    ) -> int:
        """Update retry count after an exception. Returns new retry count."""
        self._session_operation_count += 1
        if self._session_operation_count % 50 == 0:
            self._cleanup_old_timeout_counts()

        if restart_needed or not should_retry:
            return 0
        if retries > 1:
            logging.info(f"Waiting 5s before next retry for {url}...")
            time.sleep(5)
            return retries - 1
        return 0

    def _log_and_mark_failed(self, url: str, last_exception: Exception | None) -> None:
        """Log failure and mark URL as failed."""
        error_message = (
            str(last_exception)
            if last_exception
            else "Unknown error during crawl attempt"
        )
        logging.error(
            f"Giving up on {url} after exhausting retries or encountering fatal error. "
            f"Last error: {last_exception}"
        )
        self.mark_url_status(url, "failed", error_message)

    def create_embeddings(
        self,
        chunks: list[str],
        url: str,
        page_title: str,
        author: str | None = None,
    ) -> list[dict]:
        """Create embeddings for text chunks using batch API for efficiency."""
        if not chunks:
            return []

        # Batch embed all chunks in a single API call (more efficient than N calls)
        # LangChain's OpenAIEmbeddings automatically handles batching internally
        all_vectors = self.embeddings.embed_documents(chunks)

        vectors = []
        for i, (chunk, vector) in enumerate(zip(chunks, all_vectors, strict=True)):
            chunk_id = generate_vector_id(
                library_name=self.domain,
                title=page_title,
                chunk_index=i,
                source_location="web",
                source_identifier=url,
                content_type="text",
                author=author,
                chunk_text=chunk,
            )

            chunk_metadata = {
                "type": "text",
                "url": url,
                "source": url,
                "title": page_title,
                "library": self.domain,
                "text": chunk,
                "access_level": "public",
                "required_access_level": 0,
                "chunk_index": i,
                "total_chunks": len(chunks),
                "crawl_timestamp": datetime.now().isoformat(),
            }
            if author:
                chunk_metadata["author"] = author

            vectors.append(
                {"id": chunk_id, "values": vector, "metadata": chunk_metadata}
            )

            logging.debug(
                f"Vector {i + 1}/{len(chunks)} - ID: {chunk_id} - Preview: {chunk[:100]}..."
            )

        return vectors

    @requires_db
    def get_urls_pending_pinecone_deletion(self) -> list[str]:
        """Get URLs marked as 'deleted' that need Pinecone cleanup."""
        assert self.cursor is not None
        try:
            self.cursor.execute(
                f"SELECT url FROM crawl_queue WHERE status = 'deleted' AND content_hash != '{ContentHash.PINECONE_CLEANED}'"
            )
            results = self.cursor.fetchall()
            return [row[0] for row in results] if results else []
        except Exception as e:
            logging.error(f"Error fetching URLs pending Pinecone deletion: {e}")
            return []

    @requires_db
    def mark_pinecone_cleanup_complete(self, url: str) -> bool:
        """Mark that Pinecone cleanup has been completed for a URL."""
        assert self.cursor is not None
        assert self.conn is not None
        try:
            normalized_url = self.normalize_url(url)
            self.cursor.execute(
                f"UPDATE crawl_queue SET content_hash = '{ContentHash.PINECONE_CLEANED}' WHERE url = ?",
                (normalized_url,),
            )
            self.conn.commit()
            return True
        except Exception as e:
            logging.error(f"Error marking Pinecone cleanup complete for {url}: {e}")
            return False

    def _query_pinecone_by_field(
        self, pinecone_index, field: str, value: str, dummy_vector: list
    ) -> set[str]:
        """Query Pinecone for vector IDs matching a metadata field value.

        Raises:
            PineconeCleanupError: If the query fails (e.g., dimension mismatch)
        """
        try:
            response = pinecone_index.query(
                vector=dummy_vector,
                filter={field: {"$eq": value}},
                top_k=1000,
                include_metadata=True,
                include_values=False,
            )
            if response.matches:
                return {match.id for match in response.matches}
            return set()
        except Exception as e:
            logging.warning(f"Error querying Pinecone by '{field}' field: {e}")
            raise PineconeCleanupError(
                f"Failed to query Pinecone by '{field}' field: {e}"
            ) from e

    def _delete_pinecone_batch(
        self, pinecone_index, batch_ids: list[str], url: str
    ) -> int:
        """Delete a batch of vectors from Pinecone. Returns count deleted."""
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
            return len(batch_ids)
        except Exception as e:
            logging.error(f"Failed to delete vector batch for URL {url}: {e}")
            return 0

    def remove_url_from_pinecone(self, pinecone_index, url: str) -> int:
        """Remove all vectors for a specific URL from Pinecone.

        Args:
            pinecone_index: Pinecone index instance
            url: URL to remove from Pinecone

        Returns:
            Number of vectors successfully deleted (or would be deleted in dry-run mode)
        """
        try:
            vector_dimension = int(os.getenv("OPENAI_EMBEDDING_DIMENSION", 3072))
            dummy_vector = [0.0] * vector_dimension
            normalized_url = self.normalize_url(url)

            logging.debug(
                f"Querying Pinecone for vectors with normalized URL: {normalized_url}"
            )

            # Query both 'url' and 'source' fields (Pinecone doesn't support $or)
            vector_ids_set = self._query_pinecone_by_field(
                pinecone_index, "url", normalized_url, dummy_vector
            )
            vector_ids_set.update(
                self._query_pinecone_by_field(
                    pinecone_index, "source", normalized_url, dummy_vector
                )
            )

            if not vector_ids_set:
                logging.info(f"No vectors found in Pinecone for URL: {url}")
                return 0

            vector_ids = list(vector_ids_set)
            logging.info(f"Found {len(vector_ids)} vectors to delete for URL: {url}")

            # Delete in batches of 100 (Pinecone limit)
            deleted_count = 0
            batch_size = 100
            for i in range(0, len(vector_ids), batch_size):
                batch_ids = vector_ids[i : i + batch_size]
                deleted_count += self._delete_pinecone_batch(
                    pinecone_index, batch_ids, url
                )

            logging.info(f"Successfully deleted {deleted_count} vectors for URL: {url}")
            return deleted_count

        except PineconeCleanupError:
            # Let this propagate so the URL gets marked for retry
            raise
        except Exception as e:
            logging.error(f"Error removing URL from Pinecone {url}: {e}")
            return 0

    @requires_db
    def should_process_content(self, url: str, current_hash: str) -> bool:
        """Check if content has changed and should be processed"""
        assert self.cursor is not None
        self.cursor.execute(
            "SELECT content_hash FROM crawl_queue WHERE url = ?",
            (self.normalize_url(url),),
        )
        result = self.cursor.fetchone()

        # If never seen before or hash has changed, process it
        return bool(not result or not result[0] or result[0] != current_hash)

    def parse_csv_date(self, date_str: str) -> datetime | None:
        """Parse CSV date format (in configured timezone) and convert to UTC.

        CSV dates are in the timezone specified by csv_timezone config (defaults to
        America/Los_Angeles). Database stores times in UTC. This function converts
        the CSV timezone to UTC for consistent comparison.
        """
        source_tz_obj = tz.gettz(self.csv_timezone)
        utc_tz_obj = tz.UTC

        naive_dt = None
        try:
            # Handle format "2025-07-13 12:45:35" - ISO-like format
            naive_dt = datetime.strptime(date_str, "%Y-%m-%d %H:%M:%S")
        except ValueError:
            try:
                # Try alternative format without seconds "2025-07-13 12:45"
                naive_dt = datetime.strptime(date_str, "%Y-%m-%d %H:%M")
            except ValueError:
                try:
                    # Try legacy format "12/22/25 16:09" - MM/DD/YY HH:MM
                    naive_dt = datetime.strptime(date_str, "%m/%d/%y %H:%M")
                except ValueError:
                    logging.warning(f"Could not parse CSV date: {date_str}")
                    return None

        if naive_dt is None:
            return None

        # Treat parsed datetime as source timezone and convert to UTC
        source_dt = naive_dt.replace(tzinfo=source_tz_obj)
        utc_dt = source_dt.astimezone(utc_tz_obj)

        # Return as naive UTC datetime to match database storage format
        return utc_dt.replace(tzinfo=None)

    def _establish_csv_session(self, page) -> bool:
        """Establish session by visiting main site. Returns True if successful."""
        try:
            main_response = page.goto(
                self.start_url,
                timeout=Timeouts.NETWORK_IDLE_MS,
                wait_until="networkidle",
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

    def _initialize_download_info(self, download_info: dict) -> None:
        """Ensure download_info dict has required keys initialized."""
        if "content" not in download_info:
            download_info["content"] = None
        if "error" not in download_info:
            download_info["error"] = None

    def _navigate_and_check_response(self, page) -> None:
        """Navigate to CSV URL and check response status."""
        response = page.goto(
            self.csv_export_url,
            timeout=Timeouts.PAGE_DEFAULT_MS,
            wait_until="networkidle",
        )

        # Check response status
        if response and response.status >= 400:
            raise Exception(f"HTTP {response.status} error when accessing CSV URL")

    def _extract_content_if_needed(self, page, download_info: dict) -> None:
        """Extract page content if download didn't occur."""
        if not download_info["content"] and not download_info["error"]:
            # Wait a moment for potential download with timeout
            try:
                page.wait_for_timeout(3000)
            except Exception as wait_error:
                logging.warning(f"Timeout during download wait: {wait_error}")

            if not download_info["content"]:
                download_info["content"] = self._extract_page_content_csv(page)

    def _handle_download_exception(self, page, e: Exception) -> None:
        """Handle download-related exceptions."""
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

    def _navigate_to_csv_url(self, page, download_info: dict) -> None:
        """Navigate to CSV URL and handle download/content extraction with proper timeout handling."""
        self._initialize_download_info(download_info)

        try:
            self._navigate_and_check_response(page)
            self._extract_content_if_needed(page, download_info)

        except PlaywrightTimeout as timeout_error:
            # Handle Playwright timeouts specifically
            raise Exception(
                f"Navigation timeout after {CSV_TIMEOUT_MS / 1000} seconds: {timeout_error}"
            ) from timeout_error
        except Exception as e:
            self._handle_download_exception(page, e)

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
                page.set_default_timeout(Timeouts.PAGE_DEFAULT_MS)  # 30 seconds

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
                logging.debug(
                    f"CSV row validation failed - missing fields. URL: {url}, Modified Date: {modified_date_str}, Action: {action}"
                )
                return None

            # Comprehensive URL validation
            if not url.startswith(("http://", "https://")):
                logging.warning(f"Skipping invalid URL scheme: {url}")
                return None

            # Prevent path traversal and injection attacks
            if (
                ".." in url
                or "\x00" in url
                or "<script" in url.lower()
                or "javascript:" in url.lower()
            ):
                logging.warning(f"Skipping potentially malicious URL: {url}")
                raise ValueError(f"Malicious URL pattern detected: {url}")

            # Additional security checks
            parsed = urlparse(url)
            if not parsed.netloc or len(parsed.netloc) > 253:  # RFC 1035 limit
                logging.warning(f"Skipping invalid domain in URL: {url}")
                return None

            # Check for suspicious characters in domain
            if any(char in parsed.netloc for char in ["<", ">", '"', "'", "\x00"]):
                logging.warning(
                    f"Skipping URL with suspicious characters in domain: {url}"
                )
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
                logging.warning(
                    f"Could not parse modified date '{modified_date_str}' for URL {url}"
                )
                return None

            return url, modified_date, action
        except Exception as e:
            logging.warning(
                f"Exception validating CSV row for URL {row.get('URL', 'unknown')}: {e}"
            )
            return None

    @requires_db
    def _should_process_csv_url(
        self, url: str, modified_date: datetime, cutoff_date: datetime
    ) -> tuple[bool, str]:
        """Check if CSV URL should be processed. Returns (should_process, skip_reason)."""
        assert self.cursor is not None

        # Check if modified within threshold
        if modified_date < cutoff_date:
            return False, "skipped_date"

        # Ensure URL has scheme
        full_url = ensure_scheme(url)

        # Check if URL should be crawled
        if not self.is_valid_url(full_url) or self.should_skip_url(full_url):
            return False, "skipped_validation"

        # Check if URL exists in database and if last crawl is more recent than modified date
        normalized_url = self.normalize_url(full_url)
        self.cursor.execute(
            """
            SELECT last_crawl, modified_date, status 
            FROM crawl_queue 
            WHERE url = ?
            """,
            (normalized_url,),
        )
        existing = self.cursor.fetchone()

        if existing:
            last_crawl, existing_modified_date, status = existing

            # Always re-process deleted URLs (e.g. trashed then re-published)
            if status == "deleted":
                return True, ""

            # If we have a last crawl date, check if it's more recent than the modified date
            if last_crawl:
                try:
                    last_crawl_dt = datetime.fromisoformat(last_crawl)
                    # If last crawl is more recent than modified date, skip it
                    if last_crawl_dt > modified_date:
                        return False, "skipped_already_current"
                except ValueError:
                    # If we can't parse the date, proceed with processing
                    logging.warning(
                        f"  - Warning: Could not parse last_crawl date: {last_crawl}"
                    )
                    pass

        return True, ""

    def _process_single_csv_row(
        self, row: dict, cutoff_date: datetime, stats: dict, pinecone_index=None
    ) -> None:
        """Process a single CSV row and update stats."""
        try:
            url = row.get("URL", "").strip()
            # Validate CSV row
            validation_result = self._validate_csv_row(row)
            if not validation_result:
                stats["skipped_validation"] = stats.get("skipped_validation", 0) + 1
                logging.debug(f"CSV row validation failed for URL: {url}")
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

    @requires_db
    def _handle_csv_removal(
        self, full_url: str, stats: dict, pinecone_index=None
    ) -> None:
        """Handle removal action for CSV row."""
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

    @requires_db
    def _handle_csv_add_update(
        self,
        full_url: str,
        row: dict,
        modified_date: datetime,
        cutoff_date: datetime,
        stats: dict,
    ) -> None:
        """Handle add/update action for CSV row."""
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

    def _log_csv_summary(self, csv_data: list[dict]) -> None:
        """Log a summary of CSV data before processing."""
        total_rows = len(csv_data)
        add_update_count = 0
        remove_count = 0
        invalid_action_count = 0

        for row in csv_data:
            action = row.get("Required Action", "").strip().lower()
            if action == "add/update":
                add_update_count += 1
            elif action == "remove":
                remove_count += 1
            elif action:  # Has an action but it's not recognized
                invalid_action_count += 1

        logging.info(
            f"CSV summary: {total_rows} total rows - "
            f"{add_update_count} add/update, {remove_count} remove"
            + (
                f", {invalid_action_count} invalid/unknown"
                if invalid_action_count
                else ""
            )
        )

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

        # Log results with bullet points for readability
        if messages:
            logging.info("CSV processing results:")
            for message in messages:
                logging.info(f"  - {message}")
        else:
            logging.info("CSV processing results: No URLs processed")

        if total_processed > 0:
            logging.info(f"Total URLs ready for processing: {total_processed}")

    @requires_db
    def process_csv_data(self, csv_data: list[dict], pinecone_index=None) -> int:
        """Process CSV data and add modified URLs to queue with high priority"""
        assert self.conn is not None
        if not csv_data:
            logging.info("CSV processing: No rows to process")
            return 0

        # Log CSV summary before processing
        self._log_csv_summary(csv_data)

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

    @requires_db
    def update_csv_tracking(self, csv_error: str | None = None, success: bool = False):
        """Update CSV tracking table with latest status and timestamp"""
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

    @requires_db
    def should_check_csv(self) -> bool:
        """Check if CSV should be processed with cooldown period to prevent frequent downloads"""
        assert self.cursor is not None
        if not self.csv_mode_enabled:
            return False

        # Only check CSV if initial crawl is completed (unless force_csv_mode bypasses this)
        if not self.is_initial_crawl_completed():
            if self.force_csv_mode:
                logging.debug(
                    "--force-csv-mode: Bypassing initial crawl completion check"
                )
            else:
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

                # Minimum 30 minutes between CSV checks (unless force_csv_mode is enabled and not yet used)
                if time_since_last_check.total_seconds() < 30 * 60:
                    if self.force_csv_mode and not self._csv_force_used:
                        logging.info(
                            f"CSV cooldown bypassed once (--force-csv-mode): {time_since_last_check.total_seconds():.0f}s since last check"
                        )
                        self._csv_force_used = True  # Only bypass once per session
                    else:
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

    @requires_db
    def mark_initial_crawl_completed(self, _retried: bool = False) -> bool:
        """Mark that the initial full crawl has been completed"""
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
            return True

        except Exception as e:
            if self._is_locking_protocol_error(e):
                if not _retried and self.recover_database_connection():
                    logging.warning(
                        "Retrying mark_initial_crawl_completed after lock recovery"
                    )
                    return self.mark_initial_crawl_completed(_retried=True)
                self.mark_db_recovery_failed(
                    f"mark_initial_crawl_completed failed after recovery attempt: {e}"
                )
            logging.error(f"Error marking initial crawl completed: {e}")
            return False

    @requires_db
    def is_initial_crawl_completed(self, _retried: bool = False) -> bool:
        """Check if initial crawl has been completed"""
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
            if self._is_locking_protocol_error(e):
                if not _retried and self.recover_database_connection():
                    logging.warning(
                        "Retrying is_initial_crawl_completed after lock recovery"
                    )
                    return self.is_initial_crawl_completed(_retried=True)
                self.mark_db_recovery_failed(
                    f"is_initial_crawl_completed failed after recovery attempt: {e}"
                )
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

    def _cleanup_old_timeout_counts(self, max_entries: int | None = None) -> None:
        """Remove oldest entries if dict exceeds max size to prevent memory leak.

        Uses LRU-style cleanup: removes entries with lowest timeout counts first,
        then by random selection if counts are equal.
        """
        if max_entries is None:
            max_entries = self.MAX_TIMEOUT_COUNTS_ENTRIES

        current_time = time.time()
        # Check for cleanup every time this is called if size exceeds limit
        # OR every 5 minutes regardless of size (to prevent buildup)
        should_cleanup = (
            len(self.session_timeout_counts) > max_entries
            or current_time - self._last_cleanup_check > 300
        )

        if should_cleanup and self.session_timeout_counts:
            original_size = len(self.session_timeout_counts)

            if len(self.session_timeout_counts) > max_entries:
                # Remove excess entries using LRU-like strategy
                # Sort by timeout count (ascending), then by URL for determinism
                sorted_entries = sorted(
                    self.session_timeout_counts.items(),
                    key=lambda x: (
                        x[1],
                        x[0],
                    ),  # (timeout_count, url) - lowest counts first
                )

                # Keep only the most recent entries (highest timeout counts)
                # But ensure we keep at least some minimum number
                keep_count = min(max_entries, max(100, len(sorted_entries) // 2))

                # Get URLs to keep (highest timeout counts = most recent activity)
                urls_to_keep = {url for url, _ in sorted_entries[-keep_count:]}

                # Remove URLs not in the keep set
                urls_to_remove = [
                    url
                    for url in self.session_timeout_counts
                    if url not in urls_to_keep
                ]

                for url in urls_to_remove:
                    del self.session_timeout_counts[url]

                removed_count = len(urls_to_remove)
                self._total_timeouts_tracked -= sum(
                    self.session_timeout_counts.get(url, 0) for url in urls_to_remove
                )
                logging.info(
                    f"Cleaned up {removed_count} old timeout count entries "
                    f"({original_size} → {len(self.session_timeout_counts)} entries, "
                    f"tracking {self._total_timeouts_tracked} total timeouts)"
                )
            else:
                # Periodic cleanup even when under limit - remove entries with count = 0
                # These are URLs that previously timed out but have since been processed successfully
                zero_count_urls = [
                    url
                    for url, count in self.session_timeout_counts.items()
                    if count == 0
                ]
                for url in zero_count_urls:
                    del self.session_timeout_counts[url]

                if zero_count_urls:
                    logging.debug(
                        f"Periodic cleanup: removed {len(zero_count_urls)} entries with zero timeout count"
                    )

            # Periodic stats logging every 10 cleanups
            if hasattr(self, "_cleanup_count"):
                self._cleanup_count = getattr(self, "_cleanup_count", 0) + 1
            else:
                self._cleanup_count = 1

            if self._cleanup_count % 10 == 0:
                stats = self.get_timeout_stats()
                logging.info(
                    f"Timeout tracking stats: {stats['total_entries']} URLs, "
                    f"{stats['total_timeouts']} timeouts, max {stats['max_timeouts']} per URL"
                )

            self._last_cleanup_check = current_time

    def reset_timeout_count(self, url: str) -> None:
        """Reset timeout count for a URL when it's successfully processed."""
        normalized_url = self.normalize_url(url)
        if normalized_url in self.session_timeout_counts:
            old_count = self.session_timeout_counts[normalized_url]
            if old_count > 0:
                self.session_timeout_counts[normalized_url] = (
                    0  # Mark as successfully processed
                )
                logging.debug(f"Reset timeout count for {url}: {old_count} → 0")

    def get_timeout_stats(self) -> dict:
        """Get statistics about timeout tracking for monitoring."""
        if not self.session_timeout_counts:
            return {"total_entries": 0, "total_timeouts": 0, "max_timeouts": 0}

        counts = list(self.session_timeout_counts.values())
        return {
            "total_entries": len(self.session_timeout_counts),
            "total_timeouts": sum(counts),
            "max_timeouts": max(counts),
            "avg_timeouts": sum(counts) / len(counts) if counts else 0,
            "zero_count_entries": sum(1 for c in counts if c == 0),
        }

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


if __name__ == "__main__":
    # Import CLI module here to avoid circular import
    try:
        from .cli import main
    except ImportError:
        from cli import main  # type: ignore[import-not-found]

    main()
