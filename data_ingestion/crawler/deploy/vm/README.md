# Crawler VM (Lightsail / dedicated Linux) — install notes

Paste-ready **systemd** units and helper scripts for production: bounded Docker runs, SQLite backups, daily email report,
and failure notification (rough parity with “something failed in the cloud” alerting).

All paths below assume host layout from [CLOUD-DEPLOYMENT.md](../CLOUD-DEPLOYMENT.md):

```text
/srv/ananda-crawler/
  db/  logs/  env/  backups/
```

## One-time host setup

### Lightsail / small RAM: add swap (recommended)

Aside from **SSH keys** (key-only login, no password), production setup on a **2 GB** (or similar) Lightsail instance
needed **swap** or the host became overloaded very quickly once Docker + Playwright/Firefox + spaCy workloads ran.

Add a swapfile early (sizes are examples—tune to your bundle):

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

Optional: lower swappiness slightly if you prefer RAM first (`vm.swappiness=10` in `sysctl.d`). Reboot once to confirm
swap comes up from `/etc/fstab`.

1. Install Docker and add your admin user to the `docker` group; install **`sqlite3`** for backups (`sudo apt install sqlite3`).
2. Build the image (from repo on the VM): see `CLOUD-DEPLOYMENT.md`.
3. Install scripts to `/usr/local/bin`:

   ```bash
   sudo install -m 0755 deploy/vm/backup-sqlite.sh /usr/local/bin/ananda-crawler-backup-sqlite.sh
   sudo install -m 0755 deploy/vm/ananda-crawler-notify-failure.sh /usr/local/bin/ananda-crawler-notify-failure.sh
   ```

4. Copy systemd units and enable timers (edit files first if your paths or site differ):

   ```bash
   sudo cp deploy/vm/ananda-crawler.service /etc/systemd/system/
   sudo cp deploy/vm/ananda-crawler.timer /etc/systemd/system/
   sudo cp deploy/vm/ananda-crawler-daily-report.service /etc/systemd/system/
   sudo cp deploy/vm/ananda-crawler-daily-report.timer /etc/systemd/system/
   sudo cp deploy/vm/ananda-crawler-orphan-reconcile.service /etc/systemd/system/
   sudo cp deploy/vm/ananda-crawler-orphan-reconcile.timer /etc/systemd/system/
   sudo cp deploy/vm/ananda-crawler-backup.service /etc/systemd/system/
   sudo cp deploy/vm/ananda-crawler-backup.timer /etc/systemd/system/
   sudo cp deploy/vm/ananda-crawler-failure-notify.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now ananda-crawler.timer
   sudo systemctl enable --now ananda-crawler-daily-report.timer
   sudo systemctl enable --now ananda-crawler-orphan-reconcile.timer
   sudo systemctl enable --now ananda-crawler-backup.timer
   ```

5. **Rebuild the image** after pulling commits that add `notify_systemd_failure.py`, then `sudo systemctl start ananda-crawler.service` once to verify.

## What each unit does

| Unit / script | Role |
|---------------|------|
| `ananda-crawler.service` + `.timer` | Hourly bounded `docker run` crawl (PT window in the timer). |
| `ananda-crawler-daily-report.service` + `.timer` | Daily `daily_report.py` email (queue / activity; optional CloudWatch section unused on VM). |
| `ananda-crawler-orphan-reconcile.service` + `.timer` | Weekly `reconcile_orphaned_vectors.py --apply-if-safe --email-report` (read-only DB; auto-delete within 5% guard). |
| `ananda-crawler-backup.service` + `.timer` | Nightly `sqlite3 .backup` into `/srv/ananda-crawler/backups/`; retention via `RETENTION_DAYS` (default 14) in the script. |
| `ananda-crawler-failure-notify.service` | Started when `ananda-crawler.service` fails; runs Docker + `notify_systemd_failure.py` to send ops email. |

## Backup retention

`ananda-crawler-backup-sqlite.sh` honors:

- `DATA_ROOT` (default `/srv/ananda-crawler`)
- `SITE` (default `ananda-public`)
- `RETENTION_DAYS` (default `14`)

Override in `ananda-crawler-backup.service` with `Environment=` lines if needed.

## systemd version note

`Timezone=` in `[Timer]` requires **systemd 249+** (Ubuntu 22.04+). If your image is older, use `OnCalendar=` in UTC or set the system timezone to `America/Los_Angeles` and omit `Timezone=`.

## Operational checks

```bash
systemctl list-timers 'ananda-crawler*'
journalctl -u ananda-crawler.service -n 100 --no-pager
journalctl -u ananda-crawler-daily-report.service -n 50 --no-pager
journalctl -u ananda-crawler-orphan-reconcile.service -n 50 --no-pager
journalctl -u ananda-crawler-backup.service -n 20 --no-pager
```
