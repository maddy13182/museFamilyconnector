// Family Hub API — Cloudflare Worker entry point.
// Zero runtime dependencies. All handlers go through resolveToken() (§7);
// every data query is scoped by (family_id, member_id).
//
// Exported handleRequest(req, db, env) is what tests drive against a local
// SQLite DbClient; the default export wires it to D1 in production.

import {
  DbClient,
  Env,
  Row,
  HttpError,
  AuthContext,
  TASK_STATUSES,
  MEMBER_ROLES,
  TRANSFER_COMPLETION_MODES,
  FAMILY_KINDS,
} from './types.js';
import {
  sha256hex,
  credentialHash,
  randomBase62,
  newAgentToken,
  newInviteCode,
  newProvisioningCode,
  resolveToken,
} from './auth.js';
import { scanPii, type PiiHit } from './pii.js';
import {
  reqString,
  optString,
  reqEmail,
  reqEnum,
  reqIdArray,
  parseLimit,
  parseSeqCursor,
  reqIsoDate,
  reqJsonData,
  optSearchQuery,
  escapeLike,
  reqAgentPublicKey,
  optAgentPublicKey,
  reqE2eeFlag,
  reqKeyId,
  reqEnvelopeB64,
  isE2eeWireBody,
} from './validate.js';
import { d1Client } from './db.js';
import { UI_HTML } from './ui.js';
// Single source of truth for the server version: server/package.json.
// The skill (agent-skill/hub) carries its own VERSION constant; the two
// version independently (docs/VERSIONING.md).
import pkg from '../package.json' with { type: 'json' };
const SERVER_VERSION: string = pkg.version;

const MAX_BODY = 20000;
const MAX_DATA = 20000;
const IDEM_TTL_HOURS = 24;
const IDEM_CREATE_TTL_HOURS = 24;
const PROVISION_TTL_HOURS = 24;
const INVITE_TTL_DAYS = 7;
const TRANSFER_TTL_DAYS = 7;

// Idempotency for create operations (family/topic/invite). Entries use the
// separate idempotency_keys table; creates use create_idempotency, which also
// remembers the provisioning code so a deduped retry can mint a fresh one
// and revoke the orphaned token from the first attempt.
type CreateScope = 'family' | 'topic' | 'invite' | 'ownership_transfer';

function readIdemKey(req: Request): string | null {
  const k = req.headers.get('idempotency-key');
  if (k === null) return null;
  if (k.length === 0 || k.length > 128) {
    throw new HttpError(400, 'bad_request', 'Idempotency-Key must be 1-128 chars');
  }
  return k;
}

async function findCreateIdem(
  db: DbClient,
  scope: CreateScope,
  memberId: string,
  key: string,
): Promise<Record<string, unknown> | null> {
  return await db.queryOne(
    `SELECT * FROM create_idempotency
       WHERE scope = ? AND member_id = ? AND key = ? AND expires_at > ?`,
    [scope, memberId, key, nowIso()],
  );
}

async function recordCreateIdem(
  db: DbClient,
  scope: CreateScope,
  memberId: string,
  key: string,
  resourceId: string,
  codeHash: string | null,
): Promise<void> {
  const ts = nowIso();
  await db.execAtomically([
    {
      sql: `INSERT OR REPLACE INTO create_idempotency
              (scope, member_id, key, resource_id, code_hash, created_at, expires_at)
            VALUES (?,?,?,?,?,?,?)`,
      params: [scope, memberId, key, resourceId, codeHash, ts, hoursFromNow(IDEM_CREATE_TTL_HOURS)],
    },
  ]);
  logEvent('info', 'idempotency_stored', { scope, key });
}

// Mint a single-use provisioning code. Shared by the manual mint endpoint
// and the dedup path (which issues a FRESH code — the original code's
// plaintext is unrecoverable once stored as a hash).
// F17: issuedByTokenId records the token under whose authority the code is
// minted (the caller's auth.token_id); NULL when no auth context exists.
async function mintProvisioningCode(
  db: DbClient,
  env: Env,
  opts: {
    familyId: string;
    memberId: string;
    agentLabel: string;
    createdBy: string;
    issuedByTokenId?: string | null;
  },
): Promise<{ code: string; codeHash: string; expiresAt: string }> {
  const code = newProvisioningCode();
  const codeHash = await credentialHash(env.TOKEN_PEPPER, code);
  const expiresAt = hoursFromNow(PROVISION_TTL_HOURS);
  await db.execAtomically([
    {
      sql: `INSERT INTO provisioning_codes(code_hash, family_id, member_id, agent_label, created_by, expires_at, used_at, issued_by_token_id)
            VALUES (?,?,?,?,?,?,NULL,?)`,
      params: [
        codeHash,
        opts.familyId,
        opts.memberId,
        opts.agentLabel,
        opts.createdBy,
        expiresAt,
        opts.issuedByTokenId ?? null,
      ],
    },
  ]);
  logEvent('info', 'provisioning_code_minted', {});
  return { code, codeHash, expiresAt };
}

// True when the DB error is a UNIQUE constraint violation (used to convert
// racy inserts into clean 409s instead of 500s).
function isUniqueViolation(e: unknown): boolean {
  return e instanceof Error && /unique constraint failed/i.test(e.message);
}

// Structured logging. Every line carries the server version so log streams
// can be correlated with releases. Never log tokens, codes, or request
// bodies — paths are redacted via redactPath() and query strings are dropped.
//
// Field allowlist for `fields` (keep it tight — these lines persist in
// Workers Logs): method, path (redacted), status, code (string literal from
// HttpError), ms, event-specific static strings. Do NOT add headers, bodies,
// tokens, codes, emails, names, or message content.
type LogLevel = 'info' | 'warn' | 'error';

export function logEvent(
  level: LogLevel,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    v: SERVER_VERSION,
    level,
    event,
    ...fields,
  });
  if (level === 'error') console.error(line);
  else console.log(line);
}

// Redact single-use codes from URL paths before logging: on these routes the
// code IS the credential. Redacts the whole tail after the prefix —
// over-redaction is the safe direction (trailing slashes, extra segments).
// The bare collection routes (/v1/invites, /v1/provisioning-codes) carry no
// code and are left alone.
export function redactPath(path: string): string {
  return path
    .replace(/^(\/v1\/invites\/).*/, '$1[redacted]')
    .replace(/^(\/v1\/provisioning-codes\/).*/, '$1[redacted]');
}

function nowIso(): string {
  return new Date().toISOString();
}
function hoursFromNow(h: number): string {
  return new Date(Date.now() + h * 3600_000).toISOString();
}
function daysFromNow(d: number): string {
  return new Date(Date.now() + d * 86400_000).toISOString();
}

// Rate limiting for unauthenticated credential endpoints.
//
// workers.dev has no custom zone, so Cloudflare's zone-based rate-limiting
// rules don't apply here. This is a fixed-window counter in D1, checked
// BEFORE the credential lookup. Legitimate use is 1-2 attempts ever; the
// limit (10 per 10 min per IP per endpoint) only bites brute-forcers.
// Returns a 429 Response when exceeded, null when the request may proceed.
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 10 * 60_000;

function clientIp(req: Request): string {
  // Cloudflare always sets CF-Connecting-IP; fall back defensively.
  return req.headers.get('CF-Connecting-IP')?.trim() || 'unknown';
}

async function checkRateLimit(
  db: DbClient,
  req: Request,
  endpoint: 'invite_accept' | 'code_redeem',
): Promise<Response | null> {
  const ip = clientIp(req);
  const now = Date.now();
  const windowStart = new Date(
    Math.floor(now / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_WINDOW_MS,
  ).toISOString();
  const key = `${ip}|${endpoint}|${windowStart}`;
  const expiresAt = new Date(now + RATE_LIMIT_WINDOW_MS).toISOString();
  const nowIsoStr = new Date(now).toISOString();

  // Lazy-expire old rows (indexed delete, one per check).
  await db.execAtomically([
    { sql: `DELETE FROM rate_limits WHERE expires_at <= ?`, params: [nowIsoStr] },
    {
      sql: `INSERT INTO rate_limits(key, count, window_start, expires_at)
            VALUES (?,?,?,?)
            ON CONFLICT(key) DO UPDATE SET count = count + 1`,
      params: [key, 1, windowStart, expiresAt],
    },
  ]);
  const row = await db.queryOne(`SELECT count FROM rate_limits WHERE key = ?`, [key]);
  const count = (row?.['count'] as number) ?? 1;
  if (count > RATE_LIMIT_MAX) {
    const retryAfter = Math.max(1, Math.ceil((new Date(expiresAt).getTime() - now) / 1000));
    const res = json(
      {
        error: {
          code: 'rate_limited',
          message: `Too many attempts. Try again in ${retryAfter} seconds.`,
        },
      },
      429,
    );
    res.headers.set('Retry-After', String(retryAfter));
    return res;
  }
  return null;
}
function newId(): string {
  return crypto.randomUUID();
}

// Identity principals (F02). A principal is the stable cross-circle identity
// behind member rows; authorization joins use it, never the email string.
// New member rows get a FRESH principal, inserted in the same atomic batch as
// the member row so a failed create leaves no orphan behind. The ONLY path
// that reuses an existing principal is locked circle creation, which carries
// the already-verified caller's principal onto the new member row —
// hub-owner power must derive from a verified credential, never from an
// email string the caller supplies.
function newPrincipalId(): string {
  return 'pr_' + newId().replace(/-/g, '');
}
function principalInsertOp(
  principalId: string,
  ts: string,
): { sql: string; params: (string | number | null)[] } {
  return {
    sql: `INSERT INTO principals(id, created_at) VALUES (?,?)`,
    params: [principalId, ts],
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

// Security headers, applied to EVERY response in handleRequest() (the worker
// has no other response path). CSP notes — kept restrictive without breaking
// the dashboard (/), which is a single self-contained HTML page:
// - script-src/style-src 'unsafe-inline': the dashboard ships one inline
//   <script> and one inline <style> and has no build step, so a nonce would
//   require per-request HTML rewriting. Inline code is ours (ui.ts escapes
//   all entry text before rendering), so the residual inline-XSS risk is
//   accepted and documented here. No external script/style/object sources
//   are allowed at all.
// - connect-src 'self' https:: the dashboard's "API base" field lets the
//   operator point it at a different origin (e.g. a custom domain); 'self'
//   alone would break that feature. https: still blocks cleartext exfil.
// - frame-ancestors 'none' (+ X-Frame-Options: DENY for legacy browsers):
//   the dashboard must never be framed (clickjacking a token-paste page).
function securityHeaders(): Record<string, string> {
  return {
    'content-security-policy':
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
      "connect-src 'self' https:; base-uri 'self'; form-action 'self'; " +
      "frame-ancestors 'none'",
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  };
}

/** Stamp the security headers onto a response (mutates and returns it). */
function withSecurityHeaders(res: Response): Response {
  const headers = securityHeaders();
  for (const name of Object.keys(headers)) {
    res.headers.set(name, headers[name] as string);
  }
  return res;
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new HttpError(400, 'bad_request', 'Request body must be valid JSON');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'bad_request', 'Request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

/** Reject on PII hit with 422 + explanation (SPEC §11). Never logs the match. */
function piiGuard(text: string): void {
  const hit = scanPii(text);
  if (hit) {
    throw new HttpError(
      422,
      'pii_detected',
      `Message rejected: ${hit.description}. Please remove it and retry.`,
    );
  }
}

/**
 * Pattern-based deep scan of a JSON value (F08): every string leaf is run
 * through scanPii. Iterative to avoid recursion-depth issues on hostile
 * input; cycle-safe for good measure. Never returns the matched value.
 */
function scanPiiDeep(value: unknown): PiiHit | null {
  const stack: unknown[] = [value];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v === 'string') {
      const hit = scanPii(v);
      if (hit) return hit;
    } else if (v !== null && typeof v === 'object') {
      if (seen.has(v)) continue;
      seen.add(v);
      for (const k of Object.keys(v)) stack.push((v as Record<string, unknown>)[k]);
    }
    // Non-string primitives (numbers, booleans, null) carry no PII text.
  }
  return null;
}

/** Reject on PII hit in any string leaf of a JSON value (F08: entry data,
 *  task completion results). Never logs the match. */
function piiGuardJson(value: unknown): void {
  const hit = scanPiiDeep(value);
  if (hit) {
    throw new HttpError(
      422,
      'pii_detected',
      `Message rejected: ${hit.description}. Please remove it and retry.`,
    );
  }
}

const PII_REDACTED_LEAF = '[redacted]';

/**
 * Structure-preserving PII scrub of a JSON value (F08): string leaves that
 * scanPii flags are replaced with a marker; everything else (including
 * linkage fields like task_id) is untouched.
 */
function redactPiiLeaves<T>(value: T): T {
  if (typeof value === 'string') {
    return (scanPii(value) ? PII_REDACTED_LEAF : value) as T;
  }
  if (Array.isArray(value)) {
    return value.map(redactPiiLeaves) as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value)) {
      out[k] = redactPiiLeaves((value as Record<string, unknown>)[k]);
    }
    return out as T;
  }
  return value;
}

function parseDataField(row: Row): unknown {
  const d = row['data'];
  if (d === null || d === undefined) return null;
  try {
    return JSON.parse(d as string);
  } catch {
    return null;
  }
}

function publicEntry(row: Row): Record<string, unknown> {
  return {
    gseq: row['gseq'],
    topic_id: row['topic_id'],
    seq: row['seq'],
    ts: row['ts'],
    actor_member_id: row['actor_member_id'],
    agent_label: row['agent_label'],
    kind: row['kind'],
    body: row['body'],
    data: parseDataField(row),
    reply_to_seq: row['reply_to_seq'],
  };
}

function publicMember(row: Row): Record<string, unknown> {
  return {
    id: row['id'],
    family_id: row['family_id'],
    name: row['name'],
    email: row['email'],
    role: row['role'],
    created_at: row['created_at'],
  };
}

// E2EE (Phase 1): the key directory serves public keys only — the single
// canonical serializer, mirroring publicMember(). Never includes anything
// but the key and its binding metadata.
function publicAgentKey(row: Row): Record<string, unknown> {
  return {
    member_id: row['member_id'],
    agent_label: row['agent_label'],
    public_key: row['public_key'],
    created_at: row['created_at'],
  };
}

function publicTask(row: Row): Record<string, unknown> {
  return {
    id: row['id'],
    topic_id: row['topic_id'],
    title: row['title'],
    description: row['description'],
    status: row['status'],
    owner_member_id: row['owner_member_id'],
    assignee_member_id: row['assignee_member_id'],
    parent_task_id: row['parent_task_id'],
    due_at: row['due_at'],
    result: parseDataField({ data: row['result'] }),
    created_by: row['created_by'],
    created_at: row['created_at'],
    updated_at: row['updated_at'],
  };
}

// ---------------------------------------------------------------------------
// Scoping helpers — the authorization core.
// ---------------------------------------------------------------------------

/** Topic in the caller's family, or 404 (never leaks cross-family existence). */
async function getTopicInFamily(db: DbClient, auth: AuthContext, topicId: string): Promise<Row> {
  const topic = await db.queryOne(
    `SELECT * FROM topics WHERE id = ? AND family_id = ?`,
    [topicId, auth.family_id],
  );
  if (!topic) throw new HttpError(404, 'not_found', 'Topic not found');
  return topic;
}

/** Require caller participation; returns topic + caller's history_from_seq.
 *  403 when the topic exists but the caller is not a participant. */
