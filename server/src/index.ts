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
  newInvitePageToken,
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
  parseFh1Header,
} from './validate.js';
import { d1Client } from './db.js';
import { UI_HTML } from './ui.js';
// Single source of truth for the server version: server/package.json.
// The skill (agent-skill/hub) carries its own VERSION constant; the two
// version independently (docs/VERSIONING.md).
import pkg from '../package.json' with { type: 'json' };
const SERVER_VERSION: string = pkg.version;
// B2: repo-controlled CLI release manifest (server/client-manifest.json).
// Bundled at build time = loaded at worker startup; no D1 read on the hot
// path. The release workflow is the only writer.
// skill_sha256 + skill_version are present for CLI releases cut after the
// skill bundle (bundle-client.mjs fails closed when they are absent), so
// they are required here — a successful build guarantees them.
type ClientManifestPin = {
  version: string;
  min_cli_version: string;
  download_url: string;
  sha256: string;
  released_at: string;
  skill_sha256: string;
  skill_version: string;
};
import clientManifestJson from '../client-manifest.json' with { type: 'json' };
const clientManifest: ClientManifestPin = clientManifestJson as ClientManifestPin;
// §3.6: the pinned CLI artifacts, bundled at build time by
// server/scripts/bundle-client.mjs (npm run bundle:client, wired as
// 'prebuild' and in 'pretest'). Gitignored; the build fails closed without
// it, so these endpoints never serve placeholders.
import { CLIENT_DIST } from './client-dist.generated.js';

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
// EXCEPTION: key-lineage audit events (agent_key_registered,
// agent_key_rotated, token_revoked) additionally carry key_fp (a fingerprint
// of the PUBLIC key only — not secret), agent_label, member_id, and
// family_id per the client-hardening spec §3 B3, so any message can be traced
// end-to-end via key fp → agent_label → member_id → circle_id.
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
// code and are left alone. /i/ paths carry the invite page token, which is
// the credential for the onboarding page.
export function redactPath(path: string): string {
  return path
    .replace(/^(\/v1\/invites\/).*/, '$1[redacted]')
    .replace(/^(\/v1\/provisioning-codes\/).*/, '$1[redacted]')
    .replace(/^(\/i\/).*/, '$1[redacted]');
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
  endpoint: 'invite_accept' | 'code_redeem' | 'invite_page' | 'client_download',
  // Per-endpoint bucket override. Credential endpoints use the tight default
  // (10/10min); public download endpoints get a generous bucket (spec §3.4).
  max: number = RATE_LIMIT_MAX,
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
  if (count > max) {
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

// ---------------------------------------------------------------------------
// Sync v2 — N05 field-level E2EE enforcement + write-time key checks.
// ---------------------------------------------------------------------------

/** True when the topic is E2EE. Small lookup for paths that reach the topic
 *  through a task id (getTaskInScope returns the task, not the topic). */
async function topicE2ee(db: DbClient, topicId: string): Promise<boolean> {
  const t = await db.queryOne(`SELECT e2ee FROM topics WHERE id = ?`, [topicId]);
  return (t?.['e2ee'] as number) === 1;
}

// POST /entries content kinds. Everything except 'message' is a protocol /
// system kind: plaintext by design, readable by agents that do not (yet)
// hold the topic key (key rotation notices, key requests, pending-key
// notices, archive announcements). Spec §1.5 exempts the protocol kind
// `key-request` from the fh1 requirement; the server's wire enum spells it
// `key_request`, and the same plaintext-by-design rationale covers the other
// three system kinds — the CLI posts all four via its plaintext
// system-entry path, and encrypting them would break rotation/add flows.
// N05 content checks and the epoch/rotation write gates below therefore
// apply only to kind 'message'.
function isProtocolKind(kind: string): boolean {
  return kind !== 'message';
}

// N05: a content field on an E2EE topic must be a well-formed fh1 wire
// body. Violation -> 400 plaintext_in_e2ee_topic. Never logs the value.
function requireE2eeContent(value: unknown, field: string): void {  if (!isE2eeWireBody(value)) {
    logEvent('warn', 'plaintext_in_e2ee_topic', { field });
    throw new HttpError(
      400,
      'plaintext_in_e2ee_topic',
      `${field} must be E2EE ciphertext (fh1) in an E2EE topic`,
    );
  }
}

// N05: entry `data` (a JSON string) on an E2EE topic. The sealed payload is
// carried as a JSON string holding the fh1 wire body — structured plaintext
// linkage data is not permitted on E2EE content writes. Absent/null data is
// fine.
function requireE2eeData(data: string | null, field: string): void {
  if (data === null) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    parsed = undefined;
  }
  if (typeof parsed !== 'string' || !isE2eeWireBody(parsed)) {
    logEvent('warn', 'plaintext_in_e2ee_topic', { field });
    throw new HttpError(
      400,
      'plaintext_in_e2ee_topic',
      `${field} must be E2EE ciphertext (fh1) in an E2EE topic`,
    );
  }
}

// Write-time key checks (spec §1.5): server-side gates on encrypted content
// writes to E2EE topics, independent of client version. keyId is parsed
// from the fh1 body header. Order is deliberate: epoch liveness first
// (genesis not yet committed), then key freshness (stale client keystore),
// then the rotation pause (removal / from-join rekey pending).
function checkE2eeWriteKey(topic: Row, keyId: string): void {
  const epoch = topic['current_epoch'] as number;
  if (epoch < 1) {
    logEvent('warn', 'key_not_active', { reason: 'epoch_0' });
    throw new HttpError(
      409,
      'key_not_active',
      'E2EE topic has no active key yet — writes blocked until the first key is committed',
    );
  }
  if (keyId !== (topic['current_key_id'] as string | null)) {
    logEvent('warn', 'stale_key', { reason: 'key_id_mismatch' });
    throw new HttpError(
      409,
      'stale_key',
      'Entry was encrypted to a superseded topic key — fetch the current key and retry',
    );
  }
  if ((topic['rotation_required'] as number) === 1) {
    logEvent('warn', 'rotation_required', { reason: 'rekey_pending' });
    throw new HttpError(
      409,
      'rotation_required',
      'A membership change requires a fresh key — encrypted writes pause until the owner commits a rotation',
    );
  }
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
  // R1: msg_id extracted from the fh1 body at POST time (NULL otherwise).
  msgId?: string | null;
}): BatchOp {
  const pin = args.pin ? ` HAVING ${args.pin}` : '';
  return {
    sql: `INSERT INTO entries(topic_id, seq, ts, actor_member_id, agent_label, token_id, kind, body, data, reply_to_seq, msg_id)
          SELECT ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ?, ?, ?, ?, ?, ?, ?
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
      args.msgId ?? null,
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
// Client version gate (B1) + key fingerprints (B3).
// ---------------------------------------------------------------------------

const CLI_UA_RE = /^family-hub-agent\/(\S+)$/;
// Legacy sentinel: the hardcoded UA string that predated real versioning —
// always treated as 0.0.0 (below any minimum) when the gate is on.
const LEGACY_CLI_UA_VERSION = '1.0';

/** API-major prefix of a request path (spec §1, §3.3), or null for non-API
 *  paths (`/`, `/i/...`). Dispatch in routeRequest branches on this so a
 *  breaking change later adds a parallel v2 block; v1 shapes stay frozen. */
function apiMajorOf(path: string): 'v1' | 'v2' | null {
  if (path === '/v1' || path.startsWith('/v1/')) return 'v1';
  if (path === '/v2' || path.startsWith('/v2/')) return 'v2';
  return null;
}

/** Paths the client version gate never blocks: liveness, the upgrade
 *  metadata, and the replacement artifacts — an outdated client must always
 *  be able to reach what it needs in order to update. */
function isGateExempt(path: string): boolean {
  return (
    path === '/v1/health' ||
    path === '/v1/client/latest' ||
    path.startsWith('/v1/client/download/')
  );
}

type Semver = [number, number, number];

/** Strict x.y.z parse; null when the string is not a semver. */
function parseSemver(v: string): Semver | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareSemver(a: Semver, b: Semver): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Reject CLI clients below the configured minimum version. Rules:
 * - The exact legacy string `family-hub-agent/1.0` is a sentinel → 0.0.0.
 * - Requests WITHOUT a `family-hub-agent` UA (browser dashboard, curl) are
 *   never gated.
 * - Default MIN_CLI_VERSION "0.0.0" = gate off.
 * - Unparseable versions fail closed (treated as 0.0.0): a client that
 *   cannot prove its version is treated as outdated.
 * - Rejection is HTTP 426 (Upgrade Required), code `client_too_old`
 *   (spec §3.2 — was 400; the plain-language upgrade message is kept).
 * Called for /v1/... requests EXCEPT /v1/health, /v1/client/latest, and
 * /v1/client/download/* — an outdated client must always be able to reach
 * liveness checks and the upgrade metadata + replacement artifacts
 * (`hub upgrade` reads /v1/client/latest) it needs in order to update.
 */
function gateClientVersion(req: Request, env: Env): void {
  const ua = req.headers.get('user-agent');
  if (!ua) return;
  const m = CLI_UA_RE.exec(ua.trim());
  if (!m) return; // not a hub agent — browser dashboard, curl, uptime checks.
  const raw = m[1] === LEGACY_CLI_UA_VERSION ? '0.0.0' : m[1];
  const minRaw = (env.MIN_CLI_VERSION ?? '0.0.0').trim() || '0.0.0';
  const client: Semver = parseSemver(raw) ?? [0, 0, 0];
  const min: Semver = parseSemver(minRaw) ?? [0, 0, 0];
  if (compareSemver(client, min) < 0) {
    throw new HttpError(
      426,
      'client_too_old',
      `Client version ${raw} is below the required minimum ${minRaw}. ` +
        'Update your CLI: see agent-skill/INSTALL.md (hub upgrade), then retry.',
    );
  }
}

/**
 * Key fingerprint (B3): first 16 hex chars of SHA-256(public_key), prefixed
 * `fp:`. Computed over the stored base64 representation. Public keys are
 * public, so the fingerprint is safe for the audit log.
 */
async function keyFingerprint(publicKey: string): Promise<string> {
  return 'fp:' + (await sha256hex(publicKey)).slice(0, 16);
}

// ---------------------------------------------------------------------------
// Sync v2 read receipts (spec §1.4).
//
// GET /v1/topics/:tid/history issues a receipt binding
// (member_id, agent_label, topic_id, from_seq, through_seq); POST
// /v1/topics/:tid/ack must present a receipt whose HMAC verifies before the
// ack advances. Receipts are stateless (server restart loses nothing): the
// HMAC is the whole credential.
//
// Wire format: `fhrr1.<from_seq>.<through_seq>.<hmac_hex64>` where the HMAC
// is HMAC-SHA256(READ_RECEIPT_SECRET, canonical) and canonical is a
// pipe-joined, version-tagged payload. The member/agent/topic binding lives
// INSIDE the HMAC, so a receipt minted for one agent cannot be replayed by
// another (cross-agent replay fails verification).
//
// The secret is read from env (READ_RECEIPT_SECRET) and never logged. When
// unset the server fails closed with 500 misconfigured — receipts are
// never silently disabled.
// ---------------------------------------------------------------------------

const RECEIPT_PREFIX = 'fhrr1';

function receiptCanonical(
  memberId: string,
  agentLabel: string,
  topicId: string,
  fromSeq: number,
  throughSeq: number,
): string {
  return ['fh-read-receipt', 'v1', memberId, agentLabel, topicId, String(fromSeq), String(throughSeq)].join(
    '|',
  );
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Constant-time hex comparison (no early exit on first mismatch). */
function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function readReceiptSecret(env: Env): string {
  const s = env.READ_RECEIPT_SECRET;
  if (!s) {
    throw new HttpError(
      500,
      'misconfigured',
      'READ_RECEIPT_SECRET is not set — read receipts cannot be issued or verified',
    );
  }
  return s;
}

async function issueReadReceipt(
  env: Env,
  memberId: string,
  agentLabel: string,
  topicId: string,
  fromSeq: number,
  throughSeq: number,
): Promise<string> {
  const mac = await hmacSha256Hex(
    readReceiptSecret(env),
    receiptCanonical(memberId, agentLabel, topicId, fromSeq, throughSeq),
  );
  return `${RECEIPT_PREFIX}.${fromSeq}.${throughSeq}.${mac}`;
}

const RECEIPT_MAC_RE = /^[0-9a-f]{64}$/;

/**
 * Verify a receipt binds THIS (member_id, agent_label, topic_id).
 * Returns the bound (from_seq, through_seq). 403 invalid_read_receipt on
 * any malformation or HMAC mismatch (forgery / cross-agent replay).
 */
async function verifyReadReceipt(
  env: Env,
  receipt: string,
  memberId: string,
  agentLabel: string,
  topicId: string,
): Promise<{ from_seq: number; through_seq: number }> {
  const bad = (): HttpError =>
    new HttpError(403, 'invalid_read_receipt', 'read_receipt failed verification');
  const parts = receipt.split('.');
  if (parts.length !== 4 || parts[0] !== RECEIPT_PREFIX) throw bad();
  const fromSeq = /^\d+$/.test(parts[1]) ? Number(parts[1]) : NaN;
  const throughSeq = /^\d+$/.test(parts[2]) ? Number(parts[2]) : NaN;
  if (!Number.isSafeInteger(fromSeq) || !Number.isSafeInteger(throughSeq)) throw bad();
  if (!RECEIPT_MAC_RE.test(parts[3])) throw bad();
  const expected = await hmacSha256Hex(
    readReceiptSecret(env),
    receiptCanonical(memberId, agentLabel, topicId, fromSeq, throughSeq),
  );
  if (!constantTimeEqualHex(parts[3], expected)) throw bad();
  return { from_seq: fromSeq, through_seq: throughSeq };
}

// ---------------------------------------------------------------------------
// Handlers.
// ---------------------------------------------------------------------------

async function handleHealth(): Promise<Response> {
  return json({ ok: true, version: SERVER_VERSION, api_versions: ['v1'] });
}

/** Absolute URLs for this server's own CLI download endpoints, derived
 *  from the request origin (spec §3.5 — the server's responses always use
 *  this server's URLs, never the GitHub provenance URL in the pin). */
function clientDownloadUrls(origin: string): {
  hub: string;
  sigstore: string;
  manifest: string;
  skill: string;
} {
  return {
    hub: `${origin}/v1/client/download/hub`,
    sigstore: `${origin}/v1/client/download/hub.sigstore`,
    manifest: `${origin}/v1/client/download/manifest.json`,
    skill: `${origin}/v1/client/download/skill.tar.gz`,
  };
}

// B2: GET /v1/client/latest — the CLI release the deployed server knows
// about, sourced from the repo-controlled server/client-manifest.json
// (bundled at build time; no D1 read on the hot path; the release workflow
// is the only writer). Public: `hub upgrade` reads this before/without a
// token, and the client version gate never blocks it. All URLs are absolute
// and self-referential: this server serves its own bundled artifacts.
async function handleClientLatest(req: Request): Promise<Response> {
  const origin = new URL(req.url).origin;
  const assets = clientDownloadUrls(origin);
  return json({
    version: clientManifest.version,
    min_cli_version: clientManifest.min_cli_version,
    server_version: SERVER_VERSION,
    sha256: clientManifest.sha256,
    released_at: clientManifest.released_at,
    download_url: assets.hub,
    assets: {
      hub: assets.hub,
      sigstore: assets.sigstore,
      manifest: assets.manifest,
    },
    // The full skill bundle (SKILL.md, references/, INSTALL.md,
    // requirements.txt + the hub artifact, its sigstore bundle, and the
    // release manifest), hash-verified at build time. `hub upgrade`'s
    // skill-refresh reads this block; the bundle itself is served at
    // GET /v1/client/download/skill.tar.gz.
    skill: {
      url: assets.skill,
      sha256: clientManifest.skill_sha256,
      version: clientManifest.skill_version,
    },
  });
}

/** Decode base64 → bytes without Node's Buffer: atob exists in both the
 *  Workers runtime and Node 16+, and its binary string maps 1:1 to bytes. */
function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// §3.4: GET /v1/client/download/{hub,hub.sigstore,manifest.json,skill.tar.gz}
// — the build-bundled CLI artifacts + skill bundle (public; the client
// version gate never blocks them — an outdated client must be able to fetch
// its replacement).
// FIXED asset map: dispatch is on exact paths in routeRequest (no path
// parameters), so there is no traversal surface by construction; anything
// else under /v1/client/download/ hits the explicit 404 in routeRequest.
// Cache-Control is public, max-age=300 (bytes change when the pin updates
// + the server redeploys — must NOT be immutable). Rate-limited with a
// generous bucket; 429 uses the standard rate_limited envelope + Retry-After.
const CLIENT_DOWNLOAD_MAX_PER_WINDOW = 100;

type ClientDownloadAsset = 'hub' | 'sigstore' | 'manifest' | 'skill';

function clientDownloadAsset(asset: ClientDownloadAsset): {
  filename: string;
  contentType: string;
  bytes: Uint8Array<ArrayBuffer>;
} {
  switch (asset) {
    case 'hub':
      return {
        filename: 'hub',
        contentType: 'application/octet-stream',
        bytes: b64ToBytes(CLIENT_DIST.hubB64),
      };
    case 'sigstore':
      return {
        filename: 'hub.sigstore',
        contentType: 'application/json',
        bytes: b64ToBytes(CLIENT_DIST.sigstoreB64),
      };
    case 'manifest':
      return {
        filename: 'manifest.json',
        contentType: 'application/json',
        bytes: b64ToBytes(CLIENT_DIST.manifestB64),
      };
    case 'skill':
      return {
        filename: 'skill.tar.gz',
        contentType: 'application/gzip',
        bytes: b64ToBytes(CLIENT_DIST.skillTarGzB64),
      };
  }
}

async function handleClientDownload(
  db: DbClient,
  req: Request,
  asset: ClientDownloadAsset,
): Promise<Response> {
  const limited = await checkRateLimit(db, req, 'client_download', CLIENT_DOWNLOAD_MAX_PER_WINDOW);
  if (limited) return limited;
  const { filename, contentType, bytes } = clientDownloadAsset(asset);
  return new Response(bytes, {
    status: 200,
    headers: {
      'content-type': contentType,
      'content-disposition': `attachment; filename="${filename}"`,
      'content-length': String(bytes.length),
      'cache-control': 'public, max-age=300',
    },
  });
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

/**
 * Mint an onboarding page token for an invite. Returns the invite_pages
 * INSERT op (for the same execAtomically batch as the invites INSERT) and
 * the one-time onboarding URL. The raw page token is returned to the
 * inviter ONCE inside `onboarding_url`; only sha256(pepper || token) is
 * stored. The origin comes from the request URL server-side — never from a
 * client-supplied base URL.
 */
async function mintInvitePage(
  env: Env,
  req: Request,
  codeHash: string,
  expiresAt: string,
): Promise<{
  sql: string;
  params: (string | number | null)[];
  onboardingUrl: string;
}> {
  const pageToken = newInvitePageToken();
  const pageTokenHash = await credentialHash(env.TOKEN_PEPPER, pageToken);
  const onboardingUrl = `${new URL(req.url).origin}/i/${pageToken}`;
  return {
    sql: `INSERT INTO invite_pages(page_token_hash, invite_code_hash, created_at, expires_at, verify_attempts, last_attempt_at)
          VALUES (?,?,?, ?,0,NULL)`,
    params: [pageTokenHash, codeHash, nowIso(), expiresAt],
    onboardingUrl,
  };
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
      const page = await mintInvitePage(env, req, codeHash, expiresAt);
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
        { sql: page.sql, params: page.params },
      ]);
      logEvent('info', 'idempotency_stored', { scope: 'invite', key: idemKey });
      return json({ invite_code: code, expires_at: expiresAt, onboarding_url: page.onboardingUrl, deduped: true });
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
  const page = await mintInvitePage(env, req, codeHash, expiresAt);
  const ops: { sql: string; params: (string | number | null)[] }[] = [
    {
      sql: `INSERT INTO invites(code_hash, family_id, email, role, created_by, expires_at, used_at)
            VALUES (?,?,?,?,?,?,NULL)`,
      params: [codeHash, auth.family_id, email, role, auth.member_id, expiresAt],
    },
    { sql: page.sql, params: page.params },
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
  return json({ invite_code: code, expires_at: expiresAt, onboarding_url: page.onboardingUrl }, 201);
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
  // while an invite for this (family_id, email) is still unused, and the
  // UPDATE consumes it — one atomic batch, in this order (the conditional
  // INSERTs must run before the consume UPDATE so they see pre-consume
  // state). Scoped by (family_id, email) rather than the presented code
  // hash: several live codes can exist for one email (the raw fallback plus
  // codes minted by email verifies), and concurrent accepts of DIFFERENT
  // codes must still create exactly one member and one token — the
  // pre-batch duplicate guard is TOCTOU. The winner is the call whose
  // member row exists afterwards; the loser falls into the 409 path below.
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
             WHERE EXISTS (SELECT 1 FROM invites WHERE family_id = ? AND email = ? AND used_at IS NULL)`,
      params: [memberId, inviteFamilyId, displayName, email, inviteRole, principalId, ts, inviteFamilyId, email],
    },
    {
      sql: `INSERT INTO agent_tokens(token_hash, token_id, member_id, agent_label, created_at, revoked_at, last_used_at, issued_by_token_id)
            SELECT ?,?,?,?,?,NULL,NULL,NULL
             WHERE EXISTS (SELECT 1 FROM invites WHERE family_id = ? AND email = ? AND used_at IS NULL)`,
      params: [tokenHash, tokenId, memberId, agentLabel, ts, inviteFamilyId, email],
    },
    {
      // Consume EVERY live code for this (family_id, email): the email has
      // joined, so sibling codes (raw fallback, verify-minted) are spent.
      sql: `UPDATE invites SET used_at = ? WHERE family_id = ? AND email = ? AND used_at IS NULL`,
      params: [ts, inviteFamilyId, email],
    },
    {
      // Self-destruct the onboarding page (v0.11.0) in the same atomic
      // batch: match by (family_id, email) rather than the presented code
      // hash, because a successful email verify mints a fresh code and
      // repoints the page at it — the invitee may accept with the
      // page-revealed code OR the raw fallback code the inviter shared
      // directly, and the page must die in both cases. (Deleting by
      // family+email is safe: an accepted email can never accept again —
      // the duplicate guard 409s — so no live page for that email can be
      // harmed.)
      sql: `DELETE FROM invite_pages
             WHERE invite_code_hash IN (SELECT code_hash FROM invites WHERE family_id = ? AND email = ?)`,
      params: [inviteFamilyId, email],
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
// Invite onboarding pages (v0.11.0). One single-use page per invite at
// /i/<page-token>: the inviter sends the URL; the invitee (human or their
// agent) proves the invited email and receives a single-use invite code plus
// the exact `hub setup` command. Two secrets — the unguessable URL
// (possession) and the invited email (knowledge) — mirroring the existing
// code-is-the-credential model. Public by design (the token is the
// credential): these routes are registered BEFORE the Bearer choke point in
// routeRequest(), and /i/* is not under /v1/* so the client version gate
// does not apply (an un-enrolled invitee has no client version to gate).
// There is no listing endpoint.
//
// Plaintext invite codes are unrecoverable once stored (only the hash is
// kept), so a successful email verify MINTS A FRESH code for the same
// (family, email, role) — the same pattern the idempotency-hit path in
// handleCreateInvite uses — inserts it as a new invite row, and repoints
// the page at it, atomically. The original code stays live until the invite
// is accepted or expires (it was already shared with the inviter as the
// raw-code fallback); the (family_id, email) duplicate guard in
// handleAcceptInvite prevents a second member from either code.
// ---------------------------------------------------------------------------

const INVITE_PAGE_TOKEN_MAX_LEN = 128;
const VERIFY_MAX_ATTEMPTS = 10;
const VERIFY_BACKOFF_MS = 5 * 60_000;
const VERIFY_ATTEMPT_DECAY_MS = 60 * 60_000;

/** Extract the page token from a /i/ URL segment: strip an optional
 *  trailing `.json`, URL-decode. Empty, overlong, or undecodable input
 *  throws the identical page 404. */
function extractPageToken(segment: string): string {
  let s = segment;
  if (s.endsWith('.json')) s = s.slice(0, -'.json'.length);
  let token: string;
  try {
    token = decodeURIComponent(s);
  } catch {
    throw new HttpError(404, 'not_found', 'Not found');
  }
  if (token.length === 0 || token.length > INVITE_PAGE_TOKEN_MAX_LEN) {
    throw new HttpError(404, 'not_found', 'Not found');
  }
  return token;
}

interface InvitePage {
  pageTokenHash: string;
  email: string;
  role: string;
  familyId: string;
  familyName: string;
  createdBy: string;
  expiresAt: string;
  verifyAttempts: number;
  lastAttemptAt: string | null;
}

/** Load a live invite page by presented token. Unknown tokens, used
 *  invites, and expired invites all throw the IDENTICAL 404 (same code,
 *  same message, same serialization). Dead rows are lazily deleted when
 *  noticed. */
async function loadInvitePage(db: DbClient, env: Env, rawToken: string): Promise<InvitePage> {
  const pageTokenHash = await credentialHash(env.TOKEN_PEPPER, rawToken);
  const row = await db.queryOne(
    `SELECT p.page_token_hash AS page_token_hash,
            p.verify_attempts AS verify_attempts,
            p.last_attempt_at AS last_attempt_at,
            i.email AS email,
            i.role AS role,
            i.family_id AS family_id,
            i.created_by AS created_by,
            i.expires_at AS expires_at,
            i.used_at AS used_at,
            f.name AS family_name
       FROM invite_pages p
       JOIN invites i ON i.code_hash = p.invite_code_hash
       JOIN families f ON f.id = i.family_id
      WHERE p.page_token_hash = ?`,
    [pageTokenHash],
  );
  if (!row) throw new HttpError(404, 'not_found', 'Not found');
  const usedAt = row['used_at'] as string | null;
  const expiresAt = row['expires_at'] as string;
  if (usedAt || expiresAt <= nowIso()) {
    // Lazy cleanup: the invite is spent or expired, so the page is dead.
    await db.queryAll(`DELETE FROM invite_pages WHERE page_token_hash = ?`, [pageTokenHash]);
    throw new HttpError(404, 'not_found', 'Not found');
  }
  return {
    pageTokenHash,
    email: row['email'] as string,
    role: row['role'] as string,
    familyId: row['family_id'] as string,
    familyName: row['family_name'] as string,
    createdBy: row['created_by'] as string,
    expiresAt,
    verifyAttempts: (row['verify_attempts'] as number) ?? 0,
    lastAttemptAt: row['last_attempt_at'] as string | null,
  };
}

/** Masked email hint: first char of the local part + `***@` + domain. */
function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '***';
  return `${email.charAt(0)}***@${email.slice(at + 1)}`;
}

/** Constant-time string equality for the email check: both sides are
 *  hashed first, then the fixed-size digests are compared in a
 *  no-early-exit loop (no length oracle). */
async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const da = await sha256hex(a);
  const dbDigest = await sha256hex(b);
  let diff = 0;
  for (let i = 0; i < da.length; i++) {
    diff |= da.charCodeAt(i) ^ dbDigest.charCodeAt(i);
  }
  return diff === 0;
}

