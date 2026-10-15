import { wireBody } from './syncv2_helpers.js';
import { b64 } from './syncv2_helpers.js';
// End-to-end lifecycle against local SQLite (SPEC §§6-12, 17):
// family -> invite -> accept -> topic -> post -> invite kid (from_join) ->
// spawn linked child -> task -> subtask -> sync cursors -> redact,
// plus EVERY denied case from SPEC §12.
import { test } from 'node:test';
import assert from 'node:assert';
import { makeClientApp as makeApp } from './fixture-client.js';
import type { TestClientApp as TestApp } from './fixture-client.js';

interface Ctx {
  app: TestApp;
  famA: string;
  famB: string;
  ownerToken: string;
  ownerId: string;
  parentToken: string;
  parentId: string;
  kidToken: string;
  kidId: string;
  parentTopic: string;
}

async function bootstrapFamily(app: TestApp, name: string, ownerName: string, email: string) {
  const fam = await app.call('POST', '/v2/families', {
    body: { name, owner_name: ownerName, owner_email: email },
  });
  assert.equal(fam.status, 201);
  const red = await app.call(
    'POST',
    `/v2/provisioning-codes/${encodeURIComponent(fam.body.provisioning_code)}/redeem`,
    { body: { agent_public_key: b64(32) } },
  );
  assert.equal(red.status, 201);
  return {
    famId: fam.body.family.id as string,
    token: red.body.token as string,
    memberId: red.body.member.id as string,
  };
}

async function inviteAccept(
  app: TestApp,
  famId: string,
  inviterToken: string,
  email: string,
  role: string,
  displayName: string,
) {
  const inv = await app.call('POST', `/v2/families/${famId}/invites`, {
    token: inviterToken,
    body: { email, role },
  });
  assert.equal(inv.status, 201);
  const acc = await app.call(
    'POST',
    `/v2/invites/${encodeURIComponent(inv.body.invite_code)}/accept`,
    { body: { display_name: displayName, agent_label: displayName.toLowerCase() + '-agent' , agent_public_key: b64(32) } },
  );
  assert.equal(acc.status, 201);
  return {
    token: acc.body.token as string,
    memberId: acc.body.member.id as string,
    inviteCode: inv.body.invite_code as string,
  };
}

const ctx: Ctx = {} as Ctx;

test('1. bootstrap two families; lock setup afterwards', async () => {
  const app = makeApp();
  const a = await bootstrapFamily(app, 'Fam A', 'Mahesh', 'mahesh@a.dev');
  const b = await bootstrapFamily(app, 'Fam B', 'Stranger', 's@b.dev');
  ctx.app = app;
  ctx.famA = a.famId;
  ctx.famB = b.famId;
  ctx.ownerToken = a.token;
  ctx.ownerId = a.memberId;
  app.env.SETUP_LOCKED = '1';
  // v0.2.0+: locked creation requires auth now — no token is 401, and a
  // non-hub-owner token is 403. (Old behavior was a blanket 403.)
  const locked = await app.call('POST', '/v2/families', {
    body: { name: 'X', owner_name: 'X', owner_email: 'x@x.dev' },
  });
  assert.equal(locked.status, 401);
  assert.equal(locked.body.error.code, 'unauthorized');
});

test('2. invite parent + kid; parent cannot invite an owner; invite reuse denied', async () => {
  const { app, famA, ownerToken } = ctx;
  const parent = await inviteAccept(app, famA, ownerToken, 'lakshmi@a.dev', 'parent', 'Lakshmi');
  const kid = await inviteAccept(app, famA, ownerToken, 'harshika@a.dev', 'kid', 'Harshika');
  ctx.parentToken = parent.token;
  ctx.parentId = parent.memberId;
  ctx.kidToken = kid.token;
  ctx.kidId = kid.memberId;

  const noOwner = await app.call('POST', `/v2/families/${famA}/invites`, {
    token: ctx.parentToken,
    body: { email: 'x@a.dev', role: 'owner' },
  });
  assert.equal(noOwner.status, 403);

  const reuse = await app.call(
    'POST',
    `/v2/invites/${encodeURIComponent(kid.inviteCode)}/accept`,
    { body: { display_name: 'Again', agent_label: 'x' , agent_public_key: b64(32) } },
  );
  assert.equal(reuse.status, 409);
  assert.equal(reuse.body.error.code, 'invite_used');
});

