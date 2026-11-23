import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers';
import type { EncryptTokensParams, Env } from '../types';
import {
  recordWorkflowStatus,
  registerChainedWorkflow,
  runActivity,
} from './activity-client';

export class EncryptTokensWorkflow extends WorkflowEntrypoint<
  Env,
  EncryptTokensParams & { workflowId?: string }
> {
  async run(
    event: Readonly<WorkflowEvent<EncryptTokensParams & { workflowId?: string }>>,
    step: WorkflowStep
  ): Promise<{ changed: number; failed: number }> {
    let lastId = event.payload.lastId;
    let changed = event.payload.changed ?? 0;
    let failed = event.payload.failed ?? 0;
    const workflowId = event.payload.workflowId || 'encrypt_tokens';

    try {
      for (let page = 0; page < 100; page++) {
        const result = await runActivity<{
          changed: number;
          failed: number;
          lastId?: string;
        }>(
          step,
          `encrypt token page ${page}`,
          this.env,
          'integrations',
          'encryptStoredTokens',
          [lastId],
          {
            retries: {
              limit: 3,
              delay: '2 minutes',
              backoff: 'constant',
            },
            timeout: '10 minutes',
          }
        );

        changed += result.changed;
        failed += result.failed;
        if (!result.lastId) {
          const summary = { changed, failed };
          await step.do('mark encrypt completed', () =>
            recordWorkflowStatus(this.env, workflowId, 'COMPLETED', summary)
          );
          return summary;
        }
        lastId = result.lastId;
      }

      await step.do('continue encrypt as new', async () => {
        const nextInstanceId = `${workflowId}_${crypto.randomUUID().slice(0, 8)}`;
        await this.env.ENCRYPT_TOKENS_WORKFLOW.create({
          id: nextInstanceId,
          params: { lastId, changed, failed, workflowId },
        });
        await registerChainedWorkflow(
          this.env,
          workflowId,
          'encryptTokensWorkflow',
          nextInstanceId
        );
      });

      return { changed, failed };
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