/** HTML-escape interpolated values (family name, hint, URLs, timestamps). */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/** The agent-facing JSON page. Contains no invite code. The verify path is
 *  absolute and embeds the page token the agent already holds (it fetched
 *  this very URL): a relative './verify' would resolve against /i/ and drop
 *  the token segment, 404ing. Echoing the token back to its holder is not a
 *  leak, and /i/ paths are redacted from logs. CLI download URLs point at
 *  THIS server's /v1/client/download/* endpoints (spec §3.11).
 *
 *  Install steps shared by the JSON and HTML invite pages. The flow starts
 *  with the skill bundle: download skill.tar.gz from THIS server → verify
 *  its sha256 against the hash this page provides → extract → verify hub's
 *  sigstore seal → verify hub's sha256 against the release manifest →
 *  install the Python deps. No GitHub URLs anywhere in the flow.
 *  The interpolated bundle hash is constrained to [0-9a-f]{64} by
 *  bundle-client.mjs checkPin at build time (the server only builds when
 *  the pin carries a valid 64-hex skill_sha256), so it cannot break out of
 *  the single-quoted python string it sits in. */
function inviteInstallSteps(origin: string): string[] {
  const urls = clientDownloadUrls(origin);
  return [
    'mkdir -p ~/workspace/skills/family-hub && cd ~/workspace/skills/family-hub',
    `curl -sSLO ${urls.skill}`,
    `python3 -c "import hashlib; assert hashlib.sha256(open('skill.tar.gz','rb').read()).hexdigest()=='${clientManifest.skill_sha256}', 'skill bundle hash mismatch'"`,
    'tar -xzf skill.tar.gz',
    'chmod +x hub',
    'pip install "sigstore>=3.0,<4.0" && python3 -m sigstore verify identity --bundle hub.sigstore --cert-identity "https://github.com/maddy13182/museFamilyconnector/.github/workflows/release.yml@refs/heads/main" --cert-oidc-issuer "https://token.actions.githubusercontent.com" hub',
    `python3 -c "import hashlib,json; assert hashlib.sha256(open('hub','rb').read()).hexdigest()==json.load(open('manifest.json'))['sha256']"`,
    'pip install -r requirements.txt',
  ];
}
function invitePageJson(page: InvitePage, rawToken: string, origin: string): Record<string, unknown> {
  const urls = clientDownloadUrls(origin);
  return {
    page: 'invite',
    family_name: page.familyName,
    role: page.role,
    email_hint: maskEmail(page.email),
    expires_at: page.expiresAt,
    client: {
      version: clientManifest.version,
      download_url: urls.hub,
      sha256: clientManifest.sha256,
      // Everything the install steps need: the bundle URL + its hash
      // (verified before extraction), and the hub hash (verified after
      // extraction, against the release manifest inside the bundle).
      skill: {
        version: clientManifest.skill_version,
        download_url: urls.skill,
        sha256: clientManifest.skill_sha256,
      },
    },
    install: {
      summary:
        'Install the Family Hub skill bundle, verify its hash, verify the CLI signature, then run hub setup.',
      steps: inviteInstallSteps(origin),
      verify_note: 'If signature or hash verification fails, do NOT install — ask the inviter.',
    },
    // Absolute path: the agent POSTs here directly. (A relative './verify'
    // would resolve to /i/verify and drop the token segment.)
    verify: {
      method: 'POST',
      path: `/i/${rawToken}/verify`,
      body: { email: 'the invited email address' },
    },
  };
}