async function requireParticipant(
  db: DbClient,
  auth: AuthContext,
  topicId: string,
): Promise<{ topic: Row; history_from_seq: number }> {
  const topic = await getTopicInFamily(db, auth, topicId);
  const part = await db.queryOne(
    `SELECT history_from_seq FROM topic_participants WHERE topic_id = ? AND member_id = ?`,
    [topicId, auth.member_id],
  );
  if (!part) throw new HttpError(403, 'forbidden', 'Not a participant of this topic');
  return { topic, history_from_seq: part['history_from_seq'] as number };
}

/** All ids must be members of the caller's family; returns their rows. */
async function requireFamilyMembers(
  db: DbClient,
  auth: AuthContext,
  ids: string[],
): Promise<Row[]> {
  const rows: Row[] = [];
  for (const id of ids) {
    const m = await db.queryOne(
      `SELECT * FROM members WHERE id = ? AND family_id = ?`,
      [id, auth.family_id],
    );
    if (!m) throw new HttpError(400, 'bad_request', `Unknown member id: ${id}`);
    rows.push(m);
  }
  return rows;
}

/**
 * Task visibility predicate (F06): a member may see a task only when its
 * `task_created` entry sits at or after their `history_from_seq` floor, so a
 * from_join member never sees tasks created before they joined. Every task
 * row has exactly one task_created entry (appended by handleCreateTask), so
 * EXISTS is exact — no migration needed.
 * The single `?` binds the caller's member_id.
 */
const TASK_VISIBLE_TO_MEMBER = `EXISTS (
  SELECT 1 FROM entries e
    JOIN topic_participants p ON p.topic_id = e.topic_id AND p.member_id = ?
   WHERE e.topic_id = tasks.topic_id
     AND e.kind = 'task_created'
     AND json_extract(e.data, '$.task_id') = tasks.id
     AND e.seq >= p.history_from_seq
)`;

/**
 * Append an entry, assigning per-topic seq = MAX(seq)+1 atomically.
 * Retries once on seq collision (UNIQUE constraint).
 */
async function appendEntry(
  db: DbClient,
  args: {
    topic_id: string;
    kind: string;
    body: string;
    auth: AuthContext;
    data?: string | null;
    reply_to_seq?: number | null;
  },
): Promise<Row> {
  if (args.reply_to_seq !== undefined && args.reply_to_seq !== null) {
    const ref = await db.queryOne(
      `SELECT seq FROM entries WHERE topic_id = ? AND seq = ?`,
      [args.topic_id, args.reply_to_seq],
    );
    if (!ref) throw new HttpError(400, 'bad_request', 'reply_to_seq does not exist in this topic');
  }
  const ts = nowIso();
  for (let attempt = 0; attempt < 2; attempt++) {
    const cur = await db.queryOne(`SELECT MAX(seq) AS m FROM entries WHERE topic_id = ?`, [
      args.topic_id,
    ]);
    const seq = ((cur?.['m'] as number | null) ?? 0) + 1;
    try {
      await db.execAtomically([
        {
          sql: `INSERT INTO entries(topic_id, seq, ts, actor_member_id, agent_label, token_id, kind, body, data, reply_to_seq)
                VALUES (?,?,?,?,?,?,?,?,?,?)`,
          params: [
            args.topic_id,
            seq,
            ts,
            args.auth.member_id,
            args.auth.agent_label,
            args.auth.token_id,
            args.kind,
            args.body,
            args.data ?? null,
            args.reply_to_seq ?? null,
          ],
        },
      ]);
      const row = await db.queryOne(
        `SELECT * FROM entries WHERE topic_id = ? AND seq = ?`,
        [args.topic_id, seq],
      );
      if (!row) throw new HttpError(500, 'internal', 'Failed to read back inserted entry');
      return row;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt === 0 && /unique|constraint/i.test(msg)) continue; // seq race: retry
      throw e;
    }
  }
  throw new HttpError(500, 'internal', 'Could not append entry');
}

/** One statement inside an execAtomically batch. */
type BatchOp = { sql: string; params: (string | number | null)[] };

/**
 * F12: build an entry INSERT that computes its per-topic seq INSIDE the
 * statement (COALESCE(MAX(seq),0)+1), so the insert can share one atomic
 * batch with the state change it records — no read-then-write seq race and
 * no state-without-event window. An optional HAVING pin gates the insert on
 * a condition evaluated after the earlier statements in the same batch
 * (e.g. "the task row actually flipped to done"), so the event is written
 * exactly when its state change applied. Aggregate-without-GROUP-BY still
 * yields one row for an empty topic (seq 1); a false pin yields zero rows.
 */
function entryInsertOp(args: {
  topicId: string;
  kind: string;
  body: string;
  auth: AuthContext;
  data: string | null;
  ts: string;
  replyToSeq?: number | null;
  pin?: string;
  pinParams?: (string | number | null)[];
}): BatchOp {
  const pin = args.pin ? ` HAVING ${args.pin}` : '';
  return {
    sql: `INSERT INTO entries(topic_id, seq, ts, actor_member_id, agent_label, token_id, kind, body, data, reply_to_seq)
          SELECT ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?
            FROM entries WHERE topic_id = ?${pin}`,
    params: [
      args.topicId,
      args.ts,
      args.auth.member_id,
      args.auth.agent_label,
      args.auth.token_id,
      args.kind,
      args.body,
      args.data,
      args.replyToSeq ?? null,
      args.topicId,
      ...(args.pinParams ?? []),
    ],
  };
}

/**
 * F12: run an atomic batch that contains entry inserts, retrying once when
 * the batch dies on a UNIQUE/constraint violation — a concurrent writer won
 * the same per-topic seq, and the seq subquery is re-evaluated on retry.
 * The batch is all-or-nothing, so a failed attempt never leaves partial
 * state behind for the retry to duplicate.
 */
async function execBatchWithRetry(db: DbClient, buildOps: () => BatchOp[]): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await db.execAtomically(buildOps());
      return;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt === 0 && /unique|constraint/i.test(msg)) continue; // seq race: retry
      throw e;
    }
  }
  throw new HttpError(500, 'internal', 'Could not commit batch');
}

/**
 * F14: read an OPTIONAL JSON object body. An absent/empty body is fine ({});
 * a present-but-malformed body is 400 — never silently swallowed.
 */
async function readOptionalJson(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.trim() === '') return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'bad_request', 'Request body must be valid JSON');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'bad_request', 'Request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

/** Server rule: a task cannot be done while it has open subtasks. */
async function assertNoOpenSubtasks(db: DbClient, taskId: string): Promise<void> {
  const open = await db.queryAll(
    `SELECT id FROM tasks WHERE parent_task_id = ? AND status NOT IN ('done','cancelled')`,
    [taskId],
  );
  if (open.length > 0) {
    throw new HttpError(
      409,
      'subtasks_open',
      `Cannot complete task: ${open.length} subtask(s) still open`,
    );
  }
}

// ---------------------------------------------------------------------------
// Handlers.
// ---------------------------------------------------------------------------

async function handleHealth(): Promise<Response> {
  return json({ ok: true, version: SERVER_VERSION });
}

// POST /v1/families — bootstrap when unlocked; hub-owner circle creation
// when locked via SETUP_LOCKED=1 (v0.2.0+).
async function handleCreateFamily(db: DbClient, env: Env, req: Request): Promise<Response> {
  if (env.SETUP_LOCKED === '1') {
    return await handleCreateFamilyLocked(db, env, req);
  }
  const body = await readJson(req);
  const name = reqString(body['name'], 'name', 1, 120);
  const ownerName = reqString(body['owner_name'], 'owner_name', 1, 120);
  const ownerEmail = reqEmail(body['owner_email'], 'owner_email');

  const nameTaken = await db.queryOne(
    `SELECT 1 FROM families WHERE name = ? COLLATE NOCASE LIMIT 1`,
    [name],
  );
  if (nameTaken) {
    throw new HttpError(409, 'circle_name_taken', `A circle named "${name}" already exists`);
  }

  const familyId = newId();
  const memberId = newId();
  const principalId = newPrincipalId();
  const ts = nowIso();
  const code = newProvisioningCode();
  const codeHash = await credentialHash(env.TOKEN_PEPPER, code);
  const provisionExpiresAt = hoursFromNow(PROVISION_TTL_HOURS);
  try {
    await db.execAtomically([
      principalInsertOp(principalId, ts),
      { sql: `INSERT INTO families(id, name, created_at) VALUES (?,?,?)`, params: [familyId, name, ts] },
      {
        sql: `INSERT INTO members(id, family_id, name, email, role, principal_id, created_at) VALUES (?,?,?,?,?,?,?)`,
        params: [memberId, familyId, ownerName, ownerEmail, 'owner', principalId, ts],
      },
      {
        sql: `INSERT INTO provisioning_codes(code_hash, family_id, member_id, agent_label, created_by, expires_at, used_at)
              VALUES (?,?,?,?,?,?,NULL)`,
        params: [codeHash, familyId, memberId, 'owner-agent', memberId, provisionExpiresAt],
      },
    ]);
  } catch (e) {
    if (isUniqueViolation(e)) {
      throw new HttpError(409, 'circle_name_taken', `A circle named "${name}" already exists`);
    }
    throw e;
  }
  // Member goes through publicMember(), the single canonical serializer —
  // hand-built member objects drift (a missing family_id once crashed the
  // CLI's circle join after token issuance).
  const createdMember = await db.queryOne(`SELECT * FROM members WHERE id = ?`, [memberId]);
  if (!createdMember) throw new HttpError(500, 'internal', 'Member row missing after create');
  return json(
    {
      family: { id: familyId, name, created_at: ts },
      member: publicMember(createdMember),
      provisioning_code: code,
      provisioning_expires_at: hoursFromNow(PROVISION_TTL_HOURS),
    },
    201,
  );
}

/**
 * True when the caller is a hub owner: the principal behind the verified
 * calling token holds the 'owner' role in at least one circle (F02).
 * Identity is matched by principal_id — never by the email string — so a
 * member row that merely shares an email with another circle's owner gains
 * no hub-owner powers. Fail closed: no principal, no power.
 */
async function isHubOwner(db: DbClient, auth: AuthContext): Promise<boolean> {
  if (auth.role === 'owner') return true;
  const pid = auth.principal_id;
  if (!pid) return false;
  const row = await db.queryOne(
    `SELECT 1 FROM members WHERE principal_id = ? AND role = 'owner' LIMIT 1`,
    [pid],
  );
  return row !== null;
}

// POST /v1/families while SETUP_LOCKED=1 — hub-owner circle creation
// (v0.2.0+). The caller must authenticate (401) and be a hub owner (403).
// The creator becomes an 'owner' member of the new family, and receives a
// single-use provisioning code (mirroring bootstrap) so their agent can
// mint a token bound to the new family — the existing token stays bound
// to the old one.
async function handleCreateFamilyLocked(db: DbClient, env: Env, req: Request): Promise<Response> {
  const auth = await resolveToken(db, env, req.headers.get('authorization'));
  if (!(await isHubOwner(db, auth))) {
    throw new HttpError(
      403,
      'forbidden',
      'Only hub owners can create a family while setup is locked',
    );
  }
  const body = await readJson(req);
  const name = reqString(body['name'], 'name', 1, 120).trim();
  if (name.length === 0) {
    throw new HttpError(400, 'bad_request', 'name must not be blank');
  }
  const kind =
    body['kind'] === undefined ? 'family' : reqEnum(body['kind'], 'kind', FAMILY_KINDS);
  const idemKey = readIdemKey(req);

  const me = await db.queryOne(`SELECT name, email FROM members WHERE id = ?`, [auth.member_id]);
  if (!me) throw new HttpError(401, 'unauthorized', 'Unknown token');
  const creatorName = me['name'] as string;
  const creatorEmail = me['email'] as string;
  // F02: the new member row inherits the caller's already-verified principal
  // (bound to the token by resolveToken, never from caller input). This is
  // the one legitimate cross-circle linking path: the caller's identity was
  // proven by their credential, so their new membership is the same person.
  const callerPrincipal = auth.principal_id;
  if (!callerPrincipal) {
    throw new HttpError(500, 'internal', 'Calling member has no principal');
  }

  // Idempotent retry: the client never got the first response, but the work
  // is done. Return the existing circle with a FRESH provisioning code (the
  // original code's plaintext is unrecoverable) instead of duplicating it.
  if (idemKey) {
    const prior = await findCreateIdem(db, 'family', auth.member_id, idemKey);
    if (prior) {
      logEvent('info', 'idempotency_hit', { scope: 'family', key: idemKey });
      return await dedupFamilyCreate(db, env, auth, prior['resource_id'] as string, idemKey, prior['code_hash'] as string | null);
    }
  }

  // Circle names are unique (case-insensitive) — identical names are almost
  // always an accident, and ambiguity here is dangerous.
  const nameTaken = await db.queryOne(
    `SELECT 1 FROM families WHERE name = ? COLLATE NOCASE LIMIT 1`,
    [name],
  );
  if (nameTaken) {
    logEvent('warn', 'circle_name_conflict', {});
    throw new HttpError(409, 'circle_name_taken', `A circle named "${name}" already exists`);
  }

  const familyId = newId();
  const memberId = newId();
  const ts = nowIso();
  const code = newProvisioningCode();
  const codeHash = await credentialHash(env.TOKEN_PEPPER, code);
  const provisionExpiresAt = hoursFromNow(PROVISION_TTL_HOURS);
  const ops: { sql: string; params: (string | number | null)[] }[] = [
    {
      sql: `INSERT INTO families(id, name, kind, created_at) VALUES (?,?,?,?)`,
      params: [familyId, name, kind, ts],
    },
    {
      sql: `INSERT INTO members(id, family_id, name, email, role, principal_id, created_at) VALUES (?,?,?,?,?,?,?)`,
      params: [memberId, familyId, creatorName, creatorEmail, 'owner', callerPrincipal, ts],
    },
    {
      sql: `INSERT INTO provisioning_codes(code_hash, family_id, member_id, agent_label, created_by, expires_at, used_at)
            VALUES (?,?,?,?,?,?,NULL)`,
      params: [codeHash, familyId, memberId, 'owner-agent', auth.member_id, provisionExpiresAt],
    },
  ];
  if (idemKey) {
    ops.push({
      sql: `INSERT OR REPLACE INTO create_idempotency
              (scope, member_id, key, resource_id, code_hash, created_at, expires_at)
            VALUES (?,?,?,?,?,?,?)`,
      params: ['family', auth.member_id, idemKey, familyId, codeHash, ts, hoursFromNow(IDEM_CREATE_TTL_HOURS)],
    });
  }
  try {
    await db.execAtomically(ops);
  } catch (e) {
    if (isUniqueViolation(e)) {
      // Lost a race: re-read to find out whether it was the name or the key.
      if (idemKey) {
        const prior = await findCreateIdem(db, 'family', auth.member_id, idemKey);
        if (prior) {
          return await dedupFamilyCreate(db, env, auth, prior['resource_id'] as string, idemKey, prior['code_hash'] as string | null);
        }
      }
      const taken = await db.queryOne(
        `SELECT 1 FROM families WHERE name = ? COLLATE NOCASE LIMIT 1`,
        [name],
      );
      if (taken) throw new HttpError(409, 'circle_name_taken', `A circle named "${name}" already exists`);
    }
    throw e;
  }
  logEvent('info', 'idempotency_stored', { scope: 'family', key: idemKey ?? '(none)' });
  return json(
    {
      id: familyId,
      name,
      kind,
      created_at: ts,
      provisioning_code: code,
      provisioning_expires_at: provisionExpiresAt,
    },
    201,
  );
}

