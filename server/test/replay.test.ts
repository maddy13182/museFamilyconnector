// R1 replay protection (spec §1.2, §1.5): msg_id extracted from fh1 bodies
// at POST time, UNIQUE(topic_id, msg_id).
//
// Covers: duplicate POST with the same payload -> idempotent success (the
// existing entry, deduped:true); same msg_id with a different payload ->
// 409 msg_id_conflict (genuine conflict, including a replayed ciphertext
// with a swapped blob); msg_id scope is per-topic; plaintext bodies carry
// no msg_id (duplicates are separate entries — Idempotency-Key is the
// separate dedupe mechanism); and a retried write under a superseded key
// still dedupes (the msg_id check runs before the stale_key gate — a retry
// is not a new write).
import { test } from 'node:test';
import assert from 'node:assert';
import {
  makeApp,
  TestApp,
  hex,
  setupKeyedFamily,
  createE2eeTopic,
  createPlainTopic,
  postEntry,
  postEnvelope,
  commitKey,
  wireBody,
} from './syncv2_helpers.js';

/** E2EE topic at epoch 1 with a committed key; returns { tid, keyId }. */
async function committedTopic(app: TestApp, name: string) {
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

test('duplicate POST, same payload -> idempotent success (same entry, deduped)', async () => {
  const app = makeApp();
  const { owner, tid, keyId } = await committedTopic(app, 'Replay1');
  const msgId = hex(16);
  const body = wireBody(keyId, msgId);

  const first = await postEntry(app, owner.token, tid, body);
  assert.equal(first.status, 201);
  const second = await postEntry(app, owner.token, tid, body);
  assert.equal(second.status, 200, 'retry of the same write succeeds');
  assert.equal(second.body.deduped, true);
  assert.equal(second.body.entry.seq, first.body.entry.seq);
  assert.equal(second.body.entry.gseq, first.body.entry.gseq);

  const count = (await app.db.queryOne(`SELECT COUNT(*) AS c FROM entries WHERE topic_id = ?`, [tid]))!['c'];
  assert.equal(count, 1, 'no duplicate row stored');
});

test('same msg_id, different payload -> 409 msg_id_conflict', async () => {
  const app = makeApp();
  const { owner, tid, keyId } = await committedTopic(app, 'Replay2');
  const msgId = hex(16);

  const first = await postEntry(app, owner.token, tid, wireBody(keyId, msgId));
  assert.equal(first.status, 201);

  // Adversarial: the same msg_id with a swapped ciphertext blob (a replayed
  // ciphertext presented as a new entry).
  const forged = wireBody(keyId, msgId); // fresh random blob, same msg_id
  assert.notEqual(forged, first.body.entry.body);
  const clash = await postEntry(app, owner.token, tid, forged);
  assert.equal(clash.status, 409);
  assert.equal(clash.body.error.code, 'msg_id_conflict');

  const count = (await app.db.queryOne(`SELECT COUNT(*) AS c FROM entries WHERE topic_id = ?`, [tid]))!['c'];
  assert.equal(count, 1, 'the conflicting write stored nothing');
});

test('msg_id is scoped per topic: same id in another topic is fine', async () => {
  const app = makeApp();
  const { owner, tid, keyId } = await committedTopic(app, 'Replay3');
  const other = await createPlainTopic(app, owner.token, 'other');
  const msgId = hex(16);

  const r1 = await postEntry(app, owner.token, tid, wireBody(keyId, msgId));
  assert.equal(r1.status, 201);
  // Plaintext topic: no msg_id extraction — but even an fh1 body in another
  // E2EE topic would not clash. Use a second E2EE topic for the real check.
  const { tid: tid2 } = await createE2eeTopic(app, owner.token);
  const keyId2 = hex(16);
  await postEnvelope(app, owner.token, tid2, owner.memberId, owner.agentLabel, keyId2);
  const c2 = await commitKey(app, owner.token, tid2, {
    expectedEpoch: 1,
    keyId: keyId2,
    commitment: hex(32),
  });
  assert.equal(c2.status, 200);
  const r2 = await postEntry(app, owner.token, tid2, wireBody(keyId2, msgId));
  assert.equal(r2.status, 201, 'same msg_id in a different topic does not conflict');
  void other;
});

test('plaintext bodies carry no msg_id: duplicates are separate entries', async () => {
  const app = makeApp();
  const { owner } = await setupKeyedFamily(app, 'Replay4');
  const tid = await createPlainTopic(app, owner.token, 'plain replay');

  const r1 = await postEntry(app, owner.token, tid, 'same words');
  const r2 = await postEntry(app, owner.token, tid, 'same words');
  assert.equal(r1.status, 201);
  assert.equal(r2.status, 201, 'no msg_id -> no replay dedupe');
  assert.notEqual(r1.body.entry.seq, r2.body.entry.seq);
});

test('retry under a superseded key still dedupes (msg_id check precedes stale_key)', async () => {
  const app = makeApp();
  const { owner, tid, keyId } = await committedTopic(app, 'Replay5');
  const msgId = hex(16);
  const body = wireBody(keyId, msgId);
  const first = await postEntry(app, owner.token, tid, body);
  assert.equal(first.status, 201);

  // Rotate to epoch 2...
  const keyId2 = hex(16);
  await postEnvelope(app, owner.token, tid, owner.memberId, owner.agentLabel, keyId2);
  const c = await commitKey(app, owner.token, tid, {
    expectedEpoch: 2,
    keyId: keyId2,
    commitment: hex(32),
  });
  assert.equal(c.status, 200);

  // ...then the client retries the ORIGINAL post (same bytes, old key_id).
  // It is a retry, not a new write: idempotent success, NOT stale_key.
  const retry = await postEntry(app, owner.token, tid, body);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.deduped, true);
  assert.equal(retry.body.entry.seq, first.body.entry.seq);

  // But a genuinely NEW write under the old key is still rejected.
  const stale = await postEntry(app, owner.token, tid, wireBody(keyId, hex(16)));
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'stale_key');
});
