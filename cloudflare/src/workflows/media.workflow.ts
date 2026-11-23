import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers';
import type { Env, GenerateVideoParams, ProcessMediaParams } from '../types';
import {
  parseActivityError,
  recordWorkflowStatus,
  runActivity,
} from './activity-client';

const POLL_INTERVAL = '5 seconds';
const MAX_POLLS = 720; // 1 hour

const CHECK_RETRY_CONFIG = {
  retries: {
    limit: 10,
    delay: '10 seconds' as const,
    backoff: 'exponential' as const,
  },
  timeout: '2 minutes' as const,
};

export class ProcessMediaWorkflow extends WorkflowEntrypoint<
  Env,
  ProcessMediaParams & { workflowId?: string }
> {
  async run(
    event: Readonly<WorkflowEvent<ProcessMediaParams & { workflowId?: string }>>,
    step: WorkflowStep
  ): Promise<void> {
    const { mediaId } = event.payload;
    const workflowId = event.payload.workflowId || `media_${mediaId}`;

    let jobId: string | null;
    try {
      jobId = await runActivity<string | null>(
        step,
        'submit media processing',
        this.env,
        'media',
        'submitMediaProcessing',
        [mediaId],
        {
          retries: { limit: 0, delay: '1 second' },
          timeout: '2 minutes',
        }
      );
    } catch (err) {
      const parsed = parseActivityError(err);
      await runActivity(
        step,
        'fail media submit',
        this.env,
        'media',
        'failMediaProcessing',
        [mediaId, parsed.message || 'Could not submit job'],
        CHECK_RETRY_CONFIG
      );
      await recordWorkflowStatus(this.env, workflowId, 'COMPLETED');
      return;
    }

    if (!jobId) {
      await recordWorkflowStatus(this.env, workflowId, 'COMPLETED');
      return;
    }

    for (let i = 0; i < MAX_POLLS; i++) {
      await step.sleep(`poll wait ${i}`, POLL_INTERVAL);
      try {
        const done = await runActivity<boolean>(
          step,
          `check media ${i}`,
          this.env,
          'media',
          'checkMediaProcessing',
          [mediaId, jobId],
          CHECK_RETRY_CONFIG
        );
        if (done) {
          await recordWorkflowStatus(this.env, workflowId, 'COMPLETED');
          return;
        }
      } catch (err) {
        const parsed = parseActivityError(err);
        await runActivity(
          step,
          'fail media check',
          this.env,
          'media',
          'failMediaProcessing',
          [mediaId, parsed.message || 'Could not check job'],
          CHECK_RETRY_CONFIG
        );
        await recordWorkflowStatus(this.env, workflowId, 'COMPLETED');
        return;
      }
    }

    await runActivity(
      step,
      'timeout media processing',
      this.env,
      'media',
      'failMediaProcessing',
      [mediaId, 'Processing timed out'],
      CHECK_RETRY_CONFIG
    );
    await recordWorkflowStatus(this.env, workflowId, 'COMPLETED');
  }
}

export class GenerateVideoWorkflow extends WorkflowEntrypoint<
  Env,
  GenerateVideoParams & { workflowId?: string }
> {
  async run(
    event: Readonly<WorkflowEvent<GenerateVideoParams & { workflowId?: string }>>,
    step: WorkflowStep
  ): Promise<unknown> {
    const { organizationId, body, workflowId } = event.payload;
    try {
      const media = await runActivity(
        step,
        'generate video',
        this.env,
        'video',
        'generateVideo',
        [organizationId, body],
        {
          retries: { limit: 0, delay: '1 second' },
          timeout: '40 minutes',
        }
      );
      await step.do('save video result', () =>
        recordWorkflowStatus(this.env, workflowId, 'COMPLETED', media)
      );
      return media;
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