// Shared dedup response for POST /v1/families with a repeated idempotency key.
// Issues a FRESH provisioning code for the already-created circle and revokes
// the orphaned token if the original code was redeemed — the retry proves the
// client never received that token.
async function dedupFamilyCreate(
  db: DbClient,
  env: Env,
  auth: AuthContext,
  familyId: string,
  idemKey: string,
  origCodeHash: string | null,
): Promise<Response> {
  const family = await db.queryOne(`SELECT * FROM families WHERE id = ?`, [familyId]);
  if (!family) throw new HttpError(500, 'internal', 'Idempotency record points at a missing circle');
  const member = await db.queryOne(
    // F02: match the caller's member row in the new circle by principal_id —
    // the verified identity — never by the email string.
    `SELECT * FROM members WHERE family_id = ? AND principal_id = (SELECT principal_id FROM members WHERE id = ?)`,
    [familyId, auth.member_id],
  );
  if (!member) throw new HttpError(500, 'internal', 'Idempotency record points at a missing member');
  if (origCodeHash) {
    const pc = await db.queryOne(
      `SELECT redeemed_token_id FROM provisioning_codes WHERE code_hash = ?`,
      [origCodeHash],
    );
    const orphanTid = pc?.['redeemed_token_id'] as string | null;
    if (orphanTid) {
      await db.execAtomically([
        {
          sql: `UPDATE agent_tokens SET revoked_at = ? WHERE token_id = ? AND revoked_at IS NULL`,
          params: [nowIso(), orphanTid],
        },
      ]);
      logEvent('info', 'orphan_token_revoked', {});
    }
  }
  const minted = await mintProvisioningCode(db, env, {
    familyId,
    memberId: member['id'] as string,
    agentLabel: 'owner-agent',
    createdBy: auth.member_id,
    issuedByTokenId: auth.token_id,
  });
  await recordCreateIdem(db, 'family', auth.member_id, idemKey, familyId, minted.codeHash);
  return json(
    {
      id: familyId,
      name: family['name'],
      kind: family['kind'],
      created_at: family['created_at'],
      provisioning_code: minted.code,
      provisioning_expires_at: minted.expiresAt,
      deduped: true,
    },
    200,
  );
}

// GET /v1/families — list circles the caller is a member of (v0.2.0+).
// Membership is matched by principal_id (F02): the stable identity behind
// the verified calling token. A member row that merely shares an email with
// a member of another circle is NOT linked to it — emails are attributes,
// not identity keys. Fail closed: no principal, no circles.
async function handleListFamilies(db: DbClient, auth: AuthContext): Promise<Response> {
  const pid = auth.principal_id;
  if (!pid) return json({ families: [] });
  const rows = await db.queryAll(
    `SELECT f.id, f.name, f.kind, f.created_at, m.role AS my_role
       FROM families f
       JOIN members m ON m.family_id = f.id
      WHERE m.principal_id = ?
      ORDER BY f.created_at ASC`,
    [pid],
  );
  return json({
    families: rows.map((r) => ({
      id: r['id'],
      name: r['name'],
      kind: r['kind'],
      my_role: r['my_role'],
      created_at: r['created_at'],
    })),
  });
}

// POST /v1/families/:fid/invites — owner/parent only.
async function handleCreateInvite(
  db: DbClient,
  env: Env,
  req: Request,
  auth: AuthContext,
  fid: string,
): Promise<Response> {
  if (fid !== auth.family_id) throw new HttpError(404, 'not_found', 'Family not found');
  if (auth.role !== 'owner' && auth.role !== 'parent') {
    throw new HttpError(403, 'forbidden', 'Only owner/parent can invite members');
  }
  const body = await readJson(req);
  const email = reqEmail(body['email']);
  const role = reqEnum(body['role'], 'role', MEMBER_ROLES);
  if (role === 'owner' && auth.role !== 'owner') {
    throw new HttpError(403, 'forbidden', 'Only the owner can invite another owner');
  }
  const idemKey = readIdemKey(req);
  if (idemKey) {
    const prior = await findCreateIdem(db, 'invite', auth.member_id, idemKey);
    if (prior) {
      // Mirror the normal path: if the email joined since, report it.
      const already = await db.queryOne(
        `SELECT id FROM members WHERE family_id = ? AND email = ?`,
        [auth.family_id, email],
      );
      if (already) throw new HttpError(409, 'already_member', 'This email is already a family member');
      // Fresh invite code for the same (email, role): the original code's
      // plaintext is unrecoverable, and the invitee never got it.
      logEvent('info', 'idempotency_hit', { scope: 'invite', key: idemKey });
      const code = newInviteCode();
      const codeHash = await credentialHash(env.TOKEN_PEPPER, code);
      const expiresAt = daysFromNow(INVITE_TTL_DAYS);
      await db.execAtomically([
        {
          sql: `INSERT INTO invites(code_hash, family_id, email, role, created_by, expires_at, used_at)
                VALUES (?,?,?,?,?,?,NULL)`,
          params: [codeHash, auth.family_id, email, role, auth.member_id, expiresAt],
        },
        {
          sql: `INSERT OR REPLACE INTO create_idempotency
                  (scope, member_id, key, resource_id, code_hash, created_at, expires_at)
                VALUES (?,?,?,?,?,?,?)`,
          params: ['invite', auth.member_id, idemKey, codeHash, null, nowIso(), hoursFromNow(IDEM_CREATE_TTL_HOURS)],
        },
      ]);
      logEvent('info', 'idempotency_stored', { scope: 'invite', key: idemKey });
      return json({ invite_code: code, expires_at: expiresAt, deduped: true });
    }
  }
  const existing = await db.queryOne(
    `SELECT id FROM members WHERE family_id = ? AND email = ?`,
    [auth.family_id, email],
  );
  if (existing) throw new HttpError(409, 'already_member', 'This email is already a family member');

  const code = newInviteCode();
  const codeHash = await credentialHash(env.TOKEN_PEPPER, code);
  const expiresAt = daysFromNow(INVITE_TTL_DAYS);
  const ops: { sql: string; params: (string | number | null)[] }[] = [
    {
      sql: `INSERT INTO invites(code_hash, family_id, email, role, created_by, expires_at, used_at)
            VALUES (?,?,?,?,?,?,NULL)`,
      params: [codeHash, auth.family_id, email, role, auth.member_id, expiresAt],
    },
  ];
  if (idemKey) {
    ops.push({
      sql: `INSERT OR REPLACE INTO create_idempotency
              (scope, member_id, key, resource_id, code_hash, created_at, expires_at)
            VALUES (?,?,?,?,?,?,?)`,
      params: ['invite', auth.member_id, idemKey, codeHash, null, nowIso(), hoursFromNow(IDEM_CREATE_TTL_HOURS)],
    });
  }
  await db.execAtomically(ops);
  if (idemKey) logEvent('info', 'idempotency_stored', { scope: 'invite', key: idemKey });
  return json({ invite_code: code, expires_at: expiresAt }, 201);
}

// POST /v1/invites/:code/accept — no auth; the code is the credential.
async function handleAcceptInvite(
  db: DbClient,
  env: Env,
  req: Request,
  code: string,
): Promise<Response> {
  const body = await readJson(req);
  const displayName = reqString(body['display_name'], 'display_name', 1, 120);
  const agentLabel = reqString(body['agent_label'], 'agent_label', 1, 80);

  const codeHash = await credentialHash(env.TOKEN_PEPPER, code);
  const invite = await db.queryOne(`SELECT * FROM invites WHERE code_hash = ?`, [codeHash]);
  if (!invite) throw new HttpError(404, 'not_found', 'Invite not found');
  if (invite['used_at']) {
    const existingMember = await db.queryOne(
      `SELECT * FROM members WHERE family_id = ? AND email = ?`,
      [invite['family_id'] as string, invite['email'] as string],
    );
    return json(
      {
        error: { code: 'invite_used', message: 'Invite already used' },
        member: existingMember ? publicMember(existingMember) : null,
        token_already_issued: true,
      },
      409,
    );
  }
  if ((invite['expires_at'] as string) <= nowIso()) {
    throw new HttpError(410, 'invite_expired', 'Invite expired');
  }
  const email = invite['email'] as string;
  const inviteFamilyId = invite['family_id'] as string;
  const inviteRole = invite['role'] as string;
  const dup = await db.queryOne(
    `SELECT id FROM members WHERE family_id = ? AND email = ?`,
    [inviteFamilyId, email],
  );
  if (dup) throw new HttpError(409, 'already_member', 'This email is already a family member');

  const memberId = newId();
  const principalId = newPrincipalId();
  const token = newAgentToken();
  const tokenHash = await credentialHash(env.TOKEN_PEPPER, token);
  const tokenId = newId();
  const ts = nowIso();
  // F05: atomic conditional consume. The member and token INSERTs only fire
  // while the invite is still unused, and the UPDATE consumes it — one atomic
  // batch, in this order (the conditional INSERTs must run before the consume
  // UPDATE so they see pre-consume state). Concurrent accepts of the same
  // code therefore create exactly one member and one token; the winner is the
  // call whose member row exists afterwards.
  // F02: the new member gets a FRESH principal. An invite code proves code
  // possession, not email ownership, so the row must never inherit another
  // circle's principal by email match — even when the same email already has
  // a member elsewhere. (If the conditional member INSERT below does not
  // fire, the principals row is an inert orphan: nothing references
  // principals outward.)
  await db.execAtomically([
    principalInsertOp(principalId, ts),
    {
      sql: `INSERT INTO members(id, family_id, name, email, role, principal_id, created_at)
            SELECT ?,?,?,?,?,?,?
             WHERE EXISTS (SELECT 1 FROM invites WHERE code_hash = ? AND used_at IS NULL)`,
      params: [memberId, inviteFamilyId, displayName, email, inviteRole, principalId, ts, codeHash],
    },
    {
      sql: `INSERT INTO agent_tokens(token_hash, token_id, member_id, agent_label, created_at, revoked_at, last_used_at, issued_by_token_id)
            SELECT ?,?,?,?,?,NULL,NULL,NULL
             WHERE EXISTS (SELECT 1 FROM invites WHERE code_hash = ? AND used_at IS NULL)`,
      params: [tokenHash, tokenId, memberId, agentLabel, ts, codeHash],
    },
    {
      sql: `UPDATE invites SET used_at = ? WHERE code_hash = ? AND used_at IS NULL`,
      params: [ts, codeHash],
    },
  ]);
  const won = await db.queryOne(`SELECT id FROM members WHERE id = ?`, [memberId]);
  if (!won) {
    // Lost a concurrent-accept race: the winner's member row holds this email.
    const winnerMember = await db.queryOne(
      `SELECT * FROM members WHERE family_id = ? AND email = ?`,
      [inviteFamilyId, email],
    );
    return json(
      {
        error: { code: 'invite_used', message: 'Invite already used' },
        member: winnerMember ? publicMember(winnerMember) : null,
        token_already_issued: true,
      },
      409,
    );
  }
  // Token is returned ONCE here and never again.
  // The member object goes through publicMember(), the single canonical
  // member serializer — never hand-built. (A hand-built object once omitted
  // family_id, crashing the CLI's circle join AFTER issuance but BEFORE the
  // token was saved: invite spent, token lost.)
  const newMember = await db.queryOne(`SELECT * FROM members WHERE id = ?`, [memberId]);
  if (!newMember) throw new HttpError(500, 'internal', 'Member row missing after accept');
  return json(
    {
      member: publicMember(newMember),
      token,
      token_id: tokenId,
    },
    201,
  );
}

// ---------------------------------------------------------------------------
// Ownership transfer (offer -> accept). Ownership is a responsibility and is
// never forced on anyone: the current owner offers it to one existing member
// of the same circle, and the recipient must explicitly accept before
// anything changes. Exactly one pending transfer may exist per circle.
// ---------------------------------------------------------------------------

function publicTransfer(row: Row): Record<string, unknown> {
  return {
    id: row['id'],
    family_id: row['family_id'],
    from_member_id: row['from_member_id'],
    to_member_id: row['to_member_id'],
    on_complete: row['on_complete'],
    status: row['status'],
    created_at: row['created_at'],
    expires_at: row['expires_at'],
    decided_at: row['decided_at'],
  };
}

async function findPendingTransfer(db: DbClient, familyId: string): Promise<Row | null> {
  return await db.queryOne(
    `SELECT * FROM ownership_transfers WHERE family_id = ? AND status = 'pending' LIMIT 1`,
    [familyId],
  );
}

// Lazy expiry: a pending transfer past its expires_at can never be accepted
// again, so mark it cancelled the first time it is noticed. No background
// job needed (same pattern as the rate-limit rows in migration 0007).
async function cancelExpiredTransfer(db: DbClient, transfer: Row): Promise<void> {
  await db.execAtomically([
    {
      sql: `UPDATE ownership_transfers SET status = 'cancelled', decided_at = ? WHERE id = ? AND status = 'pending'`,
      params: [nowIso(), transfer['id'] as string],
    },
  ]);
  logEvent('info', 'ownership_transfer_expired', {});
}

// POST /v1/families/:fid/transfer — owner offers ownership to another member.
async function handleOfferOwnership(
  db: DbClient,
  env: Env,
  req: Request,
  auth: AuthContext,
  fid: string,
): Promise<Response> {
  if (fid !== auth.family_id) throw new HttpError(404, 'not_found', 'Family not found');
  if (auth.role !== 'owner') {
    throw new HttpError(403, 'forbidden', 'Only the circle owner can initiate an ownership transfer');
  }
  const body = await readJson(req);
  const toMemberId = reqString(body['to_member_id'], 'to_member_id', 1, 64);
  const onComplete =
    body['on_complete'] === undefined
      ? 'remove'
      : reqEnum(body['on_complete'], 'on_complete', TRANSFER_COMPLETION_MODES);

  // Target must be an existing member of THIS circle — never from
  // caller-supplied identity claims beyond the member id — and must not
  // already be an owner (a caller who is an owner cannot offer to themselves).
  const target = await db.queryOne(
    `SELECT * FROM members WHERE id = ? AND family_id = ?`,
    [toMemberId, auth.family_id],
  );
  if (!target) throw new HttpError(404, 'not_found', 'Target member is not in this circle');
  if (target['role'] === 'owner') {
    throw new HttpError(422, 'already_owner', 'Target member is already a circle owner');
  }

  // Idempotent retry: same key returns the transfer the first attempt made
  // (mirroring create/invite dedup) instead of a second pending transfer.
  const idemKey = readIdemKey(req);
  if (idemKey) {
    const prior = await findCreateIdem(db, 'ownership_transfer', auth.member_id, idemKey);
    if (prior) {
      const t = await db.queryOne(`SELECT * FROM ownership_transfers WHERE id = ?`, [
        prior['resource_id'] as string,
      ]);
      if (!t) {
        throw new HttpError(500, 'internal', 'Idempotency record points at a missing transfer');
      }
      logEvent('info', 'idempotency_hit', { scope: 'ownership_transfer', key: idemKey });
      return json({ transfer: publicTransfer(t), deduped: true });
    }
  }

  // Exactly one pending transfer per circle. An expired pending transfer is
  // not a live offer — cancel it and let the new offer proceed.
  const existing = await findPendingTransfer(db, auth.family_id);
  if (existing) {
    if ((existing['expires_at'] as string) <= nowIso()) {
      await cancelExpiredTransfer(db, existing);
    } else {
      throw new HttpError(409, 'transfer_pending', 'A transfer offer is already pending for this circle');
    }
  }

  const transferId = newId();
  const ts = nowIso();
  const expiresAt = daysFromNow(TRANSFER_TTL_DAYS);
  const ops: { sql: string; params: (string | number | null)[] }[] = [
    {
      sql: `INSERT INTO ownership_transfers(id, family_id, from_member_id, to_member_id, on_complete, status, created_at, expires_at, decided_at)
            VALUES (?,?,?,?,?,'pending',?,?,NULL)`,
      params: [transferId, auth.family_id, auth.member_id, toMemberId, onComplete, ts, expiresAt],
    },
  ];
  if (idemKey) {
    ops.push({
      sql: `INSERT OR REPLACE INTO create_idempotency
              (scope, member_id, key, resource_id, code_hash, created_at, expires_at)
            VALUES (?,?,?,?,?,?,?)`,
      params: [
        'ownership_transfer',
        auth.member_id,
        idemKey,
        transferId,
        null,
        ts,
        hoursFromNow(IDEM_CREATE_TTL_HOURS),
      ],
    });
  }
  try {
    await db.execAtomically(ops);
  } catch (e) {
    if (isUniqueViolation(e)) {
      // Lost a race with a concurrent offer: exactly one pending transfer
      // per circle is enforced by the partial unique index.
      throw new HttpError(409, 'transfer_pending', 'A transfer offer is already pending for this circle');
    }
    throw e;
  }
  if (idemKey) logEvent('info', 'idempotency_stored', { scope: 'ownership_transfer', key: idemKey });
  logEvent('info', 'ownership_transfer_initiated', {});
  const created = await db.queryOne(`SELECT * FROM ownership_transfers WHERE id = ?`, [
    transferId,
  ]);
  if (!created) throw new HttpError(500, 'internal', 'Transfer row missing after insert');
  return json({ transfer: publicTransfer(created) }, 201);
}

