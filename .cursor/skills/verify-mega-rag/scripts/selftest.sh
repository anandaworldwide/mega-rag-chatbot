#!/usr/bin/env bash
# Offline checks for verify-mega-rag helpers. No product server. No secrets.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
export VERIFY_MEGA_RAG_EVIDENCE_ROOT="$WORK/evidence"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

require_cmd python3
require_cmd node
require_cmd curl
cleanup() {
  if [[ -n "${MOCK_PID:-}" ]] && pid_is_alive "$MOCK_PID"; then
    kill -TERM "$MOCK_PID" 2>/dev/null || true
    sleep 1
    if pid_is_alive "$MOCK_PID"; then
      kill -KILL "$MOCK_PID" 2>/dev/null || true
    fi
  fi
  if command -v trash >/dev/null 2>&1; then
    trash "$WORK" >/dev/null 2>&1 || true
  else
    rm -r "$WORK"
  fi
}
trap cleanup EXIT

pass() {
  echo "PASS $*"
}

fail() {
  echo "FAIL $*" >&2
  exit 1
}

echo '{"id":"share-ok-id","title":null,"turns":[]}' | summarize_share_json >/dev/null \
  || fail "allowlist payload must pass."
pass "share-json-allowlist"

if echo '{"id":"x","title":null,"turns":[],"uuid":"secret"}' | summarize_share_json >/dev/null; then
  fail "uuid at the top level must fail."
fi
pass "share-json-rejects-uuid"

if echo '{"id":"x","title":null,"turns":[{"id":"t","uuid":"secret"}]}' | summarize_share_json >/dev/null; then
  fail "uuid inside turns must fail."
fi
pass "share-json-rejects-nested-uuid"

python3 "$SCRIPT_DIR/mock-luca-proxy.py" >"$WORK/listen.txt" &
MOCK_PID=$!
ready=0
for i in $(seq 1 20); do
  if [[ -s "$WORK/listen.txt" ]]; then
    ready=1
    break
  fi
  sleep 1
done
[[ "$ready" == "1" ]] || fail "Mock server did not print a bind address."
LISTEN="$(tr -d '[:space:]' <"$WORK/listen.txt")"
[[ "$LISTEN" == 127.0.0.1:* ]] || fail "Mock server did not print a loopback bind."
MOCK_PORT="${LISTEN##*:}"
BASE_URL="http://127.0.0.1:${MOCK_PORT}"

ensure_evidence_root
RUN_ID="selftest"
RUN_DIR="$(run_dir_for "$RUN_ID")"
mkdir -p "$RUN_DIR"
write_current_pointer "$RUN_ID"
printf '%s\n' "ananda" >"$RUN_DIR/site"
printf '%s\n' "$MOCK_PORT" >"$RUN_DIR/port"
printf '%s\n' "$BASE_URL" >"$RUN_DIR/base_url"
printf '%s\n' "$MOCK_PID" >"$RUN_DIR/server.pid"

"$SCRIPT_DIR/doctor.sh" || fail "doctor.sh failed against the Luca proxy mock."
pass "doctor-luca-mock"

"$SCRIPT_DIR/drive.sh" --feature logged-out-share || fail "logged-out-share did not PASS."
grep -q "PASS logged-out Luca share path" "$RUN_DIR/drive-logged-out-share.txt" \
  || fail "logged-out-share note missing PASS line."
pass "drive-logged-out-share"

set +e
"$SCRIPT_DIR/drive.sh" --feature history-and-sharing
history_rc=$?
set -e
[[ "$history_rc" == "2" ]] || fail "history-and-sharing must exit 2 BLOCKED. Got $history_rc."
grep -q "GET /api/chats -> 401" "$RUN_DIR/drive-history-and-sharing.txt" \
  || fail "history-and-sharing must record chats 401."
pass "drive-history-and-sharing-blocked-after-401"

export VERIFY_MEGA_RAG_SHARE_ID="share-ok-id"
"$SCRIPT_DIR/drive.sh" --feature logged-out-share || fail "logged-out-share with SHARE_ID did not PASS."
grep -q "allowlist=ok" "$RUN_DIR/drive-logged-out-share.txt" \
  || fail "SHARE_ID run must record allowlist=ok."
if grep -Eqi "secret|meditation|stillness" "$RUN_DIR/drive-logged-out-share.txt"; then
  fail "Evidence note must not contain payload values."
fi
pass "drive-logged-out-share-with-id"
unset VERIFY_MEGA_RAG_SHARE_ID

echo "ok" >"$WORK/selftest.ok"
echo "selftest passed"
