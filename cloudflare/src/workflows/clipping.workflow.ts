import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers';
import type { ClippingClipParams, ClippingParams, Env } from '../types';
import {
  parseActivityError,
  recordWorkflowStatus,
  runActivity,
} from './activity-client';

type ClippingJobState = 'pending' | 'done' | 'retry' | 'failed';

const SUBMIT_RETRY = {
  retries: { limit: 3, delay: '10 seconds' as const, backoff: 'exponential' as const },
  timeout: '2 minutes' as const,
};

const POLL_RETRY = {
  retries: { limit: 10, delay: '10 seconds' as const, backoff: 'exponential' as const },
  timeout: '2 minutes' as const,
};

const AI_RETRY = {
  retries: { limit: 3, delay: '1 minute' as const, backoff: 'constant' as const },
  timeout: '15 minutes' as const,
};

const FAST_POLLS = 12;
const MAX_POLLS = 248; // ~1 hour at 12*5s + 236*15s
const MAX_SUBMITS = 3;

function formatReason(err: unknown, fallback: string) {
  const parsed = parseActivityError(err);
  return {
    error: parsed.message || fallback,
    customer: parsed.isAppFailure && parsed.errorType === 'clipping_stop',
  };
}

async function runPolledJob<T extends { state: ClippingJobState }>(
  step: WorkflowStep,
  label: string,
  env: Env,
  submitMethod: string,
  submitArg: Record<string, unknown>,
  checkMethod: string,
  checkArg: (jobId: string) => Record<string, unknown>
): Promise<T | { state: 'failed' }> {
  for (let attempt = 0; attempt < MAX_SUBMITS; attempt++) {
    const jobId = await runActivity<string>(
      step,
      `${label} submit ${attempt}`,
      env,
      'clipping',
      submitMethod,
      [submitArg],
      SUBMIT_RETRY
    );

    let answer: T | undefined;
    for (let poll = 0; poll < MAX_POLLS; poll++) {
      await step.sleep(
        `${label} sleep ${attempt}-${poll}`,
        poll < FAST_POLLS ? '5 seconds' : '15 seconds'
      );
      answer = await runActivity<T>(
        step,
        `${label} check ${attempt}-${poll}`,
        env,
        'clipping',
        checkMethod,
        [checkArg(jobId)],
        POLL_RETRY
      );
      if (answer.state !== 'pending') {
        break;
      }
    }

    if (answer?.state !== 'retry') {
      return !answer || answer.state === 'pending'
        ? { state: 'failed' }
        : answer;
    }
  }

  return { state: 'failed' };
}

export class ClippingClipWorkflow extends WorkflowEntrypoint<
  Env,
  ClippingClipParams
> {
  async run(
    event: Readonly<WorkflowEvent<ClippingClipParams>>,
    step: WorkflowStep
  ): Promise<void> {
    const { clipId } = event.payload;
    try {
      const fetched = await runPolledJob<{ state: ClippingJobState }>(
        step,
        `clip-fetch-${clipId}`,
        this.env,
        'submitClipFetch',
        { clipId },
        'checkClipFetch',
        (jobId) => ({ clipId, jobId })
      );

      if (fetched.state !== 'done') {
        await runActivity(
          step,
          'fail clip fetch',
          this.env,
          'clipping',
          'failClip',
          [
            {
              clipId,
              error: 'The clip could not be downloaded',
              customer: true,
            },
          ],
          POLL_RETRY
        );
        return;
      }

      await runActivity(
        step,
        'caption clip',
        this.env,
        'clipping',
        'captionClip',
        [{ clipId }],
        AI_RETRY
      );

      const rendered = await runPolledJob<{ state: ClippingJobState }>(
        step,
        `clip-render-${clipId}`,
        this.env,
        'submitClipRender',
        { clipId },
        'checkClipRender',
        (jobId) => ({ clipId, jobId })
      );

      if (rendered.state !== 'done') {
        await runActivity(
          step,
          'fail clip render',
          this.env,
          'clipping',
          'failClip',
          [
            {
              clipId,
              error: 'The clip could not be rendered',
              customer: true,
            },
          ],
          POLL_RETRY
        );
      }
    } catch (err) {
      await runActivity(
        step,
        'fail clip exception',
        this.env,
        'clipping',
        'failClip',
        [{ clipId, ...formatReason(err, 'The clip could not be rendered') }],
        POLL_RETRY
      ).catch(() => {});
    }
  }
}

