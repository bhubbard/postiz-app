import { requireInternalAuth } from './auth';
import type { DigestEmailItem, Env, WorkflowStatus } from './types';

interface StartRequestBody {
  workflowType: string;
  workflowId?: string;
  taskQueue?: string;
  workflowIdConflictPolicy?: 'USE_EXISTING' | 'TERMINATE_EXISTING' | string;
  args?: any[];
  searchAttributes?: Record<string, string>;
  signal?: string;
  signalArgs?: any[];
}

function getBindingForType(
  env: Env,
  workflowType: string
): Workflow<any> | null {
  switch (workflowType) {
    case 'postWorkflowV112':
      return env.POST_PUBLISH_WORKFLOW;
    case 'refreshTokenWorkflow':
      return env.REFRESH_TOKEN_WORKFLOW;
    case 'autoPostWorkflow':
      return env.AUTOPOST_WORKFLOW;
    case 'streakWorkflowV2':
    case 'streakWorkflow':
      return env.STREAK_WORKFLOW;
    case 'sendSingleEmailWorkflow':
      return env.SEND_EMAIL_WORKFLOW;
    case 'processMediaWorkflow':
      return env.PROCESS_MEDIA_WORKFLOW;
    case 'generateVideoWorkflow':
      return env.GENERATE_VIDEO_WORKFLOW;
    case 'clippingWorkflow':
      return env.CLIPPING_WORKFLOW;
    case 'encryptTokensWorkflow':
      return env.ENCRYPT_TOKENS_WORKFLOW;
    default:
      return null;
  }
}

export function mapCfStatusToTemporal(status: string): WorkflowStatus {
  switch (status) {
    case 'complete':
      return 'COMPLETED';
    case 'errored':
      return 'FAILED';
    case 'terminated':
      return 'TERMINATED';
    case 'queued':
    case 'running':
    case 'paused':
    case 'waiting':
    case 'waitingForPause':
    case 'rollingBack':
    default:
      return 'RUNNING';
  }
}

async function terminateInstanceSafely(
  binding: Workflow<any> | null,
  cfInstanceId: string
): Promise<void> {
  if (!binding) {
    return;
  }
  try {
    const inst = await binding.get(cfInstanceId);
    await inst.terminate();
  } catch {
    // Instance may already be finished or purged.
  }
}

async function startOrReuseWorkflow(
  env: Env,
  body: StartRequestBody
): Promise<{
  workflowId: string;
  cfInstanceId: string;
  reused: boolean;
  binding: Workflow<any>;
}> {
  const binding = getBindingForType(env, body.workflowType);
  if (!binding) {
    throw new Error(`Unsupported Cloudflare workflow type: ${body.workflowType}`);
  }

  const stateId = env.POSTIZ_STATE.idFromName('global');
  const stateStub = env.POSTIZ_STATE.get(stateId);
  const workflowId =
    body.workflowId || `${body.workflowType}_${crypto.randomUUID()}`;
  const existing = await stateStub.getWorkflow(workflowId);

  if (existing && existing.status === 'RUNNING') {
    const existingBinding = getBindingForType(env, existing.workflowType) || binding;
    let liveStatus: WorkflowStatus = 'RUNNING';
    try {
      const inst = await existingBinding.get(existing.cfInstanceId);
      const statusRes = await inst.status();
      liveStatus = mapCfStatusToTemporal(statusRes.status);
      if (liveStatus !== 'RUNNING') {
        await stateStub.updateWorkflowStatus(
          workflowId,
          liveStatus,
          statusRes.output,
          statusRes.error?.message
        );
      }
    } catch {
      liveStatus = 'TERMINATED';
    }

    if (liveStatus === 'RUNNING') {
      if (body.workflowIdConflictPolicy === 'USE_EXISTING') {
        return {
          workflowId,
          cfInstanceId: existing.cfInstanceId,
          reused: true,
          binding: existingBinding,
        };
      }
      await terminateInstanceSafely(existingBinding, existing.cfInstanceId);
      await stateStub.updateWorkflowStatus(workflowId, 'TERMINATED');
    }
  }

  const cfInstanceId = `${workflowId}_${crypto.randomUUID().slice(0, 8)}`;
  const rawParam =
    body.args && body.args.length > 0 && typeof body.args[0] === 'object'
      ? body.args[0]
      : {};
  const params = { ...rawParam, workflowId };

  await binding.create({
    id: cfInstanceId,
    params,
  });

  await stateStub.registerWorkflow({
    workflowId,
    workflowType: body.workflowType,
    cfInstanceId,
    postId: body.searchAttributes?.postId ?? rawParam?.postId ?? null,
    organizationId:
      body.searchAttributes?.organizationId ?? rawParam?.organizationId ?? null,
    status: 'RUNNING',
  });

  return { workflowId, cfInstanceId, reused: false, binding };
}

