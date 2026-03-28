"""Browser lifecycle management for the website crawler."""

import gc
import logging
import time
from contextlib import suppress

# Optional imports (may not be available in all environments)
try:
    import psutil
except ImportError:
    psutil = None

import os
import sys

# Add parent directory to path for utils imports
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from utils.progress_utils import is_exiting

# Import from crawler submodules (support both module and direct execution)
try:
    from .config import USER_AGENT, Timeouts
    from .health import _log_system_resources
    from .process_cleanup import _cleanup_orphaned_processes, _log_process_diagnostics
except ImportError:
    from config import USER_AGENT, Timeouts  # type: ignore[import-not-found]
    from health import _log_system_resources  # type: ignore[import-not-found]
    from process_cleanup import (  # type: ignore[import-not-found]
        _cleanup_orphaned_processes,
        _log_process_diagnostics,
    )


def _setup_browser_with_timeout(p, timeout_seconds: int = 120) -> tuple:
    """Setup browser with timeout to prevent indefinite hangs.

    Note: We pass a longer timeout to Playwright itself rather than
    using threading/signals to avoid conflicts with Playwright's greenlets.
    """
    # Convert seconds to milliseconds for Playwright
    timeout_ms = timeout_seconds * 1000
    return _setup_browser(p, timeout_ms=timeout_ms)


def _prepare_browser_launch(attempt: int) -> None:
    """Prepare system for browser launch with diagnostics and cleanup."""
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
        available_ratio = memory.available / memory.total if memory.total else 0
        if available_ratio < 0.25:
            logging.warning(
                f"Low memory available ({available_gb:.1f}GB, {available_ratio:.0%} free), "
                f"performing aggressive cleanup"
            )
            # More aggressive garbage collection
            gc.collect(2)  # Full collection
            time.sleep(2)  # Give OS time to reclaim memory

    # Kill any orphaned Firefox processes before launching new one
    _cleanup_orphaned_processes()

    # Always add a small delay after cleanup to let ports/resources free up
    time.sleep(3)


def _handle_retry_delay(attempt: int, max_retries: int, base_delay: int) -> None:
    """Handle retry delay with exponential backoff and diagnostics."""
    if attempt > 0:
        delay = base_delay * (2 ** (attempt - 1))  # Exponential backoff: 15s, 30s
        logging.warning(
            f"Browser launch attempt {attempt + 1}/{max_retries} failed. "
            f"Waiting {delay}s before retry..."
        )
        logging.info("System resources before retry:")
        _log_system_resources()
        _log_process_diagnostics()
        time.sleep(delay)


def _launch_browser_instance(
    p, timeout_ms: int, attempt: int, max_retries: int
) -> tuple:
    """Launch browser instance and verify responsiveness."""
    logging.info(
        f"Launching Firefox browser (timeout: {timeout_ms / 1000:.0f}s, attempt {attempt + 1}/{max_retries})..."
    )

    # Use a shorter timeout for browser launch to avoid hanging
    # The timeout_ms is for overall operation, but browser launch should be faster
    launch_timeout = min(
        Timeouts.BROWSER_LAUNCH_MS, timeout_ms
    )  # Max 30 seconds for browser launch

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
        logging.warning(f"Browser launched but failed responsiveness test: {test_e}")
        with suppress(Exception):
            browser.close()
        raise Exception(f"Browser not responsive: {test_e}") from test_e

    logging.info("Browser launched successfully and passed responsiveness test")
    return browser, page


def _handle_browser_error(
    e: Exception, attempt: int, max_retries: int, browser
) -> None:
    """Handle browser launch errors with diagnostics and cleanup."""
    error_msg = f"Browser launch attempt {attempt + 1}/{max_retries} failed: {e}"
    logging.warning(error_msg)

    # Log additional diagnostic information on failure
    error_str_lower = str(e).lower()
    if "timeout" in error_str_lower:
        logging.warning("Browser launch timed out - this may indicate:")
        logging.warning("  - Insufficient system memory or CPU resources")
        logging.warning("  - Previous browser processes not properly cleaned up")
        logging.warning("  - System under heavy load")
        _log_process_diagnostics()
    elif "connection" in error_str_lower or "closed while reading" in error_str_lower:
        logging.warning(
            "Browser connection failed - this may indicate network issues or driver instability"
        )
        # Add small delay to let network recover
        time.sleep(2)
    elif "no space left on device" in error_str_lower or "disk" in error_str_lower:
        logging.error("Disk space issue detected - browser launch cannot proceed")
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
        logging.error("2. Kill any orphaned Firefox processes: pkill -f firefox")
        logging.error("3. Update Playwright browsers: playwright install firefox")
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


def _setup_browser(p, timeout_ms: int = 60000) -> tuple:
    """Setup and return browser and page with retry logic and resource cleanup."""
    max_retries = 3
    base_delay = 15  # seconds - increased delay for better recovery
    browser = None  # Initialize for type safety

    for attempt in range(max_retries):
        try:
            _prepare_browser_launch(attempt)
            _handle_retry_delay(attempt, max_retries, base_delay)
            browser, page = _launch_browser_instance(
                p, timeout_ms, attempt, max_retries
            )
            return browser, page

        except Exception as e:
            _handle_browser_error(e, attempt, max_retries, browser)

    # Should never reach here due to exception above, but for type safety
    raise Exception("Unexpected error in browser setup")


def _handle_browser_restart(
    p,
    page,
    browser,
    pages_since_restart: int,
    batch_results: list,
    batch_start_time: float,
    crawler,
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
    if stats.get("available", True):
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
    else:
        stats_message = (
            f"\n--- Stats at {pages_since_restart} page boundary ---\n"
            f"- Processing {pages_per_minute:.1f} pages/minute (last {pages_since_restart} pages)\n"
            "- Database stats unavailable due to database access error\n"
            f"- Session success rate: {round(batch_success_rate)}% (last {batch_attempts} attempts)\n"
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
    recovery_delay = 2  # Short delay - system resources are typically fine
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
        browser, page = _setup_browser_with_timeout(
            p, timeout_seconds=Timeouts.BROWSER_SETUP_SECONDS
        )
        logging.info("Browser restarted successfully.")
        return browser, page, time.time(), []
    except Exception as restart_err:
        logging.error(
            f"Critical error: Browser restart failed completely: {restart_err}"
        )
        # Re-raise the exception to be handled by the main loop
        raise


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


def _setup_crawler_browser(crawler, p) -> tuple:
    """Set up browser and health monitoring for crawler."""
    browser, page = _setup_browser_with_timeout(p, timeout_seconds=120)
    crawler.health_monitor.set_browser(browser, page)
    crawler.health_monitor.start_monitoring()
    return browser, page
