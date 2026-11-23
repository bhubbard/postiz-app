# syntax=docker/dockerfile:1
FROM --platform=linux/amd64 node:22.23.4-bookworm-slim AS base

ARG NEXT_PUBLIC_VERSION=cf-track2
ENV NEXT_PUBLIC_VERSION=$NEXT_PUBLIC_VERSION
ENV NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    g++ \
    make \
    python3 \
    openssl \
  && rm -rf /var/lib/apt/lists/*

RUN npm --no-update-notifier --no-fund --global install pnpm@10.6.1

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY apps/backend/package.json apps/backend/tsconfig.json apps/backend/tsconfig.build.json apps/backend/nest-cli.json ./apps/backend/
COPY apps/frontend/package.json apps/frontend/tsconfig.json apps/frontend/next.config.js apps/frontend/postcss.config.mjs apps/frontend/tailwind.config.cjs ./apps/frontend/
COPY apps/frontend/scripts ./apps/frontend/scripts
COPY apps/orchestrator/package.json apps/orchestrator/tsconfig.json ./apps/orchestrator/
COPY libraries/helpers/package.json ./libraries/helpers/
COPY libraries/nestjs-libraries/package.json ./libraries/nestjs-libraries/
COPY libraries/react-shared-libraries/package.json ./libraries/react-shared-libraries/
COPY libraries/nestjs-libraries/src/database/prisma ./libraries/nestjs-libraries/src/database/prisma

RUN pnpm install --frozen-lockfile

COPY libraries ./libraries
COPY apps/backend ./apps/backend
COPY apps/frontend ./apps/frontend
COPY apps/orchestrator/src/activities ./apps/orchestrator/src/activities
COPY cloudflare/container-entrypoint.sh /usr/local/bin/postiz-entrypoint.sh

RUN chmod +x /usr/local/bin/postiz-entrypoint.sh \
 && pnpm run prisma-generate \
 && NODE_OPTIONS="--max-old-space-size=4096" pnpm --filter ./apps/backend run build \
 && NODE_OPTIONS="--max-old-space-size=4096" pnpm --filter ./apps/frontend run build \
 && rm -rf /app/apps/frontend/.next/cache /root/.pnpm-store /tmp/*

EXPOSE 3000 4200

ENTRYPOINT ["/usr/local/bin/postiz-entrypoint.sh"]
