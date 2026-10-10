// D1 adapter for the DbClient interface (worker runtime).
// All SQL stays plain SQLite with positional ? binds — identical statements
// run on stock SQLite (see server/test/sqlite.ts for the test adapter).

import { DbClient, Row, SqlParam } from './types.js';

/** Wrap a D1Database binding. `d1` is typed as unknown to avoid pulling in
 *  @cloudflare/workers-types (zero-dependency rule). */
export function d1Client(d1: unknown): DbClient {
  const db = d1 as {
    prepare(sql: string): {
      bind(...params: SqlParam[]): {
        all(): Promise<{ results: Row[] }>;
        first(): Promise<Row | null>;
        run(): Promise<unknown>;
      };
    };
    batch(statements: unknown[]): Promise<unknown[]>;
  };
  return {
    async queryAll(sql: string, params: SqlParam[] = []): Promise<Row[]> {
      const res = await db.prepare(sql).bind(...params).all();
      return res.results ?? [];
    },
    async queryOne(sql: string, params: SqlParam[] = []): Promise<Row | null> {
      const row = await db.prepare(sql).bind(...params).first();
      return row ?? null;
    },
    async execAtomically(ops: Array<{ sql: string; params?: SqlParam[] }>): Promise<void> {
      if (ops.length === 0) return;
      // D1 batch() is atomic: all statements apply or none do.
      await db.batch(ops.map((o) => db.prepare(o.sql).bind(...(o.params ?? []))));
    },
  };
}
