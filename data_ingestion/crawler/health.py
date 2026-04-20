"""Health monitoring and system resource checks for the website crawler."""

import logging
import threading
import time

# Optional imports (may not be available in all environments)
try:
    import psutil
except ImportError:
    psutil = None

# Import from crawler submodules (support both module and direct execution)
try:
    from .config import HEALTH_CHECK_INTERVAL, HEALTH_WEDGE_TIMEOUT
except ImportError:
    from config import (  # type: ignore[import-not-found]
        HEALTH_CHECK_INTERVAL,
        HEALTH_WEDGE_TIMEOUT,
    )


class HealthMonitor:
    """Monitors crawler health and triggers restarts if wedged."""

    def __init__(self, crawler):
        self.crawler = crawler
        self.last_progress_time = time.time()
        self.browser = None
        self.page = None
        self._shutdown_requested = threading.Event()

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

                # Trigger graceful shutdown before the kernel starts thrashing.
                # Sized for a 2 GB host: by the time we hit ~1.65 GB used /
                # 350 MB free, swap pressure is imminent and sshd/systemd
                # responsiveness is at risk. earlyoom is the hard backstop.
                if memory.percent > 90 or available_gb < 0.35:
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

    def request_shutdown(self):
        """Request graceful shutdown from main thread."""
        self._shutdown_requested.set()

    def is_shutdown_requested(self) -> bool:
        """Check if shutdown has been requested."""
        return self._shutdown_requested.is_set()

    def start_monitoring(self):
        """Start the health monitoring thread."""

        def monitor_loop():
            while True:
                time.sleep(HEALTH_CHECK_INTERVAL)
                if not self.check_health():
                    logging.error("Health check failed - requesting graceful shutdown")
                    self.request_shutdown()
                    return  # Exit the monitoring thread

        thread = threading.Thread(target=monitor_loop, daemon=True)
        thread.start()
        logging.info("Health monitoring started")


def _check_memory_health() -> list[str]:
    """Check memory health and return list of issues."""
    issues = []
    if psutil is None:
        return issues

    memory = psutil.virtual_memory()

    # Be more lenient for bounded execution - only flag critical issues that prevent operation
    # For bounded execution (45-min runs), we can tolerate higher memory usage since we'll exit soon
    available_gb = memory.available / 1024**3

    if memory.percent > 90:
        issues.append(
            f"Critical memory usage: {memory.percent:.1f}% used ({available_gb:.1f}GB available)"
        )
    elif available_gb < 0.35:
        issues.append(f"Critically low memory available: {available_gb:.1f}GB")

    return issues


def _check_disk_health() -> list[str]:
    """Check disk space health and return list of issues."""
    issues = []
    if psutil is None:
        return issues

    disk = psutil.disk_usage("/")
    if disk.percent > 90:
        issues.append(
            f"Low disk space: {disk.percent}% used ({disk.free / 1024**3:.1f}GB free)"
        )
    elif disk.free < 5 * 1024**3:  # Less than 5GB free
        issues.append(f"Very low disk space: {disk.free / 1024**3:.1f}GB free")
    return issues


def _check_firefox_processes() -> list[str]:
    """Check for orphaned Firefox processes and return list of issues."""
    issues = []
    if psutil is None:
        return issues

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
    return issues


def _check_cpu_health() -> list[str]:
    """Check CPU usage and return list of issues."""
    issues = []
    if psutil is None:
        return issues

    cpu_percent = psutil.cpu_percent(interval=1)
    if cpu_percent > 80:
        issues.append(f"High CPU usage: {cpu_percent}%")
    return issues


def _check_system_health() -> tuple[bool, list[str]]:
    """Perform comprehensive system health check before starting crawler.
    Returns (is_healthy, list_of_issues)."""
    issues = []

    if psutil is None:
        return True, []  # Skip health checks if psutil not available

    try:
        issues.extend(_check_memory_health())
        issues.extend(_check_disk_health())
        issues.extend(_check_firefox_processes())
        issues.extend(_check_cpu_health())

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

    except Exception as e:
        logging.warning(f"Error logging system resources: {e}")
