import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers';
import type { Env, PostPublishParams } from '../types';
import {
  parseActivityError,
  recordWorkflowStatus,
  registerChainedWorkflow,
  runActivity,
} from './activity-client';

const STANDARD_RETRY = {
  retries: {
    limit: 3,
    delay: '2 minutes' as const,
    backoff: 'constant' as const,
  },
  timeout: '10 minutes' as const,
};

const CHECK_RETRY = {
  retries: {
    limit: 3,
    delay: '10 seconds' as const,
    backoff: 'constant' as const,
  },
  timeout: '2 minutes' as const,
};

const MUTATION_NO_RETRY = {
  retries: {
    limit: 0,
    delay: '1 second' as const,
  },
  timeout: '30 minutes' as const,
};

const MAX_PENDING_CHECKS = 90;
const MAX_PUBLISH_ATTEMPTS = 5;
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export class PostPublishWorkflow extends WorkflowEntrypoint<
  Env,
  PostPublishParams & { workflowId?: string }
> {
  async run(
    event: Readonly<WorkflowEvent<PostPublishParams & { workflowId?: string }>>,
    step: WorkflowStep
  ): Promise<boolean> {
    const { taskQueue, postId, organizationId, postNow = false } = event.payload;
    const workflowId = event.payload.workflowId || `post_${postId}`;

    try {
      const outcome = await this.executePublish(
        step,
        taskQueue,
        postId,
        organizationId,
        postNow
      );
      await step.do('mark post workflow completed', () =>
        recordWorkflowStatus(this.env, workflowId, 'COMPLETED', outcome)
      );
      return outcome;
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

  private async executePublish(
    step: WorkflowStep,
    taskQueue: string,
    postId: string,
    organizationId: string,
    postNow: boolean
  ): Promise<boolean> {
    const firstPost = await runActivity<any>(
      step,
      'load initial post',
      this.env,
      'post',
      'getPost',
      [organizationId, postId],
      STANDARD_RETRY
    );

    if (!firstPost) {
      await runActivity(
        step,
        'mark missing post error',
        this.env,
        'post',
        'changeState',
        [postId, 'ERROR', 'No Post'],
        STANDARD_RETRY
      );
      return false;
    }

    if (!postNow && firstPost.state !== 'QUEUE') {
      await runActivity(
        step,
        'mark already posted error',
        this.env,
        'post',
        'changeState',
        [firstPost.id, 'ERROR', 'Already posted', [firstPost]],
        STANDARD_RETRY
      );
      return false;
    }

    if (!postNow && firstPost.publishDate) {
      const waitMs = Math.max(
        0,
        new Date(firstPost.publishDate).getTime() - Date.now()
      );
      if (waitMs > 0) {
        try {
          await step.waitForEvent('wait publish date or poke', {
            type: 'poke',
            timeout: Math.min(waitMs, ONE_YEAR_MS),
          });
        } catch {
          // Normal timeout when scheduled publishDate is reached.
        }
      }
    }

    const startTimeMs = await step.do<number>(
      'capture publish start time',
      async () => Date.now()
    );

    const postsListBefore = await runActivity<any[]>(
      step,
      'load post thread list',
      this.env,
      'post',
      'getPostsList',
      [organizationId, postId],
      STANDARD_RETRY
    );

    const [post] = postsListBefore || [];
    if (!post) {
      await runActivity(
        step,
        'mark missing post after wait',
        this.env,
        'post',
        'changeState',
        [postId, 'ERROR', 'No Post'],
        STANDARD_RETRY
      );
      return false;
    }

    if (post.integration?.refreshNeeded) {
      await runActivity(
        step,
        'notify refresh needed',
        this.env,
        'post',
        'inAppNotification',
        [
          post.organizationId,
          `We couldn't post to ${post.integration?.providerIdentifier} for ${post?.integration?.name}`,
          `We couldn't post to ${post.integration?.providerIdentifier} for ${post?.integration?.name} because you need to reconnect it. Please enable it and try again.`,
          true,
          false,
          'info',
        ],
        STANDARD_RETRY
      );
      await runActivity(
        step,
        'mark refresh needed error',
        this.env,
        'post',
        'changeState',
        [postsListBefore[0].id, 'ERROR', 'Refresh channel needed', postsListBefore],
        STANDARD_RETRY
      );
      return false;
    }

    if (post.integration?.disabled) {
      await runActivity(
        step,
        'notify channel disabled',
        this.env,
        'post',
        'inAppNotification',
        [
          post.organizationId,
          `We couldn't post to ${post.integration?.providerIdentifier} for ${post?.integration?.name}`,
          `We couldn't post to ${post.integration?.providerIdentifier} for ${post?.integration?.name} because it's disabled. Please enable it and try again.`,
          true,
          false,
          'info',
        ],
        STANDARD_RETRY
      );
      await runActivity(
        step,
        'mark channel disabled error',
        this.env,
        'post',
        'changeState',
        [postsListBefore[0].id, 'ERROR', 'Channel disabled', postsListBefore],
        STANDARD_RETRY
      );
      return false;
    }

    const toComment =
      postsListBefore.length === 1
        ? false
        : await runActivity<boolean>(
            step,
            'check commentable integration',
            this.env,
            'post',
            'isCommentable',
            [post.integration],
            STANDARD_RETRY
          );

    const postsList = toComment ? postsListBefore : [postsListBefore[0]];
    const postsResults: any[] = [];

    const classifyAndRefresh = async (
      err: unknown,
      stepPrefix: string,
      getIntegration?: () => Promise<any>
    ): Promise<{
      type: 'retry' | 'stop' | 'bad-body' | 'unknown';
      message: string;
    }> => {
      const parsed = parseActivityError(err);
      if (parsed.isAppFailure && parsed.errorType === 'refresh_token') {
        const integrationTarget = getIntegration
          ? await getIntegration()
          : post.integration;
        const refreshed = await runActivity<any>(
          step,
          `${stepPrefix} refresh token`,
          this.env,
          'post',
          'refreshTokenWithCause',
          [integrationTarget, parsed.message || ''],
          STANDARD_RETRY
        );
        if (!refreshed || !refreshed.accessToken) {
          return { type: 'stop', message: parsed.message || '' };
        }
        if (!getIntegration) {
          post.integration.token = refreshed.accessToken;
        }
        return { type: 'retry', message: parsed.message || '' };
      }

      if (parsed.isAppFailure && parsed.errorType === 'bad_body') {
        return { type: 'bad-body', message: parsed.message || '' };
      }

      return { type: 'unknown', message: parsed.message || '' };
    };

    const markUnconfirmed = async (err: unknown, suffix: string) => {
      const message = err instanceof Error ? err.message : String(err ?? '');
      await runActivity(
        step,
        `mark unconfirmed ${suffix}`,
        this.env,
        'post',
        'changeState',
        [postsList[0].id, 'ERROR', message, postsList],
        STANDARD_RETRY
      );
      const provider = post.integration?.providerIdentifier || '';
      const capitalized =
        provider.charAt(0).toUpperCase() + provider.slice(1);
      await runActivity(
        step,
        `notify unconfirmed ${suffix}`,
        this.env,
        'post',
        'inAppNotification',
        [
          post.organizationId,
          `We couldn't confirm your post on ${capitalized}`,
          `Your post was sent to ${capitalized}, but we couldn't confirm it was published. Please check your ${post?.integration?.name} account before posting again to avoid duplicates.`,
          true,
          false,
          'fail',
        ],
        STANDARD_RETRY
      );
    };

    const resolvePending = async (
      pending: any,
      postIdx: number
    ): Promise<any | false> => {
      let pendingData = pending.pendingData;
      let errorAttempts = 0;

      for (let check = 0; check < MAX_PENDING_CHECKS; check++) {
        try {
          let result = await runActivity<any>(
            step,
            `check post status ${postIdx}-${check}`,
            this.env,
            'post',
            'checkPostStatus',
            [post.integration, pendingData],
            CHECK_RETRY
          );

          if (result.status !== 'completed') {
            pendingData = result.pendingData;
          }

          if (result.status === 'ready') {
            result = await runActivity<any>(
              step,
              `finalize post ${postIdx}-${check}`,
              this.env,
              'post',
              'finalizePost',
              [post.integration, result.pendingData],
              MUTATION_NO_RETRY
            );
          }

          if (result.status === 'completed') {
            return {
              id: pending.id,
              postId: result.postId,
              releaseURL: result.releaseURL,
              status: 'success',
            };
          }

          pendingData = result.pendingData;
          errorAttempts = 0;
        } catch (err) {
          const handled = await classifyAndRefresh(
            err,
            `pending-${postIdx}-${check}`
          );
          if (handled.type === 'retry') {
            continue;
          }
          if (handled.type === 'stop') {
            await markUnconfirmed(handled.message, `pending-stop-${postIdx}`);
            return false;
          }
          if (handled.type === 'bad-body') {
            await runActivity(
              step,
              `mark pending bad body ${postIdx}`,
              this.env,
              'post',
              'changeState',
              [postsList[0].id, 'ERROR', handled.message, postsList],
              STANDARD_RETRY
            );
            await runActivity(
              step,
              `notify pending bad body ${postIdx}`,
              this.env,
              'post',
              'inAppNotification',
              [
                post.organizationId,
                `Error posting on ${post.integration?.providerIdentifier} for ${post?.integration?.name}`,
                `An error occurred while posting on ${post.integration?.providerIdentifier}${handled.message ? `: ${handled.message}` : ''}`,
                true,
                false,
                'fail',
              ],
              STANDARD_RETRY
            );
            return false;
          }

          errorAttempts++;
          if (errorAttempts >= MAX_PUBLISH_ATTEMPTS) {
            break;
          }
        }

        await step.sleep(`wait pending poll ${postIdx}-${check}`, '20 seconds');
      }

      await markUnconfirmed('Could not confirm the post status', `pending-max-${postIdx}`);
      return false;
    };

    for (let i = 0; i < postsList.length; i++) {
      const before = postsResults.length;
      let posted = false;
      let updated = false;

      for (let attempt = 0; attempt < MAX_PUBLISH_ATTEMPTS; attempt++) {
        try {
          if (i === 0) {
            const res = await runActivity<any[]>(
              step,
              `publish main post ${attempt}`,
              this.env,
              'post',
              'postSocialPending',
              [post.integration, [postsList[i]]],
              MUTATION_NO_RETRY
            );
            postsResults.push(...res);
          } else {
            if (postsList[i].delay) {
              const delayMs = 60_000 * Math.max(0, Number(postsList[i].delay ?? 0));
              if (delayMs > 0 && attempt === 0) {
                await step.sleep(`comment delay ${i}`, delayMs);
              }
            }
            const res = await runActivity<any[]>(
              step,
              `publish comment ${i}-${attempt}`,
              this.env,
              'post',
              'postComment',
              [
                postsResults[0].postId,
                postsResults.length === 1
                  ? undefined
                  : postsResults[i - 1].postId,
                post.integration,
                [postsList[i]],
              ],
              MUTATION_NO_RETRY
            );
            postsResults.push(...res);
          }

          posted = true;

          if (postsResults[i].status === 'pending') {
            let resolved: any | false = false;
            try {
              resolved = await resolvePending(postsResults[i], i);
            } catch (err) {
              await markUnconfirmed(err, `pending-exc-${i}`).catch(() => {});
              resolved = false;
            }
            if (!resolved) {
              return false;
            }
            postsResults[i] = resolved;
          }

          await runActivity(
            step,
            `update post row ${i}`,
            this.env,
            'post',
            'updatePost',
            [postsList[i].id, postsResults[i].postId, postsResults[i].releaseURL],
            STANDARD_RETRY
          );
          updated = true;

          if (i === 0) {
            const provider = post.integration.providerIdentifier || '';
            const capitalized =
              provider.charAt(0).toUpperCase() + provider.slice(1);
            await runActivity(
              step,
              'notify post published',
              this.env,
              'post',
              'inAppNotification',
              [
                post.integration.organizationId,
                `Your post has been published on ${capitalized}`,
                `Your post has been published on ${capitalized} at ${postsResults[0].releaseURL}`,
                true,
                true,
              ],
              STANDARD_RETRY
            );
          }

          break;
        } catch (err) {
          if (posted) {
            if (!updated) {
              await markUnconfirmed(err, `post-update-${i}`).catch(() => {});
              return false;
            }
            break;
          }

          const handled = await classifyAndRefresh(err, `publish-${i}-${attempt}`);
          if (handled.type === 'retry') {
            continue;
          }

          await runActivity(
            step,
            `mark publish error ${i}-${attempt}`,
            this.env,
            'post',
            'changeState',
            [
              postsList[0].id,
              'ERROR',
              handled.message || (err instanceof Error ? err.message : String(err)),
              postsList,
            ],
            STANDARD_RETRY
          );

          if (handled.type === 'stop') {
            return false;
          }

          if (handled.type === 'bad-body') {
            await runActivity(
              step,
              `notify bad body ${i}`,
              this.env,
              'post',
              'inAppNotification',
              [
                post.organizationId,
                `Error posting${i === 0 ? ' ' : ' comments '}on ${post.integration?.providerIdentifier} for ${post?.integration?.name}`,
                `An error occurred while posting${i === 0 ? ' ' : ' comments '}on ${post.integration?.providerIdentifier}${handled.message ? `: ${handled.message}` : ''}`,
                true,
                false,
                'fail',
              ],
              STANDARD_RETRY
            );
            return false;
          }
        }
      }

      if (postsResults.length === before) {
        await markUnconfirmed(
          'Could not publish after several attempts',
          `exhausted-${i}`
        ).catch(() => {});
        return false;
      }
    }

    await runActivity(
      step,
      'send post webhooks',
      this.env,
      'post',
      'sendWebhooks',
      [postsResults[0].postId, post.organizationId, post.integration.id],
      STANDARD_RETRY
    );

    const internalPlugsList = await runActivity<any[]>(
      step,
      'load internal plugs',
      this.env,
      'post',
      'internalPlugs',
      [post.integration, JSON.parse(post.settings)],
      STANDARD_RETRY
    );

    const rawGlobalPlugs = await runActivity<any[]>(
      step,
      'load global plugs',
      this.env,
      'post',
      'globalPlugs',
      [post.integration],
      STANDARD_RETRY
    );

    const globalPlugsList = (rawGlobalPlugs || []).reduce((all: any[], current) => {
      for (let i = 1; i <= current.totalRuns; i++) {
        all.push({
          ...current,
          delay: current.delay * i,
        });
      }
      return all;
    }, []);

    const repeatPost = !post.intervalInDays
      ? []
      : [
          {
            type: 'repeat-post',
            delay:
              post.intervalInDays * 24 * 60 * 60 * 1000 -
              (Date.now() - startTimeMs),
          },
        ];

    const queue = [
      ...(internalPlugsList || []),
      ...globalPlugsList,
      ...repeatPost,
    ].sort((a, b) => Number(a.delay ?? 0) - Number(b.delay ?? 0));

    let plugSeq = 0;
    while (queue.length > 0) {
      const todo = queue.shift()!;
      const seq = plugSeq++;
      const delayMs = Math.max(0, Number(todo.delay ?? 0));
      if (delayMs > 0) {
        await step.sleep(`wait plug ${seq}`, Math.min(delayMs, ONE_YEAR_MS));
      }

      if (todo.type === 'internal-plug') {
        for (let attempt = 0; attempt < MAX_PUBLISH_ATTEMPTS; attempt++) {
          try {
            await runActivity(
              step,
              `run internal plug ${seq}-${attempt}`,
              this.env,
              'post',
              'processInternalPlug',
              [{ ...todo, post: postsResults[0].postId }],
              STANDARD_RETRY
            );
            break;
          } catch (err) {
            const handled = await classifyAndRefresh(
              err,
              `internal-plug-${seq}-${attempt}`,
              () =>
                runActivity(
                  step,
                  `load plug integration ${seq}-${attempt}`,
                  this.env,
                  'post',
                  'getIntegrationById',
                  [organizationId, todo.integration],
                  STANDARD_RETRY
                )
            );
            if (handled.type === 'stop' || handled.type === 'bad-body') {
              break;
            }
          }
        }
      }

      if (todo.type === 'global') {
        for (let attempt = 0; attempt < MAX_PUBLISH_ATTEMPTS; attempt++) {
          try {
            const done = await runActivity<boolean>(
              step,
              `run global plug ${seq}-${attempt}`,
              this.env,
              'post',
              'processPlug',
              [{ ...todo, postId: postsResults[0].postId }],
              STANDARD_RETRY
            );
            if (done) {
              for (let idx = queue.length - 1; idx >= 0; idx--) {
                if (queue[idx].plugId === todo.plugId) {
                  queue.splice(idx, 1);
                }
              }
            }
            break;
          } catch (err) {
            const handled = await classifyAndRefresh(
              err,
              `global-plug-${seq}-${attempt}`
            );
            if (handled.type === 'stop' || handled.type === 'bad-body') {
              break;
            }
          }
        }
      }

      if (todo.type === 'repeat-post') {
        await step.do(`spawn repeat post ${seq}`, async () => {
          const childWorkflowId = `post_${post.id}_${crypto.randomUUID().slice(0, 10)}`;
          const cfInstanceId = `${childWorkflowId}_${crypto.randomUUID().slice(0, 8)}`;
          await this.env.POST_PUBLISH_WORKFLOW.create({
            id: cfInstanceId,
            params: {
              taskQueue,
              postId,
              organizationId,
              postNow: true,
              workflowId: childWorkflowId,
            },
          });
          await registerChainedWorkflow(
            this.env,
            childWorkflowId,
            'postWorkflowV112',
            cfInstanceId,
            { postId, organizationId }
          );
        });
      }
    }

    return true;
  }
}
