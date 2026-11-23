import { DynamicModule, Global, Injectable, Module } from '@nestjs/common';
import { TemporalService } from 'nestjs-temporal-core';

function getInternalBaseUrl(): string {
  const base = process.env.CLOUDFLARE_INTERNAL_URL;
  if (!base) {
    throw new Error('CLOUDFLARE_INTERNAL_URL is required when WORKFLOW_DRIVER=cloudflare');
  }
  return base.replace(/\/+$/, '');
}

function getAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (process.env.CLOUDFLARE_INTERNAL_SECRET) {
    headers['Authorization'] = `Bearer ${process.env.CLOUDFLARE_INTERNAL_SECRET}`;
  }
  return headers;
}

async function callWorkflowControl<T>(
  path: string,
  method: 'GET' | 'POST',
  body?: unknown
): Promise<T> {
  const res = await fetch(`${getInternalBaseUrl()}/__cf/workflows${path}`, {
    method,
    headers: getAuthHeaders(),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Cloudflare workflow API ${path} failed (${res.status}): ${text}`);
  }

  return (await res.json()) as T;
}

function extractSearchAttributes(typedSearchAttributes: any): Record<string, string> {
  const result: Record<string, string> = {};
  if (!typedSearchAttributes) {
    return result;
  }

  const pairs =
    typeof typedSearchAttributes.getAll === 'function'
      ? typedSearchAttributes.getAll()
      : Array.isArray(typedSearchAttributes.searchAttributes)
        ? typedSearchAttributes.searchAttributes
        : [];

  for (const pair of pairs) {
    const name = pair?.key?.name;
    if (name && pair?.value !== undefined && pair?.value !== null) {
      result[name] = String(pair.value);
    }
  }
  return result;
}

@Injectable()
export class CloudflareTemporalService {
  readonly client = {
    getRawClient: () => ({
      workflow: {
        start: async (workflowType: string, options: any = {}) => {
          return callWorkflowControl('/start', 'POST', {
            workflowType,
            workflowId: options.workflowId,
            taskQueue: options.taskQueue,
            workflowIdConflictPolicy: options.workflowIdConflictPolicy,
            args: options.args ?? [],
            searchAttributes: extractSearchAttributes(options.typedSearchAttributes),
          });
        },
        signalWithStart: async (workflowType: string, options: any = {}) => {
          return callWorkflowControl('/signal-with-start', 'POST', {
            workflowType,
            workflowId: options.workflowId,
            taskQueue: options.taskQueue,
            signal: options.signal,
            signalArgs: options.signalArgs ?? [],
            workflowIdConflictPolicy: options.workflowIdConflictPolicy,
            args: options.args ?? [],
            searchAttributes: extractSearchAttributes(options.typedSearchAttributes),
          });
        },
        list: ({ query }: { query: string }) => {
          return {
            async *[Symbol.asyncIterator]() {
              const data = await callWorkflowControl<{
                workflows: Array<{ workflowId: string }>;
              }>('/list', 'POST', { query });
              for (const item of data.workflows || []) {
                yield item;
              }
            },
          };
        },
      },
    }),
    getWorkflowHandle: async (workflowId: string) => {
      const encoded = encodeURIComponent(workflowId);
      return {
        workflowId,
        describe: async () => {
          return callWorkflowControl<{ status: { name: string } }>(
            `/describe/${encoded}`,
            'GET'
          );
        },
        terminate: async () => {
          await callWorkflowControl(`/terminate/${encoded}`, 'POST', {});
        },
        result: async () => {
          const data = await callWorkflowControl<{
            ok: boolean;
            output?: unknown;
            error?: string;
          }>(`/result/${encoded}`, 'GET');
          if (!data.ok) {
            throw new Error(data.error || `Workflow ${workflowId} failed`);
          }
          return data.output;
        },
      };
    },
  };

  async terminateWorkflow(workflowId: string) {
    const encoded = encodeURIComponent(workflowId);
    return callWorkflowControl(`/terminate/${encoded}`, 'POST', {});
  }
}

@Global()
@Module({})
export class CloudflareTemporalModule {
  static forRoot(): DynamicModule {
    return {
      module: CloudflareTemporalModule,
      global: true,
      providers: [
        CloudflareTemporalService,
        {
          provide: TemporalService,
          useExisting: CloudflareTemporalService,
        },
      ],
      exports: [TemporalService, CloudflareTemporalService],
    };
  }
}
