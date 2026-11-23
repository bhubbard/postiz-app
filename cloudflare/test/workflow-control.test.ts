import { describe, expect, it, vi } from 'vitest';
import { StateStore } from '../src/state-do';
import { handleWorkflowControl } from '../src/workflow-control';
import type { DigestEmailItem, Env, WorkflowStatus } from '../src/types';
import { createMemorySql } from './helpers/memory-sql';

function createMockEnv() {
  const store = new StateStore(createMemorySql());
  const instances = new Map<
    string,
    { status: string; output?: unknown; terminated: boolean; events: any[] }
  >();
  const digestCalls: Array<{ orgId: string; items: DigestEmailItem[] }> = [];

  const makeBinding = () => ({
    create: vi.fn(async ({ id }: { id: string; params: unknown }) => {
      instances.set(id, { status: 'running', terminated: false, events: [] });
      return { id };
    }),
    get: vi.fn(async (id: string) => {
      const rec = instances.get(id) ?? {
        status: 'complete',
        terminated: false,
        events: [],
      };
      return {
        id,
        status: async () => ({ status: rec.status, output: rec.output }),
        terminate: async () => {
          rec.terminated = true;
          rec.status = 'terminated';
        },
        sendEvent: async (evt: any) => {
          rec.events.push(evt);
        },
      };
    }),
  });

  const env = {
    CLOUDFLARE_INTERNAL_SECRET: 'super-secret',
    POSTIZ_STATE: {
      idFromName: () => 'global',
      get: () => ({
        registerWorkflow: async (input: any) => store.registerWorkflow(input),
        getWorkflow: async (id: string) => store.getWorkflow(id),
        updateWorkflowStatus: async (
          id: string,
          status: WorkflowStatus,
          result?: unknown,
          err?: string | null
        ) => store.updateWorkflowStatus(id, status, result, err),
        listWorkflowsByQuery: async (q: string) => store.listWorkflowsByQuery(q),
        enqueueDigest: async (orgId: string, items: DigestEmailItem[]) => {
          digestCalls.push({ orgId, items });
        },
      }),
    },
    POST_PUBLISH_WORKFLOW: makeBinding(),
    REFRESH_TOKEN_WORKFLOW: makeBinding(),
    AUTOPOST_WORKFLOW: makeBinding(),
    STREAK_WORKFLOW: makeBinding(),
    SEND_EMAIL_WORKFLOW: makeBinding(),
    PROCESS_MEDIA_WORKFLOW: makeBinding(),
    GENERATE_VIDEO_WORKFLOW: makeBinding(),
    CLIPPING_WORKFLOW: makeBinding(),
    CLIPPING_CLIP_WORKFLOW: makeBinding(),
    ENCRYPT_TOKENS_WORKFLOW: makeBinding(),
  } as unknown as Env;

  return { env, store, instances, digestCalls };
}

describe('handleWorkflowControl', () => {
  it('rejects requests without valid bearer secret', async () => {
    const { env } = createMockEnv();
    const res = await handleWorkflowControl(
      new Request('https://worker.test/__cf/workflows/start', {
        method: 'POST',
        body: JSON.stringify({ workflowType: 'postWorkflowV112' }),
      }),
      env
    );
    expect(res.status).toBe(401);
  });

  it('enforces TERMINATE_EXISTING and USE_EXISTING conflict policies', async () => {
    const { env, instances } = createMockEnv();
    const headers = {
      'Content-Type': 'application/json',
      Authorization: 'Bearer super-secret',
    };

    const start1 = await handleWorkflowControl(
      new Request('https://worker.test/__cf/workflows/start', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          workflowType: 'postWorkflowV112',
          workflowId: 'post_123',
          args: [{ taskQueue: 'x', postId: '123', organizationId: 'org1' }],
          searchAttributes: { postId: '123', organizationId: 'org1' },
        }),
      }),
      env
    );
    const body1 = (await start1.json()) as any;
    expect(start1.status).toBe(200);
    expect(body1.reused).toBe(false);

    // USE_EXISTING via signal-with-start reuses and sends poke event
    const pokeRes = await handleWorkflowControl(
      new Request('https://worker.test/__cf/workflows/signal-with-start', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          workflowType: 'postWorkflowV112',
          workflowId: 'post_123',
          signal: 'poke',
          signalArgs: [],
          workflowIdConflictPolicy: 'USE_EXISTING',
          args: [{ taskQueue: 'x', postId: '123', organizationId: 'org1' }],
        }),
      }),
      env
    );
    const pokeBody = (await pokeRes.json()) as any;
    expect(pokeBody.reused).toBe(true);
    expect(instances.get(body1.cfInstanceId)?.events).toEqual([
      { type: 'poke', payload: {} },
    ]);

    // TERMINATE_EXISTING terminates first CF instance and starts a new one
    const start2 = await handleWorkflowControl(
      new Request('https://worker.test/__cf/workflows/start', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          workflowType: 'postWorkflowV112',
          workflowId: 'post_123',
          workflowIdConflictPolicy: 'TERMINATE_EXISTING',
          args: [{ taskQueue: 'x', postId: '123', organizationId: 'org1' }],
        }),
      }),
      env
    );
    const body2 = (await start2.json()) as any;
    expect(body2.reused).toBe(false);
    expect(body2.cfInstanceId).not.toBe(body1.cfInstanceId);
    expect(instances.get(body1.cfInstanceId)?.terminated).toBe(true);
  });

  it('routes digestEmailWorkflow signalWithStart into PostizStateDO digest queue', async () => {
    const { env, digestCalls } = createMockEnv();
    const res = await handleWorkflowControl(
      new Request('https://worker.test/__cf/workflows/signal-with-start', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer super-secret',
        },
        body: JSON.stringify({
          workflowType: 'digestEmailWorkflow',
          workflowId: 'digest_email_workflow_org1',
          signal: 'email',
          signalArgs: [[{ title: 'Published', message: 'Live', type: 'success' }]],
          args: [{ organizationId: 'org1' }],
        }),
      }),
      env
    );

    expect(res.status).toBe(200);
    expect(digestCalls).toEqual([
      {
        orgId: 'org1',
        items: [{ title: 'Published', message: 'Live', type: 'success' }],
      },
    ]);
  });
});