// POST /v1/families/:fid/transfer/accept — the named recipient accepts.
async function handleAcceptOwnershipTransfer(
  db: DbClient,
  auth: AuthContext,
  fid: string,
): Promise<Response> {
  if (fid !== auth.family_id) throw new HttpError(404, 'not_found', 'Family not found');
  const transfer = await findPendingTransfer(db, auth.family_id);
  if (!transfer) {
    throw new HttpError(404, 'not_found', 'No pending ownership transfer for this circle');
  }
  if ((transfer['expires_at'] as string) <= nowIso()) {
    await cancelExpiredTransfer(db, transfer);
    throw new HttpError(410, 'transfer_expired', 'The ownership transfer offer has expired');
  }
  // Only the named recipient may accept — ownership is never forced on
  // anyone else.
  if (auth.member_id !== transfer['to_member_id']) {
    throw new HttpError(403, 'forbidden', 'Only the named recipient can accept this ownership transfer');
  }

  // Re-verify both parties are still in place before the swap. The offer
  // lapses if the offering owner left the circle or lost the owner role,
  // and if the recipient is gone there is no one to promote.
  const target = await db.queryOne(
    `SELECT id, role FROM members WHERE id = ? AND family_id = ?`,
    [transfer['to_member_id'] as string, auth.family_id],
  );
  if (!target) {
    throw new HttpError(410, 'transfer_recipient_gone', 'The transfer recipient is no longer a member');
  }
  const offerer = await db.queryOne(
    `SELECT id, role FROM members WHERE id = ? AND family_id = ?`,
    [transfer['from_member_id'] as string, auth.family_id],
  );
  if (!offerer || offerer['role'] !== 'owner') {
    await db.execAtomically([
      {
        sql: `UPDATE ownership_transfers SET status = 'cancelled', decided_at = ? WHERE id = ? AND status = 'pending'`,
        params: [nowIso(), transfer['id'] as string],
      },
    ]);
    throw new HttpError(409, 'transfer_offer_lapsed', 'The offering owner is no longer a circle owner');
  }

  const ts = nowIso();
  const offererId = offerer['id'] as string;
  const recipientId = target['id'] as string;
  const onComplete = transfer['on_complete'] as string;
  // The swap is ONE atomic batch — promote first, then strip the offering
  // owner's role — so the circle never sits with zero owners.
  const ops: { sql: string; params: (string | number | null)[] }[] = [
    {
      sql: `UPDATE members SET role = 'owner' WHERE id = ? AND family_id = ?`,
      params: [recipientId, auth.family_id],
    },
    {
      sql: `UPDATE ownership_transfers SET status = 'completed', decided_at = ? WHERE id = ? AND status = 'pending'`,
      params: [ts, transfer['id'] as string],
    },
    {
      sql: `UPDATE members SET role = 'parent' WHERE id = ? AND role = 'owner'`,
      params: [offererId],
    },
  ];
  if (onComplete === 'remove') {
    // The offering owner's session ends with the transfer: revoke every
    // agent token they hold for this circle. Their member row is RETAINED
    // (not deleted) — invites, topics, entries, tasks and the audit trail
    // reference members(id) with NOT NULL foreign keys, so a physical
    // DELETE would either fail or destroy circle history. With no valid
    // tokens and the owner role stripped, they cannot act in the circle
    // again until the new owner re-enrolls them.
    ops.push({
      sql: `UPDATE agent_tokens SET revoked_at = ? WHERE member_id = ? AND revoked_at IS NULL`,
      params: [ts, offererId],
    });
  }
  await db.execAtomically(ops);
  logEvent('info', 'ownership_transfer_completed', {});
  const completed = await db.queryOne(`SELECT * FROM ownership_transfers WHERE id = ?`, [
    transfer['id'] as string,
  ]);
  if (!completed) throw new HttpError(500, 'internal', 'Transfer row missing after completion');
  return json({
    transfer: publicTransfer(completed),
    new_owner: { id: recipientId, role: 'owner' },
    previous_owner: { id: offererId, role: onComplete === 'demote' ? 'parent' : 'removed' },
  });
}

// POST /v1/families/:fid/transfer/cancel — the current owner withdraws a
// pending offer.
async function handleCancelOwnershipTransfer(
  db: DbClient,
  auth: AuthContext,
  fid: string,
): Promise<Response> {
  if (fid !== auth.family_id) throw new HttpError(404, 'not_found', 'Family not found');
  if (auth.role !== 'owner') {
    throw new HttpError(403, 'forbidden', 'Only the circle owner can cancel an ownership transfer');
  }
  const transfer = await findPendingTransfer(db, auth.family_id);
  if (!transfer) {
    throw new HttpError(404, 'not_found', 'No pending ownership transfer for this circle');
  }
  if ((transfer['expires_at'] as string) <= nowIso()) {
    await cancelExpiredTransfer(db, transfer);
    throw new HttpError(410, 'transfer_expired', 'The ownership transfer offer has already expired');
  }
  const ts = nowIso();
  await db.execAtomically([
    {
      sql: `UPDATE ownership_transfers SET status = 'cancelled', decided_at = ? WHERE id = ? AND status = 'pending'`,
      params: [ts, transfer['id'] as string],
    },
  ]);
  logEvent('info', 'ownership_transfer_cancelled', {});
  const cancelled = await db.queryOne(`SELECT * FROM ownership_transfers WHERE id = ?`, [
    transfer['id'] as string,
  ]);
  if (!cancelled) throw new HttpError(500, 'internal', 'Transfer row missing after cancellation');
  return json({ transfer: publicTransfer(cancelled) });
}

// GET /v1/families/:fid/transfer — any circle member may read the pending
// offer (or {transfer: null} when there is none).
async function handleGetOwnershipTransfer(
  db: DbClient,
  auth: AuthContext,
  fid: string,
): Promise<Response> {
  if (fid !== auth.family_id) throw new HttpError(404, 'not_found', 'Family not found');
  const transfer = await findPendingTransfer(db, auth.family_id);
  return json({ transfer: transfer ? publicTransfer(transfer) : null });
}

// POST /v1/provisioning-codes — mint a single-use code for an extra agent.
// (SPEC §6 step 4; endpoint added — see SPEC_GAPS.md note.)
async function handleMintProvisioning(
  db: DbClient,
  env: Env,
  req: Request,
  auth: AuthContext,
): Promise<Response> {
  const body = await readJson(req);
  const memberId = reqString(body['member_id'], 'member_id', 1, 128);
  const agentLabel = reqString(body['agent_label'], 'agent_label', 1, 80);
  const target = await db.queryOne(
    `SELECT * FROM members WHERE id = ? AND family_id = ?`,
    [memberId, auth.family_id],
  );
  if (!target) throw new HttpError(404, 'not_found', 'Member not found');
  const selfMint = memberId === auth.member_id;
  // F01: only the owner can mint a credential for another member. Self-mint
  // is always allowed, for every role. In particular a parent can never mint
  // for an owner-role member (or for any other member at all).
  if (!selfMint && auth.role !== 'owner') {
    throw new HttpError(403, 'forbidden', 'Only the owner can mint codes for other members');
  }
  const minted = await mintProvisioningCode(db, env, {
    familyId: auth.family_id,
    memberId,
    agentLabel,
    createdBy: auth.member_id,
    issuedByTokenId: auth.token_id,
  });
  return json({ provisioning_code: minted.code, expires_at: minted.expiresAt }, 201);
}

// POST /v1/provisioning-codes/:code/redeem — no auth; the code is the credential.
async function handleRedeemProvisioning(
  db: DbClient,
  env: Env,
  req: Request,
  code: string,
): Promise<Response> {
  // E2EE (Phase 1): optional agent_public_key binds the agent's X25519
  // identity to the same (member_id, agent_label) as the token being
  // issued. Validated (400) BEFORE the single-use code is consumed — a
  // malformed key must never burn the code. Absent = the agent has no
  // E2EE identity; plaintext topics still work.
  const body: Record<string, unknown> = await readJson(req).catch(() => ({}));
  const agentPublicKey = optAgentPublicKey(body['agent_public_key'], 'agent_public_key');
  const codeHash = await credentialHash(env.TOKEN_PEPPER, code);
  const pc = await db.queryOne(`SELECT * FROM provisioning_codes WHERE code_hash = ?`, [codeHash]);
  if (!pc) throw new HttpError(404, 'not_found', 'Provisioning code not found');
  if (pc['used_at']) {
    // Explicit, actionable shape (not a generic 409): the client can tell the
    // user they are already a member but this device holds no token, and ask
    // an owner for a fresh code.
    const member = await db.queryOne(`SELECT * FROM members WHERE id = ?`, [pc['member_id'] as string]);
    return json(
      {
        error: { code: 'code_used', message: 'Provisioning code already used' },
        member: member ? publicMember(member) : null,
        token_already_issued: true,
      },
      409,
    );
  }
  if ((pc['expires_at'] as string) <= nowIso()) {
    throw new HttpError(410, 'code_expired', 'Provisioning code expired');
  }
  const member = await db.queryOne(`SELECT * FROM members WHERE id = ?`, [pc['member_id'] as string]);
  if (!member) throw new HttpError(404, 'not_found', 'Member not found');

  const token = newAgentToken();
  const tokenHash = await credentialHash(env.TOKEN_PEPPER, token);
  const tokenId = newId();
  const ts = nowIso();
  if (agentPublicKey) {
    // One active key per (member_id, agent_label). A second enrollment for
    // the same agent label must not silently replace the existing E2EE
    // identity — the partial unique index is the backstop, but fail here
    // with an actionable 409 instead of a constraint error. (Rotation of an
    // existing identity goes through POST /v1/agent-keys/rotate with the
    // agent's bearer token, not a fresh provisioning code.)
    const existing = await db.queryOne(
      `SELECT id FROM agent_keys WHERE member_id = ? AND agent_label = ? AND superseded_at IS NULL`,
      [pc['member_id'] as string, pc['agent_label'] as string],
    );
    if (existing) {
      throw new HttpError(
        409,
        'agent_key_exists',
        'An E2EE identity key is already registered for this agent label. ' +
          'Use a distinct agent label for the new agent, or rotate the ' +
          'existing key with POST /v1/agent-keys/rotate.',
      );
    }
  }
  // F05: atomic conditional consume + issue in a single batch. The token
  // INSERT only fires while the code is still unused (the conditional
  // INSERT...SELECT runs before the consume UPDATE so it sees pre-consume
  // state); the UPDATE then consumes the code iff still unused. Concurrent
  // redeems of the same code therefore mint exactly one token — the winner
  // is the call whose token_id the code row records as redeemed_token_id.
  // F17: the new token inherits the code's issued_by_token_id, so revoking
  // the minter's token cascades to it.
  await db.execAtomically([
    {
      sql: `INSERT INTO agent_tokens(token_hash, token_id, member_id, agent_label, created_at, revoked_at, last_used_at, issued_by_token_id)
            SELECT ?, ?, pc.member_id, pc.agent_label, ?, NULL, NULL, pc.issued_by_token_id
              FROM provisioning_codes pc
             WHERE pc.code_hash = ? AND pc.used_at IS NULL`,
      params: [tokenHash, tokenId, ts, codeHash],
    },
    {
      sql: `UPDATE provisioning_codes SET used_at = ?, redeemed_token_id = ? WHERE code_hash = ? AND used_at IS NULL`,
      params: [ts, tokenId, codeHash],
    },
    // E2EE (Phase 1): bind the agent's public key to the same
    // (member_id, agent_label) in the SAME atomic batch as the token
    // issuance. The conditional INSERT only fires for the redeem that won
    // the code (redeemed_token_id = this call's tokenId, set by the UPDATE
    // above) — the loser of a concurrent-redeem race stores nothing.
    ...(agentPublicKey
      ? [
          {
            sql: `INSERT INTO agent_keys(id, member_id, agent_label, public_key, created_at, superseded_at)
                  SELECT ?, pc.member_id, pc.agent_label, ?, ?, NULL
                    FROM provisioning_codes pc
                   WHERE pc.code_hash = ? AND pc.redeemed_token_id = ?`,
            params: [newId(), agentPublicKey, ts, codeHash, tokenId],
          },
        ]
      : []),
  ]);
  const consumed = await db.queryOne(
    `SELECT redeemed_token_id FROM provisioning_codes WHERE code_hash = ?`,
    [codeHash],
  );
  if (!consumed || consumed['redeemed_token_id'] !== tokenId) {
    // Lost a concurrent-redeem race: another call consumed the code first.
    return json(
      {
        error: { code: 'code_used', message: 'Provisioning code already used' },
        member: member ? publicMember(member) : null,
        token_already_issued: true,
      },
      409,
    );
  }
  return json({ token, token_id: tokenId, member: publicMember(member) }, 201);
}

// E2EE (Phase 1) — GET /v1/agent-keys?member_id=… — the public-key
// directory. Authenticated. Returns ACTIVE keys only, and only for members
// the caller shares a circle (family) with — never cross-circle. Public
// keys are public, so the only access rule is circle membership; no key
// material beyond the public key is ever returned (see publicAgentKey).
async function handleAgentKeyDirectory(
  db: DbClient,
  req: Request,
  auth: AuthContext,
): Promise<Response> {
  const url = new URL(req.url);
  const memberId = url.searchParams.get('member_id');
  if (memberId !== null && (memberId.length === 0 || memberId.length > 128)) {
    throw new HttpError(400, 'bad_request', 'member_id must be 1-128 chars');
  }
  const base = `SELECT k.member_id, k.agent_label, k.public_key, k.created_at
      FROM agent_keys k
      JOIN members m ON m.id = k.member_id
     WHERE k.superseded_at IS NULL AND m.family_id = ?`;
  const rows = memberId
    ? await db.queryAll(`${base} AND k.member_id = ?`, [auth.family_id, memberId])
    : await db.queryAll(base, [auth.family_id]);
  return json({ keys: rows.map(publicAgentKey) });
}

