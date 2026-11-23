import { describe, expect, it } from 'vitest';
import { StateStore } from '../src/state-do';
import { createMemorySql } from './helpers/memory-sql';

describe('StateStore (SQLite DO backing)', () => {
  it('handles KV get/set/EX/NX/del/expire accurately', () => {
    const store = new StateStore(createMemorySql());
    const t0 = 1_700_000_000_000;

    expect(store.kvSet('lock:1', 'a', { ttlMs: 15_000, nx: true }, t0)).toBe(true);
    expect(store.kvSet('lock:1', 'b', { ttlMs: 15_000, nx: true }, t0 + 1000)).toBe(false);
    expect(store.kvGet('lock:1', t0 + 5000)).toBe('a');

    // Once expired, NX succeeds again
    expect(store.kvGet('lock:1', t0 + 15_001)).toBeNull();
    expect(store.kvSet('lock:1', 'c', { ttlMs: 10_000, nx: true }, t0 + 15_001)).toBe(true);
    expect(store.kvGet('lock:1', t0 + 16_000)).toBe('c');

    expect(store.kvExpire('lock:1', 60_000, t0 + 16_000)).toBe(1);
    expect(store.kvGet('lock:1', t0 + 50_000)).toBe('c');
    expect(store.kvDel(['lock:1', 'missing'])).toBe(1);
    expect(store.kvGet('lock:1', t0 + 50_000)).toBeNull();
  });

  it('handles Redis-compatible list rpush, lrange, and expire', () => {
    const store = new StateStore(createMemorySql());
    const t0 = 1_700_000_000_000;

    expect(store.listRpush('uploadSessionMedia:s1', ['m1', 'm2'], t0)).toBe(2);
    expect(store.listRpush('uploadSessionMedia:s1', ['m3'], t0 + 100)).toBe(3);
    expect(store.listLrange('uploadSessionMedia:s1', 0, -1, t0 + 200)).toEqual([
      'm1',
      'm2',
      'm3',
    ]);
    expect(store.listLrange('uploadSessionMedia:s1', 1, 1, t0 + 200)).toEqual(['m2']);
    expect(store.kvExpire('uploadSessionMedia:s1', 5000, t0 + 200)).toBe(1);
    expect(store.listLrange('uploadSessionMedia:s1', 0, -1, t0 + 5201)).toEqual([]);
  });

  it('enforces rate-limit windows and blocking durations', () => {
    const store = new StateStore(createMemorySql());
    const t0 = 1_700_000_000_000;

    const r1 = store.throttleIncrement('org1_posts', 60_000, 2, 120_000, 'default', t0);
    expect(r1.totalHits).toBe(1);
    expect(r1.isBlocked).toBe(false);

    const r2 = store.throttleIncrement('org1_posts', 60_000, 2, 120_000, 'default', t0 + 1000);
    expect(r2.totalHits).toBe(2);
    expect(r2.isBlocked).toBe(false);

    const r3 = store.throttleIncrement('org1_posts', 60_000, 2, 120_000, 'default', t0 + 2000);
    expect(r3.totalHits).toBe(3);
    expect(r3.isBlocked).toBe(true);
    expect(r3.timeToBlockExpire).toBe(120);

    // After block expires, hits reset
    const r4 = store.throttleIncrement('org1_posts', 60_000, 2, 120_000, 'default', t0 + 123_000);
    expect(r4.totalHits).toBe(1);
    expect(r4.isBlocked).toBe(false);
  });

  it('indexes workflows and filters by Temporal search-attribute query', () => {
    const store = new StateStore(createMemorySql());

    store.registerWorkflow({
      workflowId: 'post_p1',
      workflowType: 'postWorkflowV112',
      cfInstanceId: 'post_p1_abc',
      postId: 'p1',
      organizationId: 'org1',
      status: 'RUNNING',
      now: 100,
    });
    store.registerWorkflow({
      workflowId: 'post_p2',
      workflowType: 'postWorkflowV112',
      cfInstanceId: 'post_p2_def',
      postId: 'p2',
      organizationId: 'org1',
      status: 'COMPLETED',
      now: 200,
    });

    expect(
      store.listWorkflowsByQuery('postId="p1" AND ExecutionStatus="Running"')
    ).toEqual([{ workflowId: 'post_p1' }]);

    store.updateWorkflowStatus('post_p1', 'TERMINATED');
    expect(
      store.listWorkflowsByQuery('postId="p1" AND ExecutionStatus="Running"')
    ).toEqual([]);
  });

  it('batches digest items per org and preserves initial 1h flush window', () => {
    const store = new StateStore(createMemorySql());
    const t0 = 1_700_000_000_000;

    const firstFlush = store.enqueueDigest(
      'org1',
      [{ title: 'Post 1', message: 'Published 1', type: 'success' }],
      t0,
      3_600_000
    );
    const secondFlush = store.enqueueDigest(
      'org1',
      [{ title: 'Post 2', message: 'Published 2', type: 'success' }],
      t0 + 600_000,
      3_600_000
    );

    expect(firstFlush).toBe(t0 + 3_600_000);
    expect(secondFlush).toBe(t0 + 3_600_000);
    expect(store.takeDueDigests(t0 + 1_000_000)).toEqual([]);

    const due = store.takeDueDigests(t0 + 3_600_000);
    expect(due).toEqual([
      {
        organizationId: 'org1',
        items: [
          { title: 'Post 1', message: 'Published 1', type: 'success' },
          { title: 'Post 2', message: 'Published 2', type: 'success' },
        ],
      },
    ]);
    expect(store.nextDigestFlushAt()).toBeNull();
  });
});
