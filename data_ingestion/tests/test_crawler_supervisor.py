import os
import subprocess
from unittest.mock import MagicMock, patch


def test_monitor_crawler_health_kills_on_no_output_timeout():
    """
    If the crawler produces no output for OUTPUT_TIMEOUT, the supervisor should treat it as wedged and kill it.
    """
    from crawler.crawler_supervisor import CrawlerSupervisor

    supervisor = CrawlerSupervisor.__new__(CrawlerSupervisor)
    supervisor.logger = MagicMock()
    supervisor._force_kill_process = MagicMock()
    supervisor._update_last_output_time = MagicMock()
    supervisor._check_health_failure_in_log = MagicMock(return_value=False)
    supervisor._check_shutdown_timeout = MagicMock(return_value=False)

    process = MagicMock(spec=subprocess.Popen)
    process.poll.return_value = None

    start_time = 1000.0

    # First loop iteration sleeps, then reads time; ensure we're beyond OUTPUT_TIMEOUT (600s).
    with (
        patch("crawler.crawler_supervisor.time.sleep", return_value=None),
        patch("crawler.crawler_supervisor.time.time", return_value=start_time + 601.0),
    ):
        supervisor._monitor_crawler_health(process, MagicMock(), start_time)

    supervisor._force_kill_process.assert_called_once_with(process)


def test_update_last_output_time_ignores_stale_log_history(tmp_path):
    """Leftover lines from a prior run must not look like live output."""
    from crawler.crawler_supervisor import CrawlerSupervisor

    supervisor = CrawlerSupervisor.__new__(CrawlerSupervisor)
    supervisor.logger = MagicMock()
    crawler_log = tmp_path / "crawler.log"
    crawler_log.write_text("old line from previous run\n" * 20)
    old_mtime = 1_000.0
    os.utime(crawler_log, (old_mtime, old_mtime))

    last_output_time = 2_000.0
    current_time = 2_601.0
    result = supervisor._update_last_output_time(crawler_log, current_time, last_output_time)
    assert result == last_output_time


def test_update_last_output_time_advances_when_log_is_newer(tmp_path):
    from crawler.crawler_supervisor import CrawlerSupervisor

    supervisor = CrawlerSupervisor.__new__(CrawlerSupervisor)
    supervisor.logger = MagicMock()
    crawler_log = tmp_path / "crawler.log"
    crawler_log.write_text("fresh output\n")
    fresh_mtime = 2_500.0
    os.utime(crawler_log, (fresh_mtime, fresh_mtime))

    result = supervisor._update_last_output_time(crawler_log, 2_601.0, 2_000.0)
    assert result == fresh_mtime
