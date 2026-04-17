#!/usr/bin/env python3
"""
Send an ops email when the crawler systemd oneshot unit fails.

Intended to be run inside the crawler Docker image (same env as daily_report), e.g.:

  docker run --rm -e DATA_DIR=/app/data --env-file ... -v ... ananda-crawler:latest \\
    python /app/crawler/notify_systemd_failure.py
"""

from __future__ import annotations

import os
import sys

from pyutil.email_ops import get_site_shortname, send_ops_alert_sync


def main() -> int:
    site_id = os.environ.get("SITE_ID", "ananda-public")
    os.environ["SITE_ID"] = site_id
    short = get_site_shortname(site_id)
    subject = f"[{short}] Crawler systemd job failed"
    body = (
        "The ananda-crawler.service unit entered a failed state.\n\n"
        "On the VM, inspect:\n"
        "  sudo journalctl -u ananda-crawler.service -b -n 200 --no-pager\n"
        "  sudo systemctl status ananda-crawler.service\n"
    )
    if send_ops_alert_sync(subject=subject, message=body, error_details=None):
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