export class ClippingWorkflow extends WorkflowEntrypoint<
  Env,
  ClippingParams & { workflowId?: string }
> {
  async run(
    event: Readonly<WorkflowEvent<ClippingParams & { workflowId?: string }>>,
    step: WorkflowStep
  ): Promise<void> {
    const { clippingId } = event.payload;
    const workflowId = event.payload.workflowId || `clipping_${clippingId}`;

    try {
      const analysed = await runPolledJob<{
        state: ClippingJobState;
        transcribe?: boolean;
      }>(
        step,
        `analyse-${clippingId}`,
        this.env,
        'submitClippingAnalyse',
        { clippingId },
        'checkClippingAnalyse',
        (jobId) => ({ clippingId, jobId })
      );

      if (analysed.state !== 'done') {
        await runActivity(
          step,
          'fail clipping analyse',
          this.env,
          'clipping',
          'failClipping',
          [
            {
              clippingId,
              error: 'The video could not be analysed',
              customer: true,
            },
          ],
          POLL_RETRY
        );
        await recordWorkflowStatus(this.env, workflowId, 'COMPLETED');
        return;
      }

      if ('transcribe' in analysed && analysed.transcribe) {
        await runActivity(
          step,
          'transcribe clipping',
          this.env,
          'clipping',
          'transcribeClipping',
          [{ clippingId }],
          AI_RETRY
        );
      }

      const clips = await runActivity<string[]>(
        step,
        'pick clipping clips',
        this.env,
        'clipping',
        'pickClippingClips',
        [{ clippingId }],
        AI_RETRY
      );

      if (clips.length > 0) {
        const childInstances = await step.do('spawn clip workflows', async () => {
          const created: string[] = [];
          for (const clipId of clips) {
            const instanceId = `clipping_clip_${clipId}_${crypto.randomUUID().slice(0, 8)}`;
            await this.env.CLIPPING_CLIP_WORKFLOW.create({
              id: instanceId,
              params: { clipId },
            });
            created.push(instanceId);
          }
          return created;
        });

        // Wait for all child clip workflows to finish (max ~75 min)
        let pending = [...childInstances];
        for (let wait = 0; wait < 900 && pending.length > 0; wait++) {
          await step.sleep(`wait clips ${wait}`, '5 seconds');
          pending = await step.do(`check clips ${wait}`, async () => {
            const remaining: string[] = [];
            for (const id of pending) {
              const inst = await this.env.CLIPPING_CLIP_WORKFLOW.get(id);
              const { status } = await inst.status();
              if (
                status !== 'complete' &&
                status !== 'errored' &&
                status !== 'terminated'
              ) {
                remaining.push(id);
              }
            }
            return remaining;
          });
        }
      }
    } catch (err) {
      await runActivity(
        step,
        'fail clipping exception',
        this.env,
        'clipping',
        'failClipping',
        [{ clippingId, ...formatReason(err, 'Clipping failed') }],
        POLL_RETRY
      );
      await recordWorkflowStatus(this.env, workflowId, 'COMPLETED');
      return;
    }

    try {
      await runActivity(
        step,
        'create clipping drafts',
        this.env,
        'clipping',
        'createClippingDrafts',
        [{ clippingId }],
        POLL_RETRY
      );
    } catch (err) {
      await runActivity(
        step,
        'fail clipping drafts',
        this.env,
        'clipping',
        'failClipping',
        [
          {
            clippingId,
            ...formatReason(err, 'The draft posts could not be created'),
          },
        ],
        POLL_RETRY
      );
      await recordWorkflowStatus(this.env, workflowId, 'COMPLETED');
      return;
    }

    await runActivity(
      step,
      'finish clipping',
      this.env,
      'clipping',
      'finishClipping',
      [{ clippingId }],
      POLL_RETRY
    );
    await recordWorkflowStatus(this.env, workflowId, 'COMPLETED');
  }
}
