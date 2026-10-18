// Shared builders for sync-v2 / E2EE-lifecycle tests (spec §5).
//
// Every helper here drives the public HTTP surface via makeApp(); the only
// direct-DB reads are assertions. No @types/node in this repo: random bytes
// via WebCrypto (DOM lib), base64 via btoa.
import assert from 'node:assert';
import { makeApp, TestApp } from './app.js';

export interface Party {
  token: string;
  memberId: string;
  agentLabel: string;
}

export function b64(n: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return btoa(String.fromCharCode(...bytes));
}

export function hex(n: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Family whose owner's agent has a registered identity key. */
export async function setupKeyedFamily(
  app: TestApp,
  name: string,
): Promise<{ famId: string; owner: Party }> {
  const fam = await app.call('POST', '/v2/families', {
    body: { name, owner_name: 'Ow', owner_email: `o-${name}@x.dev` },
  });
  assert.equal(fam.status, 201);
  const famId = (await app.db.queryOne('SELECT id FROM families WHERE name = ?', [name]))!['id'] as string;
  const red = await app.call(
    'POST',
    `/v2/provisioning-codes/${encodeURIComponent(fam.body.provisioning_code)}/redeem`,
    { body: { agent_public_key: b64(32) } },
  );
  assert.equal(red.status, 201);
  return {
    famId,
    owner: {
      token: red.body.token as string,
      memberId: red.body.member.id as string,
      agentLabel: 'owner-agent',
    },
  };
}

/** Extra member via the invite flow (no identity key unless added later). */
export async function addMember(
  app: TestApp,
  famId: string,
  inviterToken: string,
  email: string,
  role: string,
  displayName: string,
): Promise<{ token: string; memberId: string }> {
  const inv = await app.call('POST', `/v2/families/${famId}/invites`, {
    token: inviterToken,
    body: { email, role },
  });
  assert.equal(inv.status, 201);
  const acc = await app.call(
    'POST',
    `/v2/invites/${encodeURIComponent(inv.body.invite_code)}/accept`,
    { body: { display_name: displayName, agent_label: `${displayName.toLowerCase()}-agent` , agent_public_key: b64(32) } },
  );
  assert.equal(acc.status, 201);
  return { token: acc.body.token as string, memberId: acc.body.member.id as string };
}

/** Extra agent for an existing member (distinct token + agent_label),
 *  optionally with a registered identity key. */
export async function addAgent(
  app: TestApp,
  minterToken: string,
  memberId: string,
  label: string,
  withKey: boolean,
): Promise<Party> {
  const m = await app.call('POST', '/v2/provisioning-codes', {
    token: app.credentials.get(memberId) ?? minterToken,
    body: { member_id: memberId, agent_label: label },
  });
  assert.equal(m.status, 201);
  const red = await app.call(
    'POST',
    `/v2/provisioning-codes/${encodeURIComponent(m.body.provisioning_code)}/redeem`,
    { body: { agent_public_key: (await app.db.queryOne('SELECT public_key FROM agent_keys WHERE member_id = ? AND agent_label = ? AND superseded_at IS NULL',[memberId,label]))?.public_key ?? b64(32) } },
  );
  assert.equal(red.status, 201);
  if (!withKey) await app.db.execAtomically([{sql: 'DELETE FROM agent_keys WHERE member_id = ? AND agent_label = ?',params:[memberId,label]}]);
  return { token: red.body.token as string, memberId: red.body.member.id as string, agentLabel: label };
}

export async function createE2eeTopic(
  app: TestApp,
  token: string,
  opts: { participantIds?: string[]; subject?: string; initialKeyId?: string } = {},
): Promise<{ status: number; body: any; tid: string }> {
  const res = await app.call('POST', '/v2/topics', {
    token,
    body: {
      topic_id: hex(16),
      subject: opts.subject ?? wireBody(opts.initialKeyId ?? hex(16)),
      kind: 'group',
      participant_member_ids: opts.participantIds ?? [],
    },
  });
  assert.equal(res.status, 201);
  return { status: res.status, body: res.body, tid: res.body.topic.id as string };
}

/** An active encrypted topic for read/ack business journeys. */
export async function createActiveTopic(
  app: TestApp, token: string, _subject: string, participantIds: string[] = [],
): Promise<string> {
  const { tid } = await createE2eeTopic(app, token, {participantIds});
  const row = await app.call('GET', `/v2/topics/${tid}`, {token});
  const keys = await app.call('GET', '/v2/agent-keys', {token});
  await genesisCommit(app, token, tid, keys.body.keys.filter((k: any)=>row.body.participants.some((p: any)=>p.member_id===k.member_id)).map((k: any)=>({memberId:k.member_id,agentLabel:k.agent_label})));
  return tid;
}

export async function inviteToTopic(
  app: TestApp,
  token: string,
  tid: string,
  memberIds: string[],
  historyFrom: 'full' | 'from_join' = 'full',
): Promise<void> {
  const res = await app.call('POST', `/v2/topics/${tid}/invite`, {
    token,
    body: { member_ids: memberIds, history_from: historyFrom },
  });
  assert.equal(res.status, 200);
}

export async function postEnvelope(
  app: TestApp,
  token: string,
  tid: string,
  targetMemberId: string,
  targetAgentLabel: string,
  keyId: string,
): Promise<{ status: number; body: any }> {
  return app.call('POST', `/v2/topics/${tid}/envelopes`, {
    token,
    body: {
      member_id: targetMemberId,
      agent_label: targetAgentLabel,
      key_id: keyId,
      envelope: b64(96),
    },
  });
}

export interface CommitOpts {
  expectedEpoch: number;
  keyId: string;
  commitment: string;
  force?: boolean;
}

/** POST /v2/topics/:tid/keys/commit. Returns the raw call result. */
export async function commitKey(
  app: TestApp,
  token: string,
  tid: string,
  opts: CommitOpts,
): Promise<{ status: number; body: any }> {
  return app.call('POST', `/v2/topics/${tid}/keys/commit`, {
    token,
    body: {
      expected_epoch: opts.expectedEpoch,
      key_id: opts.keyId,
      commitment: opts.commitment,
      subject: wireBody(opts.keyId),
      ...(opts.force !== undefined ? { force: opts.force } : {}),
    },
  });
}

/**
 * A well-formed fh1 wire body: `fh1.<keyId>.<msgId>.<blob>`, blob decoding
 * to 40 raw bytes (>= the 24-nonce + 16-tag minimum). Pass an explicit
 * msgId for replay tests.
 */
export function wireBody(keyId: string, msgId?: string): string {
  return `fh1.${keyId}.${msgId ?? hex(16)}.${b64(40)}`;
}

/** POST a kind=message entry; returns the raw call result. */
export async function postEntry(
  app: TestApp,
  token: string,
  tid: string,
  body: string,
  extra: Record<string, unknown> = {},
): Promise<{ status: number; body: any }> {
  return app.call('POST', `/v2/topics/${tid}/entries`, {
    token,
    body: { kind: 'message', body, ...extra },
  });
}

/**
 * Full genesis ceremony through the public surface: stage envelopes for
 * every (member, agent) pair given, then commit expected_epoch 1.
 * Returns the committed key_id.
 */
export async function genesisCommit(
  app: TestApp,
  ownerToken: string,
  tid: string,
  agents: Array<{ memberId: string; agentLabel: string }>,
): Promise<string> {
  const keyId = hex(16);
  const commitment = hex(32);
  for (const a of agents) {
    const r = await postEnvelope(app, ownerToken, tid, a.memberId, a.agentLabel, keyId);
    assert.equal(r.status, 201, `envelope POST failed: ${JSON.stringify(r.body)}`);
  }
  const c = await commitKey(app, ownerToken, tid, { expectedEpoch: 1, keyId, commitment });
  assert.equal(c.status, 200, `genesis commit failed: ${JSON.stringify(c.body)}`);
  return keyId;
}

/** Read-state row for assertions (null when the agent never synced/acked). */
export async function readState(
  app: TestApp,
  memberId: string,
  agentLabel: string,
  tid: string,
): Promise<number | null> {
  const row = await app.db.queryOne(
    `SELECT acked_seq FROM topic_read_state WHERE member_id = ? AND agent_label = ? AND topic_id = ?`,
    [memberId, agentLabel, tid],
  );
  return row ? (row['acked_seq'] as number) : null;
}

export { makeApp };
export type { TestApp };