test('3. parents_only topic: kid gets 403 on read/history/post; invisible in list', async () => {
  const { app, ownerToken, ownerId, kidToken } = ctx;
  const t = await app.call('POST', '/v2/topics', {
    token: ownerToken,
    body: {
      subject: 'Kyler planning',
      kind: 'group',
      participant_member_ids: [ownerId],
      parents_only: true,
    },
  });
  assert.equal(t.status, 201);
  ctx.parentTopic = t.body.topic.id as string;

  // parent auto-included via parents_only
  const meta = await app.call('GET', `/v2/topics/${ctx.parentTopic}`, { token: ctx.parentToken });
  assert.equal(meta.status, 200);

  for (const [m, p] of [
    ['GET', `/v2/topics/${ctx.parentTopic}`],
    ['GET', `/v2/topics/${ctx.parentTopic}/history`],
    ['POST', `/v2/topics/${ctx.parentTopic}/entries`],
  ] as const) {
    const r = await app.call(m, p, {
      token: kidToken,
      body: m === 'POST' ? { body: 'sneaky' } : undefined,
    });
    assert.equal(r.status, 403, `${m} ${p}`);
  }
  const list = await app.call('GET', '/v2/topics', { token: kidToken });
  assert.ok(!(list.body.topics as any[]).some((x) => x.id === ctx.parentTopic));
});

test('5. invite kid with from_join: old history hidden, new messages visible', async () => {
  const { app, ownerToken, ownerId, parentId, kidToken, kidId } = ctx;
  // regular (non-parents-only) topic for the from_join check
  const t = await app.call('POST', '/v2/topics', {
    token: ownerToken,
    body: {
      subject: 'General',
      kind: 'group',
      participant_member_ids: [ownerId, parentId],
    },
  });
  assert.equal(t.status, 201);
  const tid = t.body.topic.id as string;
  await app.call('POST', `/v2/topics/${tid}/entries`, {
    token: ownerToken,
    body: { body: 'Old message before the kid joined.' },
  });

  const inv = await app.call('POST', `/v2/topics/${tid}/invite`, {
    token: ownerToken,
    body: { member_ids: [kidId], history_from: 'from_join' },
  });
  assert.equal(inv.status, 200);

  const hist = await app.call('GET', `/v2/topics/${tid}/history`, { token: kidToken });
  assert.equal(hist.status, 200);
  const bodies = (hist.body.entries as any[]).map((e) => e.body as string);
  assert.ok(!bodies.some((b) => b.includes('Old message before the kid joined')), 'old message must stay hidden');
  assert.ok(bodies.some((b) => b.includes('joined the topic')));

  await app.call('POST', `/v2/topics/${tid}/entries`, {
    token: ownerToken,
    body: { body: 'Update for everyone: meeting Thursday.' },
  });
  const hist2 = await app.call('GET', `/v2/topics/${tid}/history`, { token: kidToken });
  assert.ok(
    (hist2.body.entries as any[]).some((e) => (e.body as string).includes('meeting Thursday')),
  );

  // inviting a kid into a parents-only topic stays forbidden
  const denied = await app.call('POST', `/v2/topics/${ctx.parentTopic}/invite`, {
    token: ownerToken,
    body: { member_ids: [kidId], history_from: 'full' },
  });
  assert.equal(denied.status, 403);
});

