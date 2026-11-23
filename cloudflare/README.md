# Postiz on Cloudflare (Hybrid CF-Native / Track 2)

Deploy Postiz on Cloudflare using **Workers + Containers + R2 + Workflows + Cron Triggers + SQLite Durable Objects**, eliminating self-hosted Temporal, Elasticsearch, and Redis. The only external dependency is a managed PostgreSQL database (such as **Neon** or **Supabase**).

## Architecture

| Component | Role | Source |
| :--- | :--- | :--- |
| **Edge Router Worker** | Routes `/` → Next.js (`:4200`), `/api/*` → NestJS (`:3000`), `/uploads/*` → R2 (`POSTIZ_MEDIA`), blocks `/internal/*`, runs hourly `missingPostWorkflow` cron | [`src/index.ts`](./src/index.ts) |
| **Web Container DO** | `PostizWebContainer` manages the `linux/amd64` NestJS + Next.js container (`standard-1`, 15m idle scale-to-zero) and internal activity RPCs | [`src/web-container.ts`](./src/web-container.ts) |
| **SQLite State DO** | `PostizStateDO` replaces Redis (KV, `NX` locks, lists, API throttling), stores workflow lookup state (`postId` / `organizationId`), and batches 1h digest emails via DO Alarms | [`src/state-do.ts`](./src/state-do.ts) |
| **Cloudflare Workflows** | `PostPublishWorkflow`, `RefreshTokenWorkflow`, `AutoPostWorkflow`, `StreakWorkflow`, `SendEmailWorkflow`, `ProcessMediaWorkflow`, `GenerateVideoWorkflow`, `ClippingWorkflow`, `ClippingClipWorkflow`, `EncryptTokensWorkflow` | [`src/workflows/`](./src/workflows) |
| **Backend Adapters** | Activates transparently when `WORKFLOW_DRIVER=cloudflare` and `REDIS_DRIVER=cloudflare`; upstream Temporal/Redis behavior stays untouched otherwise | [`../libraries/nestjs-libraries/src/temporal/cloudflare.temporal.module.ts`](../libraries/nestjs-libraries/src/temporal/cloudflare.temporal.module.ts) |

## Prerequisites

1. **Cloudflare Workers Paid plan** (required for Containers and Workflows).
2. **Cloudflare CLI (`cf`)** authenticated (`cf auth login`) and **Docker** running locally (for building the `linux/amd64` container image).
3. **Managed PostgreSQL** (`DATABASE_URL`, e.g. Neon or Supabase).
4. **R2 S3 API Token** (`CLOUDFLARE_ACCESS_KEY` / `CLOUDFLARE_SECRET_ACCESS_KEY`) for Postiz's browser-direct presigned multipart uploads.

## Quickstart

1. Copy the example secrets file and fill in your Postgres, R2, and generated secrets:
   ```bash
   cp cloudflare/.env.cloudflare.example cloudflare/.env.cloudflare
   ```
   > **Important:** `CLOUDFLARE_BUCKET_URL` must **not** end with a trailing slash (use `https://<your-domain>/uploads` to serve through the Worker's R2 binding, or your public R2 custom domain).
2. Configure CORS on your R2 bucket so browser-direct multipart `PUT`s succeed from your Postiz origin (`AllowedOrigins`, `AllowedMethods: ["GET", "PUT", "HEAD"]`, `AllowedHeaders: ["*"]`).
3. Run the automated setup and deployment script:
   ```bash
   ./cloudflare/scripts/setup.sh
   ```
4. Attach your custom domain in the Cloudflare Dashboard (or `worker.domains` in [`cloudflare.config.ts`](./cloudflare.config.ts)) and optionally protect the domain with **Cloudflare Access**.

## Local Development & Verification

```bash
cd cloudflare
pnpm install
pnpm run typecheck
pnpm test
cf deploy --dry-run
```

## Syncing Upstream Updates

Because backend integration hooks are guarded behind `WORKFLOW_DRIVER=cloudflare` / `REDIS_DRIVER=cloudflare` and all Worker/Container/Workflow files live inside `cloudflare/`, syncing with `gitroomhq/postiz-app` stays straightforward:

```bash
git fetch upstream
git rebase upstream/main
```

## Notes & Limits

- **100 MB Edge Upload Limit**: Browser media uploads in Postiz use presigned R2 multipart URLs (`POST /api/media/create-multipart-upload` → browser `PUT` directly to R2), bypassing Cloudflare's 100 MB Free/Pro request body limit.
- **100 MiB Container Outbound Limit**: Cloudflare Containers enforce a default 100 MiB limit per outbound HTTP request body. Chunked/resumable video uploads (YouTube, TikTok, etc.) stay under this limit per chunk.
