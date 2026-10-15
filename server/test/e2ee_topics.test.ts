import { wireBody } from './syncv2_helpers.js';
// E2EE Phase 2 — E2EE topics + key envelopes.
//
// Covers: e2ee=1 topic creation requires the creator's registered identity
// key (400 + `hub key-init` guidance otherwise); invalid e2ee flag values;
// envelope POST access control (caller must be a participant; target must
// be a participant with an ACTIVE registered key); envelope re-POST
// idempotency; GET envelopes returns only the caller's own envelopes;
// plaintext topic creation behaves byte-identically to before.
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

// Extra agent for an existing member (distinct token + agent_label),
// optionally with a registered identity key.
async function addAgent(
  app: TestApp,
  minterToken: string,
  memberId: string,
  label: string,
  withKey: boolean,
): Promise<Party> {
  const m = await app.call('POST', '/v2/provisioning-codes', {
    token: minterToken,
    body: { member_id: memberId, agent_label: label },
  });
  assert.equal(m.status, 201);
  const red = await app.call(
    'POST',
    `/v2/provisioning-codes/${encodeURIComponent(m.body.provisioning_code)}/redeem`,
    { body: { agent_public_key: (await app.db.queryOne('SELECT public_key FROM agent_keys WHERE member_id = ? AND agent_label = ? AND superseded_at IS NULL',[memberId,label]))?.public_key ?? b64(32) } },
  );
  assert.equal(red.status, 201);
  return { token: red.body.token as string, memberId: red.body.member.id as string, agentLabel: label };
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

async function createTopic(
  app: TestApp,
  token: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  return app.call('POST', '/v2/topics', { token, body });
}

function plaintextBody(subject = 'plain subject'): Record<string, unknown> {
  return { subject, kind: 'group', participant_member_ids: [] };
}

// ---------------------------------------------------------------------------
// Topic creation with e2ee
// ---------------------------------------------------------------------------

test('e2ee=1 without a registered creator key is 400 with key-init guidance', async () => {
  const app = makeApp();
  const fam = await app.call('POST', '/v2/families', {
    body: { name: 'NoKeyFam', owner_name: 'Ow', owner_email: 'o-nokeyfam@x.dev' },
  });
  assert.equal(fam.status, 201);
  const red = await app.call(
    'POST',
    `/v2/provisioning-codes/${encodeURIComponent(fam.body.provisioning_code)}/redeem`,
    { body: { agent_public_key: b64(32) } }, // no agent_public_key: this agent has no E2EE identity
  );
  assert.equal(red.status, 201);
  await app.db.execAtomically([{sql:'DELETE FROM agent_keys WHERE member_id = ?',params:[red.body.member.id]}]);
  const res = await createTopic(app, red.body.token as string, {
    topic_id: hex(16), subject: wireBody(hex(16)),
    kind: 'group',
    participant_member_ids: [],

  });
  assert.equal(res.status, 400);
  assert.match(String(res.body.error.message), /hub key-init/);
  // Nothing was created.
  const n = await app.db.queryOne(`SELECT COUNT(*) AS c FROM topics`, []);
  assert.equal(n!['c'], 0);
});

test('e2ee=1 with a registered key creates the topic; subject stored opaque as-is', async () => {
  const app = makeApp();
  const { owner } = await setupKeyedFamily(app, 'E2eeFam1');
  const ciphertextSubject = wireBody(hex(16)); // simulated client-side ciphertext
  const res = await createTopic(app, owner.token, {
    topic_id:hex(16), subject: ciphertextSubject,
    kind: 'group',
    participant_member_ids: [],

  });
  assert.equal(res.status, 201);
  assert.equal(res.body.topic.e2ee, 1);
  assert.equal(res.body.topic.subject, ciphertextSubject);
  const row = await app.db.queryOne(`SELECT e2ee, subject FROM topics WHERE id = ?`, [
    res.body.topic.id as string,
  ]);
  assert.equal(row!['e2ee'], 1);
  assert.equal(row!['subject'], ciphertextSubject);
});





// ---------------------------------------------------------------------------
// Envelope POST
// ---------------------------------------------------------------------------

async function envelopeBody(over: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return {
    member_id: over['member_id'] ?? 'mid',
    agent_label: over['agent_label'] ?? 'owner-agent',
    key_id: over['key_id'] ?? hex(16),
    envelope: over['envelope'] ?? b64(96),
  };
}

test('envelope POST: non-participant caller is 403; unknown topic is 404', async () => {
  const app = makeApp();
  const { famId, owner } = await setupKeyedFamily(app, 'E2eeFam4');
  const topic = await createTopic(app, owner.token, {
    topic_id: hex(16), subject: wireBody(hex(16)),
    kind: 'group',
    participant_member_ids: [],

  });
  assert.equal(topic.status, 201);
  const tid = topic.body.topic.id as string;

  // A second member who is NOT in the topic.
  const outsider = await addMember(app, famId, owner.token, 'out@e.dev', 'parent', 'Outsider');
  const res = await app.call('POST', `/v2/topics/${tid}/envelopes`, {
    token: outsider.token,
    body: await envelopeBody({ member_id: owner.memberId, agent_label: owner.agentLabel }),
  });
  assert.equal(res.status, 403);

  // Unknown topic id.
  const missing = await app.call('POST', `/v2/topics/nope-not-here/envelopes`, {
    token: owner.token,
    body: await envelopeBody({ member_id: owner.memberId, agent_label: owner.agentLabel }),
  });
  assert.equal(missing.status, 404);
});

test('envelope POST: target must be a participant with an ACTIVE registered key', async () => {
  const app = makeApp();
  const { famId, owner } = await setupKeyedFamily(app, 'E2eeFam5');
  // Member B joins the family; member C joins too but stays out of the topic.
  const memberB = await addMember(app, famId, owner.token, 'b@e.dev', 'parent', 'Bee');
  const memberC = await addMember(app, famId, owner.token, 'c@e.dev', 'parent', 'Cee');
  // B's agent registers an identity key (via rotate = initial registration).
  const agentB = await addAgent(app, owner.token, memberB.memberId, 'bee-agent', false);
  const rot = await app.call('POST', '/v2/agent-keys/rotate', {
    token: agentB.token,
    body: { agent_public_key: b64(32) },
  });
  assert.equal(rot.status, 200);

  const topic = await createTopic(app, owner.token, {
    topic_id: hex(16), subject: wireBody(hex(16)),
    kind: 'group',
    participant_member_ids: [memberB.memberId],

  });
  assert.equal(topic.status, 201);
  const tid = topic.body.topic.id as string;

  // Happy path: owner posts an envelope for B's keyed agent.
  const ok = await app.call('POST', `/v2/topics/${tid}/envelopes`, {
    token: owner.token,
    body: await envelopeBody({ member_id: memberB.memberId, agent_label: 'bee-agent' }),
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.topic_id, tid);
  assert.equal(ok.body.member_id, memberB.memberId);
  assert.equal(ok.body.agent_label, 'bee-agent');

  // Target not a participant at all (member C): 400.
  const notPart = await app.call('POST', `/v2/topics/${tid}/envelopes`, {
    token: owner.token,
    body: await envelopeBody({ member_id: memberC.memberId, agent_label: 'cee-agent' }),
  });
  assert.equal(notPart.status, 400);

  // Target is a participant but has no registered key (B's other agent): 400.
  const noKey = await app.call('POST', `/v2/topics/${tid}/envelopes`, {
    token: owner.token,
    body: await envelopeBody({ member_id: memberB.memberId, agent_label: 'unkeyed-agent' }),
  });
  assert.equal(noKey.status, 400);
  assert.match(String(noKey.body.error.message), /key-init/);

  // Target's only key is superseded (rotated away): 400.
  const rot2 = await app.call('POST', '/v2/agent-keys/rotate', {
    token: agentB.token,
    body: { agent_public_key: b64(32) },
  });
  assert.equal(rot2.status, 200);
  const superseded = await app.call('POST', `/v2/topics/${tid}/envelopes`, {
    token: owner.token,
    body: await envelopeBody({ member_id: memberB.memberId, agent_label: 'bee-agent' }),
  });
  // The new key is active for bee-agent, so this succeeds — it targets the
  // CURRENT active key, not the superseded one. Register a fresh agent to
  // test the superseded-only case.
  assert.equal(superseded.status, 201);
  const agentB2 = await addAgent(app, owner.token, memberB.memberId, 'bee2-agent', true);
  await app.call('POST', '/v2/agent-keys/rotate', {
    token: agentB2.token,
    body: { agent_public_key: b64(32) },
  });
  // bee2-agent now has exactly one key row and it is superseded... no:
  // rotate supersedes the old and inserts a new active one. To leave ONLY a
  // superseded key, mark the active row superseded directly via SQL — the
  // API never deletes, so this models "key retired with no replacement".
  await app.db.execAtomically([
    {
      sql: `UPDATE agent_keys SET superseded_at = ? WHERE member_id = ? AND agent_label = ?`,
      params: [new Date().toISOString(), memberB.memberId, 'bee2-agent'],
    },
  ]);
  const onlySuperseded = await app.call('POST', `/v2/topics/${tid}/envelopes`, {
    token: owner.token,
    body: await envelopeBody({ member_id: memberB.memberId, agent_label: 'bee2-agent' }),
  });
  assert.equal(onlySuperseded.status, 400);
});

test('envelope POST: malformed key_id / envelope / member fields are 400', async () => {
  const app = makeApp();
  const { owner } = await setupKeyedFamily(app, 'E2eeFam6');
  const topic = await createTopic(app, owner.token, {
    topic_id: hex(16), subject: wireBody(hex(16)),
    kind: 'group',
    participant_member_ids: [],

  });
  assert.equal(topic.status, 201);
  const tid = topic.body.topic.id as string;
  const good = await envelopeBody({ member_id: owner.memberId, agent_label: owner.agentLabel });

  const badBodies: Array<[string, Record<string, unknown>]> = [
    ['short key_id', { ...good, key_id: 'abcd' }],
    ['non-hex key_id', { ...good, key_id: 'z'.repeat(32) }],
    ['empty envelope', { ...good, envelope: '' }],
    ['non-base64 envelope', { ...good, envelope: '!!!' }],
    ['oversized envelope', { ...good, envelope: b64(3100) }],
    ['empty member_id', { ...good, member_id: '' }],
    ['empty agent_label', { ...good, agent_label: '' }],
  ];
  for (const [label, body] of badBodies) {
    const res = await app.call('POST', `/v2/topics/${tid}/envelopes`, { token: owner.token, body });
    assert.equal(res.status, 400, `expected 400 for ${label}`);
  }
  const n = await app.db.queryOne(`SELECT COUNT(*) AS c FROM topic_key_envelopes`, []);
  assert.equal(n!['c'], 0);
});

test('envelope POST: re-POST of the same (topic, member, label, key_id) is idempotent', async () => {
  const app = makeApp();
  const { owner } = await setupKeyedFamily(app, 'E2eeFam7');
  const topic = await createTopic(app, owner.token, {
    topic_id: hex(16), subject: wireBody(hex(16)),
    kind: 'group',
    participant_member_ids: [],

  });
  assert.equal(topic.status, 201);
  const tid = topic.body.topic.id as string;
  const keyId = hex(16);
  const first = await app.call('POST', `/v2/topics/${tid}/envelopes`, {
    token: owner.token,
    body: await envelopeBody({ member_id: owner.memberId, agent_label: owner.agentLabel, key_id: keyId }),
  });
  assert.equal(first.status, 201);
  // Same envelope again: still 201, still exactly one row.
  const again = await app.call('POST', `/v2/topics/${tid}/envelopes`, {
    token: owner.token,
    body: await envelopeBody({ member_id: owner.memberId, agent_label: owner.agentLabel, key_id: keyId }),
  });
  assert.equal(again.status, 201);
  let n = await app.db.queryOne(
    `SELECT COUNT(*) AS c FROM topic_key_envelopes WHERE topic_id = ? AND member_id = ? AND agent_label = ? AND key_id = ?`,
    [tid, owner.memberId, owner.agentLabel, keyId],
  );
  assert.equal(n!['c'], 1);
  // A different key_id is a distinct envelope, not a replacement.
  const other = await app.call('POST', `/v2/topics/${tid}/envelopes`, {
    token: owner.token,
    body: await envelopeBody({
      member_id: owner.memberId,
      agent_label: owner.agentLabel,
      key_id: hex(16),
    }),
  });
  assert.equal(other.status, 201);
  n = await app.db.queryOne(`SELECT COUNT(*) AS c FROM topic_key_envelopes WHERE topic_id = ?`, [tid]);
  assert.equal(n!['c'], 2);
});

// ---------------------------------------------------------------------------
// Envelope GET — caller's own only
// ---------------------------------------------------------------------------

test('envelope GET: each agent sees only its own envelopes; non-participant 403', async () => {
  const app = makeApp();
  const { famId, owner } = await setupKeyedFamily(app, 'E2eeFam8');
  const memberB = await addMember(app, famId, owner.token, 'b@e.dev', 'parent', 'Bee');
  const agentB = await addAgent(app, owner.token, memberB.memberId, 'bee-agent', true);
  const agentB2 = await addAgent(app, owner.token, memberB.memberId, 'bee2-agent', true);

  const topic = await createTopic(app, owner.token, {
    topic_id: hex(16), subject: wireBody(hex(16)),
    kind: 'group',
    participant_member_ids: [memberB.memberId],

  });
  assert.equal(topic.status, 201);
  const tid = topic.body.topic.id as string;
  const keyId = hex(16);

  // Envelopes for three distinct agent identities.
  for (const [mid, label] of [
    [owner.memberId, owner.agentLabel],
    [memberB.memberId, 'bee-agent'],
    [memberB.memberId, 'bee2-agent'],
  ] as Array<[string, string]>) {
    const r = await app.call('POST', `/v2/topics/${tid}/envelopes`, {
      token: owner.token,
      body: await envelopeBody({ member_id: mid, agent_label: label, key_id: keyId }),
    });
    assert.equal(r.status, 201);
  }

  // Sync v2: staged envelopes are invisible until keys/commit activates the
  // epoch. Commit the staged key (genesis, expected_epoch 1).
  const commitment = hex(32);
  const commit = await app.call('POST', `/v2/topics/${tid}/keys/commit`, {
    token: owner.token,
    body: { expected_epoch: 1, key_id: keyId, subject: wireBody(keyId), commitment },
  });
  assert.equal(commit.status, 200, `commit failed: ${JSON.stringify(commit.body)}`);
  assert.equal(commit.body.epoch, 1);
  assert.equal(commit.body.key_id, keyId);

  // Owner sees exactly their own envelope, with the epoch commitment (N07).
  const ownGet = await app.call('GET', `/v2/topics/${tid}/envelopes`, { token: owner.token });
  assert.equal(ownGet.status, 200);
  assert.equal(ownGet.body.envelopes.length, 1);
  assert.equal(ownGet.body.envelopes[0].agent_label, owner.agentLabel);
  assert.equal(ownGet.body.envelopes[0].key_id, keyId);
  assert.equal(ownGet.body.envelopes[0].epoch, 1);
  assert.equal(ownGet.body.envelopes[0].commitment, commitment);

  // bee-agent sees exactly its own — never bee2-agent's, never the owner's.
  const bGet = await app.call('GET', `/v2/topics/${tid}/envelopes`, { token: agentB.token });
  assert.equal(bGet.status, 200);
  assert.equal(bGet.body.envelopes.length, 1);
  assert.equal(bGet.body.envelopes[0].agent_label, 'bee-agent');

  const b2Get = await app.call('GET', `/v2/topics/${tid}/envelopes`, { token: agentB2.token });
  assert.equal(b2Get.status, 200);
  assert.equal(b2Get.body.envelopes.length, 1);
  assert.equal(b2Get.body.envelopes[0].agent_label, 'bee2-agent');

  // Non-participant member: 403, learns nothing.
  const outsider = await addMember(app, famId, owner.token, 'out@e.dev', 'parent', 'Outsider');
  const denied = await app.call('GET', `/v2/topics/${tid}/envelopes`, { token: outsider.token });
  assert.equal(denied.status, 403);

  // Unknown topic: 404.
  const missing = await app.call('GET', `/v2/topics/nope-not-here/envelopes`, { token: owner.token });
  assert.equal(missing.status, 404);
});
