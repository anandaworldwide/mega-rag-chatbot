#!/usr/bin/env bash
# Shared paths and helpers for the verify-mega-rag skill.
# Do not print secret values. Do not write library text to evidence.

set -euo pipefail

skill_dir() {
  cd "$(dirname "${BASH_SOURCE[0]}")/.."
  pwd
}

repo_root() {
  # scripts/ -> skill -> skills -> .cursor -> repo root
  cd "$(dirname "${BASH_SOURCE[0]}")/../../../.."
  pwd
}

die() {
  echo "verify-mega-rag: $*" >&2
  exit 1
}

VERIFY_SKILL_DIR="$(skill_dir)"
VERIFY_REPO_ROOT="$(repo_root)"
[[ -f "$VERIFY_REPO_ROOT/web/package.json" ]] || \
  die "Repo root looks wrong: $VERIFY_REPO_ROOT"
VERIFY_EVIDENCE_ROOT="${VERIFY_MEGA_RAG_EVIDENCE_ROOT:-$VERIFY_REPO_ROOT/.verify-mega-rag}"
VERIFY_CURRENT_DIR="$VERIFY_EVIDENCE_ROOT/current"
VERIFY_DEFAULT_PORT="${VERIFY_MEGA_RAG_PORT:-3000}"
VERIFY_DEFAULT_SITE="${VERIFY_MEGA_RAG_SITE:-ananda}"
VERIFY_LIVE_INDEX_NAME="ananda-2026-09-26--3-large"
VERIFY_LIVE_EMBEDDINGS_MODEL="text-embedding-3-large"

# Production hosts this skill must never target.
VERIFY_PROD_HOST_RE='(luca\.ananda\.org|vivek\.ananda\.org|chat\.ananda\.org|www\.ananda\.org|ananda\.org|staging\.ananda\.org|vayudev\.ananda\.org)'

log() {
  echo "verify-mega-rag: $*"
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Missing command: $1"
}

assert_not_production_url() {
  local url="${1:-}"
  if echo "$url" | grep -Eqi "$VERIFY_PROD_HOST_RE"; then
    die "Refusing production URL. Use http://127.0.0.1:<port> only."
  fi
}

ensure_evidence_root() {
  mkdir -p "$VERIFY_EVIDENCE_ROOT/runs" "$VERIFY_CURRENT_DIR"
}

new_run_id() {
  date -u +"%Y%m%dT%H%M%SZ"
}

run_dir_for() {
  echo "$VERIFY_EVIDENCE_ROOT/runs/$1"
}

write_current_pointer() {
  local run_id="$1"
  printf '%s\n' "$run_id" >"$VERIFY_CURRENT_DIR/run_id"
  printf '%s\n' "$(run_dir_for "$run_id")" >"$VERIFY_CURRENT_DIR/run_dir"
}

load_current() {
  [[ -f "$VERIFY_CURRENT_DIR/run_id" ]] || die "No current run. Launch first."
  VERIFY_RUN_ID="$(tr -d '[:space:]' <"$VERIFY_CURRENT_DIR/run_id")"
  VERIFY_RUN_DIR="$(run_dir_for "$VERIFY_RUN_ID")"
  [[ -d "$VERIFY_RUN_DIR" ]] || die "Current run directory is missing: $VERIFY_RUN_DIR"
  VERIFY_SITE="$(tr -d '[:space:]' <"$VERIFY_RUN_DIR/site" 2>/dev/null || true)"
  VERIFY_PORT="$(tr -d '[:space:]' <"$VERIFY_RUN_DIR/port" 2>/dev/null || true)"
  VERIFY_PID="$(tr -d '[:space:]' <"$VERIFY_RUN_DIR/server.pid" 2>/dev/null || true)"
  VERIFY_BASE_URL="$(tr -d '[:space:]' <"$VERIFY_RUN_DIR/base_url" 2>/dev/null || true)"
}

pid_is_alive() {
  local pid="${1:-}"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

html_has_markers() {
  # Read HTML from stdin. Exit 0 if every marker is present. Do not save HTML.
  local html
  html="$(cat)"
  local marker
  for marker in "$@"; do
    if ! printf '%s' "$html" | grep -Fq "$marker"; then
      echo "missing:$marker"
      return 1
    fi
  done
  echo "ok"
  return 0
}
