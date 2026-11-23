import { Module } from '@nestjs/common';
import { AutopostActivity } from '@gitroom/orchestrator/activities/autopost.activity';
import { ClippingActivity } from '@gitroom/orchestrator/activities/clipping.activity';
import { EmailActivity } from '@gitroom/orchestrator/activities/email.activity';
import { IntegrationsActivity } from '@gitroom/orchestrator/activities/integrations.activity';
import { MediaActivity } from '@gitroom/orchestrator/activities/media.activity';
import { PostActivity } from '@gitroom/orchestrator/activities/post.activity';
import { VideoActivity } from '@gitroom/orchestrator/activities/video.activity';
import { InternalActivitiesController } from '@gitroom/backend/internal/internal-activities.controller';

const activities = [
  PostActivity,
  AutopostActivity,
  EmailActivity,
  IntegrationsActivity,
  VideoActivity,
  MediaActivity,
  ClippingActivity,
];

@Module({
  controllers: [InternalActivitiesController],
  providers: [...activities],
})
export class InternalActivitiesModule {}
