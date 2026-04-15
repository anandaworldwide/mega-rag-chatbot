# Crawler production deployment (dedicated VM)

Production crawling runs on a **single dedicated Linux host** (for example AWS Lightsail with a static IP), not on AWS
ECS/Fargate. The crawler stays **containerized** (same `Dockerfile`), uses **`DATA_DIR`** on persistent disk for SQLite,
locks, and logs, and uses **bounded runs** (`--max-runtime-minutes`) triggered by **systemd** (timer + oneshot service).

For local development on macOS (LaunchAgent / `manage_crawler.sh`), see [README.md](README.md) and
[DAEMON_MANAGEMENT.md](DAEMON_MANAGEMENT.md).

## Critical rule: one writer

Never run two crawlers against the same site database at the same time (for example production VM plus a local laptop,
or two VMs). That duplicates work and risks SQLite corruption.

## Architecture (production)

- **Compute**: One Linux VM (Lightsail or equivalent) with Docker
- **Image**: Build from [Dockerfile](Dockerfile) (context is `data_ingestion/` — see Dockerfile comments)
- **State**: Host directory mounted at container `DATA_DIR` (for example `/srv/ananda-crawler` → `/app/data` in
  container)
- **Secrets**: Host file (for example `/srv/ananda-crawler/env/.env.ananda-public`) passed with `docker run --env-file`
- **Schedule**: `systemd` timer invoking a oneshot service that runs `docker run --rm ... website_crawler.py` with
  `--max-runtime-minutes` and `--non-interactive`
- **Daily report**: Separate timer or cron on the same host running `daily_report.py` inside the same image (or a venv
  with crawler deps). CloudWatch log scraping in `daily_report.py` is optional; queue/email sections work without AWS
  log APIs if credentials are not present.

## Host layout (example)

```text
/srv/ananda-crawler/
  db/           # crawler_queue_<site>.db
  logs/
  env/          # chmod 700; .env.<site> files for --env-file
  backups/      # optional dated copies of the DB
```

## Build the image on the server

From a clone of this repo on the VM:

```bash
cd mega-rag-chatbot/data_ingestion/crawler
docker build -t ananda-crawler:latest -f Dockerfile ../..
```

Match the site’s `.env.<site>` on the host and pass it into the container.

## Manual test run

```bash
docker run --rm \
  --name ananda-crawler-test \
  -e DATA_DIR=/app/data \
  --env-file /srv/ananda-crawler/env/.env.ananda-public \
  -v /srv/ananda-crawler:/app/data \
  ananda-crawler:latest \
  python /app/crawler/website_crawler.py --site ananda-public --max-runtime-minutes 10 --non-interactive
```

Confirm Playwright/Firefox starts, the DB path under `db/`, and outbound HTTPS to the crawl target.

## systemd (sketch)

**Service** (`ananda-crawler.service`): `Type=oneshot`, `ExecStart=` = `docker run --rm` with `-e DATA_DIR=/app/data`,
`-v /srv/ananda-crawler:/app/data`, `--env-file`, image `ananda-crawler:latest`, and the same `python ... website_crawler.py`
arguments as production (including `--non-interactive`).

**Timer** (`ananda-crawler.timer`): `OnCalendar=` for the desired PT window (for example hourly between 07:00 and 22:00
local), `Persistent=true`.

After edits: `sudo systemctl daemon-reload`, `sudo systemctl enable --now ananda-crawler.timer`, check with
`systemctl list-timers`.

## Deploy after code changes

On the VM: `git pull` in the repo, rebuild the image, then run the crawler service once or wait for the timer. No ECR or
ECS task definition steps.

## Switching between production VM and local

1. **Stop the production writer** (disable the systemd timer and stop any running `docker run` crawler on the VM).
2. Copy the SQLite file from the VM to your machine (for example `scp`), into the path your local `DATA_DIR` or default
   dev layout expects.
3. Run local daemon only while debugging; do not re-enable the VM timer until you are finished.
4. **Copy the database back** and re-enable the VM schedule, or restore from a VM backup if local was only for read-only
   tests.

## Retiring legacy AWS (Fargate / EFS / EventBridge)

The following existed only for the old scheduled ECS path. After you confirm Lightsail (or replacement) has been stable,
remove them in the AWS account (order may vary with your setup).

**Account**: Use the correct AWS CLI profile (for example `--profile ananda`). The default profile may point at a
different personal account, so always confirm with `aws sts get-caller-identity --profile <profile>`.

1. Disable or delete **EventBridge Scheduler** schedules for the crawler (and any separate daily-report schedule tied to
   ECS).
2. Remove any legacy **EventBridge Rules** on the default bus that still target the crawler ECS cluster (for example a
   daily cron rule created before Scheduler); delete targets first, then the rule.
3. Stop **ECS tasks** and delete the **ECS service** (if any), then delete the **cluster**, then **deregister** and
   **delete** inactive **task definition** revisions for the crawler family.
4. Delete the **EFS** file system (access points, then mount targets, then the file system) used for crawler state once
   you have a final backup on the VM. Remove any **EFS-only security groups** left behind.
5. Optionally delete the **ECR** repository if you no longer pull images from AWS.
6. Remove **Secrets Manager** secrets and **IAM roles/policies** created solely for the crawler task or EventBridge
   `RunTask` role. Keep shared roles like `ecsTaskExecutionRole` if other workloads use them; drop only crawler-specific
   inline or customer-managed policies.
7. Delete **CloudWatch log groups**: `/ecs/ananda-crawler` and, if enabled, `/aws/ecs/containerinsights/<cluster>/performance`.
8. Empty and delete the **S3** scratch bucket if one was created for crawler temp files (for example `ananda-crawler-temp-<account-id>`).

Git history still contains the old shell scripts if you need to reconstruct anything.

## Related files

- [Dockerfile](Dockerfile)
- [website_crawler.py](website_crawler.py) — queue DB path under `DATA_DIR`
- [lock_manager.py](lock_manager.py) — lock file under `DATA_DIR`
- [crawler_supervisor.py](crawler_supervisor.py) — optional bounded supervisor pattern
- [daily_report.py](daily_report.py) — email report; CloudWatch section is optional off AWS