/** The human-facing HTML page. All interpolated values are HTML-escaped;
 *  the inline script renders the verify response via textContent only
 *  (never innerHTML with server data). */
function invitePageHtml(page: InvitePage, rawToken: string, origin: string): Response {
  const verifyPath = `/i/${rawToken}/verify`;
  const steps = inviteInstallSteps(origin);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Join ${escapeHtml(page.familyName)} on Family Hub</title>
<style>body{font-family:system-ui,sans-serif;max-width:44rem;margin:2rem auto;padding:0 1rem;line-height:1.5}pre{background:#f4f4f4;padding:1rem;overflow-x:auto;white-space:pre-wrap}</style>
</head>
<body>
<h1>You&rsquo;re invited to join ${escapeHtml(page.familyName)} on Family Hub</h1>
<p>Family Hub is private agent-to-agent messaging: each family runs its own
server with messaging circles, and every family member&rsquo;s AI agent gets its
own login. This page onboards the new member&rsquo;s agent &mdash; no account or
password needed, just the invite below.</p>
<p>This invitation was sent to <strong>${escapeHtml(maskEmail(page.email))}</strong>
and expires on <code>${escapeHtml(page.expiresAt)}</code>.</p>
<h2>1. Install the skill bundle</h2>
<p>Run these on the new member&rsquo;s machine (copy-paste):</p>
<pre>${escapeHtml(steps.join('\n'))}</pre>
<p>If signature or hash verification fails, do <strong>not</strong> install &mdash; ask the inviter.</p>
<h2>2. Confirm your email</h2>
<p>Enter the invited email address (${escapeHtml(maskEmail(page.email))}) to reveal the single-use invite code:</p>
<form id="verify-form">
<input id="email" type="email" name="email" required maxlength="254" autocomplete="email">
<button type="submit">Reveal invite code</button>
</form>
<div id="result" aria-live="polite"></div>
<script>
document.getElementById('verify-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const out = document.getElementById('result');
  out.textContent = 'Checking\u2026';
  try {
    const res = await fetch('${verifyPath}', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: document.getElementById('email').value }),
    });
    if (res.status === 403) {
      out.textContent = 'That email does not match this invitation. Check the address the inviter used.';
      return;
    }
    if (res.status === 429) {
      out.textContent = 'Too many attempts \u2014 wait a few minutes and try again.';
      return;
    }
    if (!res.ok) {
      out.textContent = 'Something went wrong. Ask the inviter for a fresh invite link.';
      return;
    }
    const data = await res.json();
    out.textContent = '';
    const p = document.createElement('p');
    p.textContent = 'Email confirmed. Run this on the new member\u2019s machine:';
    const pre = document.createElement('pre');
    pre.textContent = data.setup_command;
    const note = document.createElement('p');
    note.textContent = 'The code is single-use. This page stops working once it is redeemed.';
    out.append(p, pre, note);
  } catch (err) {
    out.textContent = 'Network error. Check your connection and try again.';
  }
});
</script>
</body>
</html>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