// E2EE (Phase 1) — POST /v1/agent-keys/rotate {agent_public_key} —
// register (or rotate) the caller's agent identity key. Authenticated by
// the caller's bearer token, which is the bootstrap: the token proves WHO
// the agent is, the keypair becomes WHAT it can decrypt. The current
// active key (if any) is marked superseded and kept — never deleted — so
// existing envelopes still resolve; the new row becomes the single active
// key for (member_id, agent_label). Calling it with no prior key is the
// initial registration path (used by `hub key-init`).
async function handleAgentKeyRotate(
  db: DbClient,
  req: Request,
  auth: AuthContext,
): Promise<Response> {
  const body = await readJson(req);
  const agentPublicKey = reqAgentPublicKey(body['agent_public_key'], 'agent_public_key');
  const ts = nowIso();
  const keyId = newId();
  await db.execAtomically([
    {
      sql: `UPDATE agent_keys SET superseded_at = ?
             WHERE member_id = ? AND agent_label = ? AND superseded_at IS NULL`,
      params: [ts, auth.member_id, auth.agent_label],
    },
    {
      sql: `INSERT INTO agent_keys(id, member_id, agent_label, public_key, created_at, superseded_at)
            VALUES (?,?,?,?,?,NULL)`,
      params: [keyId, auth.member_id, auth.agent_label, agentPublicKey, ts],
    },
  ]);
  return json({
    member_id: auth.member_id,
    agent_label: auth.agent_label,
    public_key: agentPublicKey,
    created_at: ts,
  });
}

// E2EE (Phase 2) — POST /v1/topics/:tid/envelopes {member_id, agent_label,
// key_id, envelope} — store one sealed topic-key envelope for a recipient
// agent. The envelope blob is opaque to the server: format-validated
// (base64) and stored, never inspected.
//
// Access control (defense in depth; crypto is per-agent but the blob store
// still gates on membership):
//   - caller must be a current participant of the topic (403 otherwise;
//     404 when the topic doesn't exist in the caller's family);
//   - the target (member_id, agent_label) must be a current participant
//     AND hold an ACTIVE (non-superseded) registered public key (400
//     otherwise — sealing to an agent with no key on file is meaningless);
//   - KEY ELECTION (secfix F1): topics.current_key_id is the single source
//     of truth for "the current key". POSTing an envelope whose key_id
//     differs from current_key_id INTRODUCES a new key (rotation) and is
//     allowed only for owner/parent callers (403 otherwise); on success
//     current_key_id advances to the new key_id in the same atomic batch.
//     This stops a participant from downgrading victims to a removed
//     member's key or hijacking encryption to an attacker key.
// Re-POSTing the same (topic_id, member_id, agent_label, key_id) replaces
// the stored envelope — idempotent distribution — and PRESERVES the
// original created_at (secfix F3): re-POSTing must not forge recency.
async function handlePostEnvelope(
  db: DbClient,
  req: Request,
  auth: AuthContext,
  tid: string,
): Promise<Response> {
  const { topic } = await requireParticipant(db, auth, tid);
  const body = await readJson(req);
  const targetMemberId = reqString(body['member_id'], 'member_id', 1, 128);
  const targetAgentLabel = reqString(body['agent_label'], 'agent_label', 1, 80);
  const keyId = reqKeyId(body['key_id'], 'key_id');
  const envelope = reqEnvelopeB64(body['envelope'], 'envelope');
  // F1: a key_id different from the topic's current_key_id is a rotation —
  // owner/parent privilege. (current_key_id is NULL only for topics created
  // before this column existed; the same gate bootstraps those.)
  const currentKeyId = topic['current_key_id'] as string | null;
  let rotates = false;
  if (keyId !== currentKeyId) {
    if (auth.role !== 'owner' && auth.role !== 'parent') {
      throw new HttpError(
        403,
        'forbidden',
        'Only an owner or parent may introduce a new topic key (rotation). ' +
          'Ask an owner/parent to run `hub topic-rekey`.',
      );
    }
    rotates = true;
  }
  const targetPart = await db.queryOne(
    `SELECT member_id FROM topic_participants WHERE topic_id = ? AND member_id = ?`,
    [tid, targetMemberId],
  );
  if (!targetPart) {
    throw new HttpError(400, 'bad_request', 'envelope target must be a current participant of this topic');
  }
  const targetKey = await db.queryOne(
    `SELECT 1 FROM agent_keys WHERE member_id = ? AND agent_label = ? AND superseded_at IS NULL`,
    [targetMemberId, targetAgentLabel],
  );
  if (!targetKey) {
    throw new HttpError(
      400,
      'bad_request',
      'envelope target has no registered identity key; they must run `hub key-init` before they can receive envelopes',
    );
  }
  const ts = nowIso();
  const ops: { sql: string; params: (string | number | null)[] }[] = [
    {
      // F3: ON CONFLICT updates only the envelope blob — created_at keeps
      // its original value, so a re-POST cannot forge recency.
      sql: `INSERT INTO topic_key_envelopes(topic_id, member_id, agent_label, key_id, envelope, created_at)
            VALUES (?,?,?,?,?,?)
            ON CONFLICT(topic_id, member_id, agent_label, key_id)
            DO UPDATE SET envelope = excluded.envelope`,
      params: [tid, targetMemberId, targetAgentLabel, keyId, envelope, ts],
    },
  ];
  if (rotates) {
    ops.push({
      sql: `UPDATE topics SET current_key_id = ? WHERE id = ?`,
      params: [keyId, tid],
    });
  }
  await db.execAtomically(ops);
  const row = await db.queryOne(
    `SELECT created_at FROM topic_key_envelopes
      WHERE topic_id = ? AND member_id = ? AND agent_label = ? AND key_id = ?`,
    [tid, targetMemberId, targetAgentLabel, keyId],
  );
  return json(
    {
      topic_id: tid,
      member_id: targetMemberId,
      agent_label: targetAgentLabel,
      key_id: keyId,
      created_at: row!['created_at'],
    },
    201,
  );
}

// E2EE (Phase 2) — GET /v1/topics/:tid/envelopes — return ONLY the caller's
// own envelopes: rows are matched on the caller's (member_id, agent_label)
// taken from the Bearer <redacted> never from caller-supplied input. One agent
// can never fetch another agent's envelopes. 403 when the caller is not a
// participant (404 when the topic doesn't exist in the caller's family).
async function handleGetEnvelopes(
  db: DbClient,
  auth: AuthContext,
  tid: string,
): Promise<Response> {
  await requireParticipant(db, auth, tid);
  const rows = await db.queryAll(
    `SELECT topic_id, member_id, agent_label, key_id, envelope, created_at
       FROM topic_key_envelopes
      WHERE topic_id = ? AND member_id = ? AND agent_label = ?
      ORDER BY created_at ASC`,
    [tid, auth.member_id, auth.agent_label],
  );
  return json({ envelopes: rows });
}

// POST /v1/auth/rotate — new token; old valid 24h grace.
async function handleRotate(
  db: DbClient,
  env: Env,
  req: Request,
  auth: AuthContext,
): Promise<Response> {
  const raw = req.headers.get('authorization')!.slice('Bearer '.length).trim();
  const oldHash = await credentialHash(env.TOKEN_PEPPER, raw);
  // F04: a retired credential cannot be rotated again. A fully-revoked token
  // never reaches here (the auth choke point rejects it with 401); this
  // covers a token already carrying revoked_at, e.g. inside its
  // rotation-grace window. Rotate the current token instead.
  const old = await db.queryOne(`SELECT revoked_at FROM agent_tokens WHERE token_hash = ?`, [oldHash]);
  if (!old) throw new HttpError(401, 'unauthorized', 'Unknown token');
  if (old['revoked_at']) {
    throw new HttpError(403, 'forbidden', 'Token is retired; rotate using the current token instead');
  }
  const token = newAgentToken();
  const tokenHash = await credentialHash(env.TOKEN_PEPPER, token);
  const tokenId = newId();
  const ts = nowIso();
  const graceUntil = hoursFromNow(24);
  await db.execAtomically([
    { sql: `UPDATE agent_tokens SET revoked_at = ? WHERE token_hash = ?`, params: [graceUntil, oldHash] },
    {
      // issued_by_token_id stays NULL: rotation replaces a credential rather
      // than delegating authority, so the new token is deliberately NOT a
      // cascade target when the old token is revoked (F17).
      sql: `INSERT INTO agent_tokens(token_hash, token_id, member_id, agent_label, created_at, revoked_at, last_used_at, issued_by_token_id)
            VALUES (?,?,?, ?,?,NULL,NULL,NULL)`,
      params: [tokenHash, tokenId, auth.member_id, auth.agent_label, ts],
    },
  ]);
  return json({ token, token_id: tokenId, grace_until: graceUntil });
}

// POST /v1/auth/revoke {token_id} — self-revoke always; owner/parent for
// other members' tokens, except a parent can NEVER revoke an owner's token
// (F01). Revocation is immediate and unconditional: it overwrites any future
// rotation-grace timestamp (F04), expires pending provisioning codes issued
// under the token, and revokes one-level descendant tokens (F17; the
// one-level limit is documented — grandchildren survive).
async function handleRevoke(
  db: DbClient,
  _env: Env,
  req: Request,
  auth: AuthContext,
): Promise<Response> {
  const body = await readJson(req);
  const tokenId = reqString(body['token_id'], 'token_id', 1, 128);
  const target = await db.queryOne(
    `SELECT t.*, m.family_id AS fam, m.role AS member_role
       FROM agent_tokens t JOIN members m ON m.id = t.member_id
      WHERE t.token_id = ?`,
    [tokenId],
  );
  if (!target || target['fam'] !== auth.family_id) {
    throw new HttpError(404, 'not_found', 'Token not found');
  }
  const selfRevoke = (target['member_id'] as string) === auth.member_id;
  if (!selfRevoke) {
    if (auth.role !== 'owner' && auth.role !== 'parent') {
      throw new HttpError(403, 'forbidden', 'Only owner/parent can revoke other members\u2019 tokens');
    }
    if (target['member_role'] === 'owner' && auth.role !== 'owner') {
      throw new HttpError(403, 'forbidden', 'Only an owner can revoke an owner\u2019s token');
    }
  }
  const now = nowIso();
  // F17: transitive revocation via the credential lineage. A recursive CTE
  // computes the full descendant closure, so revoking T1 also revokes T2 and
  // T3 in a T1 -> T2 -> T3 chain. Rotated tokens have issued_by_token_id
  // NULL (rotation replaces rather than delegates), so they are excluded.
  const lineage = `WITH RECURSIVE lineage(id) AS (
    SELECT ? UNION ALL
    SELECT t.token_id FROM agent_tokens t JOIN lineage l ON t.issued_by_token_id = l.id
  ) SELECT id FROM lineage`;
  await db.execAtomically([
    // F04: unconditional — overwrites a future rotation-grace revoked_at.
    { sql: `UPDATE agent_tokens SET revoked_at = ? WHERE token_id = ?`, params: [now, tokenId] },
    // F17: expire pending (unused, unexpired) codes issued anywhere under
    // the revoked lineage. Redeeming them afterwards yields 410 code_expired.
    {
      sql: `UPDATE provisioning_codes SET expires_at = ?
             WHERE issued_by_token_id IN (${lineage}) AND used_at IS NULL AND expires_at > ?`,
      params: [now, tokenId, now],
    },
    // F17: transitive cascade to all descendant tokens.
    {
      sql: `UPDATE agent_tokens SET revoked_at = ? WHERE token_id IN (${lineage})`,
      params: [now, tokenId],
    },
  ]);
  return json({ ok: true });
}

// GET /v1/members
async function handleListMembers(db: DbClient, auth: AuthContext): Promise<Response> {
  const rows = await db.queryAll(
    `SELECT * FROM members WHERE family_id = ? ORDER BY created_at ASC`,
    [auth.family_id],
  );
  return json({ members: rows.map(publicMember) });
}

// GET /v1/me — identity bound to the calling token. Lets clients verify
// which circle a token belongs to before storing it (fail-closed paste flow).
async function handleGetSelf(db: DbClient, auth: AuthContext): Promise<Response> {
  const row = await db.queryOne(
    `SELECT * FROM members WHERE id = ? AND family_id = ?`,
    [auth.member_id, auth.family_id],
  );
  if (!row) throw new HttpError(401, 'unauthorized', 'Invalid token');
  return json({ ...publicMember(row), agent_label: auth.agent_label });
}

