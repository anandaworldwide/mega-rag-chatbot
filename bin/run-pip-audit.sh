#!/usr/bin/env bash

# Local-dev convenience wrapper around the cooldown-aware audit.
#
# Without --fix:
#   Runs bin/cooldown_audit.py which classifies findings against our 7-day
#   supply-chain cooldown (`exclude-newer = "7 days"`). Exits non-zero only on
#   findings that are past cooldown AND at or above the high severity threshold.
#
# With --fix:
#   Runs `pip-audit --fix` against each exported requirements file to upgrade
#   vulnerable packages in place. Note that any upgrade beyond the uv
#   exclude-newer window will be rejected by `uv sync` until the release ages
#   past cooldown.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIX_MODE="${1:-}"

if [[ -n "${FIX_MODE}" && "${FIX_MODE}" != "--fix" ]]; then
  echo "Usage: ./bin/run-pip-audit.sh [--fix]"
  exit 1
fi

REQUIREMENTS_FILES=(
  "requirements.txt"
  "reranking/requirements.txt"
  "data_ingestion/crawler/requirements.txt"
  "wordpress/analytics/requirements.txt"
)

cd "${ROOT_DIR}"
mkdir -p "${ROOT_DIR}/.cache/pip-audit"
export XDG_CACHE_HOME="${ROOT_DIR}/.cache"
export PIP_CONFIG_FILE=/dev/null

echo "Exporting compatibility requirements from uv.lock..."
"${ROOT_DIR}/bin/export-python-requirements.sh" >/dev/null

if [[ "${FIX_MODE}" == "--fix" ]]; then
  audit_exit_code=0
  for req_file in "${REQUIREMENTS_FILES[@]}"; do
    if [[ ! -f "${req_file}" ]]; then
      echo "Missing requirements file: ${req_file}"
      exit 1
    fi
    echo
    echo "=== pip-audit --fix ${req_file} ==="
    if ! uv run --locked pip-audit \
        --cache-dir "${ROOT_DIR}/.cache/pip-audit" \
        -r "${req_file}" \
        --fix; then
      audit_exit_code=1
    fi
  done
  exit "${audit_exit_code}"
fi

mkdir -p "${ROOT_DIR}/.cache/cooldown-audit"
req_args=()
for req_file in "${REQUIREMENTS_FILES[@]}"; do
  req_args+=(--requirements "${req_file}")
done

echo "Running cooldown-aware pip audit (7-day window)..."
exec uv run --locked python "${ROOT_DIR}/bin/cooldown_audit.py" python \
  "${req_args[@]}" \
  --fail-level high \
  --json-out "${ROOT_DIR}/.cache/cooldown-audit/python.json"