export async function handleWorkflowControl(
  request: Request,
  env: Env
): Promise<Response> {
  const authError = await requireInternalAuth(
    request,
    env.CLOUDFLARE_INTERNAL_SECRET
  );
  if (authError) {
    return authError;
  }

  const url = new URL(request.url);
  const subPath = url.pathname.replace(/^\/__cf\/workflows/, '');
  const stateId = env.POSTIZ_STATE.idFromName('global');
  const stateStub = env.POSTIZ_STATE.get(stateId);

  if (request.method === 'POST' && subPath === '/start') {
    const body = (await request.json()) as StartRequestBody;
    const started = await startOrReuseWorkflow(env, body);
    return Response.json({
      workflowId: started.workflowId,
      cfInstanceId: started.cfInstanceId,
      reused: started.reused,
    });
  }

  if (request.method === 'POST' && subPath === '/signal-with-start') {
    const body = (await request.json()) as StartRequestBody;

    if (body.workflowType === 'digestEmailWorkflow') {
      const orgId = String(body.args?.[0]?.organizationId ?? '');
      const items = (body.signalArgs?.[0] ?? []) as DigestEmailItem[];
      await stateStub.enqueueDigest(orgId, items);
      return Response.json({ workflowId: body.workflowId, queued: true });
    }

    const started = await startOrReuseWorkflow(env, body);
    if (started.reused && body.signal) {
      const inst = await started.binding.get(started.cfInstanceId);
      await inst.sendEvent({
        type: body.signal,
        payload: body.signalArgs?.[0] ?? {},
      });
    }
    return Response.json({
      workflowId: started.workflowId,
      cfInstanceId: started.cfInstanceId,
      reused: started.reused,
    });
  }

  if (request.method === 'POST' && subPath === '/list') {
    const body = (await request.json()) as { query?: string };
    const workflows = await stateStub.listWorkflowsByQuery(body.query || '');
    return Response.json({ workflows });
  }

  const describeMatch = /^\/describe\/([^/]+)$/.exec(subPath);
  if (request.method === 'GET' && describeMatch) {
    const workflowId = decodeURIComponent(describeMatch[1]);
    const rec = await stateStub.getWorkflow(workflowId);
    if (!rec) {
      return Response.json({ error: 'Workflow not found' }, { status: 404 });
    }

    if (rec.status === 'RUNNING') {
      const binding = getBindingForType(env, rec.workflowType);
      if (binding) {
        try {
          const inst = await binding.get(rec.cfInstanceId);
          const statusRes = await inst.status();
          const mapped = mapCfStatusToTemporal(statusRes.status);
          if (mapped !== 'RUNNING') {
            await stateStub.updateWorkflowStatus(
              workflowId,
              mapped,
              statusRes.output,
              statusRes.error?.message
            );
            return Response.json({ status: { name: mapped } });
          }
        } catch {
          // Keep indexed status if live lookup is unavailable.
        }
      }
    }

    return Response.json({ status: { name: rec.status } });
  }

  const terminateMatch = /^\/terminate\/([^/]+)$/.exec(subPath);
  if (request.method === 'POST' && terminateMatch) {
    const workflowId = decodeURIComponent(terminateMatch[1]);
    const rec = await stateStub.getWorkflow(workflowId);
    if (rec) {
      const binding = getBindingForType(env, rec.workflowType);
      await terminateInstanceSafely(binding, rec.cfInstanceId);
      await stateStub.updateWorkflowStatus(workflowId, 'TERMINATED');
    }
    return Response.json({ ok: true });
  }

  const resultMatch = /^\/result\/([^/]+)$/.exec(subPath);
  if (request.method === 'GET' && resultMatch) {
    const workflowId = decodeURIComponent(resultMatch[1]);
    const rec = await stateStub.getWorkflow(workflowId);
    if (!rec) {
      return Response.json(
        { ok: false, error: 'Workflow not found' },
        { status: 404 }
      );
    }

    const binding = getBindingForType(env, rec.workflowType);
    if (rec.status === 'RUNNING' && binding) {
      try {
        const inst = await binding.get(rec.cfInstanceId);
        const statusRes = await inst.status();
        const mapped = mapCfStatusToTemporal(statusRes.status);
        if (mapped !== 'RUNNING') {
          await stateStub.updateWorkflowStatus(
            workflowId,
            mapped,
            statusRes.output,
            statusRes.error?.message
          );
          if (mapped === 'COMPLETED') {
            return Response.json({ ok: true, output: statusRes.output ?? null });
          }
          return Response.json({
            ok: false,
            error: statusRes.error?.message || `Workflow ${mapped}`,
          });
        }
      } catch (err: any) {
        return Response.json({ ok: false, error: err?.message || String(err) });
      }
    }

    if (rec.status === 'COMPLETED') {
      return Response.json({
        ok: true,
        output: rec.resultJson ? JSON.parse(rec.resultJson) : null,
      });
    }

    return Response.json({
      ok: false,
      error: rec.errorMessage || `Workflow status is ${rec.status}`,
    });
  }

  return Response.json({ error: 'Not Found' }, { status: 404 });
}
