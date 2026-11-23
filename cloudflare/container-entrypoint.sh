#!/usr/bin/env bash
set -euo pipefail

cd /app

if [[ "${RUN_MIGRATIONS:-false}" == "true" ]]; then
  echo "[postiz-cf] Pushing Prisma schema to Postgres..."
  ./node_modules/.bin/prisma db push --schema ./libraries/nestjs-libraries/src/database/prisma/schema.prisma --skip-generate
fi

echo "[postiz-cf] Starting NestJS backend on :3000..."
(
  cd /app/apps/backend
  exec node --experimental-require-module ./dist/apps/backend/src/main.js
) &
BACKEND_PID=$!

echo "[postiz-cf] Starting Next.js frontend on :4200..."
(
  cd /app/apps/frontend
  exec /app/node_modules/.bin/next start -p 4200
) &
FRONTEND_PID=$!

trap 'kill -TERM "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true' SIGTERM SIGINT

wait -n "$BACKEND_PID" "$FRONTEND_PID"
EXIT_CODE=$?
kill -TERM "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true
wait || true
exit "$EXIT_CODE"
