#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "${ROOT_DIR}"

uv export --locked --package mega-rag-chatbot --group dev --no-hashes --output-file requirements.txt
uv export --locked --package mega-rag-chatbot-reranking --no-hashes --output-file reranking/requirements.txt
uv export --locked --package mega-rag-chatbot-crawler --no-hashes --output-file data_ingestion/crawler/requirements.txt
uv export --locked --package mega-rag-chatbot-wordpress-analytics --no-hashes --output-file wordpress/analytics/requirements.txt

echo "Exported compatibility requirements files from uv.lock."
