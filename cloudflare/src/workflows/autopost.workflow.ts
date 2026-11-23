import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers';
import type { AutoPostParams, Env } from '../types';
import {
  recordWorkflowStatus,
  registerChainedWorkflow,
  runActivity,
} from './activity-client';

const LOOPS_PER_INSTANCE = 24;

export class AutoPostWorkflow extends WorkflowEntrypoint<
  Env,
  AutoPostParams & { workflowId?: string }
> {
  async run(
    event: Readonly<WorkflowEvent<AutoPostParams & { workflowId?: string }>>,
    step: WorkflowStep
  ): Promise<void> {
    const { id } = event.payload;
    const workflowId = event.payload.workflowId || `autopost-${id}`;
    let immediately = event.payload.immediately;

    try {
      for (let loop = 0; loop < LOOPS_PER_INSTANCE; loop++) {
        if (immediately) {
          try {
            await runActivity(
              step,
              `autopost tick ${loop}`,
              this.env,
              'autopost',
              'autoPost',
              [id],
              {
                retries: {
                  limit: 3,
                  delay: '2 minutes',
                  backoff: 'constant',
                },
                timeout: '10 minutes',
              }
            );
          } catch {
            // Mirrors upstream autopost.workflow.ts: swallow per-run errors and continue hourly.
          }
        }
        immediately = true;
        await step.sleep(`wait 1h ${loop}`, '1 hour');
      }

      await step.do('continue autopost as new', async () => {
        const nextInstanceId = `${workflowId}_${crypto.randomUUID().slice(0, 8)}`;
        await this.env.AUTOPOST_WORKFLOW.create({
          id: nextInstanceId,
          params: { id, immediately: true, workflowId },
        });
        await registerChainedWorkflow(
          this.env,
          workflowId,
          'autoPostWorkflow',
          nextInstanceId
        );
      });
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