test('6. spawn linked child: kid reads child, still 403 on a fresh parent topic', async () => {
  const { app, ownerToken, ownerId, kidToken, kidId } = ctx;
  // fresh parents-only topic the kid is NOT in
  const pt = await app.call('POST', '/v2/topics', {
    token: ownerToken,
    body: {
      subject: 'Kyler private',
      kind: 'group',
      participant_member_ids: [ownerId],
      parents_only: true,
    },
  });
  const pid = pt.body.topic.id as string;
  await app.call('POST', `/v2/topics/${pid}/entries`, {
    token: ownerToken,
    body: { body: 'Private parent deliberation, kids must not see.' },
  });

  const spawn = await app.call('POST', `/v2/topics/${pid}/spawn`, {
    token: ownerToken,
    body: {
      subject: 'Kyler family chat',
      participant_member_ids: [kidId],
      briefing: 'We discussed Kyler\u2019s schedule. What you need to know: nothing changes this week.',
    },
  });
  assert.equal(spawn.status, 201);
  const childId = spawn.body.topic.id as string;
  assert.equal(spawn.body.topic.parent_topic_id, pid);

  const childHist = await app.call('GET', `/v2/topics/${childId}/history`, { token: kidToken });
  assert.equal(childHist.status, 200);
  const kinds = (childHist.body.entries as any[]).map((e) => e.kind);
  assert.deepEqual(kinds, ['briefing']);
  assert.ok(
    (childHist.body.entries as any[])[0].body.includes('nothing changes this week'),
  );

  const denied = await app.call('GET', `/v2/topics/${pid}/history`, { token: kidToken });
  assert.equal(denied.status, 403);
});

test('7. task delegation round-trip with structured result', async () => {
  const { app, ownerToken, kidToken, kidId } = ctx;
  const t = await app.call('POST', '/v2/topics', {
    token: ownerToken,
    body: { subject: 'Family trip', kind: 'group', participant_member_ids: [ctx.parentId, kidId] },
  });
  const tid = t.body.topic.id as string;

  const task = await app.call('POST', `/v2/topics/${tid}/tasks`, {
    token: ownerToken,
    body: { title: 'Plan family trip', description: 'March 2027 qualifier travel' },
  });
  const taskId = task.body.task.id as string;
  const sub = await app.call('POST', `/v2/topics/${tid}/tasks`, {
    token: ownerToken,
    body: {
      title: 'Check availability conflicts',
      parent_task_id: taskId,
      assignee_member_id: kidId,
    },
  });
  const subId = sub.body.task.id as string;

  // assignee sees the assignment in topic history
  const khist = await app.call('GET', `/v2/topics/${tid}/history`, { token: kidToken });
  assert.ok(
    (khist.body.entries as any[]).some(
      (e) => e.kind === 'task_created' && (e.data as any).task_id === subId,
    ),
  );

  const note = await app.call('POST', `/v2/tasks/${subId}/notes`, {
    token: kidToken,
    body: { body: 'Asked her — no conflicts that week.' },
  });
  assert.equal(note.status, 201);

  const early = await app.call('POST', `/v2/tasks/${taskId}/done`, { token: ownerToken, body: {} });
  assert.equal(early.status, 409);

  const doneSub = await app.call('POST', `/v2/tasks/${subId}/done`, {
    token: kidToken,
    body: { result: { conflicts: [] } },
  });
  assert.equal(doneSub.status, 200);
  const doneParent = await app.call('POST', `/v2/tasks/${taskId}/done`, {
    token: ownerToken,
    body: {},
  });
  assert.equal(doneParent.status, 200);
});

test('9. Plaintext PII posts rejected before storage', async () => {
  const { app, ownerToken } = ctx;
  const t = await app.call('POST', '/v2/topics', {
    token: ownerToken,
    body: { subject: 'pii', kind: 'group', participant_member_ids: [] },
  });
  const tid = t.body.topic.id as string;
  const card = await app.rawCall('POST', `/v2/topics/${tid}/entries`, {
    token: ownerToken,
    body: { body: 'card 4111 1111 1111 1111' },
  });
  assert.equal(card.status, 400);
  assert.equal(card.body.error.code, 'plaintext_in_e2ee_topic');
  const ssn = await app.rawCall('POST', `/v2/topics/${tid}/entries`, {
    token: ownerToken,
    body: { body: 'ssn 900-12-3456' },
  });
  assert.equal(ssn.status, 400);
  const hist = await app.rawCall('GET', `/v2/topics/${tid}/history`, { token: ownerToken });
  assert.ok(
    !(hist.body.entries as any[]).some((e) => (e.body as string).includes('4111')),
    'rejected PII must never be stored',
  );
});

