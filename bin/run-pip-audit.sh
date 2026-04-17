#!/usr/bin/env bash

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

# The repo enforces a strict 7-day UV exclude-newer policy. Vulnerabilities
# whose fixed releases are newer than that cooldown are temporarily ignored
# until the release ages in.
# onnx CVE-2026-28500 has no fixed PyPI release. Mitigation: reranking tooling
# is isolated, and we do not load untrusted models via onnx.hub.load().
# transformers CVE-2026-1839 currently has no resolver-compatible fixed release
# because optimum-onnx constrains transformers<4.58.0.
IGNORED_VULNS=(
  --ignore-vuln CVE-2026-22815
  --ignore-vuln CVE-2026-34513
  --ignore-vuln CVE-2026-34514
  --ignore-vuln CVE-2026-34515
  --ignore-vuln CVE-2026-34516
  --ignore-vuln CVE-2026-34517
  --ignore-vuln CVE-2026-34518
  --ignore-vuln CVE-2026-34519
  --ignore-vuln CVE-2026-34520
  --ignore-vuln CVE-2026-34525
  --ignore-vuln CVE-2026-28500
  --ignore-vuln CVE-2026-4539
  --ignore-vuln CVE-2026-1839
  --ignore-vuln GHSA-rr7j-v2q5-chgv
  --ignore-vuln GHSA-r7w7-9xr2-qq2r
  --ignore-vuln GHSA-fv5p-p927-qmxr
)

echo "Running pip-audit from the uv-managed environment..."
echo "(Ignoring accepted reranking/evaluation-only vulnerabilities)"
audit_exit_code=0

for req_file in "${REQUIREMENTS_FILES[@]}"; do
  if [[ ! -f "${req_file}" ]]; then
    echo "Missing requirements file: ${req_file}"
    exit 1
  fi

  echo
  echo "=== Auditing ${req_file} ==="
  if [[ "${FIX_MODE}" == "--fix" ]]; then
    if ! uv run --locked pip-audit --cache-dir "${ROOT_DIR}/.cache/pip-audit" -r "${req_file}" --fix "${IGNORED_VULNS[@]}"; then
      audit_exit_code=1
    fi
  else
    if ! uv run --locked pip-audit --cache-dir "${ROOT_DIR}/.cache/pip-audit" -r "${req_file}" "${IGNORED_VULNS[@]}"; then
      audit_exit_code=1
    fi
  fi
done

echo
if [[ "${audit_exit_code}" -eq 0 ]]; then
  echo "All pip-audit checks passed."
  exit 0
fi

echo "One or more pip-audit checks failed."
exit 1