// POST /v1/topics
async function handleCreateTopic(
  db: DbClient,
  _env: Env,
  req: Request,
  auth: AuthContext,
): Promise<Response> {
  const body = await readJson(req);
  // E2EE (Phase 2): optional per-topic opt-in. Absent/null = 0 — plaintext
  // topics behave byte-identically to today.
  const e2ee = reqE2eeFlag(body['e2ee'], 'e2ee');
  // E2EE (secfix F1): the creator's client-generated key_id becomes the
  // topic's current_key_id — the single source of truth clients use to
  // elect the encryption key. Required for e2ee=1 (fail-closed: without it
  // no key could ever be elected); rejected for plaintext topics, where
  // current_key_id stays NULL.
  const initialKeyId =
    body['initial_key_id'] === undefined || body['initial_key_id'] === null
      ? null
      : reqKeyId(body['initial_key_id'], 'initial_key_id');
  if (e2ee === 1 && initialKeyId === null) {
    throw new HttpError(
      400,
      'bad_request',
      'initial_key_id is required for E2EE topics (the creator\u2019s key_id)',
    );
  }
  if (e2ee !== 1 && initialKeyId !== null) {
    throw new HttpError(400, 'bad_request', 'initial_key_id is only valid for E2EE topics');
  }
  // For E2EE topics the subject may arrive already encrypted (opaque to the
  // server — stored as-is): base64 of nonce(24) + XChaCha20-Poly1305
  // ciphertext of a <=200-char subject, so up to ~320 chars. The 1024 cap
  // is headroom, not a license for longer subjects. Plaintext topics keep
  // today's exact 1-200 limit.
  const subject = reqString(body['subject'], 'subject', 1, e2ee === 1 ? 1024 : 200);
  const kind = reqEnum(body['kind'], 'kind', ['direct', 'group'] as const);
  const parentsOnly = body['parents_only'] === true;
  const idemKey = readIdemKey(req);
  if (idemKey) {
    const prior = await findCreateIdem(db, 'topic', auth.member_id, idemKey);
    if (prior) {
      logEvent('info', 'idempotency_hit', { scope: 'topic', key: idemKey });
      const topic = await db.queryOne(`SELECT * FROM topics WHERE id = ?`, [prior['resource_id'] as string]);
      if (!topic) throw new HttpError(500, 'internal', 'Idempotency record points at a missing topic');
      return json({ topic, deduped: true });
    }
  }
  // E2EE topics need the creator's agent to hold a registered identity key:
  // the creator seals the first topic-key envelopes to every participant
  // (including themselves), and sealing to yourself requires a public key
  // on file. Fail with actionable guidance before touching participants.
  if (e2ee === 1) {
    const creatorKey = await db.queryOne(
      `SELECT 1 FROM agent_keys WHERE member_id = ? AND agent_label = ? AND superseded_at IS NULL`,
      [auth.member_id, auth.agent_label],
    );
    if (!creatorKey) {
      throw new HttpError(
        400,
        'bad_request',
        'E2EE topics require the creator\u2019s agent to have a registered identity key. ' +
          'Run `hub key-init` to generate and register one, then retry.',
      );
    }
  }
  // Group topics may pass an empty list: the creator is auto-added below.
  // Direct topics still require exactly 2 participants (checked after).
  let ids = reqIdArray(body['participant_member_ids'], 'participant_member_ids', 20, 0);

  if (parentsOnly && auth.role === 'kid') {
    throw new HttpError(403, 'forbidden', 'Kids cannot create parents-only topics');
  }
  const members = await requireFamilyMembers(db, auth, ids);

  if (kind === 'direct') {
    if (ids.length !== 2 || !ids.includes(auth.member_id)) {
      throw new HttpError(
        400,
        'bad_request',
        'direct topics require exactly 2 participants including yourself',
      );
    }
  } else {
    if (!ids.includes(auth.member_id)) ids = [...ids, auth.member_id];
  }

  if (parentsOnly) {
    for (const m of members) {
      if (m['role'] === 'kid') {
        throw new HttpError(400, 'bad_request', 'parents_only topics cannot include kid members');
      }
    }
    // Auto-include every owner/parent in the family.
    const grownups = await db.queryAll(
      `SELECT id FROM members WHERE family_id = ? AND role IN ('owner','parent')`,
      [auth.family_id],
    );
    for (const g of grownups) {
      const gid = g['id'] as string;
      if (!ids.includes(gid)) ids.push(gid);
    }
  }

  const topicId = newId();
  const ts = nowIso();
  const ops: { sql: string; params: (string | number | null)[] }[] = [
    {
      sql: `INSERT INTO topics(id, family_id, subject, kind, parents_only, parent_topic_id, link_visibility, created_by, created_at, e2ee, current_key_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      params: [topicId, auth.family_id, subject, kind, parentsOnly ? 1 : 0, null, 'placeholder', auth.member_id, ts, e2ee, initialKeyId],
    },
    ...ids.map(
      (mid): { sql: string; params: (string | number | null)[] } => ({
        sql: `INSERT INTO topic_participants(topic_id, member_id, joined_at, history_from_seq) VALUES (?,?,?,1)`,
        params: [topicId, mid, ts],
      }),
    ),
  ];
  if (idemKey) {
    ops.push({
      sql: `INSERT OR REPLACE INTO create_idempotency
              (scope, member_id, key, resource_id, code_hash, created_at, expires_at)
            VALUES (?,?,?,?,?,?,?)`,
      params: ['topic', auth.member_id, idemKey, topicId, null, ts, hoursFromNow(IDEM_CREATE_TTL_HOURS)],
    });
  }
  await db.execAtomically(ops);
  if (idemKey) logEvent('info', 'idempotency_stored', { scope: 'topic', key: idemKey });
  const topic = await db.queryOne(`SELECT * FROM topics WHERE id = ?`, [topicId]);
  return json({ topic }, 201);
}

// GET /v1/topics?q=
async function handleListTopics(
  db: DbClient,
  req: Request,
  auth: AuthContext,
): Promise<Response> {
  const url = new URL(req.url);
  const q = optSearchQuery(url.searchParams.get('q'));
  let rows: Row[];
  if (q) {
    rows = await db.queryAll(
      `SELECT t.* FROM topics t
        JOIN topic_participants p ON p.topic_id = t.id AND p.member_id = ?
       WHERE t.family_id = ? AND t.subject LIKE ? ESCAPE '\\'
       ORDER BY t.created_at DESC`,
      [auth.member_id, auth.family_id, `%${escapeLike(q)}%`],
    );
  } else {
    rows = await db.queryAll(
      `SELECT t.* FROM topics t
        JOIN topic_participants p ON p.topic_id = t.id AND p.member_id = ?
       WHERE t.family_id = ?
       ORDER BY t.created_at DESC`,
      [auth.member_id, auth.family_id],
    );
  }
  return json({ topics: rows });
}

// GET /v1/topics/:tid
async function handleGetTopic(db: DbClient, auth: AuthContext, tid: string): Promise<Response> {
  const { topic } = await requireParticipant(db, auth, tid);
  const parts = await db.queryAll(
    `SELECT p.member_id, p.joined_at, m.name, m.role
       FROM topic_participants p JOIN members m ON m.id = p.member_id
      WHERE p.topic_id = ?`,
    [tid],
  );
  return json({ topic, participants: parts });
}

// E2EE (secfix F4) — PATCH /v1/topics/:tid/subject {subject} — replace the
// topic subject. Participant-only (403 otherwise; 404 when the topic
// doesn't exist in the caller's family). E2EE topics only (400 otherwise):
// the endpoint exists so `hub new-topic --e2ee` can re-encrypt the subject
// with topic-bound AAD immediately after creation — topic ids are
// server-generated, so the CLI cannot bind topic_id at create time and must
// do the two-step (create, then PATCH). The subject is opaque to the
// server: validated like a created E2EE subject (1..1024 chars, the
// ciphertext headroom cap), stored as-is, never inspected or PII-scanned.
async function handlePatchTopicSubject(
  db: DbClient,
  req: Request,
  auth: AuthContext,
  tid: string,
): Promise<Response> {
  const { topic } = await requireParticipant(db, auth, tid);
  if (topic['e2ee'] !== 1) {
    throw new HttpError(400, 'bad_request', 'subject PATCH is only supported for E2EE topics');
  }
  const body = await readJson(req);
  const subject = reqString(body['subject'], 'subject', 1, 1024);
  await db.execAtomically([
    { sql: `UPDATE topics SET subject = ? WHERE id = ?`, params: [subject, tid] },
  ]);
  const updated = await db.queryOne(`SELECT * FROM topics WHERE id = ?`, [tid]);
  return json({ topic: updated });
}

// GET /v1/topics/:tid/history?after_seq=&limit=
async function handleHistory(
  db: DbClient,
  req: Request,
  auth: AuthContext,
  tid: string,
): Promise<Response> {
  const { history_from_seq } = await requireParticipant(db, auth, tid);
  const url = new URL(req.url);
  const after = parseSeqCursor(url.searchParams.get('after_seq'));
  const limit = parseLimit(url.searchParams.get('limit'), 100, 500);
  const rows = await db.queryAll(
    `SELECT * FROM entries
      WHERE topic_id = ? AND seq > ? AND seq >= ?
      ORDER BY seq ASC LIMIT ?`,
    [tid, after, history_from_seq, limit],
  );
  const maxRow = await db.queryOne(`SELECT MAX(seq) AS m FROM entries WHERE topic_id = ?`, [tid]);
  return json({ entries: rows.map(publicEntry), max_seq: (maxRow?.['m'] as number | null) ?? 0 });
}

// GET /v1/topics/:tid/export — full topic JSON for offline copy / migration.
async function handleExport(db: DbClient, auth: AuthContext, tid: string): Promise<Response> {
  const { topic, history_from_seq } = await requireParticipant(db, auth, tid);
  const parts = await db.queryAll(
    `SELECT p.member_id, p.joined_at, p.history_from_seq, m.name, m.role
       FROM topic_participants p JOIN members m ON m.id = p.member_id
      WHERE p.topic_id = ?`,
    [tid],
  );
  const entries = await db.queryAll(
    `SELECT * FROM entries WHERE topic_id = ? AND seq >= ? ORDER BY seq ASC`,
    [tid, history_from_seq],
  );
  // F06: tasks are filtered by the caller's history floor — same rule as entry
  // reads. A from_join member must not see tasks created before they joined.
  const tasks = await db.queryAll(
    `SELECT * FROM tasks WHERE topic_id = ? AND ${TASK_VISIBLE_TO_MEMBER} ORDER BY created_at ASC`,
    [tid, auth.member_id],
  );
  return json({
    topic,
    participants: parts,
    entries: entries.map(publicEntry),
    tasks: tasks.map(publicTask),
    exported_at: nowIso(),
  });
}

// POST /v1/topics/:tid/invite — participant + owner/parent.
async function handleTopicInvite(
  db: DbClient,
  _env: Env,
  req: Request,
  auth: AuthContext,
  tid: string,
): Promise<Response> {
  await requireParticipant(db, auth, tid);
  if (auth.role !== 'owner' && auth.role !== 'parent') {
    throw new HttpError(403, 'forbidden', 'Only owner/parent can invite members to a topic');
  }
  const body = await readJson(req);
  const memberIds = reqIdArray(body['member_ids'], 'member_ids', 20);
  const historyFrom = reqEnum(body['history_from'], 'history_from', ['full', 'from_join'] as const);
  const members = await requireFamilyMembers(db, auth, memberIds);
  const { topic } = await getTopicInFamily(db, auth, tid).then((t) => ({ topic: t }));
  if ((topic['parents_only'] as number) === 1) {
    for (const m of members) {
      if (m['role'] === 'kid') {
        throw new HttpError(403, 'forbidden', 'Kids cannot be invited to a parents-only topic');
      }
    }
  }
  // F06: the visibility cutoff is computed INSIDE the membership insert, as part
  // of the same atomic batch (D1 batch / SQLite BEGIN..COMMIT). Reading
  // MAX(seq) beforehand raced with concurrent appends and could set a stale
  // floor that leaked entries posted between the read and the insert.
  const fullFloor = historyFrom === 'full' ? 1 : 0;
  const ts = nowIso();
  const existing = await db.queryAll(`SELECT member_id FROM topic_participants WHERE topic_id = ?`, [
    tid,
  ]);
  const existingIds = new Set(existing.map((r) => r['member_id'] as string));
  const added = memberIds.filter((id) => !existingIds.has(id));
  const ops = added.map((mid) => ({
    sql: `INSERT INTO topic_participants(topic_id, member_id, joined_at, history_from_seq)
          SELECT ?, ?, ?, CASE WHEN ? = 1 THEN 1
                               ELSE COALESCE((SELECT MAX(seq) FROM entries WHERE topic_id = ?), 0) + 1 END`,
    params: [tid, mid, ts, fullFloor, tid] as (string | number | null)[],
  }));
  await db.execAtomically(ops);
  for (const mid of added) {
    const m = members.find((x) => x['id'] === mid)!;
    await appendEntry(db, {
      topic_id: tid,
      kind: 'member_joined',
      body: `${m['name']} joined the topic`,
      auth,
      data: JSON.stringify({ member_id: mid, history_from: historyFrom }),
    });
  }
  return json({ added });
}

// DELETE /v1/topics/:tid/participants/:mid — owner/parent only (same 403
// rule as POST /v1/topics/:tid/invite; the caller must also be a
// participant). Removes the participant row and appends a plaintext
// `member_left` system entry naming the member.
//
// E2EE note: the removed member's sealed envelopes are deliberately KEPT —
// they already held the old topic key, and forward secrecy comes from the
// re-key the remover must run next (`hub topic-rekey`). Envelopes can no
// longer be POSTed for them: handlePostEnvelope requires a current
// participant row, so a post-removal envelope lands 400.
async function handleRemoveParticipant(
  db: DbClient,
  _env: Env,
  _req: Request,
  auth: AuthContext,
  tid: string,
  mid: string,
): Promise<Response> {
  await requireParticipant(db, auth, tid);
  if (auth.role !== 'owner' && auth.role !== 'parent') {
    throw new HttpError(403, 'forbidden', 'Only owner/parent can remove members from a topic');
  }
  const target = await db.queryOne(
    `SELECT p.member_id, m.name FROM topic_participants p
       JOIN members m ON m.id = p.member_id
      WHERE p.topic_id = ? AND p.member_id = ?`,
    [tid, mid],
  );
  if (!target) {
    throw new HttpError(400, 'bad_request', 'Member is not a participant of this topic');
  }
  const count = await db.queryOne(
    `SELECT COUNT(*) AS c FROM topic_participants WHERE topic_id = ?`,
    [tid],
  );
  if (((count?.['c'] as number) ?? 0) <= 1) {
    throw new HttpError(400, 'bad_request', 'Cannot remove the last participant of a topic');
  }
  await db.execAtomically([
    {
      sql: `DELETE FROM topic_participants WHERE topic_id = ? AND member_id = ?`,
      params: [tid, mid],
    },
  ]);
  const selfLeave = auth.member_id === mid;
  await appendEntry(db, {
    topic_id: tid,
    kind: 'member_left',
    body: selfLeave
      ? `${target['name']} left the topic`
      : `${target['name']} was removed from the topic`,
    auth,
    data: JSON.stringify({ member_id: mid }),
  });
  return json({ removed: mid });
}

// POST /v1/topics/:tid/spawn — linked child topic with curated briefing.
async function handleSpawn(
  db: DbClient,
  _env: Env,
  req: Request,
  auth: AuthContext,
  tid: string,
): Promise<Response> {
  const { topic: parent } = await requireParticipant(db, auth, tid);
  const body = await readJson(req);
  const subject = reqString(body['subject'], 'subject', 1, 200);
  const briefing = reqString(body['briefing'], 'briefing', 1, MAX_BODY);
  const linkVisibility = body['link_visibility'] === undefined
    ? 'placeholder'
    : reqEnum(body['link_visibility'], 'link_visibility', ['placeholder', 'hidden'] as const);
  let ids = reqIdArray(body['participant_member_ids'], 'participant_member_ids', 20);
  piiGuard(briefing);
  await requireFamilyMembers(db, auth, ids);
  if (!ids.includes(auth.member_id)) ids = [...ids, auth.member_id];

  const childId = newId();
  const ts = nowIso();
  await db.execAtomically([
    {
      sql: `INSERT INTO topics(id, family_id, subject, kind, parents_only, parent_topic_id, link_visibility, created_by, created_at)
            VALUES (?,?,?,?,?,?,?,?,?)`,
      params: [childId, auth.family_id, subject, 'group', 0, tid, linkVisibility, auth.member_id, ts],
    },
    ...ids.map((mid) => ({
      sql: `INSERT INTO topic_participants(topic_id, member_id, joined_at, history_from_seq) VALUES (?,?,?,1)`,
      params: [childId, mid, ts] as (string | number | null)[],
    })),
  ]);
  // The briefing is the ONLY content carried over — curated by the spawner.
  await appendEntry(db, {
    topic_id: childId,
    kind: 'briefing',
    body: briefing,
    auth,
    data: JSON.stringify({ spawned_from: tid }),
  });
  await appendEntry(db, {
    topic_id: tid,
    kind: 'topic_spawned',
    body: `Linked topic spawned: ${subject}`,
    auth,
    data: JSON.stringify({ child_topic_id: childId, child_subject: subject }),
  });
  const child = await db.queryOne(`SELECT * FROM topics WHERE id = ?`, [childId]);
  return json({ topic: child, parent_topic_id: parent['id'] }, 201);
}

// POST /v1/topics/:tid/entries — participant; Idempotency-Key supported.
async function handlePostEntry(
  db: DbClient,
  _env: Env,
  req: Request,
  auth: AuthContext,
  tid: string,
): Promise<Response> {
  await requireParticipant(db, auth, tid);
  const body = await readJson(req);
  // E2EE Phase 4 system kinds: plaintext by design, posted only by current
  // participants (requireParticipant above). key_rotated announces a topic
  // key rotation, key_request asks members for the current topic key, and
  // pending_key_distribution marks "member added, envelopes not yet sealed".
  // E2EE Phase 5 adds topic_archived: retiring a dead topic while naming its
  // successor. All four must be readable by agents that do NOT hold the topic
  // key (yet), so they are never encrypted client-side — the CLI posts them
  // via its plaintext system-entry path with a loud stderr note.
  const kind = body['kind'] === undefined
    ? 'message'
    : reqEnum(body['kind'], 'kind', [
        'message',
        'key_rotated',
        'key_request',
        'pending_key_distribution',
        'topic_archived',
      ] as const);
  const text = reqString(body['body'], 'body', 1, MAX_BODY);
  const data = reqJsonData(body['data'], 'data', MAX_DATA);
  const replyTo = body['reply_to_seq'] === undefined || body['reply_to_seq'] === null
    ? null
    : (() => {
        const n = body['reply_to_seq'];
        if (!Number.isInteger(n) || (n as number) < 1) {
          throw new HttpError(400, 'bad_request', 'reply_to_seq must be a positive integer');
        }
        return n as number;
      })();
  // E2EE ciphertext bodies are opaque to the server: scanning them for PII
  // is pointless and risks false-positive 422s on base64 digit runs, so
  // well-formed fh1 wire bodies skip the PII scan. The CLI is the
  // enforcement point for E2EE topics — it scans the plaintext BEFORE
  // encrypting. Malformed fh1-looking bodies are still scanned.
  if (!isE2eeWireBody(text)) piiGuard(text);
  // F08: entry data (JSON) is scanned too — string leaves, recursively.
  if (data) piiGuardJson(JSON.parse(data));

  const idemKey = req.headers.get('idempotency-key');
  if (idemKey !== null) {
    if (idemKey.length === 0 || idemKey.length > 128) {
      throw new HttpError(400, 'bad_request', 'Idempotency-Key must be 1-128 chars');
    }
    const existing = await db.queryOne(
      `SELECT entry_gseq FROM idempotency_keys WHERE token_id = ? AND key = ? AND expires_at > ?`,
      [auth.token_id, idemKey, nowIso()],
    );
    if (existing) {
      const row = await db.queryOne(`SELECT * FROM entries WHERE gseq = ?`, [
        existing['entry_gseq'] as number,
      ]);
      if (row) return json({ entry: publicEntry(row), deduped: true });
    }
  }

  // F12: the entry and its idempotency record commit in the SAME atomic
  // batch — a crash between the two can no longer leave an entry with no
  // retry key (or a key pointing at nothing).
  const ts = nowIso();
  const ops: BatchOp[] = [
    entryInsertOp({ topicId: tid, kind, body: text, auth, data, ts, replyToSeq: replyTo }),
  ];
  if (idemKey !== null) {
    ops.push({
      // gseq is located via the just-inserted row: inside the batch our own
      // write is visible and holds the topic's max seq, so ORDER BY seq DESC
      // LIMIT 1 pinpoints this request's entry (ts pins it further).
      sql: `INSERT OR REPLACE INTO idempotency_keys(token_id, key, entry_gseq, created_at, expires_at)
            SELECT ?, ?, e.gseq, ?, ?
              FROM entries e
             WHERE e.topic_id = ? AND e.ts = ?
             ORDER BY e.seq DESC LIMIT 1`,
      params: [auth.token_id, idemKey, ts, hoursFromNow(IDEM_TTL_HOURS), tid, ts],
    });
  }
  await execBatchWithRetry(db, () => ops);
  // ts is generated per request, so (topic_id, ts) identifies the new row.
  const entry = await db.queryOne(
    `SELECT * FROM entries WHERE topic_id = ? AND ts = ? ORDER BY seq DESC LIMIT 1`,
    [tid, ts],
  );
  if (!entry) throw new HttpError(500, 'internal', 'Failed to read back inserted entry');
  return json({ entry: publicEntry(entry) }, 201);
}

// GET /v1/sync?after_gseq=&limit= — one call per poll, all visible topics.
//
// Pagination is page-based, never head-based: fetch limit+1 rows; when the
// extra row is present there is more backlog to drain (has_more=true) and
// only the first `limit` rows are returned. next_after_gseq is always the
// last RETURNED entry's gseq — or the input cursor when the page is empty —
// so a client paging through an arbitrarily deep backlog can never skip
// entries (the old MAX-based cursor jumped past undelivered rows). No second
// query: one SELECT per sync poll.
async function handleSync(db: DbClient, req: Request, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url);
  const after = parseSeqCursor(url.searchParams.get('after_gseq'));
  const limit = parseLimit(url.searchParams.get('limit'), 100, 500);
  const rows = await db.queryAll(
    `SELECT e.* FROM entries e
       JOIN topic_participants p ON p.topic_id = e.topic_id AND p.member_id = ?
      WHERE e.gseq > ? AND e.seq >= p.history_from_seq
      ORDER BY e.gseq ASC LIMIT ?`,
    [auth.member_id, after, limit + 1],
  );
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const entries = page.map(publicEntry);
  const nextAfter = page.length > 0 ? (page[page.length - 1]['gseq'] as number) : after;
  // max_gseq stays for contract compatibility: the highest gseq in THIS
  // page (clients MUST prefer next_after_gseq as their poll cursor).
  const maxGseq = nextAfter;
  return json({ entries, max_gseq: maxGseq, next_after_gseq: nextAfter, has_more: hasMore });
}

// POST /v1/topics/:tid/tasks
async function handleCreateTask(
  db: DbClient,
  _env: Env,
  req: Request,
  auth: AuthContext,
  tid: string,
): Promise<Response> {
  await requireParticipant(db, auth, tid);
  const body = await readJson(req);
  const title = reqString(body['title'], 'title', 1, 200);
  const description = optString(body['description'], 'description', MAX_BODY);
  const dueAt = body['due_at'] === undefined || body['due_at'] === null
    ? null
    : reqIsoDate(body['due_at'], 'due_at');
  let assignee: string | null = null;
  if (body['assignee_member_id'] !== undefined && body['assignee_member_id'] !== null) {
    assignee = reqString(body['assignee_member_id'], 'assignee_member_id', 1, 128);
    const part = await db.queryOne(
      `SELECT member_id FROM topic_participants WHERE topic_id = ? AND member_id = ?`,
      [tid, assignee],
    );
    if (!part) throw new HttpError(400, 'bad_request', 'assignee must be a participant of this topic');
  }
  let parentTask: string | null = null;
  if (body['parent_task_id'] !== undefined && body['parent_task_id'] !== null) {
    parentTask = reqString(body['parent_task_id'], 'parent_task_id', 1, 128);
    const pt = await db.queryOne(`SELECT * FROM tasks WHERE id = ?`, [parentTask]);
    if (!pt || pt['topic_id'] !== tid) {
      throw new HttpError(400, 'bad_request', 'parent_task_id must be a task in this topic');
    }
  }
  if (description) piiGuard(description);
  piiGuard(title); // F08: task titles are scanned too.

  const taskId = newId();
  const ts = nowIso();
  // F13: task_created carries the full task fields, so the log can
  // reconstruct task state. The F06 visibility predicate reads task_id out
  // of this same payload — it must stay.
  const createdData = JSON.stringify({
    task_id: taskId,
    title,
    description,
    due_at: dueAt,
    status: 'open',
    owner_member_id: auth.member_id,
    assignee_member_id: assignee,
    parent_task_id: parentTask,
    created_by: auth.member_id,
    created_at: ts,
  });
  // F12: task row + task_created event commit in the SAME batch — the audit's
  // fault injection (event write fails) must leave no orphan task.
  // F14: the child insert is conditional on the parent still being open, so
  // a parent completed between validation and this batch cannot gain an
  // open child. The event is pinned to the insert actually applying.
  const ops: BatchOp[] = [
    {
      sql: `INSERT INTO tasks(id, topic_id, title, description, status, owner_member_id, assignee_member_id,
                              parent_task_id, due_at, result, created_by, created_at, updated_at)
            SELECT ?,?,?,?, 'open',?,?,?,?,?,?,?,?
             WHERE ? IS NULL
                OR NOT EXISTS (SELECT 1 FROM tasks WHERE id = ? AND status IN ('done','cancelled'))`,
      params: [
        taskId, tid, title, description, auth.member_id, assignee, parentTask, dueAt,
        null, auth.member_id, ts, ts, parentTask, parentTask,
      ],
    },
    entryInsertOp({
      topicId: tid,
      kind: 'task_created',
      body: `Task created: ${title}`,
      auth,
      data: createdData,
      ts,
      pin: `EXISTS (SELECT 1 FROM tasks WHERE id = ? AND created_at = ?)`,
      pinParams: [taskId, ts],
    }),
  ];
  await execBatchWithRetry(db, () => ops);
  const task = await db.queryOne(`SELECT * FROM tasks WHERE id = ?`, [taskId]);
  if (!task) {
    // The conditional insert refused: re-read the parent for an accurate error.
    const p = parentTask
      ? await db.queryOne(`SELECT status FROM tasks WHERE id = ?`, [parentTask])
      : null;
    const pstatus = p?.['status'] as string | undefined;
    if (pstatus === 'done' || pstatus === 'cancelled') {
      throw new HttpError(
        409,
        'parent_completed',
        'Cannot create a subtask under a completed or cancelled parent task',
      );
    }
    throw new HttpError(500, 'internal', 'Task creation did not persist');
  }
  return json({ task: publicTask(task) }, 201);
}

async function getTaskInScope(db: DbClient, auth: AuthContext, taskId: string): Promise<Row> {
  // F06: enforce the from-join visibility floor on every task path (read AND
  // write) — a member who joined after the task was created gets 404, so a
  // PATCH with an empty body can't be used as a read oracle for pre-join
  // task snapshots.
  const task = await db.queryOne(
    `SELECT * FROM tasks WHERE id = ? AND ${TASK_VISIBLE_TO_MEMBER}`,
    [taskId, auth.member_id],
  );
  if (!task) throw new HttpError(404, 'not_found', 'Task not found');
  await requireParticipant(db, auth, task['topic_id'] as string);
  return task;
}

// GET /v1/tasks/:tid?after_seq=&limit= — task + its entry trail.
// F13: the trail is one indexed SQL query (idx_entries_task_trail),
// paginated like /history — the old code fetched 5,000 topic entries and
// filtered by task_id in JS.
async function handleGetTask(
  db: DbClient,
  req: Request,
  auth: AuthContext,
  taskId: string,
): Promise<Response> {
  const task = await getTaskInScope(db, auth, taskId);
  const topicId = task['topic_id'] as string;
  // F06: a from_join member must not read task snapshots created before they
  // joined. 404 (same as a missing task) so existence doesn't leak.
  const visible = await db.queryOne(
    `SELECT 1 AS ok FROM tasks WHERE id = ? AND topic_id = ? AND ${TASK_VISIBLE_TO_MEMBER}`,
    [taskId, topicId, auth.member_id],
  );
  if (!visible) throw new HttpError(404, 'not_found', 'Task not found');
  const part = await db.queryOne(
    `SELECT history_from_seq FROM topic_participants WHERE topic_id = ? AND member_id = ?`,
    [topicId, auth.member_id],
  );
  const url = new URL(req.url);
  const after = parseSeqCursor(url.searchParams.get('after_seq'));
  const limit = parseLimit(url.searchParams.get('limit'), 100, 500);
  const rows = await db.queryAll(
    `SELECT * FROM entries
      WHERE topic_id = ? AND seq > ? AND seq >= ?
        AND json_extract(data, '$.task_id') = ?
      ORDER BY seq ASC LIMIT ?`,
    [topicId, after, part!['history_from_seq'] as number, taskId, limit + 1],
  );
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextAfter = page.length > 0 ? (page[page.length - 1]['seq'] as number) : after;
  return json({
    task: publicTask(task),
    trail: page.map(publicEntry),
    has_more: hasMore,
    next_after_seq: nextAfter,
  });
}

// GET /v1/topics/:tid/tasks — list tasks in a topic.
async function handleListTopicTasks(db: DbClient, auth: AuthContext, tid: string): Promise<Response> {
  await requireParticipant(db, auth, tid);
  // F06: same history floor as entry reads — from_join members don't see
  // tasks whose task_created entry predates their join.
  const rows = await db.queryAll(
    `SELECT * FROM tasks WHERE topic_id = ? AND ${TASK_VISIBLE_TO_MEMBER} ORDER BY created_at ASC`,
    [tid, auth.member_id],
  );
  return json({ tasks: rows.map(publicTask) });
}

// PATCH /v1/tasks/:tid
async function handlePatchTask(
  db: DbClient,
  _env: Env,
  req: Request,
  auth: AuthContext,
  taskId: string,
): Promise<Response> {
  const task = await getTaskInScope(db, auth, taskId);
  const topicId = task['topic_id'] as string;
  const body = await readJson(req);
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  let statusChanged: string | null = null;
  let assigneeChanged: string | null | undefined;
  // F13: fields that previously changed silently; emitted as task_updated.
  const updatedFields: Record<string, string | null> = {};

  if (body['title'] !== undefined) {
    const title = reqString(body['title'], 'title', 1, 200);
    piiGuard(title); // F08: task titles are scanned too.
    sets.push('title = ?');
    params.push(title);
    updatedFields['title'] = title;
  }
  if (body['description'] !== undefined) {
    const description = optString(body['description'], 'description', MAX_BODY);
    if (description) piiGuard(description);
    sets.push('description = ?');
    params.push(description);
    updatedFields['description'] = description;
  }
  if (body['due_at'] !== undefined) {
    const dueAt = body['due_at'] === null ? null : reqIsoDate(body['due_at'], 'due_at');
    sets.push('due_at = ?');
    params.push(dueAt);
    updatedFields['due_at'] = dueAt;
  }
  if (body['assignee_member_id'] !== undefined) {
    const raw = body['assignee_member_id'];
    const assignee = raw === null ? null : reqString(raw, 'assignee_member_id', 1, 128);
    if (assignee !== null) {
      const part = await db.queryOne(
        `SELECT member_id FROM topic_participants WHERE topic_id = ? AND member_id = ?`,
        [topicId, assignee],
      );
      if (!part) throw new HttpError(400, 'bad_request', 'assignee must be a participant of this topic');
    }
    if (assignee !== task['assignee_member_id']) {
      assigneeChanged = assignee;
      sets.push('assignee_member_id = ?');
      params.push(assignee);
    }
  }
  if (body['status'] !== undefined) {
    const status = reqEnum(body['status'], 'status', TASK_STATUSES);
    if (status !== task['status']) {
      if (status === 'done') await assertNoOpenSubtasks(db, taskId);
      statusChanged = status;
      sets.push('status = ?');
      params.push(status);
    }
  }
  if (sets.length === 0) {
    const fresh = await db.queryOne(`SELECT * FROM tasks WHERE id = ?`, [taskId]);
    return json({ task: publicTask(fresh!) });
  }
  const ts = nowIso();
  sets.push('updated_at = ?');
  params.push(ts);
  // F14: completing via PATCH is guarded INSIDE the update — the write only
  // applies while no open subtask exists, in the same batch as the events.
  // The pre-check above preserves the old fast-path 409; this guard closes
  // the race between that check and the write.
  let where = `WHERE id = ?`;
  const whereParams: (string | number | null)[] = [taskId];
  const completing = statusChanged === 'done';
  if (completing) {
    where += ` AND NOT EXISTS (SELECT 1 FROM tasks WHERE parent_task_id = ? AND status NOT IN ('done','cancelled'))`;
    whereParams.push(taskId);
  }
  // F12: the state change and its events commit in the SAME batch. Each event
  // is pinned to the update actually applying (updated_at flip), so a
  // guard-blocked completion emits no phantom events.
  const pin = `EXISTS (SELECT 1 FROM tasks WHERE id = ? AND updated_at = ?)`;
  const pinParams: (string | number | null)[] = [taskId, ts];
  const ops: BatchOp[] = [
    { sql: `UPDATE tasks SET ${sets.join(', ')} ${where}`, params: [...params, ...whereParams] },
  ];
  if (Object.keys(updatedFields).length > 0) {
    ops.push(
      entryInsertOp({
        topicId,
        kind: 'task_updated',
        body: `Task updated`,
        auth,
        data: JSON.stringify({ task_id: taskId, ...updatedFields }),
        ts,
        pin,
        pinParams,
      }),
    );
  }
  if (assigneeChanged !== undefined) {
    ops.push(
      entryInsertOp({
        topicId,
        kind: 'task_assigned',
        body: assigneeChanged ? `Task assigned` : `Task unassigned`,
        auth,
        data: JSON.stringify({ task_id: taskId, assignee_member_id: assigneeChanged }),
        ts,
        pin,
        pinParams,
      }),
    );
  }
  if (statusChanged) {
    ops.push(
      entryInsertOp({
        topicId,
        kind: 'task_status',
        body: `Task status → ${statusChanged}`,
        auth,
        data: JSON.stringify({ task_id: taskId, status: statusChanged }),
        ts,
        pin,
        pinParams,
      }),
    );
  }
  await execBatchWithRetry(db, () => ops);
  const updated = await db.queryOne(`SELECT * FROM tasks WHERE id = ?`, [taskId]);
  if (completing && updated!['status'] !== 'done') {
    // The atomic guard refused the completion after the pre-check passed
    // (a subtask was created in between): confirm for an accurate 409.
    const open = await db.queryAll(
      `SELECT id FROM tasks WHERE parent_task_id = ? AND status NOT IN ('done','cancelled')`,
      [taskId],
    );
    if (open.length > 0) {
      throw new HttpError(
        409,
        'subtasks_open',
        `Cannot complete task: ${open.length} subtask(s) still open`,
      );
    }
    throw new HttpError(500, 'internal', 'Task completion did not apply');
  }
  return json({ task: publicTask(updated!) });
}

// POST /v1/tasks/:tid/notes
async function handleTaskNote(
  db: DbClient,
  _env: Env,
  req: Request,
  auth: AuthContext,
  taskId: string,
): Promise<Response> {
  const task = await getTaskInScope(db, auth, taskId);
  const body = await readJson(req);
  const text = reqString(body['body'], 'body', 1, MAX_BODY);
  piiGuard(text);
  const entry = await appendEntry(db, {
    topic_id: task['topic_id'] as string,
    kind: 'task_note',
    body: text,
    auth,
    data: JSON.stringify({ task_id: taskId }),
  });
  return json({ entry: publicEntry(entry) }, 201);
}

// POST /v1/tasks/:tid/done {result?} — enforces the subtask rule.
async function handleTaskDone(
  db: DbClient,
  _env: Env,
  req: Request,
  auth: AuthContext,
  taskId: string,
): Promise<Response> {
  const task = await getTaskInScope(db, auth, taskId);
  const topicId = task['topic_id'] as string;
  // F14: an absent body is fine; malformed JSON is 400 (no longer swallowed).
  const body = await readOptionalJson(req);
  const result = reqJsonData(body['result'], 'result', MAX_DATA);
  // F08: completion results (JSON) are scanned too — string leaves, recursively.
  if (result) piiGuardJson(JSON.parse(result));
  await assertNoOpenSubtasks(db, taskId);
  const ts = nowIso();
  // F12+F14: the completion and its task_done event commit in the SAME
  // batch, and the open-subtask check is part of the UPDATE itself — a
  // subtask created between the pre-check above and this write can no longer
  // slip through. The event is pinned to the update actually applying, so a
  // guard-blocked completion emits no phantom task_done.
  await execBatchWithRetry(db, () => [
    {
      sql: `UPDATE tasks SET status = 'done', result = ?, updated_at = ? WHERE id = ?
             AND NOT EXISTS (SELECT 1 FROM tasks WHERE parent_task_id = ? AND status NOT IN ('done','cancelled'))`,
      params: [result, ts, taskId, taskId],
    },
    entryInsertOp({
      topicId,
      kind: 'task_done',
      body: `Task completed`,
      auth,
      data: JSON.stringify({ task_id: taskId, result: result ? JSON.parse(result) : null }),
      ts,
      pin: `EXISTS (SELECT 1 FROM tasks WHERE id = ? AND updated_at = ?)`,
      pinParams: [taskId, ts],
    }),
  ]);
  const updated = await db.queryOne(`SELECT * FROM tasks WHERE id = ?`, [taskId]);
  if (updated!['status'] !== 'done') {
    // The atomic guard refused: a subtask opened after the pre-check.
    const open = await db.queryAll(
      `SELECT id FROM tasks WHERE parent_task_id = ? AND status NOT IN ('done','cancelled')`,
      [taskId],
    );
    if (open.length > 0) {
      throw new HttpError(
        409,
        'subtasks_open',
        `Cannot complete task: ${open.length} subtask(s) still open`,
      );
    }
    throw new HttpError(500, 'internal', 'Task completion did not apply');
  }
  return json({ task: publicTask(updated!) });
}

// POST /v1/entries/:eid/redact — owner only. Preserves seq/actor/ts; scrubs body.
async function handleRedact(
  db: DbClient,
  _env: Env,
  _req: Request,
  auth: AuthContext,
  eid: string,
): Promise<Response> {
  if (auth.role !== 'owner') {
    throw new HttpError(403, 'forbidden', 'Only the family owner can redact entries');
  }
  const gseq = Number(eid);
  if (!Number.isInteger(gseq) || gseq < 1) {
    throw new HttpError(400, 'bad_request', 'Invalid entry id');
  }
  const entry = await db.queryOne(
    `SELECT e.* FROM entries e JOIN topics t ON t.id = e.topic_id
      WHERE e.gseq = ? AND t.family_id = ?`,
    [gseq, auth.family_id],
  );
  if (!entry) throw new HttpError(404, 'not_found', 'Entry not found');
  const ts = nowIso();
  const scrubbed = `[redacted by owner, ${ts}]`;
  // F08: also scrub PII-shaped string leaves in data, structure-preserving
  // (linkage fields like task_id survive). NULL data stays NULL.
  let newData = entry['data'] as string | null;
  if (newData !== null) {
    try {
      newData = JSON.stringify(redactPiiLeaves(JSON.parse(newData)));
    } catch {
      // data is always JSON (validated at write); keep the original rather
      // than lose it if parsing ever fails.
    }
  }
  await db.execAtomically([
    { sql: `UPDATE entries SET body = ?, data = ? WHERE gseq = ?`, params: [scrubbed, newData, gseq] },
  ]);
  await appendEntry(db, {
    topic_id: entry['topic_id'] as string,
    kind: 'redaction',
    body: `Entry #${entry['seq']} redacted by owner`,
    auth,
    data: JSON.stringify({ redacted_gseq: gseq }),
  });
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Router.
// ---------------------------------------------------------------------------

// Request entry point (what tests drive and what the worker's fetch calls).
// Logs exactly one structured line per request — method, redacted path,
// status, duration — with the server version on every line. Error detail
// (code) is logged by routeRequest's catch below, so failures produce a
// detail line plus this access line.
export async function handleRequest(req: Request, db: DbClient, env: Env): Promise<Response> {
  const start = Date.now();
  let method = '?';
  let path = '?';
  try {
    const url = new URL(req.url);
    path = redactPath(url.pathname);
    method = req.method.toUpperCase();
    const res = await routeRequest(req, db, env);
    logEvent(res.status >= 500 ? 'error' : res.status >= 400 ? 'warn' : 'info', 'request', {
      method,
      path,
      status: res.status,
      ms: Date.now() - start,
    });
    return withSecurityHeaders(res);
  } catch (e) {
    // routeRequest converts all expected errors to responses; this is the
    // last resort so a request never goes unlogged.
    logEvent('error', 'request_error', {
      method,
      path,
      status: 500,
      code: 'internal',
      ms: Date.now() - start,
    });
    return withSecurityHeaders(
      json({ error: { code: 'internal', message: 'Internal server error' } }, 500),
    );
  }
}

async function routeRequest(req: Request, db: DbClient, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method.toUpperCase();

  try {
    // Public: web UI + health.
    if (path === '/' && method === 'GET') {
      return new Response(UI_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    if (path === '/v1/health' && method === 'GET') return await handleHealth();

    // Public: bootstrap + invite/provisioning redemption (code is the credential).
    // The two redemption endpoints are rate-limited per IP: they are the only
    // unauthenticated brute-force surface (128-bit codes, but hammering still
    // burns worker invocations).
    if (path === '/v1/families' && method === 'POST') return await handleCreateFamily(db, env, req);
    if (path.startsWith('/v1/invites/') && path.endsWith('/accept') && method === 'POST') {
      const limited = await checkRateLimit(db, req, 'invite_accept');
      if (limited) return limited;
      const code = decodeURIComponent(path.slice('/v1/invites/'.length, -'/accept'.length));
      return await handleAcceptInvite(db, env, req, code);
    }
    if (path.startsWith('/v1/provisioning-codes/') && path.endsWith('/redeem') && method === 'POST') {
      const limited = await checkRateLimit(db, req, 'code_redeem');
      if (limited) return limited;
      const code = decodeURIComponent(
        path.slice('/v1/provisioning-codes/'.length, -'/redeem'.length),
      );
      return await handleRedeemProvisioning(db, env, req, code);
    }

    // Everything below requires a bearer token (the choke point).
    const authHeader = req.headers.get('authorization');
    const auth: AuthContext = await resolveToken(db, env, authHeader);

    if (path === '/v1/auth/rotate' && method === 'POST') return await handleRotate(db, env, req, auth);
    if (path === '/v1/auth/revoke' && method === 'POST') return await handleRevoke(db, env, req, auth);
    if (path === '/v1/families' && method === 'GET') return await handleListFamilies(db, auth);
    if (path === '/v1/members' && method === 'GET') return await handleListMembers(db, auth);
    if (path === '/v1/me' && method === 'GET') return await handleGetSelf(db, auth);
    if (path === '/v1/provisioning-codes' && method === 'POST') {
      return await handleMintProvisioning(db, env, req, auth);
    }
    // E2EE (Phase 1) key infrastructure.
    if (path === '/v1/agent-keys' && method === 'GET') {
      return await handleAgentKeyDirectory(db, req, auth);
    }
    if (path === '/v1/agent-keys/rotate' && method === 'POST') {
      return await handleAgentKeyRotate(db, req, auth);
    }
    if (path === '/v1/topics' && method === 'POST') return await handleCreateTopic(db, env, req, auth);
    if (path === '/v1/topics' && method === 'GET') return await handleListTopics(db, req, auth);
    if (path === '/v1/sync' && method === 'GET') return await handleSync(db, req, auth);

    const famInvite = /^\/v1\/families\/([^/]+)\/invites$/.exec(path);
    if (famInvite && method === 'POST') {
      return await handleCreateInvite(db, env, req, auth, decodeURIComponent(famInvite[1]));
    }

    // Ownership transfer (offer -> accept): POST /v1/families/:id/transfer,
    // POST /v1/families/:id/transfer/accept, POST .../cancel, GET .../transfer.
    const famTransfer = /^\/v1\/families\/([^/]+)\/transfer(\/accept|\/cancel)?$/.exec(path);
    if (famTransfer) {
      const fid = decodeURIComponent(famTransfer[1]);
      const action = famTransfer[2];
      if (!action && method === 'POST') {
        return await handleOfferOwnership(db, env, req, auth, fid);
      }
      if (!action && method === 'GET') {
        return await handleGetOwnershipTransfer(db, auth, fid);
      }
      if (action === '/accept' && method === 'POST') {
        return await handleAcceptOwnershipTransfer(db, auth, fid);
      }
      if (action === '/cancel' && method === 'POST') {
        return await handleCancelOwnershipTransfer(db, auth, fid);
      }
    }

    const topicSub = /^\/v1\/topics\/([^/]+)\/(history|export|invite|spawn|entries|tasks|envelopes|subject)$/.exec(path);
    if (topicSub && method === 'GET' && topicSub[2] === 'history') {
      return await handleHistory(db, req, auth, decodeURIComponent(topicSub[1]));
    }
    if (topicSub && method === 'GET' && topicSub[2] === 'export') {
      return await handleExport(db, auth, decodeURIComponent(topicSub[1]));
    }
    if (topicSub && method === 'POST' && topicSub[2] === 'invite') {
      return await handleTopicInvite(db, env, req, auth, decodeURIComponent(topicSub[1]));
    }
    if (topicSub && method === 'POST' && topicSub[2] === 'spawn') {
      return await handleSpawn(db, env, req, auth, decodeURIComponent(topicSub[1]));
    }
    if (topicSub && method === 'POST' && topicSub[2] === 'entries') {
      return await handlePostEntry(db, env, req, auth, decodeURIComponent(topicSub[1]));
    }
    if (topicSub && method === 'GET' && topicSub[2] === 'tasks') {
      return await handleListTopicTasks(db, auth, decodeURIComponent(topicSub[1]));
    }
    if (topicSub && method === 'POST' && topicSub[2] === 'tasks') {
      return await handleCreateTask(db, env, req, auth, decodeURIComponent(topicSub[1]));
    }
    // E2EE (Phase 2) key-envelope distribution endpoints.
    if (topicSub && method === 'POST' && topicSub[2] === 'envelopes') {
      return await handlePostEnvelope(db, req, auth, decodeURIComponent(topicSub[1]));
    }
    if (topicSub && method === 'GET' && topicSub[2] === 'envelopes') {
      return await handleGetEnvelopes(db, auth, decodeURIComponent(topicSub[1]));
    }
    // E2EE (secfix F4) — participant-only subject re-encryption (two-step
    // topic-bound subject AAD for `hub new-topic --e2ee`).
    if (topicSub && method === 'PATCH' && topicSub[2] === 'subject') {
      return await handlePatchTopicSubject(db, req, auth, decodeURIComponent(topicSub[1]));
    }

    const topicOnly = /^\/v1\/topics\/([^/]+)$/.exec(path);
    if (topicOnly && method === 'GET') {
      return await handleGetTopic(db, auth, decodeURIComponent(topicOnly[1]));
    }

    // E2EE Phase 4 — DELETE /v1/topics/:tid/participants/:mid (owner/parent).
    const topicParticipant = /^\/v1\/topics\/([^/]+)\/participants\/([^/]+)$/.exec(path);
    if (topicParticipant && method === 'DELETE') {
      return await handleRemoveParticipant(
        db,
        env,
        req,
        auth,
        decodeURIComponent(topicParticipant[1]),
        decodeURIComponent(topicParticipant[2]),
      );
    }

    const taskSub = /^\/v1\/tasks\/([^/]+)(\/(notes|done))?$/.exec(path);
    if (taskSub) {
      const taskId = decodeURIComponent(taskSub[1]);
      if (!taskSub[2] && (method === 'GET' || method === 'PATCH')) {
        return method === 'GET'
          ? await handleGetTask(db, req, auth, taskId)
          : await handlePatchTask(db, env, req, auth, taskId);
      }
      if (taskSub[3] === 'notes' && method === 'POST') {
        return await handleTaskNote(db, env, req, auth, taskId);
      }
      if (taskSub[3] === 'done' && method === 'POST') {
        return await handleTaskDone(db, env, req, auth, taskId);
      }
    }

    const redact = /^\/v1\/entries\/([^/]+)\/redact$/.exec(path);
    if (redact && method === 'POST') {
      return await handleRedact(db, env, req, auth, decodeURIComponent(redact[1]));
    }

    throw new HttpError(404, 'not_found', 'Unknown endpoint');
  } catch (e) {
    const logPath = redactPath(new URL(req.url).pathname);
    if (e instanceof HttpError) {
      // 401/403 get their own event so auth probing is visible in log streams.
      const event = e.status === 401 || e.status === 403 ? 'auth_rejected' : 'request_error';
      logEvent(e.status >= 500 ? 'error' : 'warn', event, {
        path: logPath,
        status: e.status,
        code: e.code,
      });
      return json({ error: { code: e.code, message: e.message } }, e.status);
    }
    // Never leak stack traces or SQL to clients.
    logEvent('error', 'request_error', { path: logPath, status: 500, code: 'internal' });
    return json({ error: { code: 'internal', message: 'Internal server error' } }, 500);
  }
}

// Worker entry point (production): D1-backed.
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (!env.DB) {
      logEvent('error', 'misconfigured', { detail: 'D1 binding DB is not configured' });
      return withSecurityHeaders(
        json({ error: { code: 'misconfigured', message: 'D1 binding DB is not configured' } }, 500),
      );
    }
    if (!env.TOKEN_PEPPER) {
      logEvent('error', 'misconfigured', { detail: 'TOKEN_PEPPER secret is not set' });
      return withSecurityHeaders(
        json({ error: { code: 'misconfigured', message: 'TOKEN_PEPPER secret is not set' } }, 500),
      );
    }
    return await handleRequest(req, d1Client(env.DB), env);
  },
};
