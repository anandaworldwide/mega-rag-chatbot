"""Main crawl loop functions for processing URLs and managing crawler execution."""

import argparse
import logging
import os
import signal
import sqlite3

# Import shared utilities
import sys
import time
import traceback
from typing import TYPE_CHECKING, Any

# Third party imports
from playwright.sync_api import sync_playwright

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from utils.progress_utils import is_exiting

# Import from crawler submodules (support both module and direct execution)
try:
    # When running as a module
    from .browser import (
        _cleanup_browser_resources,
        _handle_browser_restart,
        _is_browser_healthy,
        _setup_crawler_browser,
    )
    from .health import _log_system_resources
    from .lock_manager import _is_cloud_mode, _write_cloud_lock
    from .page_processing import _process_page_content
    from .process_cleanup import _cleanup_orphaned_processes, _log_process_diagnostics
except ImportError:
    # When running directly
    from browser import (  # type: ignore[import-not-found]
        _cleanup_browser_resources,
        _handle_browser_restart,
        _is_browser_healthy,
        _setup_crawler_browser,
    )
    from health import _log_system_resources  # type: ignore[import-not-found]
    from lock_manager import (  # type: ignore[import-not-found]
        _is_cloud_mode,
        _write_cloud_lock,
    )
    from page_processing import _process_page_content  # type: ignore[import-not-found]
    from process_cleanup import (  # type: ignore[import-not-found]
        _cleanup_orphaned_processes,
        _log_process_diagnostics,
    )

# Import WebsiteCrawler for type hints only (avoid circular import)
if TYPE_CHECKING:
    try:
        from .website_crawler import WebsiteCrawler
    except ImportError:
        from website_crawler import WebsiteCrawler  # type: ignore[import-not-found]

# Configure logging defaults (main() will override with _configure_logging()).
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s"
)


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


def _handle_url_processing(
    url: str, crawler: "WebsiteCrawler", browser, page
) -> tuple[tuple, bool]:
    """Handle URL processing setup and skip checks. Returns ((content, links, restart_needed), should_skip)."""
    crawler.current_processing_url = url
    normalized_url = crawler.normalize_url(url)

    # Check if URL has timed out too many times this session
    timeout_count = crawler.session_timeout_counts.get(normalized_url, 0)
    if timeout_count >= crawler.MAX_SESSION_TIMEOUTS:
        logging.warning(
            f"Skipping {url} - timed out {timeout_count} times this session. "
            "Will retry next session."
        )
        crawler.current_processing_url = None
        return (None, [], False), True  # Skip this URL for now

    logging.info(f"Processing page: {url}")

    if crawler.should_skip_url(url):
        logging.info(f"Removing URL matching skip pattern from database: {url}")
        crawler._ensure_db_initialized()
        assert crawler.cursor is not None
        assert crawler.conn is not None
        crawler.cursor.execute(
            "DELETE FROM crawl_queue WHERE url = ?", (normalized_url,)
        )
        crawler.conn.commit()
        crawler.current_processing_url = None
        return (None, [], False), True  # Return empty results and should_skip=True

    content, new_links, restart_needed = crawler.crawl_page(browser, page, url)

    if restart_needed:
        # Track timeout for this URL in the session
        crawler.session_timeout_counts[normalized_url] = timeout_count + 1
        new_count = crawler.session_timeout_counts[normalized_url]
        logging.warning(
            f"Browser restart requested after attempting {url} "
            f"(timeout #{new_count} this session)."
        )
        # Cleanup old entries if dict grows too large
        crawler._cleanup_old_timeout_counts()
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
    crawler: "WebsiteCrawler",
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

    return pages_inc, restart_inc, False  # Continue normally