test('11. cross-family access denied everywhere', async () => {
  const { app, famB } = ctx;
  // Mint a raw token for family B's member directly (provisioning code already used).
  const bMember = (await app.db.queryOne(`SELECT id FROM members WHERE family_id=?`, [famB]))!['id'] as string;
  const rawB = 'fh_' + 'b'.repeat(43);
  const { sha256hex } = await import('../src/auth.js');
  const pepper = app.env.TOKEN_PEPPER;
  await app.db.execAtomically([
    {
      sql: `INSERT INTO agent_tokens(token_hash, token_id, member_id, agent_label, created_at, revoked_at, last_used_at)
            VALUES (?,?,?,'b-agent',?,NULL,NULL)`,
      params: [await sha256hex(pepper + rawB), 'tok-b-1', bMember, new Date().toISOString()],
    },
  ]);

  const r1 = await app.call('GET', `/v2/topics/${ctx.parentTopic}`, { token: rawB });
  assert.equal(r1.status, 404); // family-scoped lookup: not found, not 403
  const r2 = await app.call('POST', `/v2/topics/${ctx.parentTopic}/entries`, {
    token: rawB,
    body: { body: 'intruder' },
  });
  assert.ok(r2.status === 403 || r2.status === 404);
  const r3 = await app.call('GET', '/v2/members', { token: rawB });
  assert.ok(!(r3.body.members as any[]).some((m: any) => m.email === 'mahesh@a.dev'));
});

// ---------------------------------------------------------------------------
// Sync v2 + E2EE rotation end-to-end (spec §5: "add v2 + rotation e2e").
// ---------------------------------------------------------------------------

