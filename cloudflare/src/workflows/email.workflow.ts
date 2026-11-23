import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers';
import type { Env, SendEmailParams } from '../types';
import { recordWorkflowStatus, runActivity } from './activity-client';

export class SendEmailWorkflow extends WorkflowEntrypoint<
  Env,
  SendEmailParams & { workflowId?: string }
> {
  async run(
    event: Readonly<WorkflowEvent<SendEmailParams & { workflowId?: string }>>,
    step: WorkflowStep
  ): Promise<void> {
    const { to, subject, html, replyTo, workflowId } = event.payload;
    try {
      await runActivity(
        step,
        'send email',
        this.env,
        'email',
        'sendEmail',
        [to, subject, html, replyTo],
        {
          retries: {
            limit: 5,
            delay: '2 seconds',
            backoff: 'exponential',
          },
          timeout: '10 minutes',
        }
      );
      await step.do('mark completed', () =>
        recordWorkflowStatus(this.env, workflowId, 'COMPLETED')
      );
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
