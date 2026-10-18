// Test harness: drives handleRequest() against an in-memory SQLite DB.
// Mirrors how the worker serves requests, minus D1.

import { credentialHash } from '../src/auth.js';
import { randomBase62 } from '../src/auth.js';
import { handleRequest } from '../src/index.js';
import { DbClient, Env } from '../src/types.js';
import { freshDb, sqliteClient } from './sqlite.js';

export interface CallOpts {
  token?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** When true, return the raw response bytes (no JSON parsing). */
  rawBytes?: boolean;
}

export interface CallResult {
  status: number;
  body: any;
  headers: Record<string, string>;
  /** Set when rawBytes is true. */
  bytes?: Uint8Array;
}

export function makeApp() {
  const raw = freshDb();
  const db: DbClient = sqliteClient(raw);
  const credentials = new Map<string, string>();
  const env: Env = {
    TOKEN_PEPPER: 'test-pepper-do-not-use-in-production',
    // Sync v2 read receipts need a secret; tests use a fixed throwaway.
    READ_RECEIPT_SECRET: 'test-read-receipt-secret-do-not-use-in-production',
    SETUP_LOCKED: '0',
  };

  async function call(method: string, path: string, opts: CallOpts = {}): Promise<CallResult> {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;
    let body: string | undefined;
    if (opts.body !== undefined) {
      if (
        method === 'POST' &&
        /^\/v2\/(invites|provisioning-codes)\/[^/]+\/(accept|redeem)$/.test(path) &&
        typeof opts.body === 'object' &&
        opts.body !== null &&
        !('agent_token' in opts.body)
      ) {
        opts = { ...opts, body: { ...opts.body, agent_token: 'fh_' + randomBase62(43) } };
      }
      if (
        method === 'POST' &&
        /\/v2\/(invites|provisioning-codes)\/[^/]+\/(accept|redeem)$/.test(path) &&
        opts.body &&
        typeof opts.body === 'object' &&
        !('email' in opts.body)
      ) {
        const hash = await credentialHash(env.TOKEN_PEPPER, decodeURIComponent(path.split('/')[3]));
        const row = path.startsWith('/v2/invites/')
          ? await db.queryOne('SELECT email FROM invites WHERE code_hash=?', [hash])
          : await db.queryOne(
              'SELECT m.email FROM provisioning_codes p JOIN members m ON m.id=p.member_id WHERE p.code_hash=?',
              [hash],
            );
        opts = { ...opts, body: { ...opts.body, email: row?.['email'] ?? 'unknown@example.test' } };
      }
      if (
        method === 'POST' &&
        /^\/v2\/families\/[^/]+\/invites$/.test(path) &&
        opts.body &&
        typeof opts.body === 'object' &&
        !('name' in opts.body)
      ) {
        opts = { ...opts, body: { ...opts.body, name: 'Invited person' } };
      }
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    const req = new Request(`https://hub.test${path}`, { method, headers, body });
    const res = await handleRequest(req, db, env);
    const resHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      resHeaders[k] = v;
    });
    if (opts.rawBytes) {
      return {
        status: res.status,
        body: undefined,
        headers: resHeaders,
        bytes: new Uint8Array(await res.arrayBuffer()),
      };
    }
    const text = await res.text();
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    if (res.status < 300 && parsed?.token && parsed?.member?.id)
      credentials.set(parsed.member.id, parsed.token);
    return { status: res.status, body: parsed, headers: resHeaders };
  }

  return { call, db, env, raw, credentials };
}

export type TestApp = ReturnType<typeof makeApp>;
