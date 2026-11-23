import {
  bindings,
  defineConfig,
  defineContainer,
  defineWorker,
  exports,
  triggers,
} from 'cf/config';

const workerName = process.env.CF_WORKER_NAME || 'postiz-cloudflare';
const bucketName = process.env.CLOUDFLARE_BUCKETNAME || 'postiz-media';

const postizWebContainer = defineContainer({
  name: `${workerName}-web`,
  image: {
    dockerfile: './Dockerfile',
    buildContext: '..',
    buildVars: {
      NEXT_PUBLIC_VERSION: process.env.NEXT_PUBLIC_VERSION || 'cf-track2',
    },
  },
  instanceType: 'standard-1',
  maxInstances: 4,
});

export default defineConfig(({ mode }) => {
  const skipContainer = mode === 'worker-only';

  const worker = defineWorker({
    name: workerName,
    compatibilityDate: '2026-10-13',
    compatibilityFlags: ['nodejs_compat'],
    entrypoint: './src/index.ts',
    triggers: [
      triggers.scheduled({
        schedule: '0 * * * *',
      }),
    ],
    exports: {
      PostizWebContainer: exports.durableObject({
        storage: 'sqlite',
        ...(skipContainer ? {} : { container: postizWebContainer }),
      }),
      PostizStateDO: exports.durableObject({
        storage: 'sqlite',
      }),
      PostPublishWorkflow: exports.workflow({
        name: `${workerName}-post-publish`,
        limits: { steps: 25000 },
      }),
      RefreshTokenWorkflow: exports.workflow({
        name: `${workerName}-refresh-token`,
        limits: { steps: 1000 },
      }),
      AutoPostWorkflow: exports.workflow({
        name: `${workerName}-autopost`,
        limits: { steps: 5000 },
      }),
      StreakWorkflow: exports.workflow({
        name: `${workerName}-streak`,
        limits: { steps: 5000 },
      }),
      SendEmailWorkflow: exports.workflow({
        name: `${workerName}-send-email`,
        limits: { steps: 100 },
      }),
      ProcessMediaWorkflow: exports.workflow({
        name: `${workerName}-process-media`,
        limits: { steps: 5000 },
      }),
      GenerateVideoWorkflow: exports.workflow({
        name: `${workerName}-generate-video`,
        limits: { steps: 100 },
      }),
      ClippingWorkflow: exports.workflow({
        name: `${workerName}-clipping`,
        limits: { steps: 10000 },
      }),
      ClippingClipWorkflow: exports.workflow({
        name: `${workerName}-clipping-clip`,
        limits: { steps: 5000 },
      }),
      EncryptTokensWorkflow: exports.workflow({
        name: `${workerName}-encrypt-tokens`,
        limits: { steps: 5000 },
      }),
    },
    env: {
      POSTIZ_WEB: bindings.durableObject({
        worker: workerName,
        exportName: 'PostizWebContainer',
      }),
      POSTIZ_STATE: bindings.durableObject({
        worker: workerName,
        exportName: 'PostizStateDO',
      }),
      POSTIZ_MEDIA: bindings.r2({
        name: bucketName,
      }),
      POST_PUBLISH_WORKFLOW: bindings.workflow({
        name: `${workerName}-post-publish`,
        worker: workerName,
        exportName: 'PostPublishWorkflow',
      }),
      REFRESH_TOKEN_WORKFLOW: bindings.workflow({
        name: `${workerName}-refresh-token`,
        worker: workerName,
        exportName: 'RefreshTokenWorkflow',
      }),
      AUTOPOST_WORKFLOW: bindings.workflow({
        name: `${workerName}-autopost`,
        worker: workerName,
        exportName: 'AutoPostWorkflow',
      }),
      STREAK_WORKFLOW: bindings.workflow({
        name: `${workerName}-streak`,
        worker: workerName,
        exportName: 'StreakWorkflow',
      }),
      SEND_EMAIL_WORKFLOW: bindings.workflow({
        name: `${workerName}-send-email`,
        worker: workerName,
        exportName: 'SendEmailWorkflow',
      }),
      PROCESS_MEDIA_WORKFLOW: bindings.workflow({
        name: `${workerName}-process-media`,
        worker: workerName,
        exportName: 'ProcessMediaWorkflow',
      }),
      GENERATE_VIDEO_WORKFLOW: bindings.workflow({
        name: `${workerName}-generate-video`,
        worker: workerName,
        exportName: 'GenerateVideoWorkflow',
      }),
      CLIPPING_WORKFLOW: bindings.workflow({
        name: `${workerName}-clipping`,
        worker: workerName,
        exportName: 'ClippingWorkflow',
      }),
      CLIPPING_CLIP_WORKFLOW: bindings.workflow({
        name: `${workerName}-clipping-clip`,
        worker: workerName,
        exportName: 'ClippingClipWorkflow',
      }),
      ENCRYPT_TOKENS_WORKFLOW: bindings.workflow({
        name: `${workerName}-encrypt-tokens`,
        worker: workerName,
        exportName: 'EncryptTokensWorkflow',
      }),

      STORAGE_PROVIDER: bindings.text('cloudflare'),
      WORKFLOW_DRIVER: bindings.text('cloudflare'),
      REDIS_DRIVER: bindings.text('cloudflare'),
      CLOUDFLARE_REGION: bindings.text('auto'),
      CLOUDFLARE_BUCKETNAME: bindings.text(bucketName),
      IS_GENERAL: bindings.text('true'),
      DISABLE_REGISTRATION: bindings.text(
        process.env.DISABLE_REGISTRATION || 'false'
      ),

      DATABASE_URL: bindings.secret(),
      JWT_SECRET: bindings.secret(),
      CLOUDFLARE_INTERNAL_SECRET: bindings.secret(),
      CLOUDFLARE_ACCOUNT_ID: bindings.secret(),
      CLOUDFLARE_ACCESS_KEY: bindings.secret(),
      CLOUDFLARE_SECRET_ACCESS_KEY: bindings.secret(),
      CLOUDFLARE_BUCKET_URL: bindings.secret(),
    },
  });

  return {
    ...(process.env.CLOUDFLARE_ACCOUNT_ID
      ? { accountId: process.env.CLOUDFLARE_ACCOUNT_ID }
      : {}),
    worker,
    ...(skipContainer ? {} : { containers: [postizWebContainer] }),
  };
});
