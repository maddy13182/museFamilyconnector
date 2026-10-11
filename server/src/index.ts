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
import { scanPii } from './pii.js';
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

// Idempotency for create operations (family/topic/invite). Entries use the
// separate idempotency_keys table; creates use create_idempotency, which also
// remembers the provisioning code so a deduped retry can mint a fresh one
// and revoke the orphaned token from the first attempt.
type CreateScope = 'family' | 'topic' | 'invite';

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
function newId(): string {
  return crypto.randomUUID();
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
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
  const ts = nowIso();
  const code = newProvisioningCode();
  const codeHash = await credentialHash(env.TOKEN_PEPPER, code);
  const provisionExpiresAt = hoursFromNow(PROVISION_TTL_HOURS);
  try {
    await db.execAtomically([
      { sql: `INSERT INTO families(id, name, created_at) VALUES (?,?,?)`, params: [familyId, name, ts] },
      {
        sql: `INSERT INTO members(id, family_id, name, email, role, created_at) VALUES (?,?,?,?,?,?)`,
        params: [memberId, familyId, ownerName, ownerEmail, 'owner', ts],
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
  return json(
    {
      family: { id: familyId, name, created_at: ts },
      member: { id: memberId, name: ownerName, email: ownerEmail, role: 'owner', created_at: ts },
      provisioning_code: code,
      provisioning_expires_at: hoursFromNow(PROVISION_TTL_HOURS),
    },
    201,
  );
}

/**
 * True when the caller is a hub owner: holds the 'owner' role in at least
 * one family. Identity is matched by email, since one human has one member
 * row per family but a single email across them.
 */
async function isHubOwner(db: DbClient, auth: AuthContext): Promise<boolean> {
  if (auth.role === 'owner') return true;
  const me = await db.queryOne(`SELECT email FROM members WHERE id = ?`, [auth.member_id]);
  if (!me) return false;
  const row = await db.queryOne(
    `SELECT 1 FROM members WHERE email = ? AND role = 'owner' LIMIT 1`,
    [me['email'] as string],
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
      sql: `INSERT INTO members(id, family_id, name, email, role, created_at) VALUES (?,?,?,?,?,?)`,
      params: [memberId, familyId, creatorName, creatorEmail, 'owner', ts],
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
    `SELECT * FROM members WHERE family_id = ? AND email = (SELECT email FROM members WHERE id = ?)`,
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

// GET /v1/families — list families the caller is a member of (v0.2.0+).
// Membership is matched by email: one human, one member row per family.
async function handleListFamilies(db: DbClient, auth: AuthContext): Promise<Response> {
  const me = await db.queryOne(`SELECT email FROM members WHERE id = ?`, [auth.member_id]);
  if (!me) throw new HttpError(401, 'unauthorized', 'Unknown token');
  const rows = await db.queryAll(
    `SELECT f.id, f.name, f.kind, f.created_at, m.role AS my_role
       FROM families f
       JOIN members m ON m.family_id = f.id
      WHERE m.email = ?
      ORDER BY f.created_at ASC`,
    [me['email'] as string],
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
  await db.execAtomically([
    {
      sql: `INSERT INTO members(id, family_id, name, email, role, created_at)
            SELECT ?,?,?,?,?,?
             WHERE EXISTS (SELECT 1 FROM invites WHERE code_hash = ? AND used_at IS NULL)`,
      params: [memberId, inviteFamilyId, displayName, email, inviteRole, ts, codeHash],
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
  return json(
    {
      member: {
        id: memberId,
        name: displayName,
        email,
        role: invite['role'],
        created_at: ts,
      },
      token,
      token_id: tokenId,
    },
    201,
  );
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
  await readJson(req).catch(() => ({})); // body optional/ignored
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
  await db.execAtomically([
    // F04: unconditional — overwrites a future rotation-grace revoked_at.
    { sql: `UPDATE agent_tokens SET revoked_at = ? WHERE token_id = ?`, params: [now, tokenId] },
    // F17: expire pending (unused, unexpired) codes issued under this token.
    // Redeeming them afterwards yields 410 code_expired.
    {
      sql: `UPDATE provisioning_codes SET expires_at = ?
             WHERE issued_by_token_id = ? AND used_at IS NULL AND expires_at > ?`,
      params: [now, tokenId, now],
    },
    // F17: one-level cascade to descendant tokens issued under this token.
    {
      sql: `UPDATE agent_tokens SET revoked_at = ? WHERE issued_by_token_id = ?`,
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
  const subject = reqString(body['subject'], 'subject', 1, 200);
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
      sql: `INSERT INTO topics(id, family_id, subject, kind, parents_only, parent_topic_id, link_visibility, created_by, created_at)
            VALUES (?,?,?,?,?,?,?,?,?)`,
      params: [topicId, auth.family_id, subject, kind, parentsOnly ? 1 : 0, null, 'placeholder', auth.member_id, ts],
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
  const tasks = await db.queryAll(`SELECT * FROM tasks WHERE topic_id = ? ORDER BY created_at ASC`, [
    tid,
  ]);
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
  const maxRow = await db.queryOne(`SELECT MAX(seq) AS m FROM entries WHERE topic_id = ?`, [tid]);
  const fromSeq = historyFrom === 'full' ? 1 : ((maxRow?.['m'] as number | null) ?? 0) + 1;
  const ts = nowIso();
  const existing = await db.queryAll(`SELECT member_id FROM topic_participants WHERE topic_id = ?`, [
    tid,
  ]);
  const existingIds = new Set(existing.map((r) => r['member_id'] as string));
  const added = memberIds.filter((id) => !existingIds.has(id));
  const ops = added.map((mid) => ({
    sql: `INSERT INTO topic_participants(topic_id, member_id, joined_at, history_from_seq) VALUES (?,?,?,?)`,
    params: [tid, mid, ts, fromSeq] as (string | number | null)[],
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
  const kind = body['kind'] === undefined ? 'message' : reqEnum(body['kind'], 'kind', ['message'] as const);
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
  piiGuard(text);

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

  const entry = await appendEntry(db, {
    topic_id: tid,
    kind,
    body: text,
    auth,
    data,
    reply_to_seq: replyTo,
  });
  if (idemKey !== null) {
    await db.execAtomically([
      {
        sql: `INSERT OR REPLACE INTO idempotency_keys(token_id, key, entry_gseq, created_at, expires_at)
              VALUES (?,?,?,?,?)`,
        params: [auth.token_id, idemKey, entry['gseq'] as number, nowIso(), hoursFromNow(IDEM_TTL_HOURS)],
      },
    ]);
  }
  return json({ entry: publicEntry(entry) }, 201);
}

// GET /v1/sync?after_gseq=&limit= — one call per poll, all visible topics.
async function handleSync(db: DbClient, req: Request, auth: AuthContext): Promise<Response> {
  const url = new URL(req.url);
  const after = parseSeqCursor(url.searchParams.get('after_gseq'));
  const limit = parseLimit(url.searchParams.get('limit'), 100, 500);
  const rows = await db.queryAll(
    `SELECT e.* FROM entries e
       JOIN topic_participants p ON p.topic_id = e.topic_id AND p.member_id = ?
      WHERE e.gseq > ? AND e.seq >= p.history_from_seq
      ORDER BY e.gseq ASC LIMIT ?`,
    [auth.member_id, after, limit],
  );
  const maxRow = await db.queryOne(
    `SELECT MAX(e.gseq) AS m FROM entries e
       JOIN topic_participants p ON p.topic_id = e.topic_id AND p.member_id = ?
      WHERE e.seq >= p.history_from_seq`,
    [auth.member_id],
  );
  const maxGseq = (maxRow?.['m'] as number | null) ?? 0;
  return json({ entries: rows.map(publicEntry), max_gseq: maxGseq, next_after_gseq: maxGseq });
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

  const taskId = newId();
  const ts = nowIso();
  await db.execAtomically([
    {
      sql: `INSERT INTO tasks(id, topic_id, title, description, status, owner_member_id, assignee_member_id,
                              parent_task_id, due_at, result, created_by, created_at, updated_at)
            VALUES (?,?,?,?, 'open', ?,?,?,?,?, ?,?,?)`,
      params: [taskId, tid, title, description, auth.member_id, assignee, parentTask, dueAt, null, auth.member_id, ts, ts],
    },
  ]);
  await appendEntry(db, {
    topic_id: tid,
    kind: 'task_created',
    body: `Task created: ${title}`,
    auth,
    data: JSON.stringify({ task_id: taskId, assignee_member_id: assignee, parent_task_id: parentTask }),
  });
  const task = await db.queryOne(`SELECT * FROM tasks WHERE id = ?`, [taskId]);
  return json({ task: publicTask(task!) }, 201);
}

async function getTaskInScope(db: DbClient, auth: AuthContext, taskId: string): Promise<Row> {
  const task = await db.queryOne(`SELECT * FROM tasks WHERE id = ?`, [taskId]);
  if (!task) throw new HttpError(404, 'not_found', 'Task not found');
  await requireParticipant(db, auth, task['topic_id'] as string);
  return task;
}

// GET /v1/tasks/:tid — task + its entry trail.
async function handleGetTask(db: DbClient, auth: AuthContext, taskId: string): Promise<Response> {
  const task = await getTaskInScope(db, auth, taskId);
  const topicId = task['topic_id'] as string;
  const part = await db.queryOne(
    `SELECT history_from_seq FROM topic_participants WHERE topic_id = ? AND member_id = ?`,
    [topicId, auth.member_id],
  );
  const rows = await db.queryAll(
    `SELECT * FROM entries WHERE topic_id = ? AND seq >= ? ORDER BY seq ASC LIMIT 5000`,
    [topicId, part!['history_from_seq'] as number],
  );
  const trail = rows.filter((r) => {
    const d = parseDataField(r) as Record<string, unknown> | null;
    return d !== null && typeof d === 'object' && (d as Record<string, unknown>)['task_id'] === taskId;
  });
  return json({ task: publicTask(task), trail: trail.map(publicEntry) });
}

// GET /v1/topics/:tid/tasks — list tasks in a topic.
async function handleListTopicTasks(db: DbClient, auth: AuthContext, tid: string): Promise<Response> {
  await requireParticipant(db, auth, tid);
  const rows = await db.queryAll(
    `SELECT * FROM tasks WHERE topic_id = ? ORDER BY created_at ASC`,
    [tid],
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

  if (body['title'] !== undefined) {
    const title = reqString(body['title'], 'title', 1, 200);
    sets.push('title = ?');
    params.push(title);
  }
  if (body['description'] !== undefined) {
    const description = optString(body['description'], 'description', MAX_BODY);
    if (description) piiGuard(description);
    sets.push('description = ?');
    params.push(description);
  }
  if (body['due_at'] !== undefined) {
    const dueAt = body['due_at'] === null ? null : reqIsoDate(body['due_at'], 'due_at');
    sets.push('due_at = ?');
    params.push(dueAt);
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
  sets.push('updated_at = ?');
  params.push(nowIso());
  params.push(taskId);
  await db.execAtomically([
    { sql: `UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`, params },
  ]);
  if (assigneeChanged !== undefined) {
    await appendEntry(db, {
      topic_id: topicId,
      kind: 'task_assigned',
      body: assigneeChanged ? `Task assigned` : `Task unassigned`,
      auth,
      data: JSON.stringify({ task_id: taskId, assignee_member_id: assigneeChanged }),
    });
  }
  if (statusChanged) {
    await appendEntry(db, {
      topic_id: topicId,
      kind: 'task_status',
      body: `Task status → ${statusChanged}`,
      auth,
      data: JSON.stringify({ task_id: taskId, status: statusChanged }),
    });
  }
  const updated = await db.queryOne(`SELECT * FROM tasks WHERE id = ?`, [taskId]);
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
  const body = await readJson(req).catch((): Record<string, unknown> => ({}));
  const result = reqJsonData(body['result'], 'result', MAX_DATA);
  await assertNoOpenSubtasks(db, taskId);
  const ts = nowIso();
  await db.execAtomically([
    {
      sql: `UPDATE tasks SET status = 'done', result = ?, updated_at = ? WHERE id = ?`,
      params: [result, ts, taskId],
    },
  ]);
  await appendEntry(db, {
    topic_id: topicId,
    kind: 'task_done',
    body: `Task completed`,
    auth,
    data: JSON.stringify({ task_id: taskId, result: result ? JSON.parse(result) : null }),
  });
  const updated = await db.queryOne(`SELECT * FROM tasks WHERE id = ?`, [taskId]);
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
  await db.execAtomically([
    { sql: `UPDATE entries SET body = ? WHERE gseq = ?`, params: [scrubbed, gseq] },
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
    return res;
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
    return json({ error: { code: 'internal', message: 'Internal server error' } }, 500);
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
    if (path === '/v1/families' && method === 'POST') return await handleCreateFamily(db, env, req);
    if (path.startsWith('/v1/invites/') && path.endsWith('/accept') && method === 'POST') {
      const code = decodeURIComponent(path.slice('/v1/invites/'.length, -'/accept'.length));
      return await handleAcceptInvite(db, env, req, code);
    }
    if (path.startsWith('/v1/provisioning-codes/') && path.endsWith('/redeem') && method === 'POST') {
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
    if (path === '/v1/topics' && method === 'POST') return await handleCreateTopic(db, env, req, auth);
    if (path === '/v1/topics' && method === 'GET') return await handleListTopics(db, req, auth);
    if (path === '/v1/sync' && method === 'GET') return await handleSync(db, req, auth);

    const famInvite = /^\/v1\/families\/([^/]+)\/invites$/.exec(path);
    if (famInvite && method === 'POST') {
      return await handleCreateInvite(db, env, req, auth, decodeURIComponent(famInvite[1]));
    }

    const topicSub = /^\/v1\/topics\/([^/]+)\/(history|export|invite|spawn|entries|tasks)$/.exec(path);
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

    const topicOnly = /^\/v1\/topics\/([^/]+)$/.exec(path);
    if (topicOnly && method === 'GET') {
      return await handleGetTopic(db, auth, decodeURIComponent(topicOnly[1]));
    }

    const taskSub = /^\/v1\/tasks\/([^/]+)(\/(notes|done))?$/.exec(path);
    if (taskSub) {
      const taskId = decodeURIComponent(taskSub[1]);
      if (!taskSub[2] && (method === 'GET' || method === 'PATCH')) {
        return method === 'GET'
          ? await handleGetTask(db, auth, taskId)
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
      return json({ error: { code: 'misconfigured', message: 'D1 binding DB is not configured' } }, 500);
    }
    if (!env.TOKEN_PEPPER) {
      logEvent('error', 'misconfigured', { detail: 'TOKEN_PEPPER secret is not set' });
      return json({ error: { code: 'misconfigured', message: 'TOKEN_PEPPER secret is not set' } }, 500);
    }
    return await handleRequest(req, d1Client(env.DB), env);
  },
};
