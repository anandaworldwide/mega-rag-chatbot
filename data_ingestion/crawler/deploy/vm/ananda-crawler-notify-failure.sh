#!/usr/bin/env bash
# Send an ops email when the crawler oneshot systemd unit fails (OnFailure hook).
# Requires: docker, ananda-crawler image, env file with vars used by pyutil.email_ops.

set -euo pipefail

DATA_ROOT="${DATA_ROOT:-/srv/ananda-crawler}"
SITE="${SITE:-ananda-public}"
IMAGE="${CRAWLER_IMAGE:-ananda-crawler:latest}"
ENV_FILE="${ENV_FILE:-${DATA_ROOT}/env/.env.${SITE}}"

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing env file: ${ENV_FILE}" >&2
  exit 1
fi

/usr/bin/docker run --rm \
  -e DATA_DIR=/app/data \
  -e SITE_ID="${SITE}" \
  --env-file "${ENV_FILE}" \
  -v "${DATA_ROOT}:/app/data" \
  "${IMAGE}" \
  /app/.venv/bin/python /app/crawler/notify_systemd_failure.py
