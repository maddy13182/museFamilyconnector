// Test-only DbClient adapter over node:sqlite (stdlib). Mirrors the D1
// adapter's contract so integration tests exercise the same handler code
// paths that run in production.

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DbClient, Row, SqlParam } from '../src/types.js';

export function freshDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/test -> dist/migrations (copied by the test script).
  const schema = readFileSync(join(here, '..', 'migrations', '0001_init.sql'), 'utf8');
  db.exec(schema);
  return db;
}

export function sqliteClient(db: DatabaseSync): DbClient {
  return {
    async queryAll(sql: string, params: SqlParam[] = []): Promise<Row[]> {
      return db.prepare(sql).all(...params) as Row[];
    },
    async queryOne(sql: string, params: SqlParam[] = []): Promise<Row | null> {
      const row = db.prepare(sql).get(...params) as Row | undefined;
      return row ?? null;
    },
    async execAtomically(ops: Array<{ sql: string; params?: SqlParam[] }>): Promise<void> {
      db.exec('BEGIN');
      try {
        for (const op of ops) {
          db.prepare(op.sql).run(...(op.params ?? []));
        }
        db.exec('COMMIT');
      } catch (e) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* ignore rollback failure */
        }
        throw e;
      }
    },
  };
}
