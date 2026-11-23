import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'crypto';
import { Response } from 'express';
import { ApplicationFailure } from '@temporalio/common';
import { AutopostActivity } from '@gitroom/orchestrator/activities/autopost.activity';
import { ClippingActivity } from '@gitroom/orchestrator/activities/clipping.activity';
import { EmailActivity } from '@gitroom/orchestrator/activities/email.activity';
import { IntegrationsActivity } from '@gitroom/orchestrator/activities/integrations.activity';
import { MediaActivity } from '@gitroom/orchestrator/activities/media.activity';
import { PostActivity } from '@gitroom/orchestrator/activities/post.activity';
import { VideoActivity } from '@gitroom/orchestrator/activities/video.activity';

const ALLOWED_METHODS: Record<string, Set<string>> = {
  post: new Set([
    'getIntegrationById',
    'searchForMissingThreeHoursPosts',
    'updatePost',
    'getPost',
    'getPostsList',
    'isCommentable',
    'postComment',
    'postSocial',
    'postSocialPending',
    'checkPostStatus',
    'finalizePost',
    'inAppNotification',
    'globalPlugs',
    'changeState',
    'internalPlugs',
    'sendWebhooks',
    'processPlug',
    'processInternalPlug',
    'refreshToken',
    'refreshTokenWithCause',
  ]),
  autopost: new Set(['autoPost']),
  email: new Set([
    'sendEmail',
    'sendEmailAsync',
    'getUserOrgs',
    'setStreak',
    'getLastPublishDate',
  ]),
  integrations: new Set([
    'getIntegrationsById',
    'refreshToken',
    'encryptStoredTokens',
  ]),
  media: new Set([
    'submitMediaProcessing',
    'checkMediaProcessing',
    'failMediaProcessing',
  ]),
  video: new Set(['generateVideo']),
  clipping: new Set([
    'submitClippingAnalyse',
    'checkClippingAnalyse',
    'transcribeClipping',
    'pickClippingClips',
    'submitClipFetch',
    'checkClipFetch',
    'captionClip',
    'submitClipRender',
    'checkClipRender',
    'failClip',
    'createClippingDrafts',
    'finishClipping',
    'failClipping',
  ]),
};

function constantTimeBearerEquals(
  authHeader: string | undefined,
  expectedSecret: string | undefined
): boolean {
  if (!authHeader || !expectedSecret) {
    return false;
  }
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  if (!match) {
    return false;
  }
  const providedDigest = createHash('sha256').update(match[1]).digest();
  const expectedDigest = createHash('sha256').update(expectedSecret).digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

@Controller('/internal')
export class InternalActivitiesController {
  private readonly activities: Record<string, any>;

  constructor(
    postActivity: PostActivity,
    autopostActivity: AutopostActivity,
    emailActivity: EmailActivity,
    integrationsActivity: IntegrationsActivity,
    videoActivity: VideoActivity,
    mediaActivity: MediaActivity,
    clippingActivity: ClippingActivity
  ) {
    this.activities = {
      post: postActivity,
      autopost: autopostActivity,
      email: emailActivity,
      integrations: integrationsActivity,
      video: videoActivity,
      media: mediaActivity,
      clipping: clippingActivity,
    };
  }

  @Get('/health')
  health() {
    return {
      status: 'ok',
      driver: process.env.WORKFLOW_DRIVER || 'temporal',
    };
  }

  @Post('/activities/:activity/:method')
  @HttpCode(200)
  async invokeActivity(
    @Param('activity') activity: string,
    @Param('method') method: string,
    @Headers('authorization') authorization: string | undefined,
    @Body() body: { args?: unknown[] } | undefined,
    @Res() res: Response
  ) {
    if (
      !constantTimeBearerEquals(
        authorization,
        process.env.CLOUDFLARE_INTERNAL_SECRET
      )
    ) {
      throw new UnauthorizedException('Invalid internal activity token');
    }

    const allowed = ALLOWED_METHODS[activity];
    const target = this.activities[activity];
    if (!allowed || !target || !allowed.has(method) || typeof target[method] !== 'function') {
      throw new NotFoundException(`Unknown activity ${activity}.${method}`);
    }

    const args = body?.args ?? [];
    if (!Array.isArray(args)) {
      throw new BadRequestException('args must be an array');
    }

    try {
      const result = await target[method](...args);
      return res.status(200).json({ ok: true, result: result ?? null });
    } catch (err: any) {
      const isAppFailure =
        err instanceof ApplicationFailure ||
        (typeof err?.type === 'string' && typeof err?.nonRetryable === 'boolean');

      if (isAppFailure) {
        return res.status(200).json({
          ok: false,
          errorType: err.type || 'application_failure',
          nonRetryable: Boolean(err.nonRetryable),
          message: err?.message || String(err),
        });
      }

      return res.status(500).json({
        ok: false,
        errorType: 'unknown',
        nonRetryable: false,
        message: err?.message || String(err),
      });
    }
  }
}
