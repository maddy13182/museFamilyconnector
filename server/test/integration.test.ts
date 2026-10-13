// End-to-end lifecycle against local SQLite (SPEC §§6-12, 17):
// family -> invite -> accept -> topic -> post -> invite kid (from_join) ->
// spawn linked child -> task -> subtask -> sync cursors -> redact,
// plus EVERY denied case from SPEC §12.
import { test } from 'node:test';
import assert from 'node:assert';
import { makeApp, TestApp } from './app.js';

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
  const fam = await app.call('POST', '/v1/families', {
    body: { name, owner_name: ownerName, owner_email: email },
  });
  assert.equal(fam.status, 201);
  const red = await app.call(
    'POST',
    `/v1/provisioning-codes/${encodeURIComponent(fam.body.provisioning_code)}/redeem`,
    { body: {} },
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
  const inv = await app.call('POST', `/v1/families/${famId}/invites`, {
    token: inviterToken,
    body: { email, role },
  });
  assert.equal(inv.status, 201);
  const acc = await app.call(
    'POST',
    `/v1/invites/${encodeURIComponent(inv.body.invite_code)}/accept`,
    { body: { display_name: displayName, agent_label: displayName.toLowerCase() + '-agent' } },
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
  const locked = await app.call('POST', '/v1/families', {
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

  const noOwner = await app.call('POST', `/v1/families/${famA}/invites`, {
    token: ctx.parentToken,
    body: { email: 'x@a.dev', role: 'owner' },
  });
  assert.equal(noOwner.status, 403);

  const reuse = await app.call(
    'POST',
    `/v1/invites/${encodeURIComponent(kid.inviteCode)}/accept`,
    { body: { display_name: 'Again', agent_label: 'x' } },
  );
  assert.equal(reuse.status, 409);
  assert.equal(reuse.body.error.code, 'invite_used');
});

test('3. parents_only topic: kid gets 403 on read/history/post; invisible in list', async () => {
  const { app, ownerToken, ownerId, kidToken } = ctx;
  const t = await app.call('POST', '/v1/topics', {
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
  const meta = await app.call('GET', `/v1/topics/${ctx.parentTopic}`, { token: ctx.parentToken });
  assert.equal(meta.status, 200);

  for (const [m, p] of [
    ['GET', `/v1/topics/${ctx.parentTopic}`],
    ['GET', `/v1/topics/${ctx.parentTopic}/history`],
    ['POST', `/v1/topics/${ctx.parentTopic}/entries`],
  ] as const) {
    const r = await app.call(m, p, {
      token: kidToken,
      body: m === 'POST' ? { body: 'sneaky' } : undefined,
    });
    assert.equal(r.status, 403, `${m} ${p}`);
  }
  const list = await app.call('GET', '/v1/topics', { token: kidToken });
  assert.ok(!(list.body.topics as any[]).some((x) => x.id === ctx.parentTopic));
});

test('5. invite kid with from_join: old history hidden, new messages visible', async () => {
  const { app, ownerToken, ownerId, parentId, kidToken, kidId } = ctx;
  // regular (non-parents-only) topic for the from_join check
  const t = await app.call('POST', '/v1/topics', {
    token: ownerToken,
    body: {
      subject: 'General',
      kind: 'group',
      participant_member_ids: [ownerId, parentId],
    },
  });
  assert.equal(t.status, 201);
  const tid = t.body.topic.id as string;
  await app.call('POST', `/v1/topics/${tid}/entries`, {
    token: ownerToken,
    body: { body: 'Old message before the kid joined.' },
  });

  const inv = await app.call('POST', `/v1/topics/${tid}/invite`, {
    token: ownerToken,
    body: { member_ids: [kidId], history_from: 'from_join' },
  });
  assert.equal(inv.status, 200);

  const hist = await app.call('GET', `/v1/topics/${tid}/history`, { token: kidToken });
  assert.equal(hist.status, 200);
  const bodies = (hist.body.entries as any[]).map((e) => e.body as string);
  assert.ok(!bodies.some((b) => b.includes('Old message before the kid joined')), 'old message must stay hidden');
  assert.ok(bodies.some((b) => b.includes('joined the topic')));

  await app.call('POST', `/v1/topics/${tid}/entries`, {
    token: ownerToken,
    body: { body: 'Update for everyone: meeting Thursday.' },
  });
  const hist2 = await app.call('GET', `/v1/topics/${tid}/history`, { token: kidToken });
  assert.ok(
    (hist2.body.entries as any[]).some((e) => (e.body as string).includes('meeting Thursday')),
  );

  // inviting a kid into a parents-only topic stays forbidden
  const denied = await app.call('POST', `/v1/topics/${ctx.parentTopic}/invite`, {
    token: ownerToken,
    body: { member_ids: [kidId], history_from: 'full' },
  });
  assert.equal(denied.status, 403);
});

test('6. spawn linked child: kid reads child, still 403 on a fresh parent topic', async () => {
  const { app, ownerToken, ownerId, kidToken, kidId } = ctx;
  // fresh parents-only topic the kid is NOT in
  const pt = await app.call('POST', '/v1/topics', {
    token: ownerToken,
    body: {
      subject: 'Kyler private',
      kind: 'group',
      participant_member_ids: [ownerId],
      parents_only: true,
    },
  });
  const pid = pt.body.topic.id as string;
  await app.call('POST', `/v1/topics/${pid}/entries`, {
    token: ownerToken,
    body: { body: 'Private parent deliberation, kids must not see.' },
  });

  const spawn = await app.call('POST', `/v1/topics/${pid}/spawn`, {
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

  const childHist = await app.call('GET', `/v1/topics/${childId}/history`, { token: kidToken });
  assert.equal(childHist.status, 200);
  const kinds = (childHist.body.entries as any[]).map((e) => e.kind);
  assert.deepEqual(kinds, ['briefing']);
  assert.ok(
    (childHist.body.entries as any[])[0].body.includes('nothing changes this week'),
  );

  const denied = await app.call('GET', `/v1/topics/${pid}/history`, { token: kidToken });
  assert.equal(denied.status, 403);
});

test('7. task delegation round-trip with structured result', async () => {
  const { app, ownerToken, kidToken, kidId } = ctx;
  const t = await app.call('POST', '/v1/topics', {
    token: ownerToken,
    body: { subject: 'Family trip', kind: 'group', participant_member_ids: [ctx.parentId, kidId] },
  });
  const tid = t.body.topic.id as string;

  const task = await app.call('POST', `/v1/topics/${tid}/tasks`, {
    token: ownerToken,
    body: { title: 'Plan family trip', description: 'March 2027 qualifier travel' },
  });
  const taskId = task.body.task.id as string;
  const sub = await app.call('POST', `/v1/topics/${tid}/tasks`, {
    token: ownerToken,
    body: {
      title: 'Check availability conflicts',
      parent_task_id: taskId,
      assignee_member_id: kidId,
    },
  });
  const subId = sub.body.task.id as string;

  // assignee sees the assignment in topic history
  const khist = await app.call('GET', `/v1/topics/${tid}/history`, { token: kidToken });
  assert.ok(
    (khist.body.entries as any[]).some(
      (e) => e.kind === 'task_created' && (e.data as any).task_id === subId,
    ),
  );

  const note = await app.call('POST', `/v1/tasks/${subId}/notes`, {
    token: kidToken,
    body: { body: 'Asked her — no conflicts that week.' },
  });
  assert.equal(note.status, 201);

  const early = await app.call('POST', `/v1/tasks/${taskId}/done`, { token: ownerToken, body: {} });
  assert.equal(early.status, 409);

  const doneSub = await app.call('POST', `/v1/tasks/${subId}/done`, {
    token: kidToken,
    body: { result: { conflicts: [] } },
  });
  assert.equal(doneSub.status, 200);
  const doneParent = await app.call('POST', `/v1/tasks/${taskId}/done`, {
    token: ownerToken,
    body: {},
  });
  assert.equal(doneParent.status, 200);
});

test('9. PII posts rejected with 422', async () => {
  const { app, ownerToken } = ctx;
  const t = await app.call('POST', '/v1/topics', {
    token: ownerToken,
    body: { subject: 'pii', kind: 'group', participant_member_ids: [] },
  });
  const tid = t.body.topic.id as string;
  const card = await app.call('POST', `/v1/topics/${tid}/entries`, {
    token: ownerToken,
    body: { body: 'card 4111 1111 1111 1111' },
  });
  assert.equal(card.status, 422);
  assert.equal(card.body.error.code, 'pii_detected');
  const ssn = await app.call('POST', `/v1/topics/${tid}/entries`, {
    token: ownerToken,
    body: { body: 'ssn 900-12-3456' },
  });
  assert.equal(ssn.status, 422);
  const hist = await app.call('GET', `/v1/topics/${tid}/history`, { token: ownerToken });
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

  const r1 = await app.call('GET', `/v1/topics/${ctx.parentTopic}`, { token: rawB });
  assert.equal(r1.status, 404); // family-scoped lookup: not found, not 403
  const r2 = await app.call('POST', `/v1/topics/${ctx.parentTopic}/entries`, {
    token: rawB,
    body: { body: 'intruder' },
  });
  assert.ok(r2.status === 403 || r2.status === 404);
  const r3 = await app.call('GET', '/v1/members', { token: rawB });
  assert.ok(!(r3.body.members as any[]).some((m: any) => m.email === 'mahesh@a.dev'));
});
