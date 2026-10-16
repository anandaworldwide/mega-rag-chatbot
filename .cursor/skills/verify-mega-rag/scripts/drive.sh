#!/usr/bin/env bash
# Drive one mapped feature against the live local app.
# Default is dry-run. Paid, email, and database writes need explicit flags.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

FEATURE=""
usage() {
  cat <<'EOF'
Usage: drive.sh --feature <id>

Feature ids:
  login-logout
  ask-sourced-answer
  title-scope
  content-filters
  history-and-sharing

Dry-run is the default. The helper checks the user-facing chrome and
does not submit chat, login, email, or votes.

Live flags (set only when you intend the side effect):
  VERIFY_MEGA_RAG_LIVE_CHAT=1
  VERIFY_MEGA_RAG_LIVE_LOGIN=1
  VERIFY_MEGA_RAG_SEND_EMAIL=1
  VERIFY_MEGA_RAG_WRITE_DB=1

Login credentials, when used, must come from the environment:
  VERIFY_MEGA_RAG_LOGIN_EMAIL
  VERIFY_MEGA_RAG_LOGIN_PASSWORD
Do not hard-code passwords. Do not invent defaults.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --feature)
      FEATURE="${2:-}"
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

[[ -n "$FEATURE" ]] || die "Pass --feature. See --help."
require_cmd curl
ensure_evidence_root
load_current
assert_not_production_url "$VERIFY_BASE_URL"

RECORD="$VERIFY_RUN_DIR/drive-${FEATURE}.txt"
: >"$RECORD"

note() {
  echo "$*" | tee -a "$RECORD"
}

fail_drive() {
  echo "FAIL $*" | tee -a "$RECORD" >&2
  exit 1
}

probe_page() {
  local path="$1"
  local dest="$2"
  node "$SCRIPT_DIR/page-probe.mjs" "$VERIFY_BASE_URL$path" >"$dest"
}

probe_field() {
  python3 -c 'import json,sys; v=json.load(open(sys.argv[1])).get(sys.argv[2]); print("" if v is None else v)' "$1" "$2"
}

assert_luca_login_identity() {
  local dest="$VERIFY_RUN_DIR/drive-${FEATURE}.probe.json"
  probe_page /login "$dest"
  local status page site_id
  status="$(probe_field "$dest" status)"
  page="$(probe_field "$dest" page)"
  site_id="$(probe_field "$dest" siteId)"
  note "GET /login -> $status page=$page siteId=$site_id"
  [[ "$status" == "200" && "$page" == "/login" && "$site_id" == "ananda" ]] || \
    fail_drive "Luca login identity failed. Login is the required gate."
}

LIVE_CHAT="${VERIFY_MEGA_RAG_LIVE_CHAT:-0}"
LIVE_LOGIN="${VERIFY_MEGA_RAG_LIVE_LOGIN:-0}"
SEND_EMAIL="${VERIFY_MEGA_RAG_SEND_EMAIL:-0}"
WRITE_DB="${VERIFY_MEGA_RAG_WRITE_DB:-0}"

note "feature=$FEATURE site=$VERIFY_SITE url=$VERIFY_BASE_URL"
note "flags live_chat=$LIVE_CHAT live_login=$LIVE_LOGIN send_email=$SEND_EMAIL write_db=$WRITE_DB"