function iB64(n: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return btoa(String.fromCharCode(...bytes));
}
function iHex(n: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
function iWire(keyId: string): string {
  return `fh1.${keyId}.${iHex(16)}.${iB64(40)}`;
}

test('20. sync v2 journey: changed-topic discovery -> read -> receipt -> ack -> quiet', async () => {
  const { app, ownerToken, parentToken, parentId } = ctx;
  const t = await app.call('POST', '/v2/topics', {
    token: ownerToken,
    body: { subject: 'v2 journey', kind: 'group', participant_member_ids: [parentId] },
  });
  assert.equal(t.status, 201);
  const tid = t.body.topic.id as string;
  // Parent posts (not owner): owner should see these as new. Own posts
  // never flag a topic as changed (server excludes self from new_count).
  await app.call('POST', `/v2/topics/${tid}/entries`, {
    token: parentToken,
    body: { body: 'first' },
  });
  await app.call('POST', `/v2/topics/${tid}/entries`, {
    token: parentToken,
    body: { body: 'second' },
  });

  // Changed-topic discovery (per-circle token).
  const s1 = await app.call('GET', '/v2/sync/topics', { token: ownerToken });
  assert.equal(s1.status, 200);
  const found = (s1.body.topics as any[]).find((x) => x.topic_id === tid);
  assert.ok(found, 'new topic is reported as changed');
  assert.equal(found.new_count, 2);
  assert.equal(found.acked_seq, 0);
  assert.equal(found.key_status, 'ok');
  assert.equal(found.circle_id, ctx.famA);

  // Read in order, ack with the receipt: the topic goes quiet.
  const h = await app.call('GET', `/v2/topics/${tid}/history`, { token: ownerToken });
  assert.equal(h.status, 200);
  assert.ok((h.body.read_receipt as string).startsWith('fhrr1.'), 'history issues a receipt');
  const ack = await app.call('POST', `/v2/topics/${tid}/ack`, {
    token: ownerToken,
    body: { seq: h.body.read_through_seq, read_receipt: h.body.read_receipt },
  });
  assert.equal(ack.status, 200);
  assert.equal(ack.body.acked_seq, 2);
  const s2 = await app.call('GET', '/v2/sync/topics', { token: ownerToken });
  assert.ok(!(s2.body.topics as any[]).some((x: any) => x.topic_id === tid), 'acked topic drops out');

  // New activity re-lists it with a fresh count (parent posts again).
  await app.call('POST', `/v2/topics/${tid}/entries`, {
    token: parentToken,
    body: { body: 'third' },
  });
  const s3 = await app.call('GET', '/v2/sync/topics', { token: ownerToken });
  const again = (s3.body.topics as any[]).find((x: any) => x.topic_id === tid);
  assert.ok(again);
  assert.equal(again.new_count, 1);
});

test('21. E2EE rotation e2e: genesis -> encrypted write -> removal gates -> rekey resumes', async () => {
  const { app, ownerToken, parentToken, parentId } = ctx;
  // Register identity keys for the two agents (owner + parent).
  for (const tok of [ownerToken, parentToken]) {
    const rk = await app.call('POST', '/v2/agent-keys/rotate', {
      token: tok,
      body: { agent_public_key: iB64(32) },
    });
    assert.equal(rk.status, 200);
  }
  const t = await app.rawCall('POST', '/v2/topics', {
    token: ownerToken,
    body: {
      topic_id:iHex(16), subject: iWire(iHex(16)),
      kind: 'group',
      participant_member_ids: [parentId],
    },
  });
  assert.equal(t.status, 201);
  const tid = t.body.topic.id as string;

  // Genesis: stage envelopes for owner + parent, commit epoch 1.
  const me = await app.call('GET', '/v2/me', { token: ownerToken });
  const meP = await app.call('GET', '/v2/me', { token: parentToken });
  const ownerLabel = me.body.agent_label as string;
  const parentLabel = meP.body.agent_label as string;
  const ownerMid = me.body.id as string;
  const k1 = iHex(16);
  for (const [mid, label] of [
    [ownerMid, ownerLabel],
    [parentId, parentLabel],
  ] as const) {
    const e = await app.call('POST', `/v2/topics/${tid}/envelopes`, {
      token: ownerToken,
      body: { member_id: mid, agent_label: label, key_id: k1, envelope: iB64(96) },
    });
    assert.equal(e.status, 201);
  }
  const c1 = await app.call('POST', `/v2/topics/${tid}/keys/commit`, {
    token: ownerToken,
    body: { expected_epoch: 1, key_id: k1, subject: wireBody(k1), commitment: iHex(32) },
  });
  assert.equal(c1.status, 200);

  // Encrypted writes flow.
  const w1 = await app.call('POST', `/v2/topics/${tid}/entries`, {
    token: ownerToken,
    body: { kind: 'message', body: iWire(k1) },
  });
  assert.equal(w1.status, 201);

  // Removal gates encrypted writes until a fresh key commits.
  const rem = await app.call('DELETE', `/v2/topics/${tid}/participants/${parentId}`, {
    token: ownerToken,
  });
  assert.equal(rem.status, 200);
  const gated = await app.call('POST', `/v2/topics/${tid}/entries`, {
    token: ownerToken,
    body: { kind: 'message', body: iWire(k1) },
  });
  assert.equal(gated.status, 409);
  assert.equal(gated.body.error.code, 'rotation_required');

  // Rekey with fresh material (the removed parent is not staged): writes resume.
  const k2 = iHex(16);
  const e2 = await app.call('POST', `/v2/topics/${tid}/envelopes`, {
    token: ownerToken,
    body: { member_id: ownerMid, agent_label: ownerLabel, key_id: k2, envelope: iB64(96) },
  });
  assert.equal(e2.status, 201);
  const c2 = await app.call('POST', `/v2/topics/${tid}/keys/commit`, {
    token: ownerToken,
    body: { expected_epoch: 2, key_id: k2, subject: wireBody(k2), commitment: iHex(32) },
  });
  assert.equal(c2.status, 200);
  const w2 = await app.call('POST', `/v2/topics/${tid}/entries`, {
    token: ownerToken,
    body: { kind: 'message', body: iWire(k2) },
  });
  assert.equal(w2.status, 201);

  // The removed parent is locked out and holds no new-key envelope.
  const gone = await app.call('GET', `/v2/topics/${tid}/history`, { token: parentToken });
  assert.equal(gone.status, 403);
});
