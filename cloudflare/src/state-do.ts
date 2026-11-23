import { DurableObject } from 'cloudflare:workers';
import type {
  DigestEmailItem,
  Env,
  WorkflowIndexRecord,
  WorkflowStatus,
} from './types';

export interface SqlCursorLike {
  toArray(): Array<Record<string, unknown>>;
}

export interface SqlStorageLike {
  exec(query: string, ...bindings: unknown[]): SqlCursorLike;
}

const DIGEST_DELAY_MS = 60 * 60 * 1000;

export class StateStore {
  constructor(private readonly sql: SqlStorageLike) {
    this.initSchema();
  }

  private initSchema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS kv_store (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        expires_at INTEGER
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS list_store (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        expires_at INTEGER
      )
    `);
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_list_store_key ON list_store(key, id)
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS throttle_store (
        key TEXT PRIMARY KEY,
        hits INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        block_expires_at INTEGER NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS workflow_index (
        workflow_id TEXT PRIMARY KEY,
        workflow_type TEXT NOT NULL,
        cf_instance_id TEXT NOT NULL,
        post_id TEXT,
        organization_id TEXT,
        status TEXT NOT NULL,
        result_json TEXT,
        error_message TEXT,
        updated_at INTEGER NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_workflow_post ON workflow_index(post_id, status)
    `);
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_workflow_org ON workflow_index(organization_id, status)
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS digest_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        organization_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        flush_at INTEGER NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_digest_flush ON digest_queue(flush_at, organization_id)
    `);
  }

  private purgeExpiredKey(key: string, now: number): void {
    this.sql.exec(
      'DELETE FROM kv_store WHERE key = ? AND expires_at IS NOT NULL AND expires_at <= ?',
      key,
      now
    );
    this.sql.exec(
      'DELETE FROM list_store WHERE key = ? AND expires_at IS NOT NULL AND expires_at <= ?',
      key,
      now
    );
  }

  kvGet(key: string, now = Date.now()): string | null {
    this.purgeExpiredKey(key, now);
    const rows = this.sql
      .exec('SELECT value FROM kv_store WHERE key = ?', key)
      .toArray();
    return rows.length > 0 ? String(rows[0].value) : null;
  }

  kvSet(
    key: string,
    value: string,
    options: { ttlMs?: number; nx?: boolean } = {},
    now = Date.now()
  ): boolean {
    this.purgeExpiredKey(key, now);

    if (options.nx) {
      const existing = this.sql
        .exec('SELECT key FROM kv_store WHERE key = ?', key)
        .toArray();
      if (existing.length > 0) {
        return false;
      }
    }

    const expiresAt =
      options.ttlMs && options.ttlMs > 0 ? now + options.ttlMs : null;

    this.sql.exec(
      `INSERT INTO kv_store (key, value, expires_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`,
      key,
      value,
      expiresAt
    );
    return true;
  }

  kvDel(keys: string[]): number {
    let deleted = 0;
    for (const key of keys) {
      const kvExists = this.sql
        .exec('SELECT 1 FROM kv_store WHERE key = ? LIMIT 1', key)
        .toArray().length;
      const listExists = this.sql
        .exec('SELECT 1 FROM list_store WHERE key = ? LIMIT 1', key)
        .toArray().length;

      if (kvExists > 0) {
        this.sql.exec('DELETE FROM kv_store WHERE key = ?', key);
      }
      if (listExists > 0) {
        this.sql.exec('DELETE FROM list_store WHERE key = ?', key);
      }
      if (kvExists > 0 || listExists > 0) {
        deleted++;
      }
    }
    return deleted;
  }

  kvExpire(key: string, ttlMs: number, now = Date.now()): number {
    this.purgeExpiredKey(key, now);
    const expiresAt = now + Math.max(0, ttlMs);

    const kvRows = this.sql
      .exec('SELECT 1 FROM kv_store WHERE key = ? LIMIT 1', key)
      .toArray().length;
    const listRows = this.sql
      .exec('SELECT 1 FROM list_store WHERE key = ? LIMIT 1', key)
      .toArray().length;

    if (kvRows > 0) {
      this.sql.exec(
        'UPDATE kv_store SET expires_at = ? WHERE key = ?',
        expiresAt,
        key
      );
    }
    if (listRows > 0) {
      this.sql.exec(
        'UPDATE list_store SET expires_at = ? WHERE key = ?',
        expiresAt,
        key
      );
    }

    return kvRows > 0 || listRows > 0 ? 1 : 0;
  }

  listRpush(key: string, values: string[], now = Date.now()): number {
    this.purgeExpiredKey(key, now);
    const existing = this.sql
      .exec(
        'SELECT expires_at FROM list_store WHERE key = ? ORDER BY id DESC LIMIT 1',
        key
      )
      .toArray();
    const expiresAt = existing.length > 0 ? existing[0].expires_at : null;

    for (const value of values) {
      this.sql.exec(
        'INSERT INTO list_store (key, value, expires_at) VALUES (?, ?, ?)',
        key,
        value,
        expiresAt
      );
    }

    const countRows = this.sql
      .exec('SELECT COUNT(*) AS cnt FROM list_store WHERE key = ?', key)
      .toArray();
    return Number(countRows[0]?.cnt ?? 0);
  }

  listLrange(
    key: string,
    start: number,
    stop: number,
    now = Date.now()
  ): string[] {
    this.purgeExpiredKey(key, now);
    const rows = this.sql
      .exec('SELECT value FROM list_store WHERE key = ? ORDER BY id ASC', key)
      .toArray();
    const values = rows.map((r) => String(r.value));
    const len = values.length;
    if (len === 0) {
      return [];
    }

    let s = start < 0 ? Math.max(0, len + start) : start;
    let e = stop < 0 ? len + stop : stop;
    if (s >= len || e < 0 || s > e) {
      return [];
    }
    e = Math.min(e, len - 1);
    return values.slice(s, e + 1);
  }

  throttleIncrement(
    key: string,
    ttlMs: number,
    limit: number,
    blockDurationMs: number,
    throttlerName: string,
    now = Date.now()
  ): {
    totalHits: number;
    timeToExpire: number;
    isBlocked: boolean;
    timeToBlockExpire: number;
  } {
    const scopedKey = `${throttlerName}:${key}`;
    const rows = this.sql
      .exec(
        'SELECT hits, expires_at, block_expires_at FROM throttle_store WHERE key = ?',
        scopedKey
      )
      .toArray();

    let hits = 0;
    let expiresAt = now + ttlMs;
    let blockExpiresAt = 0;

    if (rows.length > 0) {
      const row = rows[0];
      const prevExpires = Number(row.expires_at);
      const prevBlockExpires = Number(row.block_expires_at);

      if (prevBlockExpires > now) {
        hits = Number(row.hits);
        expiresAt = prevExpires > now ? prevExpires : now + ttlMs;
        blockExpiresAt = prevBlockExpires;
      } else if (prevExpires > now) {
        hits = Number(row.hits) + 1;
        expiresAt = prevExpires;
      } else {
        hits = 1;
      }
    } else {
      hits = 1;
    }

    let isBlocked = blockExpiresAt > now;
    if (!isBlocked && hits > limit) {
      isBlocked = true;
      blockExpiresAt =
        blockDurationMs > 0 ? now + blockDurationMs : expiresAt;
    }

    this.sql.exec(
      `INSERT INTO throttle_store (key, hits, expires_at, block_expires_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         hits = excluded.hits,
         expires_at = excluded.expires_at,
         block_expires_at = excluded.block_expires_at`,
      scopedKey,
      hits,
      expiresAt,
      blockExpiresAt
    );

    return {
      totalHits: hits,
      timeToExpire: Math.max(0, Math.ceil((expiresAt - now) / 1000)),
      isBlocked,
      timeToBlockExpire: isBlocked
        ? Math.max(0, Math.ceil((blockExpiresAt - now) / 1000))
        : 0,
    };
  }

  registerWorkflow(input: {
    workflowId: string;
    workflowType: string;
    cfInstanceId: string;
    postId?: string | null;
    organizationId?: string | null;
    status?: WorkflowStatus;
    now?: number;
  }): void {
    const now = input.now ?? Date.now();
    this.sql.exec(
      `INSERT INTO workflow_index (
         workflow_id, workflow_type, cf_instance_id, post_id, organization_id, status, result_json, error_message, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)
       ON CONFLICT(workflow_id) DO UPDATE SET
         workflow_type = excluded.workflow_type,
         cf_instance_id = excluded.cf_instance_id,
         post_id = COALESCE(excluded.post_id, workflow_index.post_id),
         organization_id = COALESCE(excluded.organization_id, workflow_index.organization_id),
         status = excluded.status,
         result_json = NULL,
         error_message = NULL,
         updated_at = excluded.updated_at`,
      input.workflowId,
      input.workflowType,
      input.cfInstanceId,
      input.postId ?? null,
      input.organizationId ?? null,
      input.status ?? 'RUNNING',
      now
    );
  }

  getWorkflow(workflowId: string): WorkflowIndexRecord | null {
    const rows = this.sql
      .exec(
        'SELECT * FROM workflow_index WHERE workflow_id = ? LIMIT 1',
        workflowId
      )
      .toArray();
    if (rows.length === 0) {
      return null;
    }
    return this.mapWorkflowRow(rows[0]);
  }

  updateWorkflowStatus(
    workflowId: string,
    status: WorkflowStatus,
    result?: unknown,
    errorMessage?: string | null,
    now = Date.now()
  ): void {
    const resultJson = result !== undefined ? JSON.stringify(result) : null;
    this.sql.exec(
      `UPDATE workflow_index
       SET status = ?, result_json = ?, error_message = ?, updated_at = ?
       WHERE workflow_id = ?`,
      status,
      resultJson,
      errorMessage ?? null,
      now,
      workflowId
    );
  }

  listWorkflowsByQuery(query: string): Array<{ workflowId: string }> {
    const postMatch = /postId\s*=\s*"([^"]+)"/i.exec(query);
    const orgMatch = /organizationId\s*=\s*"([^"]+)"/i.exec(query);
    const statusMatch = /ExecutionStatus\s*=\s*"([^"]+)"/i.exec(query);

    const clauses: string[] = [];
    const params: unknown[] = [];

    if (postMatch) {
      clauses.push('post_id = ?');
      params.push(postMatch[1]);
    }
    if (orgMatch) {
      clauses.push('organization_id = ?');
      params.push(orgMatch[1]);
    }
    if (statusMatch) {
      const wanted = statusMatch[1].toUpperCase();
      clauses.push('status = ?');
      params.push(wanted);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.sql
      .exec(
        `SELECT workflow_id FROM workflow_index ${where} ORDER BY updated_at DESC`,
        ...params
      )
      .toArray();
    return rows.map((row) => ({ workflowId: String(row.workflow_id) }));
  }

  enqueueDigest(
    organizationId: string,
    items: DigestEmailItem[],
    now = Date.now(),
    delayMs = DIGEST_DELAY_MS
  ): number {
    const existing = this.sql
      .exec(
        'SELECT MIN(flush_at) AS min_flush FROM digest_queue WHERE organization_id = ?',
        organizationId
      )
      .toArray();

    const flushAt =
      existing[0]?.min_flush !== null && existing[0]?.min_flush !== undefined
        ? Number(existing[0].min_flush)
        : now + delayMs;

    for (const item of items) {
      this.sql.exec(
        'INSERT INTO digest_queue (organization_id, payload_json, flush_at) VALUES (?, ?, ?)',
        organizationId,
        JSON.stringify(item),
        flushAt
      );
    }

    return this.nextDigestFlushAt() ?? flushAt;
  }

  takeDueDigests(now = Date.now()): Array<{
    organizationId: string;
    items: DigestEmailItem[];
  }> {
    const dueRows = this.sql
      .exec(
        'SELECT id, organization_id, payload_json FROM digest_queue WHERE flush_at <= ? ORDER BY id ASC',
        now
      )
      .toArray();

    if (dueRows.length === 0) {
      return [];
    }

    const maxId = Number(dueRows[dueRows.length - 1].id);
    this.sql.exec(
      'DELETE FROM digest_queue WHERE flush_at <= ? AND id <= ?',
      now,
      maxId
    );

    const byOrg = new Map<string, DigestEmailItem[]>();
    for (const row of dueRows) {
      const orgId = String(row.organization_id);
      const item = JSON.parse(String(row.payload_json)) as DigestEmailItem;
      const list = byOrg.get(orgId) ?? [];
      list.push(item);
      byOrg.set(orgId, list);
    }

    return Array.from(byOrg.entries()).map(([organizationId, items]) => ({
      organizationId,
      items,
    }));
  }

  nextDigestFlushAt(): number | null {
    const rows = this.sql
      .exec('SELECT MIN(flush_at) AS next_flush FROM digest_queue')
      .toArray();
    const raw = rows[0]?.next_flush;
    return raw !== null && raw !== undefined ? Number(raw) : null;
  }

  private mapWorkflowRow(row: Record<string, unknown>): WorkflowIndexRecord {
    return {
      workflowId: String(row.workflow_id),
      workflowType: String(row.workflow_type),
      cfInstanceId: String(row.cf_instance_id),
      postId: row.post_id !== null ? String(row.post_id) : null,
      organizationId:
        row.organization_id !== null ? String(row.organization_id) : null,
      status: String(row.status) as WorkflowStatus,
      resultJson: row.result_json !== null ? String(row.result_json) : null,
      errorMessage:
        row.error_message !== null ? String(row.error_message) : null,
      updatedAt: Number(row.updated_at),
    };
  }
}

export class PostizStateDO extends DurableObject<Env> {
  private readonly store: StateStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new StateStore(ctx.storage.sql);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      any
    >;

    switch (url.pathname) {
      case '/kv/get':
        return Response.json({ value: this.store.kvGet(String(body.key ?? '')) });
      case '/kv/set':
        return Response.json({
          ok: this.store.kvSet(String(body.key ?? ''), String(body.value ?? ''), {
            ttlMs: typeof body.ttlMs === 'number' ? body.ttlMs : undefined,
            nx: Boolean(body.nx),
          }),
        });
      case '/kv/del':
        return Response.json({
          deleted: this.store.kvDel(
            Array.isArray(body.keys) ? body.keys.map(String) : []
          ),
        });
      case '/kv/expire':
        return Response.json({
          updated: this.store.kvExpire(
            String(body.key ?? ''),
            Number(body.ttlMs ?? 0)
          ),
        });
      case '/list/rpush':
        return Response.json({
          length: this.store.listRpush(
            String(body.key ?? ''),
            Array.isArray(body.values) ? body.values.map(String) : []
          ),
        });
      case '/list/lrange':
        return Response.json({
          values: this.store.listLrange(
            String(body.key ?? ''),
            Number(body.start ?? 0),
            Number(body.stop ?? -1)
          ),
        });
      case '/throttle':
        return Response.json(
          this.store.throttleIncrement(
            String(body.key ?? ''),
            Number(body.ttl ?? 60_000),
            Number(body.limit ?? 60),
            Number(body.blockDuration ?? 0),
            String(body.throttlerName ?? 'default')
          )
        );
      default:
        return Response.json({ error: 'Not Found' }, { status: 404 });
    }
  }

  async registerWorkflow(input: {
    workflowId: string;
    workflowType: string;
    cfInstanceId: string;
    postId?: string | null;
    organizationId?: string | null;
    status?: WorkflowStatus;
  }): Promise<void> {
    this.store.registerWorkflow(input);
  }

  async getWorkflow(workflowId: string): Promise<WorkflowIndexRecord | null> {
    return this.store.getWorkflow(workflowId);
  }

  async updateWorkflowStatus(
    workflowId: string,
    status: WorkflowStatus,
    result?: unknown,
    errorMessage?: string | null
  ): Promise<void> {
    this.store.updateWorkflowStatus(workflowId, status, result, errorMessage);
  }

  async listWorkflowsByQuery(
    query: string
  ): Promise<Array<{ workflowId: string }>> {
    return this.store.listWorkflowsByQuery(query);
  }

  async enqueueDigest(
    organizationId: string,
    items: DigestEmailItem[]
  ): Promise<void> {
    const nextFlush = this.store.enqueueDigest(organizationId, items);
    const currentAlarm = await this.ctx.storage.getAlarm();
    if (currentAlarm === null || nextFlush < currentAlarm) {
      await this.ctx.storage.setAlarm(nextFlush);
    }
  }

  async alarm(): Promise<void> {
    const dueBatches = this.store.takeDueDigests();
    if (dueBatches.length > 0) {
      const containerId = this.env.POSTIZ_WEB.idFromName('singleton');
      const containerStub = this.env.POSTIZ_WEB.get(containerId);

      for (const batch of dueBatches) {
        try {
          const orgRes = (await containerStub.invokeActivity(
            'email',
            'getUserOrgs',
            [batch.organizationId]
          )) as
            | {
                ok: true;
                result?: {
                  users?: Array<{
                    user: {
                      email: string;
                      sendFailureEmails?: boolean;
                      sendSuccessEmails?: boolean;
                    };
                  }>;
                };
              }
            | { ok: false };

          if (!orgRes.ok || !orgRes.result?.users) {
            continue;
          }

          for (const entry of orgRes.result.users) {
            const allowFailure = entry.user.sendFailureEmails ? 'fail' : null;
            const allowSuccess = entry.user.sendSuccessEmails
              ? 'success'
              : null;

            const toSend = batch.items.filter(
              (email) =>
                email.type === allowFailure ||
                email.type === allowSuccess ||
                email.type === 'info'
            );
            if (toSend.length === 0) {
              continue;
            }

            await containerStub.invokeActivity('email', 'sendEmailAsync', [
              entry.user.email,
              toSend.length === 1
                ? toSend[0].title
                : '[Postiz] Your latest notifications',
              toSend.map((p) => p.message).join('<br/>'),
              'bottom',
            ]);
          }
        } catch (err) {
          console.error(
            `Failed flushing digest for org ${batch.organizationId}:`,
            err
          );
        }
      }
    }

    const nextFlush = this.store.nextDigestFlushAt();
    if (nextFlush !== null) {
      await this.ctx.storage.setAlarm(nextFlush);
    }
  }
}
