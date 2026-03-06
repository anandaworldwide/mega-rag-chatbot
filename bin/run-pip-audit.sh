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

echo "Installing/Updating pip-audit..."
python -m pip install --upgrade pip-audit >/dev/null

# torch >=2.6.0 doesn't publish wheels for Python 3.12, so we can't upgrade
# past 2.2.x. Accept these known torch CVEs until Python version upgrade.
# Mitigation: never call torch.load() on untrusted data.
IGNORED_VULNS=(
  --ignore-vuln PYSEC-2025-41
  --ignore-vuln PYSEC-2024-259
  --ignore-vuln CVE-2025-2953
  --ignore-vuln CVE-2025-3730
)

echo "Running pip-audit on all Python requirements files..."
echo "(Ignoring torch CVEs - no fix available for Python 3.12)"
audit_exit_code=0

for req_file in "${REQUIREMENTS_FILES[@]}"; do
  if [[ ! -f "${req_file}" ]]; then
    echo "Missing requirements file: ${req_file}"
    exit 1
  fi

  echo
  echo "=== Auditing ${req_file} ==="
  if [[ "${FIX_MODE}" == "--fix" ]]; then
    if ! pip-audit -r "${req_file}" --fix "${IGNORED_VULNS[@]}"; then
      audit_exit_code=1
    fi
  else
    if ! pip-audit -r "${req_file}" "${IGNORED_VULNS[@]}"; then
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
