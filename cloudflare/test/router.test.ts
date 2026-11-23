import { describe, expect, it, vi } from 'vitest';
import { handleRequest } from '../src/index';
import type { Env } from '../src/types';

function createRouterEnv() {
  const containerFetch = vi.fn(async () => new Response('from-container'));
  const stateFetch = vi.fn(async () => Response.json({ value: 'ok' }));
  const r2Get = vi.fn(async (key: string) =>
    key === 'hello.png'
      ? {
          body: 'png-bytes',
          httpEtag: '"etag-1"',
          writeHttpMetadata: (h: Headers) => h.set('content-type', 'image/png'),
        }
      : null
  );

  const env = {
    CLOUDFLARE_INTERNAL_SECRET: 'secret-123',
    POSTIZ_WEB: {
      idFromName: () => 'singleton',
      get: () => ({ fetch: containerFetch }),
    },
    POSTIZ_STATE: {
      idFromName: () => 'global',
      get: () => ({ fetch: stateFetch }),
    },
    POSTIZ_MEDIA: {
      get: r2Get,
    },
  } as unknown as Env;

  return { env, containerFetch, stateFetch, r2Get };
}

describe('Worker Edge Router', () => {
  it('blocks /internal/* routes from external traffic', async () => {
    const { env, containerFetch } = createRouterEnv();
    const res = await handleRequest(
      new Request('https://postiz.example.com/internal/activities/post/getPost', {
        method: 'POST',
      }),
      env
    );
    expect(res.status).toBe(403);
    expect(containerFetch).not.toHaveBeenCalled();
  });

  it('protects /__cf/state/* with bearer auth and forwards valid requests', async () => {
    const { env, stateFetch } = createRouterEnv();
    const denied = await handleRequest(
      new Request('https://postiz.example.com/__cf/state/kv/get', {
        method: 'POST',
      }),
      env
    );
    expect(denied.status).toBe(401);

    const allowed = await handleRequest(
      new Request('https://postiz.example.com/__cf/state/kv/get', {
        method: 'POST',
        headers: { Authorization: 'Bearer secret-123' },
      }),
      env
    );
    expect(allowed.status).toBe(200);
    expect(stateFetch).toHaveBeenCalledOnce();
  });

  it('serves /uploads/* from R2 with strict CSP sandbox headers', async () => {
    const { env } = createRouterEnv();
    const res = await handleRequest(
      new Request('https://postiz.example.com/uploads/hello.png'),
      env
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');

    const traversal = await handleRequest(
      new Request('https://postiz.example.com/uploads/..%2Fsecret.txt'),
      env
    );
    expect(traversal.status).toBe(400);
  });

  it('forwards normal traffic to PostizWebContainer DO', async () => {
    const { env, containerFetch } = createRouterEnv();
    const res = await handleRequest(
      new Request('https://postiz.example.com/api/posts'),
      env
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('from-container');
    expect(containerFetch).toHaveBeenCalledOnce();
  });
});
