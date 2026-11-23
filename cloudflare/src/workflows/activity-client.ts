import { NonRetryableError } from 'cloudflare:workflows';
import type { WorkflowStep, WorkflowStepConfig } from 'cloudflare:workers';
import type { Env, WorkflowStatus } from '../types';

export interface ParsedAppError {
  isAppFailure: boolean;
  errorType: string;
  message: string;
}

const APP_ERROR_PREFIX = '__POSTIZ_APP_ERR__:';

export async function runActivity<T = unknown>(
  step: WorkflowStep,
  stepName: string,
  env: Env,
  activity: string,
  method: string,
  args: unknown[],
  config?: WorkflowStepConfig
): Promise<T> {
  const execute = async (): Promise<any> => {
    const id = env.POSTIZ_WEB.idFromName('singleton');
    const stub = env.POSTIZ_WEB.get(id);
    const res = (await stub.invokeActivity(activity, method, args)) as
      | { ok: true; result: T }
      | { ok: false; errorType: string; nonRetryable: boolean; message: string };

    if (!res.ok) {
      if (res.nonRetryable) {
        throw new NonRetryableError(
          `${APP_ERROR_PREFIX}${JSON.stringify({
            errorType: res.errorType,
            message: res.message,
          })}`
        );
      }
      throw new Error(res.message || `${activity}.${method} failed`);
    }

    return res.result;
  };

  return (
    config ? step.do<any>(stepName, config, execute) : step.do<any>(stepName, execute)
  ) as Promise<T>;
}

export function parseActivityError(err: unknown): ParsedAppError {
  const raw = err instanceof Error ? err.message : String(err ?? '');
  const idx = raw.indexOf(APP_ERROR_PREFIX);
  if (idx !== -1) {
    try {
      const parsed = JSON.parse(raw.slice(idx + APP_ERROR_PREFIX.length)) as {
        errorType?: string;
        message?: string;
      };
      return {
        isAppFailure: true,
        errorType: parsed.errorType || 'application_failure',
        message: parsed.message || '',
      };
    } catch {
      // Fall through to generic handling.
    }
  }

  return {
    isAppFailure: false,
    errorType: 'unknown',
    message: raw,
  };
}

export async function recordWorkflowStatus(
  env: Env,
  workflowId: string | undefined,
  status: WorkflowStatus,
  result?: unknown,
  errorMessage?: string | null
): Promise<void> {
  if (!workflowId) {
    return;
  }
  const stateId = env.POSTIZ_STATE.idFromName('global');
  const stateStub = env.POSTIZ_STATE.get(stateId);
  await stateStub.updateWorkflowStatus(workflowId, status, result, errorMessage);
}

export async function registerChainedWorkflow(
  env: Env,
  workflowId: string,
  workflowType: string,
  cfInstanceId: string,
  metadata: { postId?: string | null; organizationId?: string | null } = {}
): Promise<void> {
  const stateId = env.POSTIZ_STATE.idFromName('global');
  const stateStub = env.POSTIZ_STATE.get(stateId);
  await stateStub.registerWorkflow({
    workflowId,
    workflowType,
    cfInstanceId,
    postId: metadata.postId ?? null,
    organizationId: metadata.organizationId ?? null,
    status: 'RUNNING',
  });
}
