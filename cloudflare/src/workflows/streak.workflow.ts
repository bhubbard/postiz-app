import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers';
import type { Env, StreakParams } from '../types';
import {
  recordWorkflowStatus,
  registerChainedWorkflow,
  runActivity,
} from './activity-client';

const DAY_MS = 86_400_000;

export class StreakWorkflow extends WorkflowEntrypoint<
  Env,
  StreakParams & { workflowId?: string }
> {
  async run(
    event: Readonly<WorkflowEvent<StreakParams & { workflowId?: string }>>,
    step: WorkflowStep
  ): Promise<void> {
    const { organizationId } = event.payload;
    const workflowId = event.payload.workflowId || `streak_${organizationId}`;
    let lastPost: number =
      event.payload.lastPost !== undefined
        ? event.payload.lastPost
        : await (async () => {
            await runActivity(
              step,
              'start streak',
              this.env,
              'email',
              'setStreak',
              [organizationId, 'start']
            );
            return step.do<number>('record streak start time', async () =>
              Date.now()
            );
          })();

    try {
      for (let check = 0; check < 30; check++) {
        const wakeAt = Math.max(Date.now() + 1000, lastPost + DAY_MS);
        await step.sleepUntil(`wait streak window ${check}`, wakeAt);

        const latestPublish = await runActivity<number | null>(
          step,
          `get last publish date ${check}`,
          this.env,
          'email',
          'getLastPublishDate',
          [organizationId]
        );
        lastPost = Math.max(lastPost, latestPublish || 0);

        const stillActive = await step.do<boolean>(
          `check streak active ${check}`,
          async () => lastPost + DAY_MS > Date.now()
        );
        if (stillActive) {
          continue;
        }

        const userOrgs = await runActivity<{
          users?: Array<{
            user: { email: string; sendStreakEmails?: boolean };
          }>;
        }>(step, 'load streak org users', this.env, 'email', 'getUserOrgs', [
          organizationId,
        ]);

        for (const entry of userOrgs?.users || []) {
          if (!entry.user.sendStreakEmails) {
            continue;
          }
          await runActivity(
            step,
            `send streak ended email ${entry.user.email}`,
            this.env,
            'email',
            'sendEmailAsync',
            [
              entry.user.email,
              'Streak Ended',
              "<p>Your streak has ended! You didn't post anything in the last 24 hours. Schedule a post now to start a new streak!</p>",
              'bottom',
            ]
          );
        }

        await runActivity(step, 'end streak', this.env, 'email', 'setStreak', [
          organizationId,
          'end',
        ]);
        await step.do('mark streak completed', () =>
          recordWorkflowStatus(this.env, workflowId, 'COMPLETED')
        );
        return;
      }

      await step.do('continue streak as new', async () => {
        const nextInstanceId = `${workflowId}_${crypto.randomUUID().slice(0, 8)}`;
        await this.env.STREAK_WORKFLOW.create({
          id: nextInstanceId,
          params: { organizationId, lastPost, workflowId },
        });
        await registerChainedWorkflow(
          this.env,
          workflowId,
          'streakWorkflowV2',
          nextInstanceId,
          { organizationId }
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
