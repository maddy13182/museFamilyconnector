// Tests: Phase C privacy boundaries.
// F06 — the from-join history floor must apply to task list, task get, and
// topic export (not just entry reads), and the cutoff must be computed inside
// the membership insert transaction.
// F08 — the PII guard must cover entry.data string leaves, task titles, and
// task completion results; owner redaction must scrub PII leaves in data.
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

test('F06: from_join member cannot read pre-join tasks via list, get, or export', async () => {
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

  // 2. get 404s the pre-join task (same as a missing task — no leak).
  const get = await app.call('GET', `/v1/tasks/${t1id}`, { token: kid2.token });
  assert.equal(get.status, 404);

  // 3. export omits the pre-join task.
  const exp = await app.call('GET', `/v1/topics/${tid}/export`, { token: kid2.token });
  assert.equal(exp.status, 200);
  assert.ok(
    !(exp.body.tasks as any[]).some((t) => t.id === t1id),
    'pre-join task must be absent from the export',
  );

  // A task created AFTER the join is visible on all three paths.
  const t2 = await app.call('POST', `/v1/topics/${tid}/tasks`, {
    token: ownerToken,
    body: { title: 'Post-join task' },
  });
  assert.equal(t2.status, 201);
  const t2id = t2.body.task.id as string;

  const list2 = await app.call('GET', `/v1/topics/${tid}/tasks`, { token: kid2.token });
  assert.ok((list2.body.tasks as any[]).some((t) => t.id === t2id), 'post-join task visible in list');
  const get2 = await app.call('GET', `/v1/tasks/${t2id}`, { token: kid2.token });
  assert.equal(get2.status, 200);
  const exp2 = await app.call('GET', `/v1/topics/${tid}/export`, { token: kid2.token });
  assert.ok((exp2.body.tasks as any[]).some((t) => t.id === t2id), 'post-join task visible in export');

  // The original participant (floor=1) still sees the pre-join task everywhere.
  const listK1 = await app.call('GET', `/v1/topics/${tid}/tasks`, { token: kid1.token });
  assert.ok((listK1.body.tasks as any[]).some((t) => t.id === t1id), 'original member still sees pre-join task in list');
  assert.equal((await app.call('GET', `/v1/tasks/${t1id}`, { token: kid1.token })).status, 200);
  const expK1 = await app.call('GET', `/v1/topics/${tid}/export`, { token: kid1.token });
  assert.ok((expK1.body.tasks as any[]).some((t) => t.id === t1id), 'original member still sees pre-join task in export');
});

test('F06: history_from=full invite still sees pre-join tasks', async () => {
  const { app, famId, ownerToken, ownerId } = await bootstrap();
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
  assert.equal((await app.call('GET', `/v1/tasks/${t1id}`, { token: kid2.token })).status, 200);
  const exp = await app.call('GET', `/v1/topics/${tid}/export`, { token: kid2.token });
  assert.ok((exp.body.tasks as any[]).some((t) => t.id === t1id), 'full-history invite sees pre-join task in export');
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

test('F08: PII-shaped task titles are rejected on create and patch', async () => {
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
  const taskId = ok.body.task.id as string;

  const badPatch = await app.call('PATCH', `/v1/tasks/${taskId}`, {
    token: ownerToken,
    body: { title: 'pay with card 4111 1111 1111 1111' },
  });
  assert.equal(badPatch.status, 422);

  const cleanPatch = await app.call('PATCH', `/v1/tasks/${taskId}`, {
    token: ownerToken,
    body: { title: 'File the paperwork tomorrow' },
  });
  assert.equal(cleanPatch.status, 200);
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

test('F08: owner redaction scrubs PII leaves in entry.data, keeps structure', async () => {
  const { app, ownerToken, ownerId } = await bootstrap();
  const tid = await makeTopic(app, ownerToken, ownerId, []);

  // Simulate a pre-fix row: the write-time guard would reject this today.
  const max = await app.db.queryOne(`SELECT MAX(seq) AS m FROM entries WHERE topic_id = ?`, [tid]);
  const seq = (((max?.['m'] as number | null) ?? 0) as number) + 1;
  await app.db.execAtomically([
    {
      sql: `INSERT INTO entries(topic_id, seq, ts, actor_member_id, agent_label, token_id, kind, body, data, reply_to_seq)
            VALUES (?,?,?,?,?,?,?,?,?,?)`,
      params: [
        tid,
        seq,
        new Date().toISOString(),
        ownerId,
        'test',
        'tok_test',
        'message',
        'hello',
        JSON.stringify({
          task_id: 't_keep',
          note: 'ssn 900-12-3456',
          keep: 'clean',
          nested: ['a', 'card 4111 1111 1111 1111'],
        }),
        null,
      ],
    },
  ]);
  const row = await app.db.queryOne(`SELECT gseq FROM entries WHERE topic_id = ? AND seq = ?`, [tid, seq]);
  const gseq = row!['gseq'] as number;

  const red = await app.call('POST', `/v1/entries/${gseq}/redact`, { token: ownerToken });
  assert.equal(red.status, 200);

  const hist = await app.call('GET', `/v1/topics/${tid}/history?after_seq=0`, { token: ownerToken });
  assert.equal(hist.status, 200);
  const entry = (hist.body.entries as any[]).find((e) => e.gseq === gseq);
  assert.ok(entry, 'redacted entry still in history');
  assert.ok((entry.body as string).startsWith('[redacted by owner'), 'body scrubbed');
  assert.equal(entry.data.task_id, 't_keep', 'linkage field preserved');
  assert.equal(entry.data.note, '[redacted]', 'PII leaf scrubbed');
  assert.equal(entry.data.keep, 'clean', 'clean leaf preserved');
  assert.deepEqual(entry.data.nested, ['a', '[redacted]'], 'nested PII leaf scrubbed');
});
