// Test harness: drives handleRequest() against an in-memory SQLite DB.
// Mirrors how the worker serves requests, minus D1.

import { handleRequest } from '../src/index.js';
import { DbClient, Env } from '../src/types.js';
import { freshDb, sqliteClient } from './sqlite.js';

export interface CallOpts {
  token?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface CallResult {
  status: number;
  body: any;
}

export function makeApp() {
  const raw = freshDb();
  const db: DbClient = sqliteClient(raw);
  const env: Env = {
    TOKEN_PEPPER: 'test-pepper-do-not-use-in-production',
    SETUP_LOCKED: '0',
  };

  async function call(method: string, path: string, opts: CallOpts = {}): Promise<CallResult> {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    const req = new Request(`https://hub.test${path}`, { method, headers, body });
    const res = await handleRequest(req, db, env);
    const text = await res.text();
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed };
  }

  return { call, db, env, raw };
}

export type TestApp = ReturnType<typeof makeApp>;
