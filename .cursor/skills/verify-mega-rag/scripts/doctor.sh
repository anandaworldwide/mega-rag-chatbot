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

fail_line() {
  echo "FAIL $*" | tee -a "$REPORT" >&2
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
  home_probe="$VERIFY_RUN_DIR/doctor.home.probe.json"
  node "$SCRIPT_DIR/page-probe.mjs" "$VERIFY_BASE_URL/" >"$home_probe"
  home_status="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("status"))' "$home_probe")"
  home_loc="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("location") or "")' "$home_probe")"
  home_login="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("locationIsLogin"))' "$home_probe")"
  home_csp="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("middlewareCsp"))' "$home_probe")"
  info "GET / -> $home_status location=${home_loc:-none} locationIsLogin=$home_login"
  luca_gate=0
  if [[ "$login_csp" == "True" || "$login_csp" == "true" ]]; then
    pass "middleware-csp /login"
  else
    fail_line "Luca /login missing Content-Security-Policy. Request proxy is not applying."
    luca_gate=1
  fi
  if [[ "$home_csp" == "True" || "$home_csp" == "true" ]]; then
    pass "middleware-csp /"
  else
    fail_line "Luca / missing Content-Security-Policy. Request proxy is not applying."
    luca_gate=1
  fi
  if [[ "$home_status" =~ ^30[1278]$ && ( "$home_login" == "True" || "$home_login" == "true" ) ]]; then
    pass "luca-home-redirects-to-login"
  else
    fail_line "Luca logged-out / must redirect to /login. Got HTTP $home_status location=${home_loc:-none}."
    luca_gate=1
  fi
  if [[ "$luca_gate" != "0" ]]; then
    fail "Luca requireLogin gate failed. Doctor must not treat AuthGuard as enough."
  fi
  # Request proxy (web/src/proxy.ts) is the cookie gate. Public /api/share/.
  # Cookie-gated /api/chats and /api/document/ on requireLogin sites.
  probe_luca_logged_out_apis "$VERIFY_BASE_URL" "$VERIFY_SHARE_PROBE_ID"
  info "GET /api/chats -> $LUCA_CHATS_CODE"
  info "GET /api/document/$VERIFY_SHARE_PROBE_ID -> $LUCA_DOCUMENT_CODE"
  info "GET /api/share/$VERIFY_SHARE_PROBE_ID -> $LUCA_SHARE_API_CODE"
  [[ "$LUCA_CHATS_CODE" == "401" ]] || \
    fail "Logged-out GET /api/chats must be 401 on Luca. Got $LUCA_CHATS_CODE."
  pass "luca-logged-out-chats-401"
  [[ "$LUCA_DOCUMENT_CODE" == "401" ]] || \
    fail "Logged-out GET /api/document/ must be 401 on Luca. Got $LUCA_DOCUMENT_CODE."
  pass "luca-logged-out-document-401"
  if [[ "$LUCA_SHARE_API_CODE" == "401" || "$LUCA_SHARE_API_CODE" == "307" || "$LUCA_SHARE_API_CODE" == "308" ]]; then
    fail "Logged-out GET /api/share/ must not be cookie-gated. Got $LUCA_SHARE_API_CODE."
  fi
  pass "luca-logged-out-share-api-public"
  share_probe="$VERIFY_RUN_DIR/doctor.share.probe.json"
  node "$SCRIPT_DIR/page-probe.mjs" "$VERIFY_BASE_URL/share/$VERIFY_SHARE_PROBE_ID" >"$share_probe"
  share_status="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("status"))' "$share_probe")"
  share_loc="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("location") or "")' "$share_probe")"
  share_login="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("locationIsLogin"))' "$share_probe")"
  info "GET /share/$VERIFY_SHARE_PROBE_ID -> $share_status location=${share_loc:-none} locationIsLogin=$share_login"
  if [[ "$share_status" == "401" || "$share_login" == "True" || "$share_login" == "true" ]]; then
    fail "Logged-out GET /share/{id} must not go to /login. Got HTTP $share_status location=${share_loc:-none}."
  fi
  pass "luca-logged-out-share-page-public"
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
