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

probe="$VERIFY_RUN_DIR/doctor.probe.json"
if [[ "$VERIFY_SITE" == "ananda" ]]; then
  node "$SCRIPT_DIR/page-probe.mjs" "$VERIFY_BASE_URL/login" >"$probe"
  login_page="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("page") or "")' "$probe")"
  login_site="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("siteId") or "")' "$probe")"
  login_req="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("requireLogin"))' "$probe")"
  login_status="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("status"))' "$probe")"
  login_chunk="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("loginChunk"))' "$probe")"
  login_csp="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("middlewareCsp"))' "$probe")"
  info "GET /login -> $login_status page=$login_page siteId=$login_site requireLogin=$login_req"
  info "login.js -> $login_chunk middlewareCsp=$login_csp"
  [[ "$login_status" == "200" ]] || fail "Luca /login must return 200. Got $login_status."
  [[ "$login_page" == "/login" ]] || fail "Luca /login payload page is $login_page."
  [[ "$login_site" == "ananda" ]] || fail "Luca /login siteId is $login_site."
  [[ "$login_req" == "True" || "$login_req" == "true" ]] || fail "Luca requireLogin is $login_req."
  [[ "$login_chunk" == "200" ]] || fail "Luca login.js chunk returned $login_chunk."
  pass "luca-login-identity"
  if [[ "$login_csp" == "True" || "$login_csp" == "true" ]]; then
    pass "middleware-csp"
  else
    info "CSP header missing. Middleware may not be running. AuthGuard still gates the UI."
  fi
  home_probe="$VERIFY_RUN_DIR/doctor.home.probe.json"
  node "$SCRIPT_DIR/page-probe.mjs" "$VERIFY_BASE_URL/" >"$home_probe"
  home_status="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("status"))' "$home_probe")"
  home_loc="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("location") or "")' "$home_probe")"
  info "GET / -> $home_status location=${home_loc:-none}"
  if [[ "$home_status" =~ ^30[1278]$ ]]; then
    pass "luca-home-redirects-to-login"
  else
    info "GET / did not redirect. Client AuthGuard sends logged-out users to /login."
  fi
else
  probe_home="$VERIFY_RUN_DIR/doctor.probe.json"
  node "$SCRIPT_DIR/page-probe.mjs" "$VERIFY_BASE_URL/" >"$probe_home"
  home_status="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("status"))' "$probe_home")"
  home_site="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("siteId") or "")' "$probe_home")"
  home_page="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("page") or "")' "$probe_home")"
  info "GET / -> $home_status page=$home_page siteId=$home_site"
  [[ "$home_status" == "200" ]] || fail "Vivek / must return 200. Got $home_status."
  [[ "$home_site" == "ananda-public" ]] || fail "Vivek siteId is $home_site."
  pass "vivek-home-identity"
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
