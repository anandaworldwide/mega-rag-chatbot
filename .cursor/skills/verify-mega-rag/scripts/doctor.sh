#!/usr/bin/env bash
# Read-only check: is this verification instance worth driving?

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

require_cmd curl
ensure_evidence_root
load_current

REPORT="$VERIFY_RUN_DIR/doctor.txt"
: >"$REPORT"

pass() {
  echo "PASS $*" | tee -a "$REPORT"
}

fail() {
  echo "FAIL $*" | tee -a "$REPORT" >&2
  exit 1
}

info() {
  echo "INFO $*" | tee -a "$REPORT"
}

[[ -n "$VERIFY_PID" ]] || fail "No server PID in the current run."
pid_is_alive "$VERIFY_PID" || fail "PID $VERIFY_PID is not running."
pass "process-up pid=$VERIFY_PID"

[[ -n "$VERIFY_PORT" ]] || fail "No port recorded."
[[ -n "$VERIFY_BASE_URL" ]] || fail "No base URL recorded."
assert_not_production_url "$VERIFY_BASE_URL"
[[ "$VERIFY_BASE_URL" == "http://127.0.0.1:${VERIFY_PORT}" ]] || \
  fail "Base URL must be http://127.0.0.1:${VERIFY_PORT}."
pass "base-url=$VERIFY_BASE_URL"

if command -v ss >/dev/null 2>&1; then
  if ss -ltnp 2>/dev/null | grep -F "pid=$VERIFY_PID" | grep -Eq "127\\.0\\.0\\.1:${VERIFY_PORT}\\b"; then
    pass "port-owned-by-us 127.0.0.1:${VERIFY_PORT}"
  elif ss -ltn | grep -Eq "127\\.0\\.0\\.1:${VERIFY_PORT}\\b"; then
    pass "port-bound 127.0.0.1:${VERIFY_PORT} (ss hid pid; process still live)"
  else
    fail "127.0.0.1:${VERIFY_PORT} is not listening."
  fi
else
  info "ss not available; HTTP check is the bind proof."
fi

[[ "$VERIFY_SITE" == "ananda" || "$VERIFY_SITE" == "ananda-public" ]] || \
  fail "Unexpected site: ${VERIFY_SITE:-empty}"
pass "site=$VERIFY_SITE"

if [[ "$VERIFY_SITE" == "ananda" ]]; then
  home_code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 -D "$VERIFY_RUN_DIR/doctor.home.headers" "$VERIFY_BASE_URL/")"
  login_body="$(mktemp)"
  login_code="$(curl -sS -o "$login_body" -w '%{http_code}' --max-time 10 "$VERIFY_BASE_URL/login")"
  info "GET / -> $home_code"
  info "GET /login -> $login_code"
  [[ "$login_code" == "200" ]] || fail "Luca /login must return 200. Got $login_code."
  if ! html_has_markers id=\"email-input\" "Email Address" "Continue" <"$login_body" >>"$REPORT"; then
    rm -f "$login_body"
    fail "Luca /login is missing the email form."
  fi
  rm -f "$login_body"
  pass "luca-login-chrome"
  if [[ "$home_code" =~ ^30[1278]$ ]]; then
    pass "luca-home-redirects-to-login"
  else
    info "GET / returned $home_code (redirect to /login is expected when logged out)."
  fi
else
  home_body="$(mktemp)"
  home_code="$(curl -sS -o "$home_body" -w '%{http_code}' --max-time 10 "$VERIFY_BASE_URL/")"
  info "GET / -> $home_code"
  [[ "$home_code" == "200" ]] || fail "Vivek / must return 200. Got $home_code."
  if ! html_has_markers id=\"userInput\" landing-chat-layout "Chat message" <"$home_body" >>"$REPORT"; then
    rm -f "$home_body"
    fail "Vivek / is missing the chat input chrome."
  fi
  rm -f "$home_body"
  pass "vivek-chat-chrome"
fi

token_code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$VERIFY_BASE_URL/api/web-token")"
info "GET /api/web-token -> $token_code"
if [[ "$token_code" == "200" ]]; then
  pass "web-token-issues"
elif [[ "$token_code" == "429" ]]; then
  info "web-token rate limited; instance is up."
else
  fail "GET /api/web-token returned $token_code. Auth secret SECURE_TOKEN may be missing."
fi

info "Doctor passed. Instance is worth driving."
echo "ok" >"$VERIFY_RUN_DIR/doctor.ok"
