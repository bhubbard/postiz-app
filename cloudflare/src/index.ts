import { requireInternalAuth } from './auth';
import type { Env } from './types';
import { handleWorkflowControl } from './workflow-control';

export { PostizWebContainer } from './web-container';
export { PostizStateDO } from './state-do';
export { PostPublishWorkflow } from './workflows/post-publish.workflow';
export { RefreshTokenWorkflow } from './workflows/refresh-token.workflow';
export { AutoPostWorkflow } from './workflows/autopost.workflow';
export { StreakWorkflow } from './workflows/streak.workflow';
export { SendEmailWorkflow } from './workflows/email.workflow';
export {
  ProcessMediaWorkflow,
  GenerateVideoWorkflow,
} from './workflows/media.workflow';
export {
  ClippingWorkflow,
  ClippingClipWorkflow,
} from './workflows/clipping.workflow';
export { EncryptTokensWorkflow } from './workflows/encrypt-tokens.workflow';

const MEDIA_CSP =
  "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'none'; script-src 'none'; frame-ancestors 'none'; sandbox";

async function serveR2Upload(request: Request, env: Env, key: string): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405 });
  }
  if (!key || key.includes('..') || key.startsWith('/')) {
    return new Response('Bad Request', { status: 400 });
  }

  const obj = await env.POSTIZ_MEDIA.get(key);
  if (!obj) {
    return new Response('Not Found', { status: 404 });
  }

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set('x-content-type-options', 'nosniff');
  headers.set('content-security-policy', MEDIA_CSP);
  headers.set('cache-control', 'public, max-age=31536000, immutable');

  return new Response(request.method === 'HEAD' ? null : obj.body, {
    status: 200,
    headers,
  });
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === '/__cf/health') {
    return Response.json({ status: 'ok', driver: 'cloudflare' });
  }

  // Never expose NestJS internal activity execution routes externally
  if (url.pathname.startsWith('/internal')) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  if (url.pathname.startsWith('/__cf/state/')) {
    const authError = await requireInternalAuth(
      request,
      env.CLOUDFLARE_INTERNAL_SECRET
    );
    if (authError) {
      return authError;
    }

    const stateId = env.POSTIZ_STATE.idFromName('global');
    const stateStub = env.POSTIZ_STATE.get(stateId);
    const rewritten = new URL(request.url);
    rewritten.pathname = url.pathname.replace(/^\/__cf\/state/, '');
    return stateStub.fetch(new Request(rewritten.toString(), request));
  }

  if (url.pathname.startsWith('/__cf/workflows/')) {
    return handleWorkflowControl(request, env);
  }

  if (url.pathname.startsWith('/uploads/')) {
    const key = decodeURIComponent(url.pathname.slice('/uploads/'.length));
    return serveR2Upload(request, env, key);
  }

  const containerId = env.POSTIZ_WEB.idFromName('singleton');
  const containerStub = env.POSTIZ_WEB.get(containerId);
  return containerStub.fetch(request);
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const containerId = env.POSTIZ_WEB.idFromName('singleton');
    const containerStub = env.POSTIZ_WEB.get(containerId);
    const res = await containerStub.invokeActivity(
      'post',
      'searchForMissingThreeHoursPosts',
      []
    );
    if (!res.ok) {
      throw new Error(
        `Scheduled missing-posts sweep failed (${res.errorType}): ${res.message}`
      );
    }
  },
};
