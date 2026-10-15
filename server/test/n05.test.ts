// N05 field-level enforcement on E2EE topics (spec §1.5): every content
// path must arrive sealed (fh1); only nonsecret indexing metadata stays
// plaintext. Violation -> 400 plaintext_in_e2ee_topic.
//
// Covers: entries (body + data), tasks (title/description, and the
// task_created entry shape: body sealed, data = {task_id plaintext, sealed
// fh1} — F06's json_extract predicate on task_id keeps working), task notes,
// spawn briefings, task_done results (fh1-required on E2EE topics), the
// key_request exemption (plus the other plaintext-by-design system kinds),
// and the deleted PATCH /v2/tasks/:id (the spec table's PATCH row is vacuous
// — the deletion IS the enforcement).
import { test } from 'node:test';
import assert from 'node:assert';
import {
  makeApp,
  TestApp,
  hex,
  setupKeyedFamily,
  createE2eeTopic,
  postEntry,
  postEnvelope,
  commitKey,
  wireBody,
} from './syncv2_helpers.js';

/** E2EE topic at epoch 1; returns { tid, keyId }. */
async function sealedTopic(app: TestApp, name: string) {
  const { owner } = await setupKeyedFamily(app, name);
  const { tid } = await createE2eeTopic(app, owner.token);
  const keyId = hex(16);
  const env = await postEnvelope(app, owner.token, tid, owner.memberId, owner.agentLabel, keyId);
  assert.equal(env.status, 201);
  const c = await commitKey(app, owner.token, tid, {
    expectedEpoch: 1,
    keyId,
    commitment: hex(32),
  });
  assert.equal(c.status, 200);
  return { owner, tid, keyId };
}

test('N05 entries: plaintext body/data rejected; sealed accepted', async () => {
  const app = makeApp();
  const { owner, tid, keyId } = await sealedTopic(app, 'N05Entries');

  const plain = await postEntry(app, owner.token, tid, 'buy milk tomorrow');
  assert.equal(plain.status, 400);
  assert.equal(plain.body.error.code, 'plaintext_in_e2ee_topic');

  const plainData = await app.call('POST', `/v2/topics/${tid}/entries`, {
    token: owner.token,
    body: { kind: 'message', body: wireBody(keyId), data: { note: 'plaintext metadata' } },
  });
  assert.equal(plainData.status, 400);
  assert.equal(plainData.body.error.code, 'plaintext_in_e2ee_topic');

  // Sealed data: the data FIELD is a JSON string holding the fh1 wire
  // body. Client-side that means passing the wire body as a plain string
  // value (reqJsonData JSON-encodes it); pre-encoding double-quotes it and
  // is rightly rejected.
  const sealedData = await app.call('POST', `/v2/topics/${tid}/entries`, {
    token: owner.token,
    body: {
      kind: 'message',
      body: wireBody(keyId),
      data: wireBody(keyId),
    },
  });
  assert.equal(sealedData.status, 201);
  const doubleEncoded = await app.call('POST', `/v2/topics/${tid}/entries`, {
    token: owner.token,
    body: {
      kind: 'message',
      body: wireBody(keyId),
      data: JSON.stringify(wireBody(keyId)),
    },
  });
  assert.equal(doubleEncoded.status, 400);
  assert.equal(doubleEncoded.body.error.code, 'plaintext_in_e2ee_topic');

  const ok = await postEntry(app, owner.token, tid, wireBody(keyId));
  assert.equal(ok.status, 201);
});

test('N05 protocol kinds cannot smuggle free-text bodies', async () => {
  const app = makeApp();
  const { owner, tid } = await sealedTopic(app, 'N05Proto');
  for (const kind of ['key_request', 'key_rotated', 'pending_key_distribution', 'topic_archived']) {
    const r = await app.call('POST', `/v2/topics/${tid}/entries`, {
      token: owner.token,
      body: { kind, body: `[${kind}] plaintext system notice` },
    });
    assert.equal(r.status, 400, `kind ${kind} must reject free-text content`);
  }
});

test('N05 tasks: plaintext title/description rejected; sealed accepted; task_created shape', async () => {
  const app = makeApp();
  const { owner, tid, keyId } = await sealedTopic(app, 'N05Tasks');

  const plainTitle = await app.call('POST', `/v2/topics/${tid}/tasks`, {
    token: owner.token,
    body: { title: 'Book the flights' },
  });
  assert.equal(plainTitle.status, 400);
  assert.equal(plainTitle.body.error.code, 'plaintext_in_e2ee_topic');

  const plainDesc = await app.call('POST', `/v2/topics/${tid}/tasks`, {
    token: owner.token,
    body: { title: wireBody(keyId), description: 'plaintext description' },
  });
  assert.equal(plainDesc.status, 400);
  assert.equal(plainDesc.body.error.code, 'plaintext_in_e2ee_topic');

  const title = wireBody(keyId);
  const desc = wireBody(keyId);
  const ok = await app.call('POST', `/v2/topics/${tid}/tasks`, {
    token: owner.token,
    body: { title, description: desc },
  });
  assert.equal(ok.status, 201);
  const taskId = ok.body.task.id as string;
  // The task row stores the sealed fields opaquely.
  assert.equal(ok.body.task.title, title);

  // task_created: body is the sealed title (no `Task created: ...` leak),
  // data = {task_id plaintext, sealed fh1}. F06's visibility predicate does
  // json_extract(data,'$.task_id') — it must stay plaintext.
  const hist = await app.call('GET', `/v2/topics/${tid}/history`, { token: owner.token });
  const created = (hist.body.entries as any[]).find((e) => e.kind === 'task_created');
  assert.ok(created, 'task_created entry exists');
  assert.ok(!created.body.includes('Task created:'), 'no plaintext title leak in the body');
  const data = created.data as { task_id?: string; title?: string; description?: string };
  assert.equal(data.task_id, taskId, 'task_id stays plaintext for F06');
  assert.equal(data.title, title);
  assert.equal(data.description, desc);
});

