#!/usr/bin/env bash
# Launch the Mega RAG Chatbot web app for verification.
# Binds 127.0.0.1 only. Never points NEXT_PUBLIC_BASE_URL at production.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

SITE="$VERIFY_DEFAULT_SITE"
PORT="$VERIFY_DEFAULT_PORT"

usage() {
  cat <<'EOF'
Usage: launch.sh [--site ananda|ananda-public] [--port 3000]

Loads .env.<site> from the repo root when that file exists.
Then forces these live values:
  SITE_ID=<site>
  NEXT_PUBLIC_BASE_URL=http://127.0.0.1:<port>
  PINECONE_INDEX_NAME=ananda-2026-09-26--3-large
  OPENAI_EMBEDDINGS_MODEL=text-embedding-3-large

The process binds 127.0.0.1 only. It does not use the repo 0.0.0.0 bind.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --site)
      SITE="${2:-}"
      shift 2
      ;;
    --port)
      PORT="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "Unknown argument: $1"
      ;;
  esac
done

[[ "$SITE" == "ananda" || "$SITE" == "ananda-public" ]] || \
  die "Site must be ananda (Luca) or ananda-public (Vivek)."
[[ "$PORT" =~ ^[0-9]+$ ]] || die "Port must be a number."

require_cmd node
require_cmd npm
require_cmd curl
require_cmd python3

assert_not_production_url "${NEXT_PUBLIC_BASE_URL:-}"
ensure_evidence_root

if [[ -f "$VERIFY_CURRENT_DIR/run_id" ]]; then
  existing_pid=""
  existing_run_dir=""
  if [[ -f "$VERIFY_CURRENT_DIR/run_dir" ]]; then
    existing_run_dir="$(tr -d '[:space:]' <"$VERIFY_CURRENT_DIR/run_dir")"
  fi
  if [[ -n "$existing_run_dir" && -f "$existing_run_dir/server.pid" ]]; then
    existing_pid="$(tr -d '[:space:]' <"$existing_run_dir/server.pid")"
  fi
  if pid_is_alive "$existing_pid"; then
    die "A verification server is already running as PID $existing_pid. Clean up first."
  fi
fi

if command -v ss >/dev/null 2>&1; then
  if ss -ltn | grep -Eq "127\\.0\\.0\\.1:${PORT}\\b"; then
    die "Port $PORT is already bound on 127.0.0.1. Set VERIFY_MEGA_RAG_PORT to a free port."
  fi
fi

[[ -d "$VERIFY_REPO_ROOT/web/node_modules" ]] || \
  die "Missing web/node_modules. Run: cd web && npm ci"

RUN_ID="$(new_run_id)"
RUN_DIR="$(run_dir_for "$RUN_ID")"
mkdir -p "$RUN_DIR"
write_current_pointer "$RUN_ID"

BASE_URL="http://127.0.0.1:${PORT}"
printf '%s\n' "$SITE" >"$RUN_DIR/site"
printf '%s\n' "$PORT" >"$RUN_DIR/port"
printf '%s\n' "$BASE_URL" >"$RUN_DIR/base_url"
printf '%s\n' "dry-run-default" >"$RUN_DIR/mode"
date -u +"%Y-%m-%dT%H:%M:%SZ" >"$RUN_DIR/started_at"

ENV_FILE="$VERIFY_REPO_ROOT/.env.$SITE"
if [[ -f "$ENV_FILE" ]]; then
  printf 'present\n' >"$RUN_DIR/env_file_state"
else
  printf 'absent-using-process-env\n' >"$RUN_DIR/env_file_state"
fi

log "Starting site=$SITE port=$PORT bind=127.0.0.1"
log "Evidence run: $RUN_DIR"

# Next.js is started by a Node helper so .env JSON values stay out of the shell.
export VERIFY_LAUNCH_SITE="$SITE"
export VERIFY_LAUNCH_PORT="$PORT"
export VERIFY_LAUNCH_REPO="$VERIFY_REPO_ROOT"
export VERIFY_LAUNCH_RUN_DIR="$RUN_DIR"
export VERIFY_LAUNCH_INDEX_NAME="$VERIFY_LIVE_INDEX_NAME"
export VERIFY_LAUNCH_EMBEDDINGS_MODEL="$VERIFY_LIVE_EMBEDDINGS_MODEL"

cd "$VERIFY_REPO_ROOT/web"
node "$SCRIPT_DIR/launch.mjs"

PID="$(tr -d '[:space:]' <"$RUN_DIR/server.pid")"
pid_is_alive "$PID" || die "Launch helper did not leave a live server PID."

READY_PATH="/login"
if [[ "$SITE" == "ananda-public" ]]; then
  READY_PATH="/"
fi

log "Waiting for HTTP ready on $BASE_URL$READY_PATH"
ready=0
for _ in $(seq 1 90); do
  if ! pid_is_alive "$PID"; then
    die "Server PID $PID exited before ready. See $RUN_DIR/launch.stdout.log"
  fi
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "$BASE_URL$READY_PATH" || true)"
  if [[ "$code" == "200" ]]; then
    ready=1
    break
  fi
  sleep 2
done

[[ "$ready" == "1" ]] || die "Server did not become usable on $READY_PATH. Last HTTP ${code:-none}."

printf '%s\n' "$READY_PATH" >"$RUN_DIR/ready_path"
printf '%s\n' "200" >"$RUN_DIR/ready_http_code"
date -u +"%Y-%m-%dT%H:%M:%SZ" >"$RUN_DIR/ready_at"
log "Ready. PID=$PID URL=$BASE_URL$READY_PATH"
log "Do not copy web/tmp/dev.log into evidence. That log can contain passages."
