"""Lock management for crawler instances to prevent concurrent runs."""

import json
import logging
import os
import subprocess
import time
import uuid
from contextlib import suppress
from datetime import datetime
from pathlib import Path
from typing import Any

# Import from progress_utils for signal handling
from utils.progress_utils import signal_handler as progress_signal_handler

# Configure logging defaults (main() will override with _configure_logging()).
logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s"
)


def _get_lock_file_path(site: str) -> str:
    """Get the appropriate lock file path based on environment.ww

    Cloud mode (DATA_DIR set): Use EFS-based lock for cross-container coordination.
    Local mode: Use /tmp for single-machine PID-based locking.
    """
    data_dir = os.getenv("DATA_DIR")
    if data_dir:
        # Cloud mode: put lock file on EFS so it's visible across containers
        lock_dir = Path(data_dir)
        lock_dir.mkdir(parents=True, exist_ok=True)
        return str(lock_dir / f"crawler_{site}.lock")
    else:
        # Local mode: use /tmp (existing behavior)
        return f"/tmp/crawler_{site}.lock"


def _is_cloud_mode() -> bool:
    """Check if running in cloud mode (ECS with EFS)."""
    return bool(os.getenv("DATA_DIR"))


def _check_and_steal_stale_lock(lock_file: str, site: str) -> bool:
    """Check if existing lock is stale and remove it if so.

    Returns True if lock was stale and removed, False if lock is fresh.
    """
    # Lock timeout: if lock file hasn't been updated in this many seconds,
    # consider it stale (crashed process). Set to 5 minutes to allow for
    # long operations like Pinecone upserts.
    LOCK_TIMEOUT_SECONDS = 300

    if not os.path.exists(lock_file):
        return True  # No lock exists, safe to proceed

    try:
        with open(lock_file) as f:
            lock_data = json.load(f)

        lock_timestamp = lock_data.get("timestamp", 0)
        lock_instance = lock_data.get("instance_id", "unknown")
        lock_age_seconds = time.time() - lock_timestamp

        if lock_age_seconds < LOCK_TIMEOUT_SECONDS:
            # Lock is fresh - another instance is running
            print(
                f"Crawler for site '{site}' already running "
                f"(instance {lock_instance}, lock age: {lock_age_seconds:.0f}s), exiting"
            )
            logging.info(
                f"Crawler for site '{site}' already running "
                f"(instance {lock_instance}, lock age: {lock_age_seconds:.0f}s), exiting"
            )
            return False
        else:
            # Lock is stale - previous instance likely crashed
            print(
                f"Removing stale cloud lock (instance {lock_instance}, "
                f"age: {lock_age_seconds:.0f}s > {LOCK_TIMEOUT_SECONDS}s timeout)"
            )
            logging.warning(
                f"Removing stale cloud lock (instance {lock_instance}, "
                f"age: {lock_age_seconds:.0f}s > {LOCK_TIMEOUT_SECONDS}s timeout)"
            )
            os.remove(lock_file)
            return True

    except (json.JSONDecodeError, KeyError, TypeError) as e:
        print(f"Error reading cloud lock file, removing it: {e}")
        logging.warning(f"Error reading cloud lock file, removing it: {e}")
        with suppress(OSError):
            os.remove(lock_file)
        return True
    except OSError as e:
        print(f"Error accessing cloud lock file: {e}")
        logging.warning(f"Error accessing cloud lock file: {e}")
        return False