test('N05 task notes: plaintext rejected; sealed accepted', async () => {
  const app = makeApp();
  const { owner, tid, keyId } = await sealedTopic(app, 'N05Notes');
  const t = await app.call('POST', `/v2/topics/${tid}/tasks`, {
    token: owner.token,
    body: { title: wireBody(keyId) },
  });
  const taskId = t.body.task.id as string;

  const plain = await app.call('POST', `/v2/tasks/${taskId}/notes`, {
    token: owner.token,
    body: { body: 'progress: half done' },
  });
  assert.equal(plain.status, 400);
  assert.equal(plain.body.error.code, 'plaintext_in_e2ee_topic');

  const ok = await app.call('POST', `/v2/tasks/${taskId}/notes`, {
    token: owner.token,
    body: { body: wireBody(keyId) },
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.entry.kind, 'task_note');
});

test('N05 linked topic has independent encryption and cannot reuse the parent key', async () => {
 const app=makeApp();const {owner,tid,keyId}=await sealedTopic(app,'N05Spawn');
 const plain=await app.call('POST',`/v2/topics/${tid}/spawn`,{token:owner.token,body:{subject:'child',briefing:'private'}});
 assert.equal(plain.status,400);
 const childKey=hex(16);
 const child=await app.call('POST',`/v2/topics/${tid}/spawn`,{token:owner.token,body:{topic_id:hex(16),subject:wireBody(childKey),participant_member_ids:[owner.memberId]}});
 assert.equal(child.status,201);const childId=child.body.topic.id;
 assert.equal(child.body.topic.current_epoch,0);
 assert.equal((await postEntry(app,owner.token,childId,wireBody(childKey))).status,409);
 await postEnvelope(app,owner.token,childId,owner.memberId,owner.agentLabel,childKey);
 assert.equal((await commitKey(app,owner.token,childId,{expectedEpoch:1,keyId:childKey,commitment:hex(32)})).status,200);
 assert.equal((await postEntry(app,owner.token,childId,wireBody(keyId))).status,409);
 const briefing=wireBody(childKey);
 const posted=await app.call('POST',`/v2/topics/${childId}/entries`,{token:owner.token,body:{kind:'briefing',body:briefing}});
 assert.equal(posted.status,201);assert.equal(posted.body.entry.body,briefing);
});

test('N05 task_done: result must be fh1 on E2EE topics (absent result is fine)', async () => {
  const app = makeApp();
  const { owner, tid, keyId } = await sealedTopic(app, 'N05Done');
  const mk = async () => {
    const t = await app.call('POST', `/v2/topics/${tid}/tasks`, {
      token: owner.token,
      body: { title: wireBody(keyId) },
    });
    assert.equal(t.status, 201);
    return t.body.task.id as string;
  };

  const t1 = await mk();
  const plainResult = await app.call('POST', `/v2/tasks/${t1}/done`, {
    token: owner.token,
    body: { result: { summary: 'all done' } },
  });
  assert.equal(plainResult.status, 400);
  assert.equal(plainResult.body.error.code, 'plaintext_in_e2ee_topic');

  const t2 = await mk();
  const sealedResult = wireBody(keyId);
  const ok = await app.call('POST', `/v2/tasks/${t2}/done`, {
    token: owner.token,
    body: { result: sealedResult },
  });
  assert.equal(ok.status, 200);
  // task_done entry: task_id plaintext, sealed result under `sealed`.
  const hist = await app.call('GET', `/v2/topics/${tid}/history`, { token: owner.token });
  const done = (hist.body.entries as any[]).find((e) => e.kind === 'task_done');
  assert.ok(done, 'task_done entry exists');
  assert.equal((done.data as any).task_id, t2);
  assert.equal((done.data as any).result, sealedResult);

  // No result at all: allowed (result null).
  const t3 = await mk();
  const none = await app.call('POST', `/v2/tasks/${t3}/done`, {
    token: owner.token,
    body: {},
  });
  assert.equal(none.status, 200);
});

test('PATCH /v2/tasks/:id is deleted (spec §1.6): the N05 PATCH row is vacuous', async () => {
  const app = makeApp();
  const { owner, tid, keyId } = await sealedTopic(app, 'N05PatchGone');
  const t = await app.call('POST', `/v2/topics/${tid}/tasks`, {
    token: owner.token,
    body: { title: wireBody(keyId) },
  });
  const taskId = t.body.task.id as string;
  for (const method of ['GET', 'PATCH']) {
    const r = await app.call(method, `/v2/tasks/${taskId}`, {
      token: owner.token,
      body: method === 'PATCH' ? { title: wireBody(keyId) } : undefined,
    });
    assert.equal(r.status, 404, `${method} /v2/tasks/:id must be gone`);
  }
});
