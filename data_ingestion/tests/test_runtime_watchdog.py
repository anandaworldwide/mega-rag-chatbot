"""Tests for the crawler runtime and shutdown watchdog."""

import os
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

from crawler.runtime_watchdog import (
    EXIT_RUNTIME_TIMEOUT,
    EXIT_SHUTDOWN_TIMEOUT,
    RuntimeWatchdog,
)

_HANG_CHILD_ARG = "hang-child"


def _run_hanging_robots_child() -> None:
    """Arm the real watchdog, then block on a robots.txt fetch that never answers."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("127.0.0.1", 0))
    sock.listen(1)
    port = sock.getsockname()[1]

    def _accept_and_hold() -> None:
        try:
            conn, _addr = sock.accept()
            time.sleep(120)
            conn.close()
        except OSError:
            pass

    threading.Thread(target=_accept_and_hold, daemon=True).start()
    watchdog = RuntimeWatchdog()
    watchdog.start(
        max_runtime_seconds=1,
        runtime_grace_seconds=1,
        shutdown_grace_seconds=30,
    )
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{port}/robots.txt")
    except Exception:
        raise SystemExit(99) from None
    raise SystemExit(99)


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


def test_watchdog_force_exits_real_process_hung_on_robots():
    repo_root = Path(__file__).resolve().parents[2]
    env = os.environ.copy()
    python_path = os.pathsep.join(
        [str(repo_root), str(repo_root / "data_ingestion"), env.get("PYTHONPATH", "")]
    )
    env["PYTHONPATH"] = python_path
    result = subprocess.run(
        [sys.executable, str(Path(__file__).resolve()), _HANG_CHILD_ARG],
        cwd=str(repo_root),
        env=env,
        timeout=15,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode in (EXIT_RUNTIME_TIMEOUT, EXIT_SHUTDOWN_TIMEOUT), (
        f"returncode={result.returncode} stdout={result.stdout!r} stderr={result.stderr!r}"
    )


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == _HANG_CHILD_ARG:
        _run_hanging_robots_child()
    else:
        raise SystemExit(f"usage: {Path(__file__).name} {_HANG_CHILD_ARG}")
