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
