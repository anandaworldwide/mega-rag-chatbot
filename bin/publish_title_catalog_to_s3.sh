#!/usr/bin/env bash
#
# Publish local title catalog artifacts to S3 (shared dev/prod layout per site).
#
# Source:  <repo>/.cache/title_prefix_catalog/reports/<site>/
# Dest:    s3://<bucket>/site-config/title-catalog/<site>/
#
# Excludes analysis.sqlite3 (local SQLite workfile; do not upload).
# Does not delete objects on S3 that are absent locally (same as aws s3 cp --recursive).
#
# Usage (from repo root):
#   ./bin/publish_title_catalog_to_s3.sh --site ananda --profile ananda
#
#   ./bin/publish_title_catalog_to_s3.sh --site ananda --bucket your-bucket --dry-run
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SITE=""
AWS_PROFILE=""
BUCKET=""
DRY_RUN=0

usage() {
  echo "Publish .cache/title_prefix_catalog/reports/<site>/ to s3://<bucket>/site-config/title-catalog/<site>/"
  echo "(excludes analysis.sqlite3)."
  echo ""
  echo "Usage: $(basename "$0") --site <site-id> [--profile <aws-profile>] [--bucket <name>] [--dry-run]"
  echo ""
  echo "  --site     Site id, e.g. ananda"
  echo "  --profile  AWS CLI named profile (recommended)"
  echo "  --bucket   S3 bucket override (default: S3_BUCKET_NAME from .env.<site>)"
  echo "  --dry-run  aws s3 cp --dryrun (no uploads)"
  echo ""
}

find_site_env_file() {
  local current_dir="$PWD"
  local env_file=""

  for _ in 1 2 3 4; do
    env_file="${current_dir}/.env.${SITE}"
    if [[ -f "$env_file" ]]; then
      printf '%s\n' "$env_file"
      return 0
    fi
    current_dir="$(dirname "$current_dir")"
  done

  env_file="${REPO_ROOT}/.env.${SITE}"
  if [[ -f "$env_file" ]]; then
    printf '%s\n' "$env_file"
    return 0
  fi

  return 1
}

load_bucket_from_site_env() {
  local env_file=""
  env_file="$(find_site_env_file)" || {
    echo "Error: failed to find .env.${SITE} in the current directory or up to three levels up." >&2
    return 1
  }

  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  set +a

  if [[ -z "${S3_BUCKET_NAME:-}" ]]; then
    echo "Error: S3_BUCKET_NAME is not set in ${env_file}. Pass --bucket to override if needed." >&2
    return 1
  fi

  printf '%s\n' "$S3_BUCKET_NAME"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --site)
      SITE="${2:-}"
      shift 2
      ;;
    --profile)
      AWS_PROFILE="${2:-}"
      shift 2
      ;;
    --bucket)
      BUCKET="${2:-}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$SITE" ]]; then
  echo "Error: --site is required." >&2
  usage >&2
  exit 1
fi

if [[ -z "$BUCKET" ]]; then
  BUCKET="$(load_bucket_from_site_env)"
fi
if [[ -z "$BUCKET" ]]; then
  echo "Error: could not resolve S3 bucket from .env.${SITE} or --bucket." >&2
  exit 1
fi

SRC="${REPO_ROOT}/.cache/title_prefix_catalog/reports/${SITE}"
if [[ ! -d "$SRC" ]]; then
  echo "Error: local catalog directory not found: ${SRC}" >&2
  echo "Rebuild first, e.g.:" >&2
  echo "  python bin/analyze_title_prefix_catalog.py --site ${SITE} --write-artifacts --artifact-version \"${SITE}-\$(date +%Y%m%d-%H%M%S)\"" >&2
  exit 1
fi

AWS_CMD=(aws)
if [[ -n "$AWS_PROFILE" ]]; then
  AWS_CMD+=(--profile "$AWS_PROFILE")
fi

S3_DEST="s3://${BUCKET}/site-config/title-catalog/${SITE}/"

echo "Publishing title catalog"
echo "  local: ${SRC}"
echo "  s3:    ${S3_DEST}"
echo "  exclude: analysis.sqlite3"
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "  mode:  dry-run"
fi

CP_ARGS=(s3 cp "$SRC" "$S3_DEST" --recursive --exclude "analysis.sqlite3")
if [[ "$DRY_RUN" -eq 1 ]]; then
  CP_ARGS+=(--dryrun)
fi

"${AWS_CMD[@]}" "${CP_ARGS[@]}"

echo "Done."
