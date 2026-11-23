import { DurableObject } from 'cloudflare:workers';
import type { Env } from './types';

const INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000;
const READY_MAX_ATTEMPTS = 45;
const READY_POLL_MS = 1000;

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]);

export function buildContainerEnv(env: Env, origin: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string' && value.length > 0 && key !== 'POSTIZ_EXTRA_ENV_JSON') {
      result[key] = value;
    }
  }

  if (typeof env.POSTIZ_EXTRA_ENV_JSON === 'string' && env.POSTIZ_EXTRA_ENV_JSON.trim()) {
    try {
      const parsed = JSON.parse(env.POSTIZ_EXTRA_ENV_JSON) as Record<string, unknown>;
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string') {
          result[key] = value;
        } else if (typeof value === 'number' || typeof value === 'boolean') {
          result[key] = String(value);
        }
      }
    } catch {
      console.warn('Ignoring invalid POSTIZ_EXTRA_ENV_JSON');
    }
  }

  const normalizedOrigin = origin.replace(/\/+$/, '');
  result.NODE_ENV = result.NODE_ENV || 'production';
  result.WORKFLOW_DRIVER = 'cloudflare';
  result.REDIS_DRIVER = 'cloudflare';
  result.STORAGE_PROVIDER = 'cloudflare';
  result.CLOUDFLARE_REGION = result.CLOUDFLARE_REGION || 'auto';
  result.BACKEND_INTERNAL_URL = 'http://127.0.0.1:3000';
  result.CLOUDFLARE_INTERNAL_URL = result.CLOUDFLARE_INTERNAL_URL || normalizedOrigin;
  result.MAIN_URL = result.MAIN_URL || normalizedOrigin;
  result.FRONTEND_URL = result.FRONTEND_URL || normalizedOrigin;
  result.NEXT_PUBLIC_BACKEND_URL =
    result.NEXT_PUBLIC_BACKEND_URL || `${normalizedOrigin}/api`;
  result.IS_GENERAL = result.IS_GENERAL || 'true';
  result.PORT = '3000';

  if (result.CLOUDFLARE_BUCKET_URL) {
    result.CLOUDFLARE_BUCKET_URL = result.CLOUDFLARE_BUCKET_URL.replace(/\/+$/, '');
  }

  return result;
}

export class PostizWebContainer extends DurableObject<Env> {
  private startupPromise: Promise<void> | null = null;
  private lastOrigin = 'https://postiz.local';

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    if (this.ctx.container?.running) {
      this.ctx.waitUntil(
        this.ctx.container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS).catch(() => {})
      );
    }
  }

  private async ensureReady(origin?: string): Promise<void> {
    if (origin) {
      this.lastOrigin = origin;
    }

    const container = this.ctx.container;
    if (!container) {
      throw new Error('Container binding is not configured on PostizWebContainer');
    }

    if (container.running && !this.startupPromise) {
      await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS).catch(() => {});
      return;
    }

    if (!this.startupPromise) {
      this.startupPromise = this.startAndWait(container).finally(() => {
        this.startupPromise = null;
      });
    }

    await this.startupPromise;
  }

  private async startAndWait(container: Container): Promise<void> {
    if (!container.running) {
      container.start({
        enableInternet: true,
        env: buildContainerEnv(this.env, this.lastOrigin),
      });
    }

    await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS).catch(() => {});

    const backendPort = container.getTcpPort(3000);
    const frontendPort = container.getTcpPort(4200);

    for (let attempt = 0; attempt < READY_MAX_ATTEMPTS; attempt++) {
      try {
        const [backendRes, frontendRes] = await Promise.all([
          backendPort.fetch('http://container/internal/health'),
          frontendPort.fetch('http://container/'),
        ]);
        if (backendRes.ok && frontendRes.status < 500) {
          return;
        }
      } catch {
        // Container ports still booting.
      }
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
    }

    throw new Error('Postiz container timed out waiting for ports 3000 and 4200');
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/internal')) {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }

    await this.ensureReady(url.origin);
    const container = this.ctx.container!;

    const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');
    const targetPort = isApi ? 3000 : 4200;
    const forwardedPath = isApi
      ? url.pathname.replace(/^\/api(?=\/|$)/, '') || '/'
      : url.pathname;

    const targetUrl = new URL(`http://container${forwardedPath}${url.search}`);
    const headers = new Headers();
    request.headers.forEach((value, key) => {
      if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
        headers.set(key, value);
      }
    });
    headers.set('host', url.host);
    headers.set('x-forwarded-host', url.host);
    headers.set('x-forwarded-proto', url.protocol.replace(/:$/, ''));
    if (!headers.has('x-forwarded-for') && request.headers.get('cf-connecting-ip')) {
      headers.set('x-forwarded-for', request.headers.get('cf-connecting-ip')!);
    }

    const methodHasBody = request.method !== 'GET' && request.method !== 'HEAD';
    const upstreamResponse = await container.getTcpPort(targetPort).fetch(
      new Request(targetUrl.toString(), {
        method: request.method,
        headers,
        body: methodHasBody ? request.body : undefined,
        redirect: 'manual',
      })
    );

    const responseHeaders = new Headers(upstreamResponse.headers);
    for (const h of ['connection', 'keep-alive', 'transfer-encoding']) {
      responseHeaders.delete(h);
    }

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    });
  }

  async invokeActivity<T = unknown>(
    activity: string,
    method: string,
    args: unknown[],
    origin?: string
  ): Promise<
    | { ok: true; result: T }
    | { ok: false; errorType: string; nonRetryable: boolean; message: string }
  > {
    await this.ensureReady(origin);
    const backendPort = this.ctx.container!.getTcpPort(3000);
    const res = await backendPort.fetch(
      `http://container/internal/activities/${encodeURIComponent(activity)}/${encodeURIComponent(method)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.env.CLOUDFLARE_INTERNAL_SECRET || ''}`,
        },
        body: JSON.stringify({ args }),
      }
    );

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `Activity ${activity}.${method} returned HTTP ${res.status}: ${text}`
      );
    }

    const payload = (await res.json()) as any;
    if (payload && typeof payload.ok === 'boolean') {
      return payload;
    }

    throw new Error(
      `Activity ${activity}.${method} returned HTTP ${res.status}: ${JSON.stringify(payload)}`
    );
  }
}
