import { wireBody } from './syncv2_helpers.js';
// E2EE Phase 5 — recovery + archive (server side).
//
// Covers: the new client-postable plaintext system kind `topic_archived` on
// POST /v2/topics/:tid/entries (accepted, stored verbatim with its data
// payload, still gated on participation; unknown kinds still 400).
import { test } from 'node:test';
import assert from 'node:assert';
import { makeApp, TestApp } from './app.js';

// No @types/node in this repo: random bytes via WebCrypto (DOM lib), base64
// via btoa (each input byte becomes one char — safe for short inputs).
function b64(n: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return btoa(String.fromCharCode(...bytes));
}
function hex(n: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

interface Party {
  token: string;
  memberId: string;
  agentLabel: string;
}

// Family whose owner's agent has a registered identity key.
async function setupKeyedFamily(app: TestApp, name: string): Promise<{ famId: string; owner: Party }> {
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

// Extra member via the invite flow (no identity key unless added later).
async function addMember(
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

async function makeTopic(app: TestApp, token: string, _e2ee: number): Promise<string> {
  const r = await app.call('POST', '/v2/topics', {token,body:{topic_id:hex(16),subject:wireBody(hex(16)),kind:'group',participant_member_ids:[]}});
  assert.equal(r.status,201);
  return r.body.topic.id;
}

// ---------------------------------------------------------------------------
// topic_archived
// ---------------------------------------------------------------------------

test('entries POST: topic_archived accepts only typed successor metadata', async () => {
  const app = makeApp();
  const { owner } = await setupKeyedFamily(app, 'RecFam1');
  const tid = await makeTopic(app, owner.token, 1);
  const successor = await makeTopic(app, owner.token, 1);

  const res = await app.call('POST', `/v2/topics/${tid}/entries`, {
    token: owner.token,
    body: {
      kind: 'topic_archived',
      data: { successor_topic_id: successor, archived_by: owner.memberId },
    },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.entry.kind, 'topic_archived');
  assert.equal(res.body.entry.body, 'topic_archived');
  const data = res.body.entry.data;
  assert.equal(data.successor_topic_id, successor);
  assert.equal(data.reason, undefined);
  assert.equal(data.archived_by, owner.memberId);

  // The archived entry is readable in history alongside older entries.
  const hist = await app.call('GET', `/v2/topics/${tid}/history`, { token: owner.token });
  assert.equal(hist.status, 200);
  const kinds = (hist.body.entries as any[]).map((e) => e.kind);
  assert.ok(kinds.includes('topic_archived'));

  // Unknown kinds are still rejected — the widened CHECK did not open the gate.
  const bad = await app.call('POST', `/v2/topics/${tid}/entries`, {
    token: owner.token,
    body: { kind: 'topic_frobnicated', body: 'nope' },
  });
  assert.equal(bad.status, 400);
});

test('entries POST: topic_archived requires participation (403 otherwise)', async () => {
  const app = makeApp();
  const { famId, owner } = await setupKeyedFamily(app, 'RecFam2');
  const tid = await makeTopic(app, owner.token, 1);
  const outsider = await addMember(app, famId, owner.token, 'out@r.dev', 'parent', 'Outsider');

  const res = await app.call('POST', `/v2/topics/${tid}/entries`, {
    token: outsider.token,
    body: { kind: 'topic_archived', body: '[topic archived] forged' },
  });
  assert.equal(res.status, 403);
});
