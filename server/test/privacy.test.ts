// Tests: Phase C privacy boundaries.
// F06 — the from-join history floor must apply to the task list (not just
// entry reads), and the cutoff must be computed inside the membership
// insert transaction. (The bare task GET, topic export, and entry redact
// endpoints that F06 once covered were deleted per spec §1.6 — the last
// section below asserts the deletions hold.)
// F08 — the PII guard must cover entry.data string leaves, task titles, and
// task completion results.
import { test } from 'node:test';
import assert from 'node:assert';
import { makeApp, TestApp } from './app.js';

async function bootstrap(): Promise<{
  app: TestApp;
  famId: string;
  ownerToken: string;
  ownerId: string;
}> {
  const app = makeApp();
  const fam = await app.call('POST', '/v1/families', {
    body: { name: 'F', owner_name: 'Mahesh', owner_email: 'm@t.dev' },
  });
  assert.equal(fam.status, 201);
  const red = await app.call(
    'POST',
    `/v1/provisioning-codes/${encodeURIComponent(fam.body.provisioning_code)}/redeem`,
    { body: {} },
  );
  assert.equal(red.status, 201);
  return {
    app,
    famId: fam.body.family.id as string,
    ownerToken: red.body.token as string,
    ownerId: red.body.member.id as string,
  };
}

async function inviteMember(
  app: TestApp,
  famId: string,
  ownerToken: string,
  email: string,
  name: string,
): Promise<{ token: string; id: string }> {
  const inv = await app.call('POST', `/v1/families/${famId}/invites`, {
    token: ownerToken,
    body: { email, role: 'kid' },
  });
  assert.equal(inv.status, 201);
  const acc = await app.call(
    'POST',
    `/v1/invites/${encodeURIComponent(inv.body.invite_code)}/accept`,
    { body: { display_name: name, agent_label: `${name.toLowerCase()}-agent` } },
  );
  assert.equal(acc.status, 201);
  return { token: acc.body.token as string, id: acc.body.member.id as string };
}

async function makeTopic(app: TestApp, ownerToken: string, ownerId: string, ids: string[]): Promise<string> {
  const t = await app.call('POST', '/v1/topics', {
    token: ownerToken,
    body: { subject: 'Trip', kind: 'group', participant_member_ids: [ownerId, ...ids] },
  });
  assert.equal(t.status, 201);
  return t.body.topic.id as string;
}

// ---------------------------------------------------------------------------
// F06
// ---------------------------------------------------------------------------

test('F06: from_join member cannot read pre-join tasks via list', async () => {
  const { app, famId, ownerToken, ownerId } = await bootstrap();
  const kid1 = await inviteMember(app, famId, ownerToken, 'k1@t.dev', 'Kid1');
  const tid = await makeTopic(app, ownerToken, ownerId, [kid1.id]);

  await app.call('POST', `/v1/topics/${tid}/entries`, {
    token: ownerToken,
    body: { body: 'Old message before anyone else joined.' },
  });
  const t1 = await app.call('POST', `/v1/topics/${tid}/tasks`, {
    token: ownerToken,
    body: { title: 'Pre-join task' },
  });
  assert.equal(t1.status, 201);
  const t1id = t1.body.task.id as string;

  // Kid2 joins later with history_from=from_join.
  const kid2 = await inviteMember(app, famId, ownerToken, 'k2@t.dev', 'Kid2');
  const inv = await app.call('POST', `/v1/topics/${tid}/invite`, {
    token: ownerToken,
    body: { member_ids: [kid2.id], history_from: 'from_join' },
  });
  assert.equal(inv.status, 200);

  // 1. list hides the pre-join task.
  const list = await app.call('GET', `/v1/topics/${tid}/tasks`, { token: kid2.token });
  assert.equal(list.status, 200);
  assert.ok(
    !(list.body.tasks as any[]).some((t) => t.id === t1id),
    'pre-join task must be absent from the task list',
  );

  // A task created AFTER the join is visible via list.
  const t2 = await app.call('POST', `/v1/topics/${tid}/tasks`, {
    token: ownerToken,
    body: { title: 'Post-join task' },
  });
  assert.equal(t2.status, 201);
  const t2id = t2.body.task.id as string;

  const list2 = await app.call('GET', `/v1/topics/${tid}/tasks`, { token: kid2.token });
  assert.ok((list2.body.tasks as any[]).some((t) => t.id === t2id), 'post-join task visible in list');

  // The original participant (floor=1) still sees the pre-join task everywhere.
  const listK1 = await app.call('GET', `/v1/topics/${tid}/tasks`, { token: kid1.token });
  assert.ok((listK1.body.tasks as any[]).some((t) => t.id === t1id), 'original member still sees pre-join task in list');
});

