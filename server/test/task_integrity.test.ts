// Tests: Phase F task integrity (audit F12-remainder, F13, F14).
// - state + event + idempotency outcome commit in one atomic batch
// - task_created carries full fields (read back via history — the bare
//   GET/PATCH /v1/tasks/:tid endpoints were deleted in sync v2, spec §1.6)
// - malformed completion JSON -> 400; absent body is fine
// - open child under a done parent is denied
// - subtask/completion checks are atomic with their writes
import { test } from 'node:test';
import assert from 'node:assert';
import { handleRequest } from '../src/index.js';
import { DbClient } from '../src/types.js';
import { makeApp, TestApp } from './app.js';

async function setup(): Promise<{ app: TestApp; token: string; topicId: string }> {
  const app = makeApp();
  const fam = await app.call('POST', '/v1/families', {
    body: { name: 'F', owner_name: 'Mahesh', owner_email: 'm@t.dev' },
  });
  const red = await app.call(
    'POST',
    `/v1/provisioning-codes/${encodeURIComponent(fam.body.provisioning_code)}/redeem`,
    { body: {} },
  );
  const token = red.body.token as string;
  const meId = red.body.member.id as string;
  const topic = await app.call('POST', '/v1/topics', {
    token,
    body: { subject: 'Chores', kind: 'group', participant_member_ids: [meId] },
  });
  assert.equal(topic.status, 201);
  return { app, token, topicId: topic.body.topic.id as string };
}

async function createTask(
  app: TestApp,
  token: string,
  topicId: string,
  body: Record<string, unknown>,
): Promise<string> {
  const r = await app.call('POST', `/v1/topics/${topicId}/tasks`, { token, body });
  assert.equal(r.status, 201, `task create failed: ${JSON.stringify(r.body)}`);
  return r.body.task.id as string;
}

/** Drive handleRequest with a chosen DbClient (lets tests fault-inject). */
async function rawCall(
  app: TestApp,
  db: DbClient,
  method: string,
  path: string,
  token: string | null,
  rawBody: string | null,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const h: Record<string, string> = { ...headers };
  if (token) h['authorization'] = `Bearer ${token}`;
  if (rawBody !== null) h['content-type'] = 'application/json';
  const req = new Request(`https://hub.test${path}`, {
    method,
    headers: h,
    body: rawBody === null ? undefined : rawBody,
  });
  const res = await handleRequest(req, db, app.env);
  const text = await res.text();
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

/** Wrap a DbClient so execAtomically throws when an op matches. */
function sabotage(
  db: DbClient,
  match: (op: { sql: string; params?: unknown[] }) => boolean,
  err: Error = new Error('injected write failure'),
): DbClient {
  return {
    ...db,
    execAtomically: async (ops) => {
      if (ops.some((o) => match(o as { sql: string; params?: unknown[] }))) throw err;
      return db.execAtomically(ops);
    },
  };
}

async function count(
  app: TestApp,
  sql: string,
  params: (string | number | null)[] = [],
): Promise<number> {
  const row = await app.db.queryOne(sql, params);
  return (row?.['c'] as number) ?? 0;
}

test('F12: task create + task_created commit atomically (event write fails -> no task)', async () => {
  const { app, token, topicId } = await setup();
  const bad = sabotage(app.db, (o) => (o.params ?? []).includes('task_created'));
  const r = await rawCall(app, bad, 'POST', `/v1/topics/${topicId}/tasks`, token, JSON.stringify({ title: 'Orphan?' }));
  assert.equal(r.status, 500);
  assert.equal(await count(app, `SELECT COUNT(*) AS c FROM tasks`), 0);
  assert.equal(await count(app, `SELECT COUNT(*) AS c FROM entries WHERE topic_id = ?`, [topicId]), 0);
});

test('F12: task_done and its event are one batch (event write fails -> still open)', async () => {
  const { app, token, topicId } = await setup();
  const tid = await createTask(app, token, topicId, { title: 'Do dishes' });
  const bad = sabotage(app.db, (o) => (o.params ?? []).includes('task_done'));
  const r = await rawCall(app, bad, 'POST', `/v1/tasks/${tid}/done`, token, JSON.stringify({}));
  assert.equal(r.status, 500);
  const row = await app.db.queryOne(`SELECT status FROM tasks WHERE id = ?`, [tid]);
  assert.equal(row?.['status'], 'open');
  assert.equal(
    await count(
      app,
      `SELECT COUNT(*) AS c FROM entries WHERE json_extract(data, '$.task_id') = ? AND kind = 'task_done'`,
      [tid],
    ),
    0,
  );
});

test('F12: seq-collision retry recovers without duplicating task or event', async () => {
  const { app, token, topicId } = await setup();
  let calls = 0;
  const flaky: DbClient = {
    ...app.db,
    execAtomically: async (ops) => {
      calls++;
      if (calls === 1) throw new Error('UNIQUE constraint failed: entries.topic_id, entries.seq');
      return app.db.execAtomically(ops);
    },
  };
  const r = await rawCall(app, flaky, 'POST', `/v1/topics/${topicId}/tasks`, token, JSON.stringify({ title: 'Retry me' }));
  assert.equal(r.status, 201);
  const tid = r.body.task.id as string;
  assert.equal(await count(app, `SELECT COUNT(*) AS c FROM tasks WHERE id = ?`, [tid]), 1);
  assert.equal(
    await count(
      app,
      `SELECT COUNT(*) AS c FROM entries WHERE kind = 'task_created' AND json_extract(data, '$.task_id') = ?`,
      [tid],
    ),
    1,
  );
});

test('F12: entry + idempotency record are one batch (key write fails -> no entry)', async () => {
  const { app, token, topicId } = await setup();
  const bad = sabotage(app.db, (o) => o.sql.includes('idempotency_keys'));
  const r = await rawCall(
    app, bad, 'POST', `/v1/topics/${topicId}/entries`, token,
    JSON.stringify({ body: 'hello' }), { 'idempotency-key': 'k-1' },
  );
  assert.equal(r.status, 500);
  assert.equal(await count(app, `SELECT COUNT(*) AS c FROM entries WHERE topic_id = ?`, [topicId]), 0);
  assert.equal(await count(app, `SELECT COUNT(*) AS c FROM idempotency_keys`), 0);
});

test('F12: entry idempotency happy path still dedups on the retry key', async () => {
  const { app, token, topicId } = await setup();
  const first = await app.call('POST', `/v1/topics/${topicId}/entries`, {
    token,
    body: { body: 'once' },
    headers: { 'idempotency-key': 'dup-1' },
  });
  assert.equal(first.status, 201);
  const again = await app.call('POST', `/v1/topics/${topicId}/entries`, {
    token,
    body: { body: 'once' },
    headers: { 'idempotency-key': 'dup-1' },
  });
  assert.equal(again.status, 200);
  assert.equal(again.body.deduped, true);
  assert.equal(again.body.entry.gseq, first.body.entry.gseq);
  assert.equal(await count(app, `SELECT COUNT(*) AS c FROM entries WHERE topic_id = ?`, [topicId]), 1);
});

test('F13: task_created carries the full task fields', async () => {
  const { app, token, topicId } = await setup();
  const created = await app.call('POST', `/v1/topics/${topicId}/tasks`, {
    token,
    body: { title: 'Pack bags', description: 'For the trip', due_at: '2027-03-05' },
  });
  assert.equal(created.status, 201);
  const tid = created.body.task.id as string;
  const hist = await app.call('GET', `/v1/topics/${topicId}/history`, { token });
  const ev = (hist.body.entries as any[]).find((e) => e.kind === 'task_created');
  assert.ok(ev, 'task_created must be in history');
  assert.equal(ev.data.task_id, tid);
  assert.equal(ev.data.title, 'Pack bags');
  assert.equal(ev.data.description, 'For the trip');
  assert.equal(ev.data.due_at, created.body.task.due_at);
  assert.equal(ev.data.status, 'open');
  assert.equal(ev.data.owner_member_id, created.body.task.owner_member_id);
  assert.equal(ev.data.assignee_member_id, null);
  assert.equal(ev.data.parent_task_id, null);
  assert.equal(ev.data.created_by, created.body.task.created_by);
  assert.equal(ev.data.created_at, created.body.task.created_at);
});

test('F14: malformed completion JSON is 400; absent body is fine', async () => {
  const { app, token, topicId } = await setup();
  const tid = await createTask(app, token, topicId, { title: 'Finish me' });
  const bad = await rawCall(app, app.db, 'POST', `/v1/tasks/${tid}/done`, token, '{not json');
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'bad_request');
  const nonObject = await rawCall(app, app.db, 'POST', `/v1/tasks/${tid}/done`, token, '[1,2]');
  assert.equal(nonObject.status, 400);
  // Absent body completes the task (result stays null).
  const ok = await rawCall(app, app.db, 'POST', `/v1/tasks/${tid}/done`, token, null);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.task.status, 'done');
  assert.equal(ok.body.task.result, null);
});

