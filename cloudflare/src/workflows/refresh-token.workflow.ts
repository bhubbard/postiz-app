import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers';
import type { Env, RefreshTokenParams } from '../types';
import {
  recordWorkflowStatus,
  registerChainedWorkflow,
  runActivity,
} from './activity-client';

const RETRY_CONFIG = {
  retries: {
    limit: 3,
    delay: '2 minutes' as const,
    backoff: 'constant' as const,
  },
  timeout: '10 minutes' as const,
};

export class RefreshTokenWorkflow extends WorkflowEntrypoint<
  Env,
  RefreshTokenParams & { workflowId?: string }
> {
  async run(
    event: Readonly<WorkflowEvent<RefreshTokenParams & { workflowId?: string }>>,
    step: WorkflowStep
  ): Promise<boolean> {
    const { integrationId, organizationId } = event.payload;
    const workflowId = event.payload.workflowId || `refresh_${integrationId}`;

    try {
      const integration = await runActivity<any>(
        step,
        'load integration before sleep',
        this.env,
        'integrations',
        'getIntegrationsById',
        [integrationId, organizationId],
        RETRY_CONFIG
      );

      if (
        !integration ||
        integration.deletedAt ||
        integration.inBetweenSteps ||
        integration.refreshNeeded
      ) {
        await step.do('mark inactive', () =>
          recordWorkflowStatus(this.env, workflowId, 'COMPLETED', false)
        );
        return false;
      }

      const expirationMs = new Date(integration.tokenExpiration).getTime();
      if (!Number.isFinite(expirationMs) || expirationMs <= Date.now()) {
        await step.do('mark expired', () =>
          recordWorkflowStatus(this.env, workflowId, 'COMPLETED', false)
        );
        return false;
      }

      await step.sleepUntil('wait token expiration', expirationMs);

      const refreshedCheck = await runActivity<any>(
        step,
        'reload integration after sleep',
        this.env,
        'integrations',
        'getIntegrationsById',
        [integrationId, organizationId],
        RETRY_CONFIG
      );

      if (
        !refreshedCheck ||
        refreshedCheck.deletedAt ||
        refreshedCheck.inBetweenSteps ||
        refreshedCheck.refreshNeeded
      ) {
        await step.do('mark stopped', () =>
          recordWorkflowStatus(this.env, workflowId, 'COMPLETED', false)
        );
        return false;
      }

      await runActivity(
        step,
        'refresh integration token',
        this.env,
        'integrations',
        'refreshToken',
        [refreshedCheck],
        RETRY_CONFIG
      );

      // Schedule next refresh cycle as a fresh Workflow instance to keep step history small
      await step.do('schedule next refresh cycle', async () => {
        const nextInstanceId = `${workflowId}_${crypto.randomUUID().slice(0, 8)}`;
        await this.env.REFRESH_TOKEN_WORKFLOW.create({
          id: nextInstanceId,
          params: { organizationId, integrationId, workflowId },
        });
        await registerChainedWorkflow(
          this.env,
          workflowId,
          'refreshTokenWorkflow',
          nextInstanceId,
          { organizationId }
        );
      });

      return true;
    } catch (err: any) {
      await recordWorkflowStatus(
        this.env,
        workflowId,
        'FAILED',
        undefined,
        err?.message || String(err)
      );
      throw err;
    }
  }
}
