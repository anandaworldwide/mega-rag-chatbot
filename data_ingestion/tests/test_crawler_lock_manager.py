"""Tests for crawler cloud lock acquire and stale-lock steal."""

import json
import signal
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from crawler.lock_manager import (
    CLOUD_LOCK_FUTURE_SKEW_SECONDS,
    CLOUD_LOCK_TIMEOUT_SECONDS,
    CrawlerLockManager,
    _cloud_lock_is_fresh,
)
from crawler.lock_manager import (
    is_exiting as lock_manager_is_exiting,
)
from crawler.website_crawler import ROBOTS_FETCH_TIMEOUT_SECONDS, WebsiteCrawler
from utils.progress_utils import is_exiting as utils_is_exiting
from utils.progress_utils import reset_shutdown_state


@pytest.fixture
def cloud_lock(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    lock_file = str(tmp_path / "crawler_test.lock")
    return lock_file


def test_lock_manager_shares_progress_utils_with_utils_import_path():
    """lock_manager imports utils.progress_utils. The package path is a second copy."""
    import data_ingestion.utils.progress_utils as package_progress

    assert utils_is_exiting is lock_manager_is_exiting
    assert package_progress.is_exiting is not lock_manager_is_exiting


def test_main_arms_watchdog_before_lock_and_cancels_when_lock_held(
    tmp_path, monkeypatch
):
    events: list[str] = []

    class RecordingWatchdog:
        def start(self, *args, **kwargs):
            events.append("watchdog_start")

        def set_cleanup(self, cleanup_fn):
            events.append("watchdog_set_cleanup")

        def cancel(self):
            events.append("watchdog_cancel")

        def notify_shutdown(self):
            events.append("watchdog_notify")

    args = SimpleNamespace(
        site="ananda-public",
        max_runtime_minutes=45,
        debug=False,
        fresh_start=False,
        retry_failed=False,
        clear_vectors=False,
        stop_after=None,
        non_interactive=True,
        force_csv_mode=False,
    )
    monkeypatch.setenv("DATA_DIR", str(tmp_path))

    def acquire(self):
        events.append("lock_acquire")
        return False

    with (
        patch("crawler.cli.parse_arguments", return_value=args),
        patch("crawler.cli.RuntimeWatchdog", RecordingWatchdog),
        patch(
            "crawler.cli._setup_logging_and_config",
            return_value={"domain": "example.com"},
        ),
        patch(
            "crawler.cli._setup_environment_and_paths",
            return_value=("example.com", "https://example.com", str(tmp_path / ".env")),
        ),
        patch("crawler.cli._perform_system_health_check"),
        patch("crawler.cli.setup_signal_handlers"),
        patch("crawler.cli.CrawlerLockManager.acquire", acquire),
    ):
        from crawler.cli import main

        with pytest.raises(SystemExit) as exc_info:
            main()

    assert exc_info.value.code == 1
    assert events.index("watchdog_start") < events.index("lock_acquire")
    assert events.index("lock_acquire") < events.index("watchdog_cancel")


def test_fresh_cloud_lock_blocks_second_acquire(cloud_lock):
    first = CrawlerLockManager("test", cloud_lock)
    assert first.acquire() is True
    second = CrawlerLockManager("test", cloud_lock)
    assert second.acquire() is False
    first.cleanup()


def test_stale_cloud_lock_is_stolen(cloud_lock):
    first = CrawlerLockManager("test", cloud_lock)
    assert first.acquire() is True
    lock_data = json.loads(Path(cloud_lock).read_text())
    lock_data["timestamp"] = time.time() - (CLOUD_LOCK_TIMEOUT_SECONDS + 1)
    Path(cloud_lock).write_text(json.dumps(lock_data))

    second = CrawlerLockManager("test", cloud_lock)
    assert second.acquire() is True
    new_data = json.loads(Path(cloud_lock).read_text())
    assert new_data["instance_id"] == second.instance_id
    second.cleanup()


def test_corrupt_cloud_lock_is_replaced(cloud_lock):
    Path(cloud_lock).write_text("not-json")
    manager = CrawlerLockManager("test", cloud_lock)
    assert manager.acquire() is True
    data = json.loads(Path(cloud_lock).read_text())
    assert "instance_id" in data
    assert "timestamp" in data
    assert "pid" in data
    manager.cleanup()


def test_missing_cloud_lock_is_acquired(cloud_lock):
    manager = CrawlerLockManager("test", cloud_lock)
    assert manager.acquire() is True
    assert Path(cloud_lock).is_file()
    manager.cleanup()


def test_wild_future_timestamp_is_stale():
    now = 1_000_000.0
    lock_data = {
        "timestamp": now + CLOUD_LOCK_FUTURE_SKEW_SECONDS + 10,
        "instance_id": "future",
    }
    assert _cloud_lock_is_fresh(lock_data, now=now) is False


def test_small_future_skew_is_fresh():
    now = 1_000_000.0
    lock_data = {"timestamp": now + 30, "instance_id": "skew"}
    assert _cloud_lock_is_fresh(lock_data, now=now) is True


def test_first_signal_keeps_lock_second_signal_removes_it(cloud_lock):
    reset_shutdown_state()
    manager = CrawlerLockManager("test", cloud_lock)
    assert manager.acquire() is True
    first_calls = []
    handler = manager.create_signal_handler(
        on_first_signal=lambda: first_calls.append(1)
    )

    handler(signal.SIGTERM, None)
    assert Path(cloud_lock).is_file()
    assert first_calls == [1]

    with pytest.raises(SystemExit) as exc_info:
        handler(signal.SIGTERM, None)
    assert exc_info.value.code == 1
    assert not Path(cloud_lock).exists()
    reset_shutdown_state()


def test_load_robots_txt_passes_urlopen_timeout():
    seen: dict[str, object] = {}

    def fake_urlopen(req, timeout=None):
        seen["timeout"] = timeout
        seen["url"] = req.full_url
        return SimpleNamespace(read=lambda: b"User-agent: *\nDisallow:\n")

    with patch("crawler.website_crawler.urllib.request.urlopen", fake_urlopen):
        crawler = WebsiteCrawler(
            "test-site",
            {"domain": "example.com", "skip_patterns": []},
            skip_db_init=True,
            skip_robots_init=True,
        )
        crawler._load_robots_txt()

    assert seen["timeout"] == ROBOTS_FETCH_TIMEOUT_SECONDS
    assert seen["url"] == "https://example.com/robots.txt"
    assert crawler.robots_parser is not None
    crawler.close()