def _initialize_crawl_loop(
    args: argparse.Namespace, crawler: "WebsiteCrawler"
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
    PAGES_PER_RESTART = 100
    stop_after = args.stop_after

    if stop_after:
        logging.info(f"Will stop crawling after processing {stop_after} pages")

    stats = crawler.get_queue_stats()
    pending_ready = stats["pending"] - stats.get("pending_retry", 0)
    logging.info(
        f"Queue breakdown: {stats['pending']} pending URLs "
        f"({pending_ready} ready now, {stats.get('pending_retry', 0)} scheduled for retry), "
        f"{stats['visited']} previously visited, {stats['failed']} permanently failed"
    )

    return (
        index_name,
        pages_processed,
        pages_since_restart,
        PAGES_PER_RESTART,
        batch_results,
        batch_start_time,
    )


def _handle_initial_crawl_completion(crawler: "WebsiteCrawler") -> None:
    """Handle marking initial crawl as completed if needed.

    Initial crawl is considered complete when:
    1. No pending URLs remain, OR
    2. All pending URLs have failed at least once (retry_count >= 1)
    """
    if crawler.csv_mode_enabled and not crawler.is_initial_crawl_completed():
        stats = crawler.get_queue_stats()

        if stats["pending"] == 0:
            # No more pending URLs
            crawler.mark_initial_crawl_completed()
            logging.info(
                "Initial crawl completed (no pending URLs) - CSV mode now active"
            )
        elif crawler.all_pending_urls_have_failed():
            # All pending URLs have been tried at least once
            crawler.mark_initial_crawl_completed()
            logging.info(
                f"Initial crawl completed ({stats['pending']} pending URLs all have retries) - CSV mode now active"
            )


def _process_pinecone_deletions(crawler: "WebsiteCrawler", pinecone_index) -> int:
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
    crawler: "WebsiteCrawler", browser, pinecone_index=None
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


def _handle_no_url_processing(
    crawler: "WebsiteCrawler",
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
            # Check if db_file is None before reconnecting
            if crawler.db_file is None:
                logging.error("Database file path is None, cannot reconnect")
                raise RuntimeError("Database not properly initialized")

            # Close the old connection
            if hasattr(crawler, "conn") and crawler.conn:
                crawler.conn.close()

            # Recreate the connection with same settings as _init_database
            crawler.conn = sqlite3.connect(
                str(crawler.db_file), timeout=60.0, check_same_thread=False
            )
            crawler.conn.row_factory = sqlite3.Row
            crawler.cursor = crawler.conn.cursor()

            # Re-enable WAL mode and other PRAGMA settings after reconnect
            crawler.cursor.execute("PRAGMA journal_mode=WAL")
            crawler.cursor.execute("PRAGMA busy_timeout=60000")
            crawler.cursor.execute("PRAGMA synchronous=NORMAL")

            logging.info("Database connection refreshed successfully with WAL mode")
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
    crawler: "WebsiteCrawler",
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
    crawler: "WebsiteCrawler",
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
    if pages_processed == 0:
        return

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


def _update_cloud_heartbeat(
    lock_file: str | None, last_heartbeat_time: float, interval_seconds: int = 60
) -> float:
    """Update cloud lock heartbeat if interval has elapsed. Returns new heartbeat time."""
    if not lock_file or not _is_cloud_mode():
        return last_heartbeat_time

    current_time = time.time()
    if current_time - last_heartbeat_time >= interval_seconds:
        try:
            _write_cloud_lock(lock_file)
            logging.debug("Updated cloud lock heartbeat")
            return current_time
        except Exception as e:
            logging.warning(f"Failed to update cloud lock heartbeat: {e}")
    return last_heartbeat_time


def _check_loop_exit_conditions(
    crawler, start_time, max_runtime_seconds, args, pages_processed
) -> bool:
    """Check if main loop should exit. Returns True if should exit."""
    if crawler.health_monitor.is_shutdown_requested():
        logging.warning("Health monitor requested shutdown - exiting gracefully")
        return True
    return _check_runtime_limits(start_time, max_runtime_seconds, args, pages_processed)


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
    lock_file: str | None = None,
):
    """Run the main crawler loop and return final page count."""
    last_heartbeat_time = time.time()

    while not is_exiting():
        last_heartbeat_time = _update_cloud_heartbeat(lock_file, last_heartbeat_time)

        if _check_loop_exit_conditions(
            crawler, start_time, max_runtime_seconds, args, pages_processed
        ):
            break

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

        if rate_limit_hit_flag and _handle_rate_limit_sleep(
            start_time, max_runtime_seconds
        ):
            break

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
    crawler: "WebsiteCrawler",
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

    # If nothing is eligible, exit before launching Playwright/Firefox.
    if not crawler.peek_next_url_to_crawl():
        logging.info("No URLs ready for processing; skipping browser launch (0 pages).")
        _log_crawler_completion(start_time, 0)
        return

    with sync_playwright() as p:
        browser, page = _setup_crawler_browser(crawler, p)

        # Lock file is already created in main() after lock check
        # Just update heartbeat for cloud mode
        if lock_file and _is_cloud_mode():
            _write_cloud_lock(lock_file)

        # Check CSV once at start of each crawler run (before main loop)
        if crawler.csv_mode_enabled:
            logging.info("Checking CSV at start of crawler run...")
            csv_added = crawler.check_and_process_csv(browser, pinecone_index)
            if csv_added > 0:
                logging.info(f"CSV startup check added {csv_added} high-priority URLs")

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
                lock_file,
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