// GET /i/:token and GET /i/:token.json — public. JSON for agents
// (Accept: application/json or the .json suffix), HTML for humans.
async function handleInvitePageGet(
  db: DbClient,
  env: Env,
  req: Request,
  segment: string,
): Promise<Response> {
  const token = extractPageToken(segment);
  // Rate-limit BEFORE the token lookup: the lookup burns a peppered hash +
  // D1 read, and unknown-token floods must hit the IP bucket, not the DB.
  // A 429 reveals only the caller's own budget, never token validity.
  const limited = await checkRateLimit(db, req, 'invite_page');
  if (limited) return limited;
  const page = await loadInvitePage(db, env, token);
  const accept = req.headers.get('accept') ?? '';
  const origin = new URL(req.url).origin;
  if (segment.endsWith('.json') || accept.includes('application/json')) {
    return json(invitePageJson(page, token, origin));
  }
  return invitePageHtml(page, token, origin);
}

// POST /i/:token/verify — body {"email": "..."}. On a match, mints a FRESH
// single-use invite code for the same (family, email, role) — the stored
// code's plaintext is unrecoverable, so this mirrors the idempotency-hit
// pattern — repoints the page at it atomically, and returns the code plus
// the exact `hub setup` command. On a mismatch: 403 and the per-page
// attempt budget is incremented. (The 403-vs-404 distinction — wrong email
// on a live page vs. dead/unknown token — is inherent to the design and
// acceptable: the URL holder already knows the URL is real. Normalization
// is trim + lowercase ONLY: no `+`-tag stripping, no Unicode confusable
// folding — the inviter must use the canonical address.)
async function handleInvitePageVerify(
  db: DbClient,
  env: Env,
  req: Request,
  segment: string,
): Promise<Response> {
  const token = extractPageToken(segment);
  // Rate-limit BEFORE the token lookup: see handleInvitePageGet.
  const limited = await checkRateLimit(db, req, 'invite_page');
  if (limited) return limited;
  const page = await loadInvitePage(db, env, token);

  const body = await readJson(req);
  // Shape validation only (string, 3-254 chars). Malformed bodies are a
  // 400 bad_request (reqString); that distinguishes request shape only,
  // never token or email validity.
  const email = reqString(body['email'], 'email', 3, 254);

  // Per-page attempt budget with backoff. Attempts older than an hour decay
  // away; 10+ attempts with the last one < 5 minutes ago -> 429 with
  // Retry-After. NEVER a hard lock: after the cooldown the real invitee can
  // always try again. The check runs before the email comparison so a
  // correct email during backoff waits too (no oracle).
  const nowMs = Date.now();
  const lastMs = page.lastAttemptAt ? Date.parse(page.lastAttemptAt) : NaN;
  const attempts =
    Number.isFinite(lastMs) && nowMs - lastMs <= VERIFY_ATTEMPT_DECAY_MS ? page.verifyAttempts : 0;
  if (attempts >= VERIFY_MAX_ATTEMPTS && Number.isFinite(lastMs) && nowMs - lastMs < VERIFY_BACKOFF_MS) {
    const retryAfter = Math.max(1, Math.ceil((VERIFY_BACKOFF_MS - (nowMs - lastMs)) / 1000));
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

  const candidate = email.trim().toLowerCase();
  const stored = page.email.trim().toLowerCase();
  if (!(await constantTimeEqual(candidate, stored))) {
    await db.queryAll(
      `UPDATE invite_pages SET verify_attempts = ?, last_attempt_at = ? WHERE page_token_hash = ?`,
      [attempts + 1, new Date(nowMs).toISOString(), page.pageTokenHash],
    );
    throw new HttpError(403, 'forbidden', 'This email does not match the invitation.');
  }

  // Match: mint a fresh code (the stored code's plaintext is unrecoverable),
  // insert it, and repoint the page at it — one atomic batch. The success
  // also counts toward the per-page attempt budget (same as a mismatch):
  // the invitee only ever needs one code, and unbounded minting would let
  // a URL+email holder stockpile sibling codes.
  const code = newInviteCode();
  const codeHash = await credentialHash(env.TOKEN_PEPPER, code);
  await db.execAtomically([
    {
      sql: `INSERT INTO invites(code_hash, family_id, email, role, created_by, expires_at, used_at)
            VALUES (?,?,?,?,?,?,NULL)`,
      params: [codeHash, page.familyId, page.email, page.role, page.createdBy, page.expiresAt],
    },
    {
      sql: `UPDATE invite_pages SET invite_code_hash = ?, verify_attempts = ?, last_attempt_at = ? WHERE page_token_hash = ?`,
      params: [codeHash, attempts + 1, new Date(nowMs).toISOString(), page.pageTokenHash],
    },
  ]);
  logEvent('info', 'invite_page_verified', {});
  // Origin comes from the request URL server-side — never a client-supplied
  // base URL. The code is base62, safe to embed unquoted in shell.
  const origin = new URL(req.url).origin;
  return json({
    invite_code: code,
    setup_command: `hub setup --server ${origin} --invite ${code}`,
    expires_at: page.expiresAt,
  });
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
  if (agentPublicKey) {
    // B3: key registration audit — key fp → agent_label → member_id → circle.
    // The conditional key INSERT above fired exactly when this redeem won
    // (verified by redeemed_token_id), so the key is now registered.
    logEvent('info', 'agent_key_registered', {
      key_fp: await keyFingerprint(agentPublicKey),
      agent_label: pc['agent_label'] as string,
      member_id: pc['member_id'] as string,
      family_id: member['family_id'] as string,
    });
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
  // B3: read the current active key BEFORE superseding it, so rotation can
  // audit old fp → new fp (no prior key = initial registration).
  const prior = await db.queryOne(
    `SELECT public_key FROM agent_keys
      WHERE member_id = ? AND agent_label = ? AND superseded_at IS NULL`,
    [auth.member_id, auth.agent_label],
  );
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
  const newFp = await keyFingerprint(agentPublicKey);
  if (prior) {
    // B3: rotation — old fp → new fp, chained to agent/member/circle.
    logEvent('info', 'agent_key_rotated', {
      old_key_fp: await keyFingerprint(prior['public_key'] as string),
      key_fp: newFp,
      agent_label: auth.agent_label,
      member_id: auth.member_id,
      family_id: auth.family_id,
    });
  } else {
    // B3: initial registration via `hub key-init`.
    logEvent('info', 'agent_key_registered', {
      key_fp: newFp,
      agent_label: auth.agent_label,
      member_id: auth.member_id,
      family_id: auth.family_id,
    });
  }
  return json({
    member_id: auth.member_id,
    agent_label: auth.agent_label,
    public_key: agentPublicKey,
    created_at: ts,
  });
}

// E2EE (sync v2, spec §1.5) — POST /v1/topics/:tid/envelopes
// {member_id, agent_label, key_id, envelope} — STAGED distribution. The
// envelope blob is opaque to the server: format-validated (base64) and
// stored, never inspected.
//
// N04 fix: non-current key_id envelopes are STORED, never flipped. The old
// behavior ("first POST with a new key_id flips topics.current_key_id")
// let a bare envelope POST elect the encryption key with no completeness
// check; now only POST /v1/topics/:tid/keys/commit advances the epoch and
// flips current_key_id.
//
// Access control (defense in depth; crypto is per-agent but the blob store
// still gates on membership):
//   - caller must be a current participant of the topic (403 otherwise;
//     404 when the topic doesn't exist in the caller's family);
//   - a key_id different from the topic's current_key_id INTRODUCES a key
//     (rotation/genesis staging) and is allowed only for owner/parent
//     callers (403 otherwise); the key_id is stored as staged — the commit
//     decides whether it activates;
//   - the target (member_id, agent_label) must be a current participant
//     AND hold an ACTIVE (non-superseded) registered public key (400
//     otherwise — sealing to an agent with no key on file is meaningless).
// The server records the target's ACTIVE identity-key id at POST time
// (topic_key_envelopes.identity_key_id) so keys/commit can reject envelopes
// sealed to superseded keys. On re-POST the recorded id refreshes to the
// key active at the latest POST (the blob was presumably re-sealed).
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
  // Introducing a key_id (one the topic has not committed) is an
  // owner/parent privilege — a participant must not stage keys for victims.
  // Staging stores the envelope; it NEVER flips topics.current_key_id (N04).
  const currentKeyId = topic['current_key_id'] as string | null;
  if (keyId !== currentKeyId && auth.role !== 'owner' && auth.role !== 'parent') {
    throw new HttpError(
      403,
      'forbidden',
      'Only an owner or parent may introduce a new topic key. ' +
        'Ask an owner/parent to run `hub topic-rekey`.',
    );
  }
  const targetPart = await db.queryOne(
    `SELECT member_id FROM topic_participants WHERE topic_id = ? AND member_id = ?`,
    [tid, targetMemberId],
  );
  if (!targetPart) {
    throw new HttpError(400, 'bad_request', 'envelope target must be a current participant of this topic');
  }
  const targetKey = await db.queryOne(
    `SELECT id FROM agent_keys WHERE member_id = ? AND agent_label = ? AND superseded_at IS NULL`,
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
  await db.execAtomically([
    {
      // F3: ON CONFLICT updates only the envelope blob (and the
      // server-observed identity_key_id) — created_at keeps its original
      // value, so a re-POST cannot forge recency.
      sql: `INSERT INTO topic_key_envelopes(topic_id, member_id, agent_label, key_id, envelope, created_at, identity_key_id)
            VALUES (?,?,?,?,?,?,?)
            ON CONFLICT(topic_id, member_id, agent_label, key_id)
            DO UPDATE SET envelope = excluded.envelope, identity_key_id = excluded.identity_key_id`,
      params: [tid, targetMemberId, targetAgentLabel, keyId, envelope, ts, targetKey['id'] as string],
    },
  ]);
  const row = await db.queryOne(
    `SELECT created_at FROM topic_key_envelopes
      WHERE topic_id = ? AND member_id = ? AND agent_label = ? AND key_id = ?`,
    [tid, targetMemberId, targetAgentLabel, keyId],
  );
  logEvent('info', 'envelope_staged', {
    endpoint: 'envelopes',
    member_id: auth.member_id,
    agent_label: auth.agent_label,
    topic_id: tid,
  });
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

// E2EE (sync v2, spec §1.5) — GET /v1/topics/:tid/envelopes — return ONLY
// the caller's own envelopes for COMMITTED epochs: rows are matched on the
// caller's (member_id, agent_label) taken from the Bearer <redacted> never
// from caller-supplied input, and joined against the topic's epoch log, so
// staged (uncommitted) keys stay invisible until keys/commit activates
// them — an uncommitted key must never be treated as usable. Each envelope
// carries its epoch's `commitment` (hex SHA256 of the topic key, NULL for
// grandfathered pre-migration epochs) so the CLI can verify-on-open (N07).
// 403 when the caller is not a participant (404 when the topic doesn't
// exist in the caller's family).
async function handleGetEnvelopes(
  db: DbClient,
  auth: AuthContext,
  tid: string,
): Promise<Response> {
  await requireParticipant(db, auth, tid);
  const rows = await db.queryAll(
    `SELECT e.topic_id, e.member_id, e.agent_label, e.key_id, e.envelope,
            e.created_at, k.epoch, k.commitment
       FROM topic_key_envelopes e
       JOIN topic_key_epochs k
         ON k.topic_id = e.topic_id AND k.key_id = e.key_id
      WHERE e.topic_id = ? AND e.member_id = ? AND e.agent_label = ?
      ORDER BY k.epoch ASC, e.created_at ASC`,
    [tid, auth.member_id, auth.agent_label],
  );
  logEvent('info', 'envelopes_listed', {
    endpoint: 'envelopes',
    member_id: auth.member_id,
    agent_label: auth.agent_label,
    topic_id: tid,
    count: rows.length,
  });
  return json({ envelopes: rows });
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
  // B3: revocation audit — the active key fingerprint for the revoked
  // token's (member_id, agent_label), so the trail
  // key fp → agent_label → member_id → circle_id stays complete through
  // revocation. null when the agent never registered an identity key.
  const activeKey = await db.queryOne(
    `SELECT public_key FROM agent_keys
      WHERE member_id = ? AND agent_label = ? AND superseded_at IS NULL`,
    [target['member_id'] as string, target['agent_label'] as string],
  );
  logEvent('info', 'token_revoked', {
    key_fp: activeKey ? await keyFingerprint(activeKey['public_key'] as string) : null,
    agent_label: target['agent_label'] as string,
    member_id: target['member_id'] as string,
    family_id: target['fam'] as string,
  });
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
  return json({
    ...publicMember(row),
    agent_label: auth.agent_label,
    // Hub-owner discovery: the agent learns from `hub me` whether it may
    // create circles (POST /v1/families when locked) instead of finding
    // out via a 403. Computed by principal, never by email (F02).
    is_hub_owner: await isHubOwner(db, auth),
  });
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

// GET /v1/topics/:tid/history?after_seq=&limit=&context=
//
// Sync v2 (spec §1.4): `context` (default 10, max 50) prepends up to that
// many entries immediately BEFORE `after_seq` (bounded below by the
// caller's history_from_seq), each flagged `is_context: true` — they are
// re-reads for orientation, not new reads. The page entries carry
// `is_context: false`.
//
// Every response includes `read_through_seq` (the highest newly-read seq
// in this page — context rows excluded; max(after, floor-1) when the page
// is empty) and a `read_receipt` HMAC binding
// (member_id, agent_label, topic_id, from_seq, through_seq), where
// from_seq = max(after, history_from_seq - 1) + 1 is the REQUESTED
// boundary (so gaps can't deadlock acks) and through_seq =
// read_through_seq (only what this page actually showed). POST
// /v1/topics/:tid/ack verifies the receipt before advancing read state.
async function handleHistory(
  db: DbClient,
  env: Env,
  req: Request,
  auth: AuthContext,
  tid: string,
): Promise<Response> {
  const { history_from_seq } = await requireParticipant(db, auth, tid);
  const url = new URL(req.url);
  const after = parseSeqCursor(url.searchParams.get('after_seq'));
  const limit = parseLimit(url.searchParams.get('limit'), 100, 500);
  const context = parseLimit(url.searchParams.get('context'), 10, 50);
  const rows = await db.queryAll(
    `SELECT * FROM entries
      WHERE topic_id = ? AND seq > ? AND seq >= ?
      ORDER BY seq ASC LIMIT ?`,
    [tid, after, history_from_seq, limit],
  );
  const ctxRows = await db.queryAll(
    `SELECT * FROM entries
      WHERE topic_id = ? AND seq <= ? AND seq >= ?
      ORDER BY seq DESC LIMIT ?`,
    [tid, after, history_from_seq, context],
  );
  ctxRows.reverse();
  const entries = [
    ...ctxRows.map((r) => ({ ...publicEntry(r), is_context: true })),
    ...rows.map((r) => ({ ...publicEntry(r), is_context: false })),
  ];
  const maxRow = await db.queryOne(`SELECT MAX(seq) AS m FROM entries WHERE topic_id = ?`, [tid]);
  const fromSeq = Math.max(after, history_from_seq - 1) + 1;
  const readThroughSeq =
    rows.length > 0 ? (rows[rows.length - 1]['seq'] as number) : fromSeq - 1;
  const readReceipt = await issueReadReceipt(
    env,
    auth.member_id,
    auth.agent_label,
    tid,
    fromSeq,
    readThroughSeq,
  );
  logEvent('info', 'topic_history', {
    endpoint: 'history',
    member_id: auth.member_id,
    agent_label: auth.agent_label,
    topic_id: tid,
    returned: rows.length,
    context: ctxRows.length,
    read_through_seq: readThroughSeq,
  });
  return json({
    entries,
    max_seq: (maxRow?.['m'] as number | null) ?? 0,
    read_through_seq: readThroughSeq,
    read_receipt: readReceipt,
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
  // Sync v2: a from_join member must never receive the current epoch key
  // (it would decrypt pre-join content), so on E2EE topics the accept sets
  // rotation_required = 1 in the SAME transaction. They stay key-pending
  // until the owner rekeys, then receive only the new epoch key. The CLI
  // seals envelopes (the server never does) — the flag + write gate is the
  // server's whole interface here.
  if (historyFrom === 'from_join' && added.length > 0 && (topic['e2ee'] as number) === 1) {
    ops.push({
      sql: `UPDATE topics SET rotation_required = 1 WHERE id = ?`,
      params: [tid] as (string | number | null)[],
    });
    logEvent('info', 'rotation_required_set', { reason: 'from_join_accept' });
  }
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
  const { topic } = await requireParticipant(db, auth, tid);
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
  // Sync v2: on E2EE topics, member removal gates future encrypted writes —
  // the removed member must not read anything written after their removal.
  // The flag is set in the SAME transaction as the removal and is cleared
  // by a successful keys/commit (Server-A). The CLI seals the new epoch's
  // envelopes (the server never seals); the write gate in handlePostEntry
  // reads this flag.
  const removalE2ee = (topic['e2ee'] as number) === 1;
  await db.execAtomically([
    {
      sql: `DELETE FROM topic_participants WHERE topic_id = ? AND member_id = ?`,
      params: [tid, mid],
    },
    ...(removalE2ee
      ? [{ sql: `UPDATE topics SET rotation_required = 1 WHERE id = ?`, params: [tid] as (string | number | null)[] }]
      : []),
  ]);
  if (removalE2ee) {
    logEvent('info', 'rotation_required_set', { reason: 'member_removed' });
  }
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
  // N05: the briefing is copied into the child topic as content — when the
  // parent is E2EE it must arrive sealed. Well-formed fh1 is opaque, so it
  // skips the PII scan (the CLI scans plaintext before encrypting).
  if ((parent['e2ee'] as number) === 1) {
    requireE2eeContent(briefing, 'briefing');
  } else {
    piiGuard(briefing);
  }
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
  const { topic } = await requireParticipant(db, auth, tid);
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
  const e2ee = (topic['e2ee'] as number) === 1;
  const protocol = isProtocolKind(kind);
  // N05: on E2EE topics, content writes must be sealed. Protocol kinds skip
  // the fh1 requirement (plaintext by design).
  if (e2ee && !protocol) {
    requireE2eeContent(text, 'body');
    requireE2eeData(data, 'data');
  }
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
  // Sealed data (a JSON string holding an fh1 wire body) is opaque like a
  // ciphertext body and skips the scan under the same rule.
  if (data) {
    const parsedData = JSON.parse(data);
    if (!(typeof parsedData === 'string' && isE2eeWireBody(parsedData))) {
      piiGuardJson(parsedData);
    }
  }

  // R1: extract msg_id from fh1 bodies at POST time. Plaintext bodies have
  // no msg_id. The unique index turns a replayed ciphertext into either an
  // idempotent success (same body) or 409 msg_id_conflict (same id, new
  // body).
  const fh1 = parseFh1Header(text);
  const msgId = fh1 ? fh1.msgId : null;
  if (msgId !== null) {
    const dup = await db.queryOne(
      `SELECT * FROM entries WHERE topic_id = ? AND msg_id = ?`,
      [tid, msgId],
    );
    if (dup) return resolveMsgIdConflict(dup, text);
  }
  // Write-time key checks (spec §1.5): server-side, independent of client
  // version. Apply to encrypted content writes on E2EE topics — protocol
  // kinds are plaintext by design and skip these gates too.
  if (e2ee && !protocol && fh1) {
    checkE2eeWriteKey(topic, fh1.keyId);
  }

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
    entryInsertOp({ topicId: tid, kind, body: text, auth, data, ts, replyToSeq: replyTo, msgId }),
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
  try {
    await execBatchWithRetry(db, () => ops);
  } catch (e) {
    // R1 race window: a concurrent POST committed the same msg_id between
    // our pre-check and this insert. Resolve against the conflicting row
    // rather than surfacing a 500.
    if (msgId !== null && isUniqueViolation(e)) {
      const dup = await db.queryOne(
        `SELECT * FROM entries WHERE topic_id = ? AND msg_id = ?`,
        [tid, msgId],
      );
      if (dup) return resolveMsgIdConflict(dup, text);
    }
    throw e;
  }
  // ts is generated per request, so (topic_id, ts) identifies the new row.
  const entry = await db.queryOne(
    `SELECT * FROM entries WHERE topic_id = ? AND ts = ? ORDER BY seq DESC LIMIT 1`,
    [tid, ts],
  );
  if (!entry) throw new HttpError(500, 'internal', 'Failed to read back inserted entry');
  return json({ entry: publicEntry(entry) }, 201);
}

// R1 conflict resolution: a second POST carrying the same (topic_id, msg_id)
// is a retried write when the stored body is byte-identical — return the
// existing entry as a successful idempotent retry. A different body under
// the same msg_id is a genuine conflict -> 409 msg_id_conflict.
function resolveMsgIdConflict(existing: Row, incomingBody: string): Response {
  if ((existing['body'] as string) === incomingBody) {
    logEvent('info', 'msg_id_replay', { outcome: 'idempotent_retry' });
    return json({ entry: publicEntry(existing), deduped: true });
  }
  logEvent('warn', 'msg_id_conflict', { outcome: 'conflict' });
  throw new HttpError(
    409,
    'msg_id_conflict',
    'An entry with this message id already exists with different content',
  );
}

// ---------------------------------------------------------------------------
// Sync v2 (spec §1.3, §1.4).
// ---------------------------------------------------------------------------

/** Opaque page token: base64url(JSON {o: offset}). btoa/atob (not Buffer)
 *  so this runs in the Worker runtime too; the payload is ASCII-only. */
function encodePageToken(offset: number): string {
  return btoa(JSON.stringify({ o: offset }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function decodePageToken(v: string | null): number {
  if (v === null || v === undefined || v === '') return 0;
  try {
    const b64 = v.replace(/-/g, '+').replace(/_/g, '/');
    const parsed: unknown = JSON.parse(atob(b64));
    const o = (parsed as { o?: unknown } | null)?.o;
    if (typeof o === 'number' && Number.isInteger(o) && o >= 0) return o;
  } catch {
    /* fall through to 400 */
  }
  throw new HttpError(400, 'bad_request', 'page_token is invalid');
}

/**
 * GET /v1/sync/topics — changed-topic discovery, ONE call per circle token
 * (spec §1.3: the Bearer <redacted> exactly one (member_id, family_id); the
 * server never crosses family boundaries, so there is no cross-circle sync).
 *
 * Changed = the topic has a VISIBLE entry (seq >= the caller's
 * history_from_seq) with seq > max(acked_seq, history_from_seq - 1), where
 * a missing read-state row counts as acked_seq 0 (all visible unread).
 *
 * Params: `bootstrap_gseq` (first call only), `limit`, `page_token`.
 * Bootstrap decision (spec-ambiguous, documented): the first call carries
 * no cursor and is a deliberate full re-read — every visible topic seeds a
 * read-state row with acked_seq 0 and reports as changed once. `bootstrap_gseq`
 * is accepted and validated but NOT used for seeding: the CLI deletes legacy
 * cursor files without reading them, so any value sent would be unreliable;
 * seeding-from-cursor was rejected in favor of the spec's headline behavior.
 *
 * Field decisions (spec-ambiguous, documented):
 * - `acked_seq` is the EFFECTIVE read position
 *   max(stored acked_seq, history_from_seq - 1).
 * - `latest_seq` / `new_count` / `last_activity_ts` / `last_actor` are
 *   computed over VISIBLE entries only (seq >= history_from_seq).
 * - `new_count` excludes the requesting agent's own entries
 *   (actor_member_id + agent_label match) — your own posts never flag a
 *   topic as "changed." Use `hub read` for full history including your own
 *   messages.
 * - `e2ee` is 0/1 (integer), matching the existing topic JSON shape.
 * - `key_status`: 'not_e2ee' for plaintext topics; for E2EE topics 'ok'
 *   when the caller's agent holds an envelope for the committed current
 *   key (current_epoch >= 1), else 'pending' (epoch 0 or no envelope —
 *   use the key-request flow). rotation_required does not change it: the
 *   agent still holds its current key; only writes pause.
 * - `assigned_to_me`: an open/in_progress/blocked task in the topic is
 *   assigned to the caller AND visible to them (F06 history floor).
 * Paging is offset-based over (last_activity_ts DESC, topic_id ASC);
 * changed sets can shift between pages — the CLI dedupes.
 */
async function handleSyncTopics(
  db: DbClient,
  req: Request,
  auth: AuthContext,
): Promise<Response> {
  const url = new URL(req.url);
  // Accepted, validated, intentionally not used for seeding (see above).
  parseSeqCursor(url.searchParams.get('bootstrap_gseq'));
  const limit = parseLimit(url.searchParams.get('limit'), 50, 200);
  const offset = decodePageToken(url.searchParams.get('page_token'));

  const rows = await db.queryAll(
    `SELECT t.id AS topic_id, t.family_id AS circle_id, f.name AS circle_name,
            t.subject, t.kind, t.e2ee,
            t.current_epoch, t.current_key_id, t.rotation_required,
            p.history_from_seq,
            COALESCE(rs.acked_seq, 0) AS acked_seq,
            (SELECT MAX(e.seq) FROM entries e
              WHERE e.topic_id = t.id AND e.seq >= p.history_from_seq) AS latest_seq,
            (SELECT COUNT(*) FROM entries e
              WHERE e.topic_id = t.id AND e.seq >= p.history_from_seq
                AND e.seq > MAX(COALESCE(rs.acked_seq, 0), p.history_from_seq - 1)
                AND NOT (e.actor_member_id = ? AND e.agent_label = ?)) AS new_count,
            (SELECT e.ts FROM entries e
              WHERE e.topic_id = t.id AND e.seq >= p.history_from_seq
              ORDER BY e.seq DESC LIMIT 1) AS last_activity_ts,
            (SELECT e.actor_member_id FROM entries e
              WHERE e.topic_id = t.id AND e.seq >= p.history_from_seq
              ORDER BY e.seq DESC LIMIT 1) AS last_actor
       FROM topics t
       JOIN topic_participants p ON p.topic_id = t.id AND p.member_id = ?
       JOIN families f ON f.id = t.family_id
       LEFT JOIN topic_read_state rs
         ON rs.topic_id = t.id AND rs.member_id = ? AND rs.agent_label = ?
      WHERE t.family_id = ?`,
    // Params in TEXTUAL ? order: new_count subquery (actor_member_id,
    // agent_label) comes before the JOIN conditions in the SQL string.
    [auth.member_id, auth.agent_label, auth.member_id, auth.member_id, auth.agent_label, auth.family_id],
  );

  const changed = rows.filter((r) => (r['new_count'] as number) > 0);
  const topicIds = rows.map((r) => r['topic_id'] as string);

  // Seed read-state rows (acked 0) for every visible topic lacking one —
  // this is the bootstrap full re-read; later joins only add rows.
  const ts = nowIso();
  if (topicIds.length > 0) {
    await db.execAtomically(
      topicIds.map((topicId) => ({
        sql: `INSERT INTO topic_read_state(member_id, agent_label, topic_id, acked_seq, updated_at)
              SELECT ?,?,?,0,?
               WHERE NOT EXISTS (
                 SELECT 1 FROM topic_read_state
                  WHERE member_id = ? AND agent_label = ? AND topic_id = ?)`,
        params: [auth.member_id, auth.agent_label, topicId, ts, auth.member_id, auth.agent_label, topicId],
      })),
    );
  }

  // key_status: caller's agents holding an envelope for the committed
  // current key.
  let okTopics = new Set<string>();
  if (topicIds.length > 0) {
    const placeholders = topicIds.map(() => '?').join(',');
    const okRows = await db.queryAll(
      `SELECT e.topic_id FROM topic_key_envelopes e
         JOIN topics t ON t.id = e.topic_id
        WHERE e.member_id = ? AND e.agent_label = ?
          AND t.current_epoch >= 1 AND e.key_id = t.current_key_id
          AND e.topic_id IN (${placeholders})`,
      [auth.member_id, auth.agent_label, ...topicIds],
    );
    okTopics = new Set(okRows.map((r) => r['topic_id'] as string));
  }

  // assigned_to_me: open task assigned to the caller and visible to them.
  let assignedTopics = new Set<string>();
  if (topicIds.length > 0) {
    const placeholders = topicIds.map(() => '?').join(',');
    const aRows = await db.queryAll(
      `SELECT DISTINCT topic_id FROM tasks
        WHERE assignee_member_id = ?
          AND status NOT IN ('done','cancelled')
          AND ${TASK_VISIBLE_TO_MEMBER}
          AND topic_id IN (${placeholders})`,
      [auth.member_id, auth.member_id, ...topicIds],
    );
    assignedTopics = new Set(aRows.map((r) => r['topic_id'] as string));
  }

  const topics = changed.map((r) => {
    const e2ee = r['e2ee'] as number;
    const topicId = r['topic_id'] as string;
    const keyStatus = e2ee !== 1 ? 'not_e2ee' : okTopics.has(topicId) ? 'ok' : 'pending';
    const effectiveAcked = Math.max(r['acked_seq'] as number, (r['history_from_seq'] as number) - 1);
    return {
      topic_id: topicId,
      circle_id: r['circle_id'],
      circle_name: r['circle_name'],
      subject: r['subject'],
      kind: r['kind'],
      e2ee,
      acked_seq: effectiveAcked,
      latest_seq: r['latest_seq'],
      new_count: r['new_count'],
      last_activity_ts: r['last_activity_ts'],
      last_actor: r['last_actor'],
      key_status: keyStatus,
      assigned_to_me: assignedTopics.has(topicId),
    };
  });
  topics.sort((a, b) => {
    const ta = (a['last_activity_ts'] as string | null) ?? '';
    const tb = (b['last_activity_ts'] as string | null) ?? '';
    if (ta !== tb) return tb < ta ? -1 : 1;
    return (a['topic_id'] as string) < (b['topic_id'] as string) ? -1 : 1;
  });

  const page = topics.slice(offset, offset + limit);
  const hasMore = offset + limit < topics.length;
  logEvent('info', 'sync_topics', {
    endpoint: 'sync/topics',
    member_id: auth.member_id,
    agent_label: auth.agent_label,
    family_id: auth.family_id,
    changed: topics.length,
    returned: page.length,
    has_more: hasMore,
  });
  return json({
    topics: page,
    has_more: hasMore,
    next_page_token: hasMore ? encodePageToken(offset + limit) : null,
    // Update advertisement (decoupled releases): the client compares these
    // against its installed CLI + skill versions on `hub sync` and nudges
    // the agent to run `hub upgrade` when either is newer. Additive — old
    // clients ignore it.
    versions: {
      server: SERVER_VERSION,
      cli: clientManifest.version,
      skill: clientManifest.skill_version,
    },
  });
}

/**
 * POST /v1/topics/:tid/ack — receipt-bound, contiguous ack (spec §1.4).
 * Body { seq, read_receipt }, both required.
 *
 * 1. HMAC-verify the receipt; it must bind THIS
 *    (member_id, agent_label, topic_id) — cross-agent replay fails here.
 * 2. effective = max(acked_seq, history_from_seq - 1).
 * 3. seq <= effective → no-op success (idempotent).
 * 4. Else require from_seq <= effective + 1 AND seq <= through_seq,
 *    else 409 noncontiguous_ack (the client must read+ack pages in order).
 * 5. Atomic max() upsert of read state.
 */
async function handleAck(
  db: DbClient,
  env: Env,
  req: Request,
  auth: AuthContext,
  tid: string,
): Promise<Response> {
  const { history_from_seq } = await requireParticipant(db, auth, tid);
  const body = await readJson(req);
  const seqRaw = body['seq'];
  if (typeof seqRaw !== 'number' || !Number.isInteger(seqRaw) || seqRaw < 0) {
    throw new HttpError(400, 'bad_request', 'seq must be a non-negative integer');
  }
  const seq = seqRaw;
  const receiptRaw = body['read_receipt'];
  if (typeof receiptRaw !== 'string' || receiptRaw.length === 0 || receiptRaw.length > 512) {
    throw new HttpError(400, 'bad_request', 'read_receipt is required');
  }
  const { from_seq, through_seq } = await verifyReadReceipt(
    env,
    receiptRaw,
    auth.member_id,
    auth.agent_label,
    tid,
  );
  const state = await db.queryOne(
    `SELECT acked_seq FROM topic_read_state
      WHERE member_id = ? AND agent_label = ? AND topic_id = ?`,
    [auth.member_id, auth.agent_label, tid],
  );
  const acked = state ? (state['acked_seq'] as number) : 0;
  const effective = Math.max(acked, history_from_seq - 1);
  if (seq <= effective) {
    logEvent('info', 'topic_ack', {
      endpoint: 'ack',
      member_id: auth.member_id,
      agent_label: auth.agent_label,
      topic_id: tid,
      outcome: 'noop',
      acked_seq: effective,
    });
    return json({ topic_id: tid, acked_seq: effective });
  }
  if (from_seq > effective + 1 || seq > through_seq) {
    logEvent('warn', 'topic_ack', {
      endpoint: 'ack',
      member_id: auth.member_id,
      agent_label: auth.agent_label,
      topic_id: tid,
      outcome: 'rejected',
      code: 'noncontiguous_ack',
    });
    throw new HttpError(
      409,
      'noncontiguous_ack',
      'Ack is not contiguous with read state: read the topic in order (from_seq must be <= acked+1) and ack only seqs covered by the receipt (seq <= through_seq)',
    );
  }
  // Atomic max(): concurrent acks can never move the cursor backwards.
  const ts = nowIso();
  await db.execAtomically([
    {
      sql: `INSERT INTO topic_read_state(member_id, agent_label, topic_id, acked_seq, updated_at)
            VALUES (?,?,?,?,?)
            ON CONFLICT(member_id, agent_label, topic_id)
            DO UPDATE SET acked_seq = max(topic_read_state.acked_seq, excluded.acked_seq),
                          updated_at = excluded.updated_at`,
      params: [auth.member_id, auth.agent_label, tid, seq, ts],
    },
  ]);
  logEvent('info', 'topic_ack', {
    endpoint: 'ack',
    member_id: auth.member_id,
    agent_label: auth.agent_label,
    topic_id: tid,
    outcome: 'advanced',
    acked_seq: seq,
  });
  return json({ topic_id: tid, acked_seq: seq });
}

/**
 * Map a keys/commit write-conflict (UNIQUE/PK backstop fired by a
 * concurrent commit that won the race between our pre-checks and the
 * atomic batch) to the spec's 409 codes. SQLite/D1 constraint messages
 * name the offending columns; the mapping is deliberately narrow so an
 * unexpected constraint still surfaces as stale_epoch (retry-safe).
 */
function commitConflictError(e: unknown): HttpError {
  const msg = e instanceof Error ? e.message : String(e);
  if (/commitment/i.test(msg)) {
    return new HttpError(
      409,
      'key_material_reuse',
      'Identical key material was committed under a different key_id (concurrent commit won)',
    );
  }
  if (/key_id/i.test(msg)) {
    return new HttpError(
      409,
      'key_reuse',
      'key_id was already used for this topic (concurrent commit won)',
    );
  }
  return new HttpError(
    409,
    'stale_epoch',
    'A concurrent key commit won the race; re-read the topic and retry',
  );
}

function agentPairKey(memberId: string, agentLabel: string): string {
  return memberId + '\n' + agentLabel;
}

function splitAgentPairKey(k: string): [string, string] {
  const i = k.indexOf('\n');
  return [k.slice(0, i), k.slice(i + 1)];
}

/**
 * POST /v1/topics/:tid/keys/commit — staged atomic key activation
 * (spec §1.4). Handles GENESIS (expected_epoch 1, topic at epoch 0) and
 * ROTATION (expected_epoch = current_epoch + 1).
 * Body { expected_epoch, key_id, commitment, force }. Owner/parent only.
 *
 * Single transaction: epoch+1 check (409 stale_epoch), key_id unused
 * (409 key_reuse), commitment 64-hex and unused (409 key_material_reuse),
 * then the set-equality of STAGED vs CURRENT agents:
 *   staged = agents with an envelope row for key_id sealed to their
 *            CURRENTLY-ACTIVE identity key (envelope.identity_key_id must
 *            match the agent's active agent_keys row);
 *   current = LIVE agents of current participant members — distinct
 *            (member_id, agent_label) from non-revoked agent_tokens.
 *            (Decision: revoked agents cannot fetch envelopes, so they do
 *            not gate completeness; keyless-but-live agents DO, via force.)
 *   - staged − current ≠ ∅ → 409 recipients_removed_key_burned {removed}:
 *     the removed party saw this key material, so the server deletes its
 *     staged rows and the client MUST generate fresh key material and
 *     restart — resealing is insufficient. force cannot override.
 *   - an agent WITH an active identity key but no staged envelope for it
 *     (missing row, or sealed to a superseded key) → 409
 *     superseded_identity_key {agents}: not force-overridable, the owner
 *     must (re-)seal to the active key.
 *   - an agent with NO active identity key at all → 409
 *     incomplete_distribution {missing}; force (OWNER-only) may commit —
 *     the only case force covers. The epoch row records forced=1 +
 *     forced_missing; those agents get key_status pending and use the
 *     key-request flow.
 *   - equal → commit: INSERT the epoch row (recipients = staged set) and
 *     CAS-update topics (current_key_id, current_epoch, clear
 *     rotation_required) in ONE atomic batch. The epoch PK plus the
 *     key_id/commitment UNIQUEs are the race backstops: a concurrent
 *     commit that wins surfaces as a constraint error, mapped to 409.
 */
async function handleKeysCommit(
  db: DbClient,
  _env: Env,
  req: Request,
  auth: AuthContext,
  tid: string,
): Promise<Response> {
  const { topic } = await requireParticipant(db, auth, tid);
  if ((topic['e2ee'] as number) !== 1) {
    throw new HttpError(400, 'bad_request', 'keys/commit is only valid for E2EE topics');
  }
  if (auth.role !== 'owner' && auth.role !== 'parent') {
    throw new HttpError(403, 'forbidden', 'Only an owner or parent may commit a topic key');
  }
  const body = await readJson(req);
  const expectedRaw = body['expected_epoch'];
  if (typeof expectedRaw !== 'number' || !Number.isInteger(expectedRaw) || expectedRaw < 1) {
    throw new HttpError(400, 'bad_request', 'expected_epoch must be a positive integer');
  }
  const expectedEpoch = expectedRaw;
  const keyId = reqKeyId(body['key_id'], 'key_id');
  const commitmentRaw = body['commitment'];
  if (typeof commitmentRaw !== 'string' || !/^[0-9a-fA-F]{64}$/.test(commitmentRaw)) {
    throw new HttpError(
      400,
      'bad_request',
      'commitment must be 64 hex chars (SHA256 of the topic key)',
    );
  }
  const commitment = commitmentRaw.toLowerCase();
  const forceRaw = body['force'];
  if (forceRaw !== undefined && forceRaw !== true && forceRaw !== false) {
    throw new HttpError(400, 'bad_request', 'force must be a boolean');
  }
  const force = forceRaw === true;
  // force is owner-only even though plain commits allow parents.
  if (force && auth.role !== 'owner') {
    throw new HttpError(403, 'forbidden', 'Only an owner may force-commit a topic key');
  }

  const currentEpoch = (topic['current_epoch'] as number | null) ?? 0;
  if (expectedEpoch !== currentEpoch + 1) {
    logEvent('warn', 'key_commit_rejected', {
      endpoint: 'keys/commit',
      member_id: auth.member_id,
      agent_label: auth.agent_label,
      topic_id: tid,
      code: 'stale_epoch',
    });
    throw new HttpError(
      409,
      'stale_epoch',
      `expected_epoch ${expectedEpoch} does not follow the topic's current epoch ${currentEpoch}`,
    );
  }
  // Pre-checks; the UNIQUE backstops below catch races (mapped to 409).
  const usedKey = await db.queryOne(
    `SELECT 1 FROM topic_key_epochs WHERE topic_id = ? AND key_id = ?`,
    [tid, keyId],
  );
  if (usedKey) {
    logEvent('warn', 'key_commit_rejected', {
      endpoint: 'keys/commit',
      member_id: auth.member_id,
      agent_label: auth.agent_label,
      topic_id: tid,
      code: 'key_reuse',
    });
    throw new HttpError(
      409,
      'key_reuse',
      'key_id was already used for this topic — generate fresh key material',
    );
  }
  const usedCommitment = await db.queryOne(
    `SELECT 1 FROM topic_key_epochs WHERE topic_id = ? AND commitment = ?`,
    [tid, commitment],
  );
  if (usedCommitment) {
    logEvent('warn', 'key_commit_rejected', {
      endpoint: 'keys/commit',
      member_id: auth.member_id,
      agent_label: auth.agent_label,
      topic_id: tid,
      code: 'key_material_reuse',
    });
    throw new HttpError(
      409,
      'key_material_reuse',
      'Identical key material was already committed under a different key_id',
    );
  }

  // staged: envelope rows for key_id sealed to the agent's currently-active
  // identity key. Envelopes sealed to superseded keys (or to agents whose
  // member has since left the topic — their key rows are never deleted)
  // simply do not appear here.
  const stagedRows = await db.queryAll(
    `SELECT e.member_id, e.agent_label FROM topic_key_envelopes e
       JOIN agent_keys k ON k.id = e.identity_key_id
      WHERE e.topic_id = ? AND e.key_id = ?
        AND k.member_id = e.member_id AND k.agent_label = e.agent_label
        AND k.superseded_at IS NULL`,
    [tid, keyId],
  );
  const staged = new Set(
    stagedRows.map((r) => agentPairKey(r['member_id'] as string, r['agent_label'] as string)),
  );
  // current: live agents of current participant members.
  const currentRows = await db.queryAll(
    `SELECT DISTINCT t.member_id, t.agent_label
       FROM agent_tokens t
       JOIN topic_participants p ON p.member_id = t.member_id
      WHERE p.topic_id = ? AND t.revoked_at IS NULL`,
    [tid],
  );
  const current = new Set(
    currentRows.map((r) => agentPairKey(r['member_id'] as string, r['agent_label'] as string)),
  );
  const activeRows = await db.queryAll(
    `SELECT member_id, agent_label FROM agent_keys WHERE superseded_at IS NULL`,
  );
  const activeSet = new Set(
    activeRows.map((r) => agentPairKey(r['member_id'] as string, r['agent_label'] as string)),
  );

  const removed = [...staged].filter((a) => !current.has(a));
  if (removed.length > 0) {
    // BURN: a removed party is assumed to have seen this key material (their
    // envelope was staged), so the whole key is unusable — delete ALL of
    // its staged rows. The client MUST generate fresh key material and
    // restart: resealing the same key is insufficient. (The server does not
    // keep a separate burn registry — the spec places the fresh-material
    // obligation on the client; a same-key_id recommit would require
    // deliberately re-sealing to the full current set, and the removed
    // member can no longer be sealed to at all: envelope POST targets must
    // be current participants.) force cannot override: committing would
    // hand future messages to the removed party.
    await db.execAtomically([
      {
        sql: `DELETE FROM topic_key_envelopes WHERE topic_id = ? AND key_id = ?`,
        params: [tid, keyId],
      },
    ]);
    const removedPairs = removed.map((a) => {
      const [member_id, agent_label] = splitAgentPairKey(a);
      return { member_id, agent_label };
    });
    logEvent('warn', 'key_commit_rejected', {
      endpoint: 'keys/commit',
      member_id: auth.member_id,
      agent_label: auth.agent_label,
      topic_id: tid,
      code: 'recipients_removed_key_burned',
      removed_count: removedPairs.length,
    });
    throw new HttpError(
      409,
      'recipients_removed_key_burned',
      'Key burned: envelopes were staged for agents who are no longer participants — they saw this key material. The staged rows were deleted; generate fresh key material and restart (resealing is insufficient).',
    );
  }

  const missing = [...current].filter((a) => !staged.has(a));
  const superseded = missing.filter((a) => activeSet.has(a));
  const keyless = missing.filter((a) => !activeSet.has(a));
  if (superseded.length > 0) {
    const agents = superseded.map((a) => {
      const [member_id, agent_label] = splitAgentPairKey(a);
      return { member_id, agent_label };
    });
    logEvent('warn', 'key_commit_rejected', {
      endpoint: 'keys/commit',
      member_id: auth.member_id,
      agent_label: auth.agent_label,
      topic_id: tid,
      code: 'superseded_identity_key',
      agent_count: agents.length,
    });
    throw new HttpError(
      409,
      'superseded_identity_key',
      'Some agents have no envelope sealed to their ACTIVE identity key (missing or sealed to a superseded key). Re-seal to the active key and recommit; force cannot override this.',
    );
  }
  let forced = 0;
  let forcedMissing: string | null = null;
  if (keyless.length > 0) {
    if (!force) {
      const agents = keyless.map((a) => {
        const [member_id, agent_label] = splitAgentPairKey(a);
        return { member_id, agent_label };
      });
      logEvent('warn', 'key_commit_rejected', {
        endpoint: 'keys/commit',
        member_id: auth.member_id,
        agent_label: auth.agent_label,
        topic_id: tid,
        code: 'incomplete_distribution',
        agent_count: agents.length,
      });
      throw new HttpError(
        409,
        'incomplete_distribution',
        'Some current agents have no active identity key and no envelope. Seal the delta and recommit, or retry with force:true (owner only) to commit without them.',
      );
    }
    forced = 1;
    forcedMissing = JSON.stringify(
      keyless.map((a) => {
        const [member_id, agent_label] = splitAgentPairKey(a);
        return [member_id, agent_label];
      }),
    );
  }

  // Single atomic batch: INSERT the epoch row, then CAS-advance the topic
  // (clearing rotation_required). The (topic_id, epoch) PK plus the
  // (topic_id, key_id) / (topic_id, commitment) UNIQUEs are the race
  // backstops — a concurrent commit that wins raises a constraint error,
  // mapped to 409 below.
  const ts = nowIso();
  const recipients = JSON.stringify(
    [...staged].map((a) => {
      const [member_id, agent_label] = splitAgentPairKey(a);
      return [member_id, agent_label];
    }),
  );
  try {
    await db.execAtomically([
      {
        sql: `INSERT INTO topic_key_epochs(
                topic_id, epoch, key_id, commitment, recipients,
                forced, forced_missing, created_at, created_by)
              VALUES (?,?,?,?,?,?,?,?,?)`,
        params: [tid, expectedEpoch, keyId, commitment, recipients, forced, forcedMissing, ts, auth.member_id],
      },
      {
        sql: `UPDATE topics
                 SET current_key_id = ?, current_epoch = ?, rotation_required = 0
               WHERE id = ? AND current_epoch = ?`,
        params: [keyId, expectedEpoch, tid, expectedEpoch - 1],
      },
    ]);
  } catch (e) {
    const mapped = commitConflictError(e);
    logEvent('warn', 'key_commit_rejected', {
      endpoint: 'keys/commit',
      member_id: auth.member_id,
      agent_label: auth.agent_label,
      topic_id: tid,
      code: mapped.code,
    });
    throw mapped;
  }
  // CAS sanity check: execAtomically reports no row counts, so re-read.
  // (The epoch PK makes a silent half-apply impossible — a lost race would
  // have raised above — this is belt-and-braces.)
  const after = await db.queryOne(`SELECT current_epoch, current_key_id FROM topics WHERE id = ?`, [
    tid,
  ]);
  if (after!['current_epoch'] !== expectedEpoch || after!['current_key_id'] !== keyId) {
    throw new HttpError(
      409,
      'stale_epoch',
      'A concurrent key commit won the race; re-read the topic and retry',
    );
  }
  logEvent('info', 'key_epoch_committed', {
    endpoint: 'keys/commit',
    member_id: auth.member_id,
    agent_label: auth.agent_label,
    topic_id: tid,
    epoch: expectedEpoch,
    forced,
  });
  return json({ topic_id: tid, epoch: expectedEpoch, key_id: keyId });
}

// POST /v1/topics/:tid/tasks
async function handleCreateTask(
  db: DbClient,
  _env: Env,
  req: Request,
  auth: AuthContext,
  tid: string,
): Promise<Response> {
  const { topic } = await requireParticipant(db, auth, tid);
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
  const taskE2ee = (topic['e2ee'] as number) === 1;
  if (taskE2ee) {
    // N05: task content fields must arrive sealed; only indexing metadata
    // stays plaintext. Well-formed fh1 is opaque — skip the PII scan (the
    // CLI scans plaintext before encrypting).
    requireE2eeContent(title, 'title');
    if (description !== null) requireE2eeContent(description, 'description');
  } else {
    if (description) piiGuard(description);
    piiGuard(title); // F08: task titles are scanned too.
  }

  const taskId = newId();
  const ts = nowIso();
  // F13: task_created carries the full task fields, so the log can
  // reconstruct task state. The F06 visibility predicate reads task_id out
  // of this same payload — it must stay.
  //
  // N05 (E2EE topics): the old `Task created: ${title}` body leaked the
  // title into the entry log. The entry body is now the sealed title as
  // posted (already fh1), and data collapses to
  // {"task_id": "…", "sealed": "fh1…"} with task_id plaintext so the F06
  // json_extract predicate keeps working. `sealed` carries the sealed
  // description (the primary content); when the task has no description it
  // carries the sealed title. Indexing metadata (status, owner/assignee
  // ids, parent_task_id, due_at) stays plaintext on the tasks row itself.
  const createdData = taskE2ee
    ? JSON.stringify({ task_id: taskId, sealed: description ?? title })
    : JSON.stringify({
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
      // N05: plaintext `Task created: ${title}` leaked the title; in E2EE
      // topics the body is the sealed title as posted.
      body: taskE2ee ? title : `Task created: ${title}`,
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
  // N05: note bodies on E2EE topics must arrive sealed. Well-formed fh1 is
  // opaque — skip the PII scan (the CLI scans plaintext before encrypting).
  if ((await topicE2ee(db, task['topic_id'] as string))) {
    requireE2eeContent(text, 'body');
  } else {
    piiGuard(text);
  }
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
  // N05 (E2EE topics): the completion result is user content — it must arrive
  // sealed (fh1), mirroring the task title/description contract. Plaintext
  // topics keep the legacy JSON result shape.
  const topicRow = await db.queryOne(`SELECT e2ee FROM topics WHERE id = ?`, [topicId]);
  const doneE2ee = (topicRow?.['e2ee'] as number) === 1;
  const rawResult = body['result'];
  let result: string | null;
  if (doneE2ee) {
    if (rawResult === undefined || rawResult === null) {
      result = null;
    } else {
      requireE2eeContent(rawResult, 'result');
      result = rawResult as string;
    }
  } else {
    result = reqJsonData(rawResult, 'result', MAX_DATA);
    // F08: completion results (JSON) are scanned too — string leaves, recursively.
    // Sealed (fh1) results are opaque — the CLI scans plaintext before encrypting.
    if (result) piiGuardJson(JSON.parse(result));
  }
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
      // N05: on E2EE topics the sealed result rides in `sealed` (mirroring
      // task_created); task_id stays plaintext for the F06 visibility
      // predicate. Plaintext topics keep the legacy embedded result shape.
      data: doneE2ee
        ? JSON.stringify({ task_id: taskId, sealed: result })
        : JSON.stringify({ task_id: taskId, result: result ? JSON.parse(result) : null }),
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
    // API-major prefix dispatch (spec §3.3): /v1/... handlers are registered
    // below. When a breaking change graduates to /v2, a parallel v2 block
    // goes here; until then an unknown API major 404s like any unknown path.
    const apiMajor = apiMajorOf(path);
    if (apiMajor === 'v2') {
      throw new HttpError(404, 'not_found', 'Not found');
    }

    // B1: client version gate on API requests. Exempt: /v1/health,
    // /v1/client/latest, and /v1/client/download/* — an outdated client must
    // always reach liveness checks, the upgrade metadata, and the
    // replacement artifacts it needs in order to update.
    if (path.startsWith('/v1/') && !isGateExempt(path)) {
      gateClientVersion(req, env);
    }

    // Public: web UI + health.
    if (path === '/' && method === 'GET') {
      return new Response(UI_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    if (path === '/v1/health' && method === 'GET') return await handleHealth();
    if (path === '/v1/client/latest' && method === 'GET') return await handleClientLatest(req);
    // §3.4: public CLI artifact downloads. Exact paths only — no path
    // parameters, so no traversal surface by construction. Anything else
    // under /v1/client/download/ falls through to the 404 below.
    if (path === '/v1/client/download/hub' && method === 'GET')
      return await handleClientDownload(db, req, 'hub');
    if (path === '/v1/client/download/hub.sigstore' && method === 'GET')
      return await handleClientDownload(db, req, 'sigstore');
    if (path === '/v1/client/download/manifest.json' && method === 'GET')
      return await handleClientDownload(db, req, 'manifest');
    if (path === '/v1/client/download/skill.tar.gz' && method === 'GET')
      return await handleClientDownload(db, req, 'skill');
    // Anything else under /v1/client/download/ is not an asset: 404, like
    // the unmatched /i/ shapes. (Public either way — no auth needed to learn
    // the asset map is fixed.)
    if (path === '/v1/client/download' || path.startsWith('/v1/client/download/')) {
      throw new HttpError(404, 'not_found', 'Not found');
    }

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

    // Public: invite onboarding pages (v0.11.0). The page token is the
    // credential, so these sit before the Bearer choke point. /i/ is not
    // under /v1/, so the client version gate above does not apply.
    // Unmatched /i/ shapes serve the same identical 404 as
    // unknown/used/expired pages.
    const inviteVerify = /^\/i\/(.+)\/verify$/.exec(path);
    if (inviteVerify && method === 'POST') {
      return await handleInvitePageVerify(db, env, req, inviteVerify[1]);
    }
    if (path.startsWith('/i/') && method === 'GET') {
      return await handleInvitePageGet(db, env, req, path.slice('/i/'.length));
    }
    if (path === '/i' || path.startsWith('/i/')) {
      throw new HttpError(404, 'not_found', 'Not found');
    }

    // Everything below requires a bearer token (the choke point).
    const authHeader = req.headers.get('authorization');
    const auth: AuthContext = await resolveToken(db, env, authHeader);

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
    // Sync v2 (spec §1.4): per-circle-token changed-topic discovery.
    // (Legacy entry-level GET /v1/sync deleted per spec §1.6.)
    if (path === '/v1/sync/topics' && method === 'GET') return await handleSyncTopics(db, req, auth);

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

    const topicSub = /^\/v1\/topics\/([^/]+)\/(history|invite|spawn|entries|tasks|envelopes|subject|ack)$/.exec(path);
    if (topicSub && method === 'GET' && topicSub[2] === 'history') {
      return await handleHistory(db, env, req, auth, decodeURIComponent(topicSub[1]));
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

    // Sync v2 (spec §1.4) — receipt-bound contiguous ack.
    if (topicSub && method === 'POST' && topicSub[2] === 'ack') {
      return await handleAck(db, env, req, auth, decodeURIComponent(topicSub[1]));
    }
    // E2EE (sync v2, spec §1.4) — POST /v1/topics/:tid/keys/commit:
    // staged atomic key activation (genesis + rotation).
    const topicKeysCommit = /^\/v1\/topics\/([^/]+)\/keys\/commit$/.exec(path);
    if (topicKeysCommit && method === 'POST') {
      return await handleKeysCommit(db, env, req, auth, decodeURIComponent(topicKeysCommit[1]));
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

    // Sync v2 §1.6: GET/PATCH /v1/tasks/:tid are deleted (no client; the CLI
    // uses notes/done). Only the notes and done sub-paths remain.
    const taskSub = /^\/v1\/tasks\/([^/]+)\/(notes|done)$/.exec(path);
    if (taskSub) {
      const taskId = decodeURIComponent(taskSub[1]);
      if (taskSub[2] === 'notes' && method === 'POST') {
        return await handleTaskNote(db, env, req, auth, taskId);
      }
      if (taskSub[2] === 'done' && method === 'POST') {
        return await handleTaskDone(db, env, req, auth, taskId);
      }
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
