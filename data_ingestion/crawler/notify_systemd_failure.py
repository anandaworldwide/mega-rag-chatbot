#!/usr/bin/env python3
"""
Send an ops email when a crawler-related systemd oneshot unit fails.

Intended to be run inside the crawler Docker image (same env as daily_report), e.g.:

  docker run --rm -e DATA_DIR=/app/data --env-file ... -v ... ananda-crawler:latest \\
    python /app/crawler/notify_systemd_failure.py

Optional env:
  SYSTEMD_FAILED_UNIT — unit name for the email body (default: ananda-crawler.service)
"""

from __future__ import annotations

import os
import sys

from pyutil.email_ops import get_site_shortname, send_ops_alert_sync


def main() -> int:
    site_id = os.environ.get("SITE_ID", "ananda-public")
    os.environ["SITE_ID"] = site_id
    unit = os.environ.get("SYSTEMD_FAILED_UNIT", "ananda-crawler.service")
    short = get_site_shortname(site_id)
    subject = f"[{short}] {unit} failed"
    body = (
        f"The {unit} unit entered a failed state.\n\n"
        "On the VM, inspect:\n"
        f"  sudo journalctl -u {unit} -b -n 200 --no-pager\n"
        f"  sudo systemctl status {unit}\n"
    )
    if send_ops_alert_sync(subject=subject, message=body, error_details=None):
        return 0
    return 1


if __name__ == "__main__":
    sys.exit(main())
