#!/usr/bin/env bash
#
# Copy irreplaceable ananda-chatbot prefixes to an external disk.
# S3 stays the official store. This script never passes --delete, so an S3
# delete does not remove the local copy.
#
# Usage (from repo root):
#   ./bin/sync_ingest_backup_from_s3.sh /Volumes/your-disk/ananda-chatbot
#   ./bin/sync_ingest_backup_from_s3.sh /Volumes/your-disk/ananda-chatbot --dry-run
#
set -euo pipefail

usage() {
  echo "Usage: $(basename "$0") <dest-dir> [--dry-run]"
  echo ""
  echo "Downloads these s3://ananda-chatbot prefixes into <dest-dir>:"
  echo "  public/audio/"
  echo "  public/pdf/Ananda Library/"
  echo "  ingestion/"
  echo "  site-config/data_ingestion/"
  echo "  site-config/title-catalog/"
  echo ""
  echo "Does not delete local files that are gone from S3."
}

if [[ $# -lt 1 || "$1" == "-h" || "$1" == "--help" ]]; then
  usage
  exit 2
fi

DEST="$1"
DRY_RUN=0
if [[ $# -eq 2 && "$2" == "--dry-run" ]]; then
  DRY_RUN=1
elif [[ $# -ne 1 ]]; then
  usage
  exit 2
fi

if [[ "$DEST" == -* ]]; then
  usage
  exit 2
fi

PROFILE="ananda"
BUCKET="ananda-chatbot"

sync_one() {
  local prefix="$1"
  mkdir -p "${DEST}/${prefix}"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    aws s3 sync "s3://${BUCKET}/${prefix}" "${DEST}/${prefix}" --profile "$PROFILE" --dryrun
  else
    aws s3 sync "s3://${BUCKET}/${prefix}" "${DEST}/${prefix}" --profile "$PROFILE"
  fi
}

sync_one "public/audio/"
sync_one "public/pdf/Ananda Library/"
sync_one "ingestion/"
sync_one "site-config/data_ingestion/"
sync_one "site-config/title-catalog/"
