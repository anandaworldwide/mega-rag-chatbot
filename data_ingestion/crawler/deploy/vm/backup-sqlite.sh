#!/usr/bin/env bash
# Backup crawler SQLite queue DB on the VM host (not inside the container).
# Uses sqlite3 ".backup" for a crash-consistent copy while the DB may be open (WAL).
#
# Usage: run from cron when the crawler is unlikely to be mid-write (e.g. 03:15 PT),
#   or stop the crawler timer briefly for a maintenance window.
#
# Environment:
#   DATA_ROOT      default /srv/ananda-crawler
#   SITE           default ananda-public
#   RETENTION_DAYS default 14 (delete older backup files in backups/)

set -euo pipefail

DATA_ROOT="${DATA_ROOT:-/srv/ananda-crawler}"
SITE="${SITE:-ananda-public}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

DB="${DATA_ROOT}/db/crawler_queue_${SITE}.db"
DEST_DIR="${DATA_ROOT}/backups"

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "sqlite3 is required (apt install sqlite3)." >&2
  exit 1
fi

mkdir -p "${DEST_DIR}"
chmod 700 "${DEST_DIR}" 2>/dev/null || true

if [[ ! -f "${DB}" ]]; then
  echo "Database not found: ${DB}" >&2
  exit 1
fi

TS="$(date +%Y%m%d-%H%M%S)"
BACKUP="${DEST_DIR}/crawler_queue_${SITE}.db.${TS}"

# "main" is the attached DB; destination path must be quoted for sqlite3 CLI
sqlite3 "${DB}" ".backup main '${BACKUP}'"
chmod 600 "${BACKUP}"

find "${DEST_DIR}" -maxdepth 1 -type f \
  -name "crawler_queue_${SITE}.db.*" \
  -mtime "+${RETENTION_DAYS}" \
  -delete

echo "Backup OK: ${BACKUP}"