test('F06: from_join member cannot use write paths as a read oracle for pre-join tasks', async () => {
  const { app, famId, ownerToken, ownerId } = await bootstrap();
  const kid1 = await inviteMember(app, famId, ownerToken, 'k1@t.dev', 'Kid1');
  const tid = await makeTopic(app, ownerToken, ownerId, [kid1.id]);

  const t1 = await app.call('POST', `/v1/topics/${tid}/tasks`, {
    token: ownerToken,
    body: { title: 'Pre-join task' },
  });
  assert.equal(t1.status, 201);
  const t1id = t1.body.task.id as string;

  const kid2 = await inviteMember(app, famId, ownerToken, 'k2@t.dev', 'Kid2');
  const inv = await app.call('POST', `/v1/topics/${tid}/invite`, {
    token: ownerToken,
    body: { member_ids: [kid2.id], history_from: 'from_join' },
  });
  assert.equal(inv.status, 200);

  // done and note paths are gated.
  const done = await app.call('POST', `/v1/tasks/${t1id}/done`, {
    token: kid2.token,
    body: {},
  });
  assert.equal(done.status, 404);
  const note = await app.call('POST', `/v1/tasks/${t1id}/notes`, {
    token: kid2.token,
    body: { body: 'hello' },
  });
  assert.equal(note.status, 404);
});

test('F06: history_from=full invite still sees pre-join tasks', async () => {  const { app, famId, ownerToken, ownerId } = await bootstrap();
  const kid1 = await inviteMember(app, famId, ownerToken, 'k1@t.dev', 'Kid1');
  const tid = await makeTopic(app, ownerToken, ownerId, [kid1.id]);
  const t1 = await app.call('POST', `/v1/topics/${tid}/tasks`, {
    token: ownerToken,
    body: { title: 'Pre-join task' },
  });
  const t1id = t1.body.task.id as string;

  const kid2 = await inviteMember(app, famId, ownerToken, 'k2@t.dev', 'Kid2');
  const inv = await app.call('POST', `/v1/topics/${tid}/invite`, {
    token: ownerToken,
    body: { member_ids: [kid2.id], history_from: 'full' },
  });
  assert.equal(inv.status, 200);

  const list = await app.call('GET', `/v1/topics/${tid}/tasks`, { token: kid2.token });
  assert.ok((list.body.tasks as any[]).some((t) => t.id === t1id), 'full-history invite sees pre-join task in list');
});

// ---------------------------------------------------------------------------
// F08
// ---------------------------------------------------------------------------

test('F08: PII-shaped values in entry.data are rejected (422)', async () => {
  const { app, ownerToken, ownerId } = await bootstrap();
  const tid = await makeTopic(app, ownerToken, ownerId, []);

  const ssn = await app.call('POST', `/v1/topics/${tid}/entries`, {
    token: ownerToken,
    body: { body: 'clean body', data: { note: 'member ssn 900-12-3456 on file' } },
  });
  assert.equal(ssn.status, 422);
  assert.equal(ssn.body.error.code, 'pii_detected');

  const nested = await app.call('POST', `/v1/topics/${tid}/entries`, {
    token: ownerToken,
    body: { body: 'clean', data: { deep: { list: ['ok', 'card 4111 1111 1111 1111'] } } },
  });
  assert.equal(nested.status, 422);
  assert.equal(nested.body.error.code, 'pii_detected');

  const clean = await app.call('POST', `/v1/topics/${tid}/entries`, {
    token: ownerToken,
    body: { body: 'clean', data: { note: 'pick up milk', count: 3 } },
  });
  assert.equal(clean.status, 201);
});

