"""Hard time limits for the crawler when a blocked call never returns.

--max-runtime-minutes is checked only in the crawl loop. A hang before that
loop, or inside a network call, never sees the flag. The first SIGTERM also
only sets a flag.

This watchdog uses daemon threads. Those threads still run when the main
thread is blocked. After the deadline they remove the lock and call os._exit.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from collections.abc import Callable
from contextlib import suppress

logger = logging.getLogger(__name__)

# The crawl-loop clock starts after init. Init plus the last page can exceed 60s.
# 300s keeps a healthy run from hitting os._exit(124) at a normal stop.
DEFAULT_RUNTIME_GRACE_SECONDS = 300
DEFAULT_SHUTDOWN_GRACE_SECONDS = 30
DEFAULT_POLL_SECONDS = 1.0
EXIT_RUNTIME_TIMEOUT = 124
EXIT_SHUTDOWN_TIMEOUT = 1


class RuntimeWatchdog:
    """Force-exit after max runtime, or after a shutdown grace period."""

    def __init__(
        self,
        *,
        sleep_fn: Callable[[float], None] = time.sleep,
        exit_fn: Callable[[int], None] = os._exit,
        time_fn: Callable[[], float] = time.monotonic,
        poll_seconds: float = DEFAULT_POLL_SECONDS,
    ) -> None:
        self._sleep_fn = sleep_fn
        self._exit_fn = exit_fn
        self._time_fn = time_fn
        self._poll_seconds = poll_seconds
        self._cancelled = threading.Event()
        self._shutdown_event = threading.Event()
        self._cleanup_fn: Callable[[], None] | None = None
        self._shutdown_grace_seconds = DEFAULT_SHUTDOWN_GRACE_SECONDS
        self._threads: list[threading.Thread] = []

    def set_cleanup(self, cleanup_fn: Callable[[], None] | None) -> None:
        """Set a lock cleanup function used before a forced exit."""
        self._cleanup_fn = cleanup_fn

    def start(
        self,
        max_runtime_seconds: float,
        runtime_grace_seconds: float = DEFAULT_RUNTIME_GRACE_SECONDS,
        shutdown_grace_seconds: float = DEFAULT_SHUTDOWN_GRACE_SECONDS,
    ) -> None:
        """Start the shutdown waiter. Start the runtime waiter when a limit is set."""
        self._shutdown_grace_seconds = shutdown_grace_seconds
        self._start_thread("crawler-shutdown-watchdog", self._shutdown_loop)
        if max_runtime_seconds > 0:
            deadline = self._time_fn() + max_runtime_seconds + runtime_grace_seconds
            self._start_thread(
                "crawler-runtime-watchdog",
                lambda: self._runtime_loop(deadline, max_runtime_seconds),
            )
            logger.info(
                "Runtime watchdog armed for %.0f seconds plus %.0f seconds grace.",
                max_runtime_seconds,
                runtime_grace_seconds,
            )

    def notify_shutdown(self) -> None:
        """Start the shutdown grace timer. Safe to call from a signal handler."""
        self._shutdown_event.set()

    def cancel(self) -> None:
        """Stop the watchdog on a normal exit."""
        self._cancelled.set()
        self._shutdown_event.set()

    def _start_thread(self, name: str, target: Callable[[], None]) -> None:
        thread = threading.Thread(target=target, name=name, daemon=True)
        self._threads.append(thread)
        thread.start()

    def _wait_until(self, deadline: float) -> bool:
        """Sleep until deadline. Return True when cancelled."""
        while not self._cancelled.is_set():
            remaining = deadline - self._time_fn()
            if remaining <= 0:
                return False
            self._sleep_fn(min(remaining, self._poll_seconds))
        return True

    def _runtime_loop(self, deadline: float, max_runtime_seconds: float) -> None:
        if self._wait_until(deadline):
            return
        self._force_exit(
            EXIT_RUNTIME_TIMEOUT,
            (
                f"Runtime watchdog: max runtime of {max_runtime_seconds:.0f} seconds "
                "plus grace ended. Forcing exit."
            ),
        )

    def _shutdown_loop(self) -> None:
        while not self._cancelled.is_set() and not self._shutdown_event.is_set():
            self._sleep_fn(self._poll_seconds)
        if self._cancelled.is_set():
            return
        deadline = self._time_fn() + self._shutdown_grace_seconds
        if self._wait_until(deadline):
            return
        self._force_exit(
            EXIT_SHUTDOWN_TIMEOUT,
            (
                f"Shutdown watchdog: process did not exit in "
                f"{self._shutdown_grace_seconds:.0f} seconds. Forcing exit."
            ),
        )

    def _force_exit(self, code: int, reason: str) -> None:
        logger.error(reason)
        if self._cleanup_fn is not None:
            with suppress(Exception):
                self._cleanup_fn()
        self._exit_fn(code)
