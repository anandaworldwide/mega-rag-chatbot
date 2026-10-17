#!/usr/bin/env bash
# Stop only the server this skill started. Keep evidence.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

ensure_evidence_root
if [[ ! -f "$VERIFY_CURRENT_DIR/run_id" ]]; then
  log "Nothing to clean. No current run pointer."
  exit 0
fi

load_current
assert_not_production_url "${VERIFY_BASE_URL:-http://127.0.0.1:${VERIFY_PORT:-3000}}"

if [[ -z "${VERIFY_PID:-}" ]]; then
  log "No PID recorded. Evidence stays at $VERIFY_RUN_DIR"
  exit 0
fi

if ! pid_is_alive "$VERIFY_PID"; then
  log "PID $VERIFY_PID is already gone. Evidence stays at $VERIFY_RUN_DIR"
  date -u +"%Y-%m-%dT%H:%M:%SZ" >"$VERIFY_RUN_DIR/cleaned_at"
  exit 0
fi

log "Stopping PID $VERIFY_PID with SIGTERM"
kill -TERM "$VERIFY_PID" 2>/dev/null || true

for _ in $(seq 1 20); do
  if ! pid_is_alive "$VERIFY_PID"; then
    break
  fi
  sleep 1
done

if pid_is_alive "$VERIFY_PID"; then
  log "PID $VERIFY_PID still alive. Sending SIGKILL."
  kill -KILL "$VERIFY_PID" 2>/dev/null || true
  sleep 1
fi

if pid_is_alive "$VERIFY_PID"; then
  die "Failed to stop PID $VERIFY_PID. Not killing by process name."
fi

date -u +"%Y-%m-%dT%H:%M:%SZ" >"$VERIFY_RUN_DIR/cleaned_at"
log "Stopped PID $VERIFY_PID."
log "Evidence remains at $VERIFY_RUN_DIR"
