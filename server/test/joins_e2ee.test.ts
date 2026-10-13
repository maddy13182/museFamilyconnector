// E2EE topic joins (spec §1.4, "Membership transitions").
//
// Covers: full_history accept -> rotation_required stays 0, writes continue,
// and the joiner can be sealed the CURRENT plus ALL COMMITTED epoch keys
// (so granted history is actually readable — key usability); the joiner's
// key_status lifecycle (pending -> ok once envelopes land); and the
// from_join contrast (rotation_required = 1, no current-key envelope).
// The from_join new-epoch-only rekey flow is covered in write_gates.test.ts.
import { test } from 'node:test';
import assert from 'node:assert';
import {
  makeApp,
  TestApp,
  b64,
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
  keyId2: string;
  commitment1: string;
  commitment2: string;
}

/** E2EE topic at epoch 2 (owner+bee), two committed epochs. */
async function twoEpochs(app: TestApp, name: string): Promise<Ctx> {
  const { famId, owner } = await setupKeyedFamily(app, name);
  const m = await addMember(app, famId, owner.token, 'bee@j.dev', 'parent', 'Bee');
  const bee = await addAgent(app, owner.token, m.memberId, 'bee-agent', true);
  const { tid } = await createE2eeTopic(app, owner.token, { participantIds: [bee.memberId] });

  const keyId1 = hex(16);
  const commitment1 = hex(32);
  for (const a of [
    { memberId: owner.memberId, agentLabel: owner.agentLabel },
    { memberId: bee.memberId, agentLabel: bee.agentLabel },
  ]) {
    assert.equal((await postEnvelope(app, owner.token, tid, a.memberId, a.agentLabel, keyId1)).status, 201);
  }
  assert.equal(
    (await commitKey(app, owner.token, tid, { expectedEpoch: 1, keyId: keyId1, commitment: commitment1 })).status,
    200,
  );

  const keyId2 = hex(16);
  const commitment2 = hex(32);
  for (const a of [
    { memberId: owner.memberId, agentLabel: owner.agentLabel },
    { memberId: bee.memberId, agentLabel: bee.agentLabel },
  ]) {
    assert.equal((await postEnvelope(app, owner.token, tid, a.memberId, a.agentLabel, keyId2)).status, 201);
  }
  assert.equal(
    (await commitKey(app, owner.token, tid, { expectedEpoch: 2, keyId: keyId2, commitment: commitment2 })).status,
    200,
  );
  return { app, famId, owner, bee, tid, keyId1, keyId2, commitment1, commitment2 };
}

async function keyStatus(app: TestApp, token: string, tid: string): Promise<string | undefined> {
  const s = await app.call('GET', '/v1/sync/topics?limit=200', { token });
  assert.equal(s.status, 200);
  return (s.body.topics as any[]).find((t: any) => t.topic_id === tid)?.key_status;
}

test('full_history accept: no rotation gate; joiner sealed all committed epoch keys', async () => {
  const { app, famId, owner, tid, keyId1, keyId2, commitment1, commitment2 } = await twoEpochs(makeApp(), 'JoinFull');

  const cm = await addMember(app, famId, owner.token, 'cee@j.dev', 'parent', 'Cee');
  const cee = await addAgent(app, owner.token, cm.memberId, 'cee-agent', true);
  await inviteToTopic(app, owner.token, tid, [cee.memberId], 'full');

  // No rotation gate for full_history: encrypted writes continue.
  const rr = await app.db.queryOne(`SELECT rotation_required FROM topics WHERE id = ?`, [tid]);
  assert.equal(rr!['rotation_required'], 0);
  const w = await postEntry(app, owner.token, tid, wireBody(keyId2));
  assert.equal(w.status, 201);

  // The joiner starts pending...
  assert.equal(await keyStatus(app, cee.token, tid), 'pending');

  // ...then the owner seals the current AND all committed epoch keys
  // (the server permits staging envelopes for already-committed key_ids —
  // the key_id differs from current_key_id, which is an owner privilege).
  for (const kid of [keyId1, keyId2]) {
    const e = await postEnvelope(app, owner.token, tid, cee.memberId, cee.agentLabel, kid);
    assert.equal(e.status, 201, `sealing epoch key ${kid} for the joiner`);
  }

  // The joiner now holds every committed epoch: granted history is
  // actually readable. Envelopes are ordered by epoch ASC, each carrying
  // its commitment for N07 verification.
  const envs = await app.call('GET', `/v1/topics/${tid}/envelopes`, { token: cee.token });
  assert.equal(envs.status, 200);
  const rows = envs.body.envelopes as any[];
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => r.key_id),
    [keyId1, keyId2],
  );
  assert.deepEqual(
    rows.map((r) => r.epoch),
    [1, 2],
  );
  assert.equal(rows[0].commitment, commitment1);
  assert.equal(rows[1].commitment, commitment2);

  assert.equal(await keyStatus(app, cee.token, tid), 'ok', 'joiner holds the current key');
});

test('from_join contrast: rotation gate set, no current-key envelope, pending', async () => {
  const { app, famId, owner, tid, keyId2 } = await twoEpochs(makeApp(), 'JoinFromJoin');

  const cm = await addMember(app, famId, owner.token, 'dee@j.dev', 'parent', 'Dee');
  const dee = await addAgent(app, owner.token, cm.memberId, 'dee-agent', true);
  await inviteToTopic(app, owner.token, tid, [dee.memberId], 'from_join');

  const rr = await app.db.queryOne(`SELECT rotation_required FROM topics WHERE id = ?`, [tid]);
  assert.equal(rr!['rotation_required'], 1, 'from_join arms the rotation gate');

  const rows = await app.db.queryAll(
    `SELECT * FROM topic_key_envelopes WHERE topic_id = ? AND member_id = ?`,
    [tid, dee.memberId],
  );
  assert.equal(rows.length, 0, 'from_join member is never given the current epoch key');
  assert.equal(await keyStatus(app, dee.token, tid), 'pending');

  // Writes pause until the rekey — even for pre-existing members.
  const blocked = await postEntry(app, owner.token, tid, wireBody(keyId2));
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, 'rotation_required');
});

test('keyless full_history joiner: envelopes cannot be staged; stays pending', async () => {
  const { app, famId, owner, tid, keyId1 } = await twoEpochs(makeApp(), 'JoinKeyless');

  // Elle joins with history_from=full but never ran key-init.
  const em = await addMember(app, famId, owner.token, 'elle@j.dev', 'parent', 'Elle');
  const elle = await addAgent(app, owner.token, em.memberId, 'elle-agent', false);
  await inviteToTopic(app, owner.token, tid, [elle.memberId], 'full');

  const e = await postEnvelope(app, owner.token, tid, elle.memberId, elle.agentLabel, keyId1);
  assert.equal(e.status, 400, 'sealing to a keyless agent is meaningless');

  // key_status stays pending; the key-request flow is their path in.
  assert.equal(await keyStatus(app, elle.token, tid), 'pending');

  // Once they register a key, the owner can seal every committed epoch.
  const rot = await app.call('POST', '/v1/agent-keys/rotate', {
    token: elle.token,
    body: { agent_public_key: b64(32) },
  });
  assert.equal(rot.status, 200);
  for (const kid of [keyId1, (await app.db.queryOne(`SELECT current_key_id FROM topics WHERE id = ?`, [tid]))!['current_key_id'] as string]) {
    assert.equal((await postEnvelope(app, owner.token, tid, elle.memberId, elle.agentLabel, kid)).status, 201);
  }
  assert.equal(await keyStatus(app, elle.token, tid), 'ok');
});
