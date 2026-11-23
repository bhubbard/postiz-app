import type { PostizStateDO } from './state-do';
import type { PostizWebContainer } from './web-container';

export interface Env {
  POSTIZ_WEB: DurableObjectNamespace<PostizWebContainer>;
  POSTIZ_STATE: DurableObjectNamespace<PostizStateDO>;
  POSTIZ_MEDIA: R2Bucket;

  POST_PUBLISH_WORKFLOW: Workflow<PostPublishParams>;
  REFRESH_TOKEN_WORKFLOW: Workflow<RefreshTokenParams>;
  AUTOPOST_WORKFLOW: Workflow<AutoPostParams>;
  STREAK_WORKFLOW: Workflow<StreakParams>;
  SEND_EMAIL_WORKFLOW: Workflow<SendEmailParams>;
  PROCESS_MEDIA_WORKFLOW: Workflow<ProcessMediaParams>;
  GENERATE_VIDEO_WORKFLOW: Workflow<GenerateVideoParams>;
  CLIPPING_WORKFLOW: Workflow<ClippingParams>;
  CLIPPING_CLIP_WORKFLOW: Workflow<ClippingClipParams>;
  ENCRYPT_TOKENS_WORKFLOW: Workflow<EncryptTokensParams>;

  DATABASE_URL?: string;
  JWT_SECRET?: string;
  CLOUDFLARE_INTERNAL_SECRET?: string;
  CLOUDFLARE_INTERNAL_URL?: string;
  MAIN_URL?: string;
  FRONTEND_URL?: string;
  NEXT_PUBLIC_BACKEND_URL?: string;
  BACKEND_INTERNAL_URL?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_ACCESS_KEY?: string;
  CLOUDFLARE_SECRET_ACCESS_KEY?: string;
  CLOUDFLARE_BUCKETNAME?: string;
  CLOUDFLARE_BUCKET_URL?: string;
  CLOUDFLARE_REGION?: string;
  STORAGE_PROVIDER?: string;
  WORKFLOW_DRIVER?: string;
  REDIS_DRIVER?: string;
  IS_GENERAL?: string;
  DISABLE_REGISTRATION?: string;
  NOT_SECURED?: string;
  API_LIMIT?: string;
  ENCRYPTION_PROVIDER?: string;
  ENCRYPTION_KEY?: string;
  EMAIL_PROVIDER?: string;
  EMAIL_FROM_ADDRESS?: string;
  EMAIL_FROM_NAME?: string;
  RESEND_API_KEY?: string;
  OPENAI_API_KEY?: string;
  DEEPGRAM_API_KEY?: string;
  RUNPOD_API_KEY?: string;
  RUNPOD_ENDPOINT_ID?: string;
  RUNPOD_INGEST_ENDPOINT_ID?: string;
  RUNPOD_CLIPPER_ENDPOINT_ID?: string;
  STRIPE_PUBLISHABLE_KEY?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_SIGNING_KEY?: string;
  STRIPE_SIGNING_KEY_CONNECT?: string;
  RUN_MIGRATIONS?: string;
  POSTIZ_EXTRA_ENV_JSON?: string;
  [key: string]: unknown;
}

export interface PostPublishParams {
  taskQueue: string;
  postId: string;
  organizationId: string;
  postNow?: boolean;
  workflowId?: string;
}

export interface RefreshTokenParams {
  organizationId: string;
  integrationId: string;
  workflowId?: string;
}

export interface AutoPostParams {
  id: string;
  immediately: boolean;
  workflowId?: string;
}

export interface StreakParams {
  organizationId: string;
  lastPost?: number;
  workflowId?: string;
}

export interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
  replyTo?: string;
  addTo: 'top' | 'bottom';
  workflowId?: string;
}

export interface ProcessMediaParams {
  mediaId: string;
  workflowId?: string;
}

export interface GenerateVideoParams {
  organizationId: string;
  body: Record<string, unknown>;
  workflowId?: string;
}

export interface ClippingParams {
  clippingId: string;
  workflowId?: string;
}

export interface ClippingClipParams {
  clipId: string;
}

export interface EncryptTokensParams {
  lastId?: string;
  changed?: number;
  failed?: number;
  workflowId?: string;
}

export interface DigestEmailItem {
  title: string;
  message: string;
  type: 'success' | 'fail' | 'info';
}

export type WorkflowStatus =
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'TERMINATED';

export interface WorkflowIndexRecord {
  workflowId: string;
  workflowType: string;
  cfInstanceId: string;
  postId: string | null;
  organizationId: string | null;
  status: WorkflowStatus;
  resultJson: string | null;
  errorMessage: string | null;
  updatedAt: number;
}
