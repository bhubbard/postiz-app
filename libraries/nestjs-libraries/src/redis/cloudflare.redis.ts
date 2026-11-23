import { ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';

function getInternalBaseUrl(): string {
  const base = process.env.CLOUDFLARE_INTERNAL_URL;
  if (!base) {
    throw new Error('CLOUDFLARE_INTERNAL_URL is required when using Cloudflare state driver');
  }
  return base.replace(/\/+$/, '');
}

function getAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (process.env.CLOUDFLARE_INTERNAL_SECRET) {
    headers['Authorization'] = `Bearer ${process.env.CLOUDFLARE_INTERNAL_SECRET}`;
  }
  return headers;
}

async function callStateApi<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${getInternalBaseUrl()}/__cf/state${path}`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Cloudflare state API ${path} failed (${res.status}): ${text}`);
  }

  return (await res.json()) as T;
}

/**
 * Drop-in `ioredis`-compatible subset backed by the `PostizStateDO` SQLite
 * Durable Object in the Cloudflare gateway Worker.
 */
export class CloudflareStateRedis {
  async get(key: string): Promise<string | null> {
    const data = await callStateApi<{ value: string | null }>('/kv/get', { key });
    return data.value ?? null;
  }

  async set(key: string, value: string, ...args: any[]): Promise<'OK' | null> {
    let ttlMs: number | undefined;
    let nx = false;

    for (let i = 0; i < args.length; i++) {
      const token = String(args[i]).toUpperCase();
      if (token === 'EX' && i + 1 < args.length) {
        ttlMs = Number(args[++i]) * 1000;
      } else if (token === 'PX' && i + 1 < args.length) {
        ttlMs = Number(args[++i]);
      } else if (token === 'NX') {
        nx = true;
      }
    }

    const data = await callStateApi<{ ok: boolean }>('/kv/set', {
      key,
      value: String(value),
      ttlMs,
      nx,
    });
    return data.ok ? 'OK' : null;
  }

  async del(...keys: string[]): Promise<number> {
    const data = await callStateApi<{ deleted: number }>('/kv/del', { keys });
    return data.deleted ?? 0;
  }

  async rpush(key: string, ...values: string[]): Promise<number> {
    const data = await callStateApi<{ length: number }>('/list/rpush', {
      key,
      values: values.map(String),
    });
    return data.length ?? 0;
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const data = await callStateApi<{ values: string[] }>('/list/lrange', {
      key,
      start,
      stop,
    });
    return data.values ?? [];
  }

  async expire(key: string, seconds: number): Promise<number> {
    const data = await callStateApi<{ updated: number }>('/kv/expire', {
      key,
      ttlMs: Number(seconds) * 1000,
    });
    return data.updated ?? 0;
  }
}

export class CloudflareThrottlerStorage implements ThrottlerStorage {
  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string
  ): Promise<ThrottlerStorageRecord> {
    return callStateApi<ThrottlerStorageRecord>('/throttle', {
      key,
      ttl,
      limit,
      blockDuration,
      throttlerName,
    });
  }
}
