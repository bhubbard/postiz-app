#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CF_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ROOT_DIR="$(cd "${CF_DIR}/.." && pwd)"

ENV_FILE="${1:-${CF_DIR}/.env.cloudflare}"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing secrets file: $ENV_FILE"
  echo "Copy ${CF_DIR}/.env.cloudflare.example to ${CF_DIR}/.env.cloudflare and fill in your values."
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

BUCKET_NAME="${CLOUDFLARE_BUCKETNAME:-postiz-media}"

echo "[1/4] Checking Cloudflare CLI authentication..."
cf auth whoami >/dev/null

echo "[2/4] Ensuring R2 bucket '${BUCKET_NAME}' exists..."
if ! cf r2 buckets get --bucket-name "$BUCKET_NAME" >/dev/null 2>&1; then
  cf r2 buckets create --name "$BUCKET_NAME" || true
fi

echo "[3/4] Pushing Prisma schema to PostgreSQL..."
(
  cd "$ROOT_DIR"
  pnpm dlx prisma@6.5.0 db push --schema ./libraries/nestjs-libraries/src/database/prisma/schema.prisma
)

echo "[4/4] Building and deploying Postiz Worker + Container + Workflows..."
cd "$CF_DIR"
pnpm install
cf deploy --secrets-file "$ENV_FILE"
