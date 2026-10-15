// Write-time key checks on E2EE topics (spec §1.5): server-side gates on
// encrypted content writes, independent of client version.
//
// Covers: 409 key_not_active at epoch 0 (genesis, also in keys_commit);
// 409 stale_key when posting with an old key_id at a newer epoch; 409
// rotation_required after member removal and after from_join accept (writes
// pause until a fresh key commits); protocol kinds bypass the gates;
// staged envelopes are invisible via GET until commit, and committed
// envelopes carry the epoch commitment (N07 verification data).
import { test } from 'node:test';
import assert from 'node:assert';
import {
  makeApp,
  TestApp,
  hex,
  setupKeyedFamily,
  addMember,
  addAgent,
  createE2eeTopic,
  inviteToTopic,
  postEntry,
  postEnvelope,
  commitKey,
  wireBody,
} from './syncv2_helpers.js';

interface Ctx {
  app: TestApp;
  famId: string;
  owner: { token: string; memberId: string; agentLabel: string };
  bee: { token: string; memberId: string; agentLabel: string };
  tid: string;
  keyId1: string;
}

async function committed(app: TestApp, name: string): Promise<Ctx> {
  const { famId, owner } = await setupKeyedFamily(app, name);
  const m = await addMember(app, famId, owner.token, 'bee@w.dev', 'parent', 'Bee');
  const bee = await addAgent(app, owner.token, m.memberId, 'bee-agent', true);
  const { tid } = await createE2eeTopic(app, owner.token, { participantIds: [bee.memberId] });
  const keyId1 = hex(16);
  for (const a of [
    { memberId: owner.memberId, agentLabel: owner.agentLabel },
    { memberId: bee.memberId, agentLabel: bee.agentLabel },
  ]) {
    const e = await postEnvelope(app, owner.token, tid, a.memberId, a.agentLabel, keyId1);
    assert.equal(e.status, 201);
  }
  const c = await commitKey(app, owner.token, tid, {
    expectedEpoch: 1,
    keyId: keyId1,
    commitment: hex(32),
  });
  assert.equal(c.status, 200);
  return { app, famId, owner, bee, tid, keyId1 };
}

test('stale_key: writing with an old key_id at a newer epoch is 409', async () => {
  const app = makeApp();
  const { owner, bee, tid, keyId1 } = await committed(app, 'GateStale');

  // Epoch 1 writes work.
  const w1 = await postEntry(app, owner.token, tid, wireBody(keyId1));
  assert.equal(w1.status, 201);

  // Rotate to epoch 2.
  const keyId2 = hex(16);
  for (const a of [
    { memberId: owner.memberId, agentLabel: owner.agentLabel },
    { memberId: bee.memberId, agentLabel: bee.agentLabel },
  ]) {
    await postEnvelope(app, owner.token, tid, a.memberId, a.agentLabel, keyId2);
  }
  const c = await commitKey(app, owner.token, tid, {
    expectedEpoch: 2,
    keyId: keyId2,
    commitment: hex(32),
  });
  assert.equal(c.status, 200);

  // A single-key keystore posting with the OLD key: rejected server-side.
  const stale = await postEntry(app, owner.token, tid, wireBody(keyId1));
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'stale_key');

  // The new key works.
  const w2 = await postEntry(app, owner.token, tid, wireBody(keyId2));
  assert.equal(w2.status, 201);
});

test('rotation_required after member removal: encrypted writes pause until rekey', async () => {
  const app = makeApp();
  const { owner, bee, tid, keyId1 } = await committed(app, 'GateRemoval');

  const rem = await app.call('DELETE', `/v2/topics/${tid}/participants/${bee.memberId}`, {
    token: owner.token,
  });
  assert.equal(rem.status, 200);

  // Encrypted content writes pause...
  const blocked = await postEntry(app, owner.token, tid, wireBody(keyId1));
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, 'rotation_required');

  // ...but protocol kinds still flow (rotation announcements must be
  // postable while writes are paused).
  const sys = await app.call('POST', `/v2/topics/${tid}/entries`, {
    token: owner.token,
    body: { kind: 'key_request', data: {member_id:owner.memberId,agent_label:owner.agentLabel} },
  });
  assert.equal(sys.status, 201);

  // Rekey clears the gate.
  const keyId2 = hex(16);
  await postEnvelope(app, owner.token, tid, owner.memberId, owner.agentLabel, keyId2);
  const c = await commitKey(app, owner.token, tid, {
    expectedEpoch: 2,
    keyId: keyId2,
    commitment: hex(32),
  });
  assert.equal(c.status, 200);
  const w = await postEntry(app, owner.token, tid, wireBody(keyId2));
  assert.equal(w.status, 201);
});