test('F14: open child under a done parent is denied', async () => {
  const { app, token, topicId } = await setup();
  const pid = await createTask(app, token, topicId, { title: 'Parent' });
  await app.call('POST', `/v1/tasks/${pid}/done`, { token, body: {} });
  const denied = await app.call('POST', `/v1/topics/${topicId}/tasks`, {
    token,
    body: { title: 'Late child', parent_task_id: pid },
  });
  assert.equal(denied.status, 409);
  assert.equal(denied.body.error.code, 'parent_completed');

  // Children under open parents still work.
  const pid3 = await createTask(app, token, topicId, { title: 'Parent 3' });
  const child = await app.call('POST', `/v1/topics/${topicId}/tasks`, {
    token,
    body: { title: 'On-time child', parent_task_id: pid3 },
  });
  assert.equal(child.status, 201);
});

test('F14: denied completion writes no phantom task_done event', async () => {
  const { app, token, topicId } = await setup();
  const pid = await createTask(app, token, topicId, { title: 'P' });
  await createTask(app, token, topicId, { title: 'S', parent_task_id: pid });
  const denied = await app.call('POST', `/v1/tasks/${pid}/done`, { token, body: {} });
  assert.equal(denied.status, 409);
  assert.equal(denied.body.error.code, 'subtasks_open');
  const hist = await app.call('GET', `/v1/topics/${topicId}/history`, { token });
  const kinds = (hist.body.entries as any[])
    .filter((e: any) => (e.data as any)?.task_id === pid)
    .map((e: any) => e.kind);
  assert.ok(!kinds.includes('task_done'), 'no phantom task_done may be emitted');
  const list = await app.call('GET', `/v1/topics/${topicId}/tasks`, { token });
  const task = (list.body.tasks as any[]).find((t: any) => t.id === pid);
  assert.equal(task.status, 'open');
});
