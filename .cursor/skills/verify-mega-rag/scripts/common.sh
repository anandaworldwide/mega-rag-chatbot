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

# Synthetic id for logged-out gate probes. Not a real Firestore document.
VERIFY_SHARE_PROBE_ID="logged-out-share-probe"

# HTTP status only. Do not follow redirects. Do not save the body.
http_status() {
  local url="${1:-}"
  [[ -n "$url" ]] || {
    echo "000"
    return 1
  }
  assert_not_production_url "$url"
  curl -sS -o /dev/null -w '%{http_code}' --max-time 30 "$url" || echo "000"
}

# Probe Luca cookie-gated APIs and the public share API. No response bodies.
# Sets LUCA_CHATS_CODE, LUCA_DOCUMENT_CODE, LUCA_SHARE_API_CODE.
probe_luca_logged_out_apis() {
  local base="${1:-}"
  local doc_id="${2:-$VERIFY_SHARE_PROBE_ID}"
  [[ -n "$base" ]] || die "probe_luca_logged_out_apis needs a base URL."
  assert_not_production_url "$base"
  LUCA_CHATS_CODE="$(http_status "$base/api/chats")"
  LUCA_DOCUMENT_CODE="$(http_status "$base/api/document/${doc_id}")"
  LUCA_SHARE_API_CODE="$(http_status "$base/api/share/${doc_id}")"
}

# Read share JSON from stdin. Print key names only. Exit 0 when the
# top-level keys are exactly id, title, turns and no uuid/email/ip keys exist.
summarize_share_json() {
  python3 "$VERIFY_SKILL_DIR/scripts/summarize-share-json.py"
}
