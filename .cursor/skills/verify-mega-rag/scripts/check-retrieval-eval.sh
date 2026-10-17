#!/usr/bin/env bash
# Gate for changes that alter text sent to retrieval.
# Does not run the live suites. Does not print secrets or answers.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

changed=""
if git -C "$VERIFY_REPO_ROOT" rev-parse --verify origin/main >/dev/null 2>&1; then
  changed="$(git -C "$VERIFY_REPO_ROOT" diff --name-only origin/main...HEAD 2>/dev/null || true)"
elif git -C "$VERIFY_REPO_ROOT" rev-parse --verify main >/dev/null 2>&1; then
  changed="$(git -C "$VERIFY_REPO_ROOT" diff --name-only main...HEAD 2>/dev/null || true)"
fi

if ! printf '%s\n' "$changed" | grep -Eq 'web/src/utils/server/inputSanitization\.ts|web/src/app/api/chat/v1/route\.ts'; then
  echo "SKIP no retrieval question-path files changed"
  exit 0
fi

echo "Retrieval question text changed."
echo "Required:"
echo "  1. cd web && npm run test:queries:ananda"
echo "  2. cd web && npm run test:queries:ananda-public"
echo "  3. Repeat both on main with the same env"
echo "  4. Put counts and scores only in the PR body"
echo "Do not invent numbers. Do not commit eval output."

missing=0
if [[ ! -f "$VERIFY_REPO_ROOT/.env.ananda" ]]; then
  echo "BLOCKED missing .env.ananda"
  missing=1
fi
if [[ ! -f "$VERIFY_REPO_ROOT/.env.ananda-public" ]]; then
  echo "BLOCKED missing .env.ananda-public"
  missing=1
fi

if [[ "$missing" -eq 1 ]]; then
  echo "If credentials are missing, say so in the PR body."
  exit 2
fi

echo "Env files present. Run the suites. Do not commit the output."
exit 0