test('F08: PII-shaped task titles are rejected on create', async () => {
  const { app, ownerToken, ownerId } = await bootstrap();
  const tid = await makeTopic(app, ownerToken, ownerId, []);

  const badCreate = await app.call('POST', `/v1/topics/${tid}/tasks`, {
    token: ownerToken,
    body: { title: 'File SSN 900-12-3456 today' },
  });
  assert.equal(badCreate.status, 422);
  assert.equal(badCreate.body.error.code, 'pii_detected');

  const ok = await app.call('POST', `/v1/topics/${tid}/tasks`, {
    token: ownerToken,
    body: { title: 'File the paperwork today' },
  });
  assert.equal(ok.status, 201);
});

test('F08: PII-shaped completion results are rejected; clean results pass', async () => {
  const { app, ownerToken, ownerId } = await bootstrap();
  const tid = await makeTopic(app, ownerToken, ownerId, []);
  const t = await app.call('POST', `/v1/topics/${tid}/tasks`, {
    token: ownerToken,
    body: { title: 'Do it' },
  });
  const taskId = t.body.task.id as string;

  const bad = await app.call('POST', `/v1/tasks/${taskId}/done`, {
    token: ownerToken,
    body: { result: { summary: 'paid, ssn 900-12-3456 verified' } },
  });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.error.code, 'pii_detected');

  const good = await app.call('POST', `/v1/tasks/${taskId}/done`, {
    token: ownerToken,
    body: { result: { summary: 'all done', items: 2 } },
  });
  assert.equal(good.status, 200);
  assert.deepEqual(good.body.task.result, { summary: 'all done', items: 2 });
});

// ---------------------------------------------------------------------------
// Spec §1.6 deletions hold: redact / export / bare task GET+PATCH are gone.
// ---------------------------------------------------------------------------

test('deleted endpoints stay deleted: redact, export, bare task GET/PATCH', async () => {
  const { app, ownerToken, ownerId } = await bootstrap();
  const tid = await makeTopic(app, ownerToken, ownerId, []);
  const entry = await app.call('POST', `/v1/topics/${tid}/entries`, {
    token: ownerToken,
    body: { body: 'some entry' },
  });
  assert.equal(entry.status, 201);
  const gseq = entry.body.entry.gseq as number;
  const task = await app.call('POST', `/v1/topics/${tid}/tasks`, {
    token: ownerToken,
    body: { title: 'some task' },
  });
  const taskId = task.body.task.id as string;

  // POST /v1/entries/:eid/redact — deleted (no client).
  for (const tok of [ownerToken]) {
    const r = await app.call('POST', `/v1/entries/${gseq}/redact`, { token: tok, body: {} });
    assert.equal(r.status, 404, 'redact must stay deleted');
  }
  // GET /v1/topics/:tid/export — deleted (no client).
  const exp = await app.call('GET', `/v1/topics/${tid}/export`, { token: ownerToken });
  assert.equal(exp.status, 404, 'export must stay deleted');
  // GET / PATCH /v1/tasks/:tid — deleted (the CLI uses notes/done).
  for (const method of ['GET', 'PATCH'] as const) {
    const r = await app.call(method, `/v1/tasks/${taskId}`, {
      token: ownerToken,
      body: method === 'PATCH' ? { title: 'x' } : undefined,
    });
    assert.equal(r.status, 404, `${method} /v1/tasks/:id must stay deleted`);
  }
  // The task sub-paths that remain still work (notes/done are not bare-task).
  const note = await app.call('POST', `/v1/tasks/${taskId}/notes`, {
    token: ownerToken,
    body: { body: 'still here' },
  });
  assert.equal(note.status, 201);
});