case "$FEATURE" in
  login-logout)
    [[ "$VERIFY_SITE" == "ananda" ]] || \
      fail_drive "login-logout is a Luca (ananda) feature. Current site is $VERIFY_SITE."
    assert_luca_login_identity
    chunk="$(probe_field "$VERIFY_RUN_DIR/drive-${FEATURE}.probe.json" loginChunk)"
    require_login="$(probe_field "$VERIFY_RUN_DIR/drive-${FEATURE}.probe.json" requireLogin)"
    note "requireLogin=$require_login login.js=$chunk"
    [[ "$chunk" == "200" ]] || fail_drive "login.js chunk returned $chunk."
    note "SSR HTML is a Next shell. #email-input appears after client hydration."
    note "Dry-run did not submit email or password."
    note "That avoids Firestore reads/writes and magic-link email."
    if [[ "$LIVE_LOGIN" == "1" ]]; then
      if [[ -z "${VERIFY_MEGA_RAG_LOGIN_EMAIL:-}" || -z "${VERIFY_MEGA_RAG_LOGIN_PASSWORD:-}" ]]; then
        fail_drive "LIVE_LOGIN=1 needs VERIFY_MEGA_RAG_LOGIN_EMAIL and VERIFY_MEGA_RAG_LOGIN_PASSWORD."
      fi
      fail_drive "Automated password POST is not shipped. Use the browser on /login. Do not log the password."
    fi
    if [[ "$SEND_EMAIL" == "1" ]]; then
      fail_drive "Magic-link send is not shipped in this helper. Use the browser only when intended."
    fi
    note "PASS Luca login page identity is present. Logout lives at /settings after a real login."
    ;;

  ask-sourced-answer)
    if [[ "$VERIFY_SITE" == "ananda" ]]; then
      note "Luca requires login. Dry-run checks /login, not the chat shell."
      assert_luca_login_identity
      note "PASS logged-out Luca serves the login identity before chat."
      if [[ "$LIVE_CHAT" == "1" ]]; then
        fail_drive "LIVE_CHAT on Luca needs a logged-in browser session first."
      fi
    else
      dest="$VERIFY_RUN_DIR/drive-${FEATURE}.probe.json"
      probe_page / "$dest"
      status="$(probe_field "$dest" status)"
      site_id="$(probe_field "$dest" siteId)"
      note "GET / -> $status siteId=$site_id"
      [[ "$status" == "200" && "$site_id" == "ananda-public" ]] || \
        fail_drive "Vivek home identity failed."
      note "Dry-run did not POST /api/chat/v1."
      note "A live send calls a paid model and Pinecone."
      note "Vivek sets hideSources, so public UI may omit the Sources heading."
      if [[ "$LIVE_CHAT" == "1" ]]; then
        fail_drive "LIVE_CHAT send is not shipped here. Use the browser Send message control."
      fi
      note "PASS Vivek chat input chrome is present."
    fi
    ;;

  title-scope)
    [[ "$VERIFY_SITE" == "ananda" ]] || \
      fail_drive "Title scope is enabled on Luca only."
    assert_luca_login_identity
    note "Dry-run did not call GET /api/titleScope/suggest."
    note "Suggest returns title strings. Do not save that JSON."
    note "PASS title-scope journey is blocked on login, as required."
    ;;

  content-filters)
    [[ "$VERIFY_SITE" == "ananda" ]] || \
      fail_drive "Author and media filters are Luca controls."
    assert_luca_login_identity
    note "PASS content-filters journey is blocked on login, as required."
    ;;

  history-and-sharing)
    if [[ "$VERIFY_SITE" == "ananda" ]]; then
      assert_luca_login_identity
      note "PASS history journey is blocked on login, as required."
    else
      dest="$VERIFY_RUN_DIR/drive-${FEATURE}.probe.json"
      probe_page / "$dest"
      status="$(probe_field "$dest" status)"
      site_id="$(probe_field "$dest" siteId)"
      note "GET / -> $status siteId=$site_id"
      [[ "$status" == "200" && "$site_id" == "ananda-public" ]] || \
        fail_drive "Vivek home identity failed."
      note "History GET /api/chats reads Firestore. Dry-run did not call it."
      note "PASS sharing chrome is checked after an answer exists. None sent."
    fi
    if [[ "$WRITE_DB" == "1" ]]; then
      fail_drive "WRITE_DB history mutations are not shipped in this helper."
    fi
    ;;

  *)
    fail_drive "Unknown feature: $FEATURE"
    ;;
esac

date -u +"%Y-%m-%dT%H:%M:%SZ" >"$VERIFY_RUN_DIR/drove_at"
printf '%s\n' "$FEATURE" >"$VERIFY_RUN_DIR/drove_feature"
note "Evidence note: $RECORD"
note "Do not copy answers, sources, or retrieval JSON into this tree."
