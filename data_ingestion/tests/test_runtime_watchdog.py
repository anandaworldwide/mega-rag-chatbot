"""Tests for the crawler runtime and shutdown watchdog."""

import threading
import time

from crawler.runtime_watchdog import (
    EXIT_RUNTIME_TIMEOUT,
    EXIT_SHUTDOWN_TIMEOUT,
    RuntimeWatchdog,
)


class _FakeClock:
    def __init__(self) -> None:
        self.now = 0.0

    def time(self) -> float:
        return self.now


def _wait_for_exits(exits: list[int], timeout: float = 2.0) -> None:
    deadline = time.time() + timeout
    while not exits and time.time() < deadline:
        time.sleep(0.01)


def _make_watchdog(clock: _FakeClock, exits: list[int], gate: threading.Event):
    def sleep_fn(seconds: float) -> None:
        gate.wait(timeout=1)
        clock.now += seconds

    def exit_fn(code: int) -> None:
        exits.append(code)
        raise SystemExit(code)

    return RuntimeWatchdog(
        sleep_fn=sleep_fn,
        exit_fn=exit_fn,
        time_fn=clock.time,
        poll_seconds=1.0,
    )


def test_runtime_watchdog_force_exits_after_deadline():
    clock = _FakeClock()
    exits: list[int] = []
    gate = threading.Event()
    watchdog = _make_watchdog(clock, exits, gate)
    cleanup_called = []
    watchdog.set_cleanup(lambda: cleanup_called.append(True))

    watchdog.start(max_runtime_seconds=1, runtime_grace_seconds=1)
    gate.set()
    _wait_for_exits(exits)
    watchdog.cancel()
    for thread in watchdog._threads:
        thread.join(timeout=1)

    assert exits == [EXIT_RUNTIME_TIMEOUT]
    assert cleanup_called == [True]


def test_shutdown_watchdog_force_exits_after_grace():
    clock = _FakeClock()
    exits: list[int] = []
    gate = threading.Event()
    watchdog = _make_watchdog(clock, exits, gate)

    watchdog.start(max_runtime_seconds=0, shutdown_grace_seconds=2)
    watchdog.notify_shutdown()
    gate.set()
    _wait_for_exits(exits)
    watchdog.cancel()
    for thread in watchdog._threads:
        thread.join(timeout=1)

    assert exits == [EXIT_SHUTDOWN_TIMEOUT]


def test_watchdog_skips_runtime_thread_when_unlimited():
    clock = _FakeClock()
    exits: list[int] = []
    gate = threading.Event()
    watchdog = _make_watchdog(clock, exits, gate)

    watchdog.start(max_runtime_seconds=0)
    names = [thread.name for thread in watchdog._threads]
    watchdog.cancel()
    gate.set()
    for thread in watchdog._threads:
        thread.join(timeout=1)

    assert names == ["crawler-shutdown-watchdog"]
    assert exits == []


def test_watchdog_cancel_prevents_force_exit():
    clock = _FakeClock()
    exits: list[int] = []
    gate = threading.Event()
    watchdog = _make_watchdog(clock, exits, gate)

    watchdog.start(max_runtime_seconds=1, runtime_grace_seconds=1)
    watchdog.cancel()
    gate.set()
    for thread in watchdog._threads:
        thread.join(timeout=1)

    assert exits == []


def test_notify_shutdown_is_idempotent():
    clock = _FakeClock()
    exits: list[int] = []
    gate = threading.Event()
    watchdog = _make_watchdog(clock, exits, gate)

    watchdog.start(max_runtime_seconds=0, shutdown_grace_seconds=1)
    watchdog.notify_shutdown()
    watchdog.notify_shutdown()
    gate.set()
    _wait_for_exits(exits)
    watchdog.cancel()
    for thread in watchdog._threads:
        thread.join(timeout=1)

    assert exits == [EXIT_SHUTDOWN_TIMEOUT]
    assert exits.count(EXIT_SHUTDOWN_TIMEOUT) == 1
