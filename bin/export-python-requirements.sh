#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXPECTED_UV_VERSION="0.13.9"

cd "${ROOT_DIR}"

UV_VERSION="$(uv --version | awk '{print $2}')"
if [[ "${UV_VERSION}" != "${EXPECTED_UV_VERSION}" ]]; then
  echo "error: uv ${EXPECTED_UV_VERSION} is required for this export (found ${UV_VERSION})." >&2
  echo "Install it with: uv self update ${EXPECTED_UV_VERSION}" >&2
  exit 1
fi

# Root keeps the workspace default "dev" group (pip-audit, pytest, ruff).
uv export --locked --package mega-rag-chatbot --group dev --no-hashes --output-file requirements.txt

# Workspace members must opt out of root default-groups. uv >=0.12 applies
# tool.uv.default-groups to member exports unless --no-default-groups is set,
# which would pollute member requirements with root-only dev tools.
uv export --locked --package mega-rag-chatbot-reranking --no-default-groups --no-hashes --output-file reranking/requirements.txt
uv export --locked --package mega-rag-chatbot-crawler --no-default-groups --no-hashes --output-file data_ingestion/crawler/requirements.txt
uv export --locked --package mega-rag-chatbot-wordpress-analytics --no-default-groups --no-hashes --output-file wordpress/analytics/requirements.txt

echo "Exported compatibility requirements files from uv.lock."
