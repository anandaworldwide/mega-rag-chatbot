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
# torch is only used in isolated reranking tooling.
# Mitigation: never call torch.load() on untrusted data.
# nltk GHSA-rf74-v2fm-23pw / CVE-2026-33230 / CVE-2026-33231 currently have
# no newer PyPI release than 3.9.3. Mitigation: nltk is only used in
# evaluation, experiments, and analysis tooling - not in the web runtime.
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
  --ignore-vuln PYSEC-2025-41
  --ignore-vuln PYSEC-2024-259
  --ignore-vuln CVE-2025-2953
  --ignore-vuln CVE-2025-3730
  --ignore-vuln CVE-2026-28500
  --ignore-vuln GHSA-rf74-v2fm-23pw
  --ignore-vuln GHSA-q56x-g2fj-4rj6
  --ignore-vuln CVE-2026-27489
  --ignore-vuln CVE-2026-34445
  --ignore-vuln CVE-2026-34446
  --ignore-vuln CVE-2026-34447
  --ignore-vuln CVE-2026-33230
  --ignore-vuln CVE-2026-33231
  --ignore-vuln CVE-2026-4539
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