test('rotation_required after from_join accept: newcomer gets no current-key envelope', async () => {
  const app = makeApp();
  const { famId, owner, bee, tid, keyId1 } = await committed(app, 'GateFromJoin');
  const cm = await addMember(app, famId, owner.token, 'cee@w.dev', 'parent', 'Cee');
  const cee = await addAgent(app, owner.token, cm.memberId, 'cee-agent', true);

  await inviteToTopic(app, owner.token, tid, [cee.memberId], 'from_join');

  // The newcomer is NOT given the current epoch key: no envelope rows for
  // them, and sync reports pending.
  const envRows = await app.db.queryAll(
    `SELECT * FROM topic_key_envelopes WHERE topic_id = ? AND member_id = ?`,
    [tid, cee.memberId],
  );
  assert.equal(envRows.length, 0, 'from_join member gets no current-key envelope');
  const s = await app.call('GET', '/v2/sync/topics', { token: cee.token });
  const t = (s.body.topics as any[]).find((x: any) => x.topic_id === tid);
  assert.ok(t, 'newcomer sees the topic');
  assert.equal(t.key_status, 'pending');

  // Encrypted writes pause for everyone until the owner rekeys.
  const blocked = await postEntry(app, owner.token, tid, wireBody(keyId1));
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, 'rotation_required');

  // Rekey: the newcomer receives ONLY the new epoch key.
  const keyId2 = hex(16);
  for (const a of [
    { memberId: owner.memberId, agentLabel: owner.agentLabel },
    { memberId: bee.memberId, agentLabel: bee.agentLabel },
    { memberId: cee.memberId, agentLabel: cee.agentLabel },
  ]) {
    await postEnvelope(app, owner.token, tid, a.memberId, a.agentLabel, keyId2);
  }
  const c = await commitKey(app, owner.token, tid, {
    expectedEpoch: 2,
    keyId: keyId2,
    commitment: hex(32),
  });
  assert.equal(c.status, 200);

  const ceeEnvs = await app.call('GET', `/v2/topics/${tid}/envelopes`, { token: cee.token });
  assert.equal(ceeEnvs.status, 200);
  const kids = (ceeEnvs.body.envelopes as any[]).map((e) => e.key_id);
  assert.deepEqual(kids, [keyId2], 'newcomer holds only the post-join epoch key');
  assert.ok(
    !(ceeEnvs.body.envelopes as any[]).some((e) => e.key_id === keyId1),
    'pre-join epoch key is cryptographically (not just policy-) unreadable',
  );

  const w = await postEntry(app, owner.token, tid, wireBody(keyId2));
  assert.equal(w.status, 201, 'writes resume after the rekey');
});

test('staged envelopes are invisible via GET until commit; commitment rides along', async () => {
  const app = makeApp();
  const { owner, bee, tid, keyId1 } = await committed(app, 'GateStaged');
  void bee;

  const keyId2 = hex(16);
  const commitment2 = hex(32);
  await postEnvelope(app, owner.token, tid, owner.memberId, owner.agentLabel, keyId2);
  await postEnvelope(app, owner.token, tid, bee.memberId, bee.agentLabel, keyId2);

  // Pre-commit: the staged key is invisible — only the committed epoch-1
  // envelope is served.
  const pre = await app.call('GET', `/v2/topics/${tid}/envelopes`, { token: owner.token });
  assert.equal(pre.status, 200);
  const preKids = (pre.body.envelopes as any[]).map((e) => e.key_id);
  assert.deepEqual(preKids, [keyId1], 'staged key invisible pre-commit');
  assert.ok(
    (pre.body.envelopes as any[])[0].commitment,
    'committed envelope carries the epoch commitment (N07 data)',
  );

  // Commit, then the new envelope is visible with its commitment.
  const c = await commitKey(app, owner.token, tid, {
    expectedEpoch: 2,
    keyId: keyId2,
    commitment: commitment2,
  });
  assert.equal(c.status, 200);
  const post = await app.call('GET', `/v2/topics/${tid}/envelopes`, { token: owner.token });
  const byKid = new Map((post.body.envelopes as any[]).map((e: any) => [e.key_id, e]));
  assert.ok(byKid.has(keyId2), 'committed envelope now visible');
  assert.equal(byKid.get(keyId2).commitment, commitment2, 'N07 verification data present');
  assert.equal(byKid.get(keyId2).epoch, 2);
});