def _acquire_cloud_lock(lock_file: str, site: str, instance_id: str) -> bool:
    """Atomically acquire cloud lock using O_CREAT | O_EXCL.

    Returns True if lock was successfully acquired, False if another instance holds it.
    """
    try:
        # Atomically create lock file - fails if file already exists
        fd = os.open(lock_file, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        try:
            # Write lock data
            lock_data = {
                "instance_id": instance_id,
                "timestamp": time.time(),
                "pid": os.getpid(),  # For debugging, not used for detection
                "started_at": datetime.now().isoformat(),
            }
            lock_json = json.dumps(lock_data)
            os.write(fd, lock_json.encode())
            os.close(fd)
            return True
        except Exception:
            # If write fails, close fd and remove file
            os.close(fd)
            with suppress(OSError):
                os.remove(lock_file)
            raise
    except FileExistsError:
        # Lock file exists - check if it's stale
        return _check_and_steal_stale_lock(lock_file, site) and _acquire_cloud_lock(
            lock_file, site, instance_id
        )
    except OSError as e:
        logging.error(f"Error acquiring cloud lock: {e}")
        return False


def _check_cloud_lock(lock_file: str, site: str) -> bool:
    """Check for existing lock in cloud mode using timestamp-based detection.

    Returns True if another instance is actively running (lock is valid).
    Returns False if no lock exists or lock is stale.

    In cloud mode, we can't use PID checking because each container has its own
    PID namespace. Instead, we use timestamp-based detection with a heartbeat.

    DEPRECATED: Use _acquire_cloud_lock() for atomic lock acquisition instead.
    """
    # Lock timeout: if lock file hasn't been updated in this many seconds,
    # consider it stale (crashed process). Set to 5 minutes to allow for
    # long operations like Pinecone upserts.
    LOCK_TIMEOUT_SECONDS = 300

    if not os.path.exists(lock_file):
        return False

    try:
        with open(lock_file) as f:
            lock_data = json.load(f)

        lock_timestamp = lock_data.get("timestamp", 0)
        lock_instance = lock_data.get("instance_id", "unknown")
        lock_age_seconds = time.time() - lock_timestamp

        if lock_age_seconds < LOCK_TIMEOUT_SECONDS:
            # Lock is fresh - another instance is running
            print(
                f"Crawler for site '{site}' already running "
                f"(instance {lock_instance}, lock age: {lock_age_seconds:.0f}s), exiting"
            )
            logging.info(
                f"Crawler for site '{site}' already running "
                f"(instance {lock_instance}, lock age: {lock_age_seconds:.0f}s), exiting"
            )
            return True
        else:
            # Lock is stale - previous instance likely crashed
            print(
                f"Removing stale cloud lock (instance {lock_instance}, "
                f"age: {lock_age_seconds:.0f}s > {LOCK_TIMEOUT_SECONDS}s timeout)"
            )
            logging.warning(
                f"Removing stale cloud lock (instance {lock_instance}, "
                f"age: {lock_age_seconds:.0f}s > {LOCK_TIMEOUT_SECONDS}s timeout)"
            )
            os.remove(lock_file)
            return False

    except (json.JSONDecodeError, KeyError, TypeError) as e:
        print(f"Error reading cloud lock file, removing it: {e}")
        logging.warning(f"Error reading cloud lock file, removing it: {e}")
        with suppress(OSError):
            os.remove(lock_file)
        return False
    except OSError as e:
        print(f"Error accessing cloud lock file: {e}")
        logging.warning(f"Error accessing cloud lock file: {e}")
        return False


def _check_local_lock(lock_file: str, site: str) -> bool:
    """Check for existing lock in local mode using PID-based detection.

    Returns True if another instance is actively running.
    Returns False if no lock exists or process is dead.
    """
    if not os.path.exists(lock_file):
        return False

    try:
        with open(lock_file) as f:
            old_pid = int(f.read().strip())

        # Check if the PID is still running
        result = subprocess.run(
            ["ps", "-p", str(old_pid)], capture_output=True, text=True
        )
        if result.returncode == 0:
            print(f"Crawler for site '{site}' already running (PID {old_pid}), exiting")
            logging.info(
                f"Crawler for site '{site}' already running (PID {old_pid}), exiting"
            )
            return True
        else:
            print(f"Removing stale lock file from dead process (PID {old_pid})")
            logging.info(f"Removing stale lock file from dead process (PID {old_pid})")
            os.remove(lock_file)
            return False

    except (ValueError, OSError) as e:
        print(f"Error reading lock file, removing it: {e}")
        logging.warning(f"Error reading lock file, removing it: {e}")
        with suppress(OSError):
            os.remove(lock_file)
        return False


def _generate_instance_id() -> str:
    """Generate a unique instance ID for this crawler run."""
    return uuid.uuid4().hex


class CrawlerLockManager:
    """Manages crawler instance locking for both local and cloud modes.

    Encapsulates lock file path and instance ID, providing methods for:
    - Atomic lock acquisition (cloud mode with O_CREAT | O_EXCL)
    - PID-based locking (local mode)
    - Heartbeat updates for cloud mode
    - Signal-safe cleanup
    """

    def __init__(self, site: str, lock_file: str):
        """Initialize lock manager.

        Args:
            site: Site identifier for logging
            lock_file: Path to the lock file
        """
        self.site = site
        self.lock_file = lock_file
        self.instance_id: str | None = None
        self.is_cloud = _is_cloud_mode()

    def acquire(self) -> bool:
        """Acquire the lock. Returns True if successful, False otherwise."""
        if self.is_cloud:
            self.instance_id = _generate_instance_id()
            return _acquire_cloud_lock(self.lock_file, self.site, self.instance_id)
        else:
            if _check_local_lock(self.lock_file, self.site):
                return False
            # Create lock file immediately after check passes
            with open(self.lock_file, "w") as f:
                f.write(str(os.getpid()))
            return True

    def write_heartbeat(self) -> None:
        """Update cloud lock file with current timestamp (heartbeat)."""
        if self.instance_id is None:
            self.instance_id = _generate_instance_id()

        lock_data = {
            "instance_id": self.instance_id,
            "timestamp": time.time(),
            "pid": os.getpid(),  # For debugging, not used for detection
            "started_at": datetime.now().isoformat(),
        }
        with open(self.lock_file, "w") as f:
            json.dump(lock_data, f)

    def cleanup(self) -> None:
        """Remove the lock file if it exists."""
        if self.lock_file and os.path.exists(self.lock_file):
            try:
                os.remove(self.lock_file)
                logging.info(f"Lock file removed: {self.lock_file}")
            except Exception as e:
                logging.warning(f"Failed to remove lock file: {e}")

    def cleanup_silent(self) -> None:
        """Remove lock file without logging (for signal handlers)."""
        if self.lock_file and os.path.exists(self.lock_file):
            with suppress(Exception):
                os.remove(self.lock_file)

    def create_signal_handler(self):
        """Create a signal handler that cleans up the lock file before exiting."""

        def lock_cleanup_handler(signum: int, frame: Any) -> None:
            """Signal handler that removes lock file before calling original handler.

            Note: No logging here as logging is not async-signal-safe.
            """
            self.cleanup_silent()  # File ops are relatively safe
            # Call the original handler to set the exiting flag
            progress_signal_handler(signum, frame)

        return lock_cleanup_handler


# Global lock manager instance - initialized in main()
_lock_manager: CrawlerLockManager | None = None


def _write_cloud_lock(lock_file: str) -> None:
    """Write/update the cloud lock file with current timestamp.

    DEPRECATED: Use CrawlerLockManager.write_heartbeat() instead.
    Kept for backward compatibility with existing heartbeat calls.
    """
    global _lock_manager
    if _lock_manager is not None:
        _lock_manager.write_heartbeat()
    else:
        # Fallback for edge cases where lock manager isn't initialized
        lock_data = {
            "instance_id": _generate_instance_id(),
            "timestamp": time.time(),
            "pid": os.getpid(),
            "started_at": datetime.now().isoformat(),
        }
        with open(lock_file, "w") as f:
            json.dump(lock_data, f)
