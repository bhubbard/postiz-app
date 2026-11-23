// @ts-expect-error node:sqlite is built into Node 22.5+ / 26 without requiring @types/node
import { DatabaseSync } from 'node:sqlite';
import type { SqlStorageLike } from '../../src/state-do';

export function createMemorySql(): SqlStorageLike {
  const db = new DatabaseSync(':memory:');
  return {
    exec(query: string, ...bindings: unknown[]) {
      const stmt = db.prepare(query);
      if (query.trim().toUpperCase().startsWith('SELECT')) {
        return {
          toArray: () =>
            stmt.all(...(bindings as any[])) as Array<Record<string, unknown>>,
        };
      }
      stmt.run(...(bindings as any[]));
      return { toArray: () => [] };
    },
  };
}
