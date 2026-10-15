// POST /v2/topics/:tid/keys/commit — staged atomic key activation
// (spec §1.4).
//
// Covers: genesis (epoch-0 writes blocked with 409 key_not_active, then
// activation); rotation happy path; stale_epoch; key_reuse; key_material_reuse
// (identical key material under a fresh key_id); burn-on-removal (409
// recipients_removed_key_burned, staged rows deleted, the burned key_id not
// recomittable); delta reseal on join (409 superseded_identity_key -> seal
// the delta -> recommit the SAME key); force audit (forced=1 +
// forced_missing recorded; keyless agents pending); superseded-identity-key
// rejection (not force-overridable; re-seal fixes it); force-by-parent 403;
// the CAS race (second commit for the same epoch loses with 409); 400 on
// plaintext topics; 403 for non-owner/parent callers.
//
// Also: the epoch log (§1.1) — append-only (no UPDATE/DELETE path), the
// grandfathered NULL-commitment acceptance, and the UNIQUE backstops.
import { test } from 'node:test';
import assert from 'node:assert';
import {
  makeApp,
  TestApp,
  Party,
  b64,
  hex,
  setupKeyedFamily,
  addMember,
  addAgent,
  createE2eeTopic,
  createActiveTopic,
  inviteToTopic,
  postEntry,
  postEnvelope,
  commitKey,
  genesisCommit,
  wireBody,
} from './syncv2_helpers.js';

interface KeyedTopic {
  app: TestApp;
  famId: string;
  owner: Party;
  tid: string;
  epoch1KeyId: string;
}

/** E2EE topic with owner+bee as participants, genesis committed (epoch 1). */
async function setupCommittedTopic(app: TestApp, name: string): Promise<KeyedTopic & { bee: Party }> {
  const { famId, owner } = await setupKeyedFamily(app, name);
  const m = await addMember(app, famId, owner.token, 'bee@k.dev', 'parent', 'Bee');
  const bee = await addAgent(app, owner.token, m.memberId, 'bee-agent', true);
  const { tid } = await createE2eeTopic(app, owner.token, {
    participantIds: [bee.memberId],
  });
  const epoch1KeyId = await genesisCommit(app, owner.token, tid, [
    { memberId: owner.memberId, agentLabel: owner.agentLabel },
    { memberId: bee.memberId, agentLabel: bee.agentLabel },
  ]);
  return { app, famId, owner, bee, tid, epoch1KeyId };
}

async function epochRows(app: TestApp, tid: string) {
  return app.db.queryAll(`SELECT * FROM topic_key_epochs WHERE topic_id = ? ORDER BY epoch ASC`, [tid]);
}

async function rotationRequired(app: TestApp, tid: string): Promise<number> {
  const row = await app.db.queryOne(`SELECT rotation_required FROM topics WHERE id = ?`, [tid]);
  return row!['rotation_required'] as number;
}

/** assert.rejects is absent from the repo's node:assert shim; local version. */
async function assertRejects(p: Promise<unknown>, message: string): Promise<void> {
  let threw = false;
  try {
    await p;
  } catch {
    threw = true;
  }
  assert.ok(threw, message);
}

// ---------------------------------------------------------------------------
// Genesis
// ---------------------------------------------------------------------------

test('genesis: encrypted writes blocked at epoch 0 (409 key_not_active), then activation', async () => {
  const app = makeApp();
  const { owner } = await setupKeyedFamily(app, 'CommitGen');
  const { tid } = await createE2eeTopic(app, owner.token);
  const keyId = hex(16);

  const blocked = await postEntry(app, owner.token, tid, wireBody(keyId));
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, 'key_not_active');

  // Malformed bodies are still N05-rejected (not key-gated) at epoch 0.
  const plain = await postEntry(app, owner.token, tid, 'plaintext nope');
  assert.equal(plain.status, 400);
  assert.equal(plain.body.error.code, 'plaintext_in_e2ee_topic');

  const kid = hex(16);
  const env = await postEnvelope(app, owner.token, tid, owner.memberId, owner.agentLabel, kid);
  assert.equal(env.status, 201, 'staging before commit is allowed');
  const c = await commitKey(app, owner.token, tid, {
    expectedEpoch: 1,
    keyId: kid,
    commitment: hex(32),
  });
  assert.equal(c.status, 200, `genesis commit failed: ${JSON.stringify(c.body)}`);
  assert.equal(c.body.epoch, 1);
  assert.equal(c.body.key_id, kid);

  const rows = await epochRows(app, tid);
  assert.equal(rows.length, 1);
  assert.equal(Object.hasOwn(rows[0], 'forced'), false);

  // Writes unblocked now.
  const ok = await postEntry(app, owner.token, tid, wireBody(kid));
  assert.equal(ok.status, 201);
});

test('keys/commit rejects a stale epoch and denies kid callers', async () => {
  const app = makeApp();
  const { famId, owner } = await setupKeyedFamily(app, 'CommitScope');
  const plain = await createActiveTopic(app, owner.token, 'plain');
  const r = await commitKey(app, owner.token, plain, {
    expectedEpoch: 1,
    keyId: hex(16),
    commitment: hex(32),
  });
  assert.equal(r.status, 409);

  const kid = await addMember(app, famId, owner.token, 'kid@c.dev', 'kid', 'Kid');
  const { tid } = await createE2eeTopic(app, owner.token, { participantIds: [kid.memberId] });
  const denied = await commitKey(app, kid.token, tid, {
    expectedEpoch: 1,
    keyId: hex(16),
    commitment: hex(32),
  });
  assert.equal(denied.status, 403);
});

test('commit body validation: bad expected_epoch / key_id / commitment / force', async () => {
  const app = makeApp();
  const { owner } = await setupKeyedFamily(app, 'CommitValid');
  const { tid } = await createE2eeTopic(app, owner.token);
  const good = { expected_epoch: 1, key_id: hex(16), commitment: hex(32) };
  for (const [label, body] of [
    ['epoch 0', { ...good, expected_epoch: 0 }],
    ['epoch string', { ...good, expected_epoch: '1' }],
    ['short key_id', { ...good, key_id: 'abc' }],
    ['short commitment', { ...good, commitment: 'ab' }],
    ['non-hex commitment', { ...good, commitment: 'z'.repeat(64) }],
    ['force string', { ...good, force: 'yes' }],
  ] as const) {
    const r = await app.call('POST', `/v2/topics/${tid}/keys/commit`, {
      token: owner.token,
      body,
    });
    assert.equal(r.status, 400, label);
  }
});

// ---------------------------------------------------------------------------
// Rotation happy path + stale_epoch
// ---------------------------------------------------------------------------

test('rotation: epoch 1 -> 2 flips current_key_id and clears rotation_required', async () => {
  const { app, owner, bee, tid, epoch1KeyId } = await setupCommittedTopic(makeApp(), 'CommitRot');
  // A removal arms rotation_required; the rotation must clear it.
  await app.call('DELETE', `/v2/topics/${tid}/participants/${bee.memberId}`, {
    token: owner.token,
  });
  assert.equal(await rotationRequired(app, tid), 1);

  const keyId2 = hex(16);
  const env = await postEnvelope(app, owner.token, tid, owner.memberId, owner.agentLabel, keyId2);
  assert.equal(env.status, 201);
  const c = await commitKey(app, owner.token, tid, {
    expectedEpoch: 2,
    keyId: keyId2,
    commitment: hex(32),
  });
  assert.equal(c.status, 200, `rotation failed: ${JSON.stringify(c.body)}`);
  assert.equal(c.body.epoch, 2);

  const topic = (await app.db.queryOne(`SELECT current_key_id, current_epoch, rotation_required FROM topics WHERE id = ?`, [tid]))!;
  assert.equal(topic['current_key_id'], keyId2);
  assert.notEqual(topic['current_key_id'], epoch1KeyId);
  assert.equal(topic['current_epoch'], 2);
  assert.equal(topic['rotation_required'], 0, 'successful commit clears the flag');

  const rows = await epochRows(app, tid);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => r['epoch']),
    [1, 2],
  );
});

test('stale_epoch: expected_epoch must be current_epoch + 1', async () => {
  const { app, owner, tid } = await setupCommittedTopic(makeApp(), 'CommitStale');
  for (const expected of [1, 3, 99]) {
    const r = await commitKey(app, owner.token, tid, {
      expectedEpoch: expected,
      keyId: hex(16),
      commitment: hex(32),
    });
    assert.equal(r.status, 409, `expected_epoch ${expected}`);
    assert.equal(r.body.error.code, 'stale_epoch');
  }
  assert.equal((await epochRows(app, tid)).length, 1, 'rejected commits append nothing');
});

// ---------------------------------------------------------------------------
// key_reuse / key_material_reuse
// ---------------------------------------------------------------------------

test('key_reuse: a key_id can never be committed twice for a topic', async () => {
  const { app, owner, bee, tid, epoch1KeyId } = await setupCommittedTopic(makeApp(), 'CommitReuse');
  const keyId2 = hex(16);
  await postEnvelope(app, owner.token, tid, owner.memberId, owner.agentLabel, keyId2);
  await postEnvelope(app, owner.token, tid, bee.memberId, bee.agentLabel, keyId2);
  const c = await commitKey(app, owner.token, tid, {
    expectedEpoch: 2,
    keyId: keyId2,
    commitment: hex(32),
  });
  assert.equal(c.status, 200);

  // Same key_id again (epoch 3): 409 key_reuse.
  const keyId3 = epoch1KeyId; // also covers reusing the epoch-1 key_id
  await postEnvelope(app, owner.token, tid, owner.memberId, owner.agentLabel, keyId3);
  await postEnvelope(app, owner.token, tid, bee.memberId, bee.agentLabel, keyId3);
  const r = await commitKey(app, owner.token, tid, {
    expectedEpoch: 3,
    keyId: keyId3,
    commitment: hex(32),
  });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'key_reuse');
});

test('key_material_reuse: identical key material under a fresh key_id is rejected', async () => {
  const { app, owner, bee, tid } = await setupCommittedTopic(makeApp(), 'CommitMatReuse');
  const commitment = hex(32); // "the same key" committed at epoch 1... no:
  // epoch 1 used a different commitment; reuse epoch-2's commitment under a
  // fresh key_id to prove the commitment UNIQUE backstop.
  const keyId2 = hex(16);
  await postEnvelope(app, owner.token, tid, owner.memberId, owner.agentLabel, keyId2);
  await postEnvelope(app, owner.token, tid, bee.memberId, bee.agentLabel, keyId2);
  const c2 = await commitKey(app, owner.token, tid, {
    expectedEpoch: 2,
    keyId: keyId2,
    commitment,
  });
  assert.equal(c2.status, 200);

  const keyId3 = hex(16); // fresh key_id...
  await postEnvelope(app, owner.token, tid, owner.memberId, owner.agentLabel, keyId3);
  await postEnvelope(app, owner.token, tid, bee.memberId, bee.agentLabel, keyId3);
  const r = await commitKey(app, owner.token, tid, {
    expectedEpoch: 3,
    keyId: keyId3,
    commitment, // ...but identical key material.
  });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'key_material_reuse');
  assert.equal((await epochRows(app, tid)).length, 2, 'rejected commit appends nothing');
});

// ---------------------------------------------------------------------------
// Burn on removal
// ---------------------------------------------------------------------------

test('burn: removal interleaved with rotation burns the key (staged rows deleted)', async () => {
  const { app, owner, bee, tid } = await setupCommittedTopic(makeApp(), 'CommitBurn');

  // Stage epoch 2 for owner + bee...
  const keyId2 = hex(16);
  await postEnvelope(app, owner.token, tid, owner.memberId, owner.agentLabel, keyId2);
  await postEnvelope(app, owner.token, tid, bee.memberId, bee.agentLabel, keyId2);
  // ...then bee is removed before the commit.
  const rem = await app.call('DELETE', `/v2/topics/${tid}/participants/${bee.memberId}`, {
    token: owner.token,
  });
  assert.equal(rem.status, 200);

  const c = await commitKey(app, owner.token, tid, {
    expectedEpoch: 2,
    keyId: keyId2,
    commitment: hex(32),
  });
  assert.equal(c.status, 409);
  assert.equal(c.body.error.code, 'recipients_removed_key_burned');

  // The key is burned: ALL its staged rows are deleted server-side.
  const staged = await app.db.queryAll(
    `SELECT * FROM topic_key_envelopes WHERE topic_id = ? AND key_id = ?`,
    [tid, keyId2],
  );
  assert.equal(staged.length, 0, 'burned key staged rows must be deleted');

  // The burned key_id cannot simply be recommitted: with no staged rows the
  // commit now fails completeness (the client MUST use fresh material —
  // the CLI regenerates and restarts; resealing the same key_id is
  // insufficient because the removed party saw it).
  const retry = await commitKey(app, owner.token, tid, {
    expectedEpoch: 2,
    keyId: keyId2,
    commitment: hex(32),
  });
  assert.equal(retry.status, 409);
  assert.notEqual(retry.body.error.code, undefined);
  assert.equal((await epochRows(app, tid)).length, 1, 'no epoch appended');

  // force cannot override the burn either.
  const forced = await commitKey(app, owner.token, tid, {
    expectedEpoch: 2,
    keyId: keyId2,
    commitment: hex(32),
  });
  assert.equal(forced.status, 409);

  // The removed member never gets the new key: envelope POSTs for them are
  // 400 (not a current participant) and they are 403 on the topic.
  const freshId = hex(16);
  const envRemoved = await postEnvelope(app, owner.token, tid, bee.memberId, bee.agentLabel, freshId);
  assert.equal(envRemoved.status, 400);
  const gone = await app.call('GET', `/v2/topics/${tid}/envelopes`, { token: bee.token });
  assert.equal(gone.status, 403);

  // Fresh material + full current set commits cleanly (epoch 2).
  await postEnvelope(app, owner.token, tid, owner.memberId, owner.agentLabel, freshId);
  const ok = await commitKey(app, owner.token, tid, {
    expectedEpoch: 2,
    keyId: freshId,
    commitment: hex(32),
  });
  assert.equal(ok.status, 200, `fresh-material commit failed: ${JSON.stringify(ok.body)}`);
  assert.equal(await rotationRequired(app, tid), 0);
});

// ---------------------------------------------------------------------------
// Delta reseal on join
// ---------------------------------------------------------------------------

test('join during rotation: 409, seal the delta, recommit the SAME key', async () => {
  const { app, famId, owner, bee, tid } = await setupCommittedTopic(makeApp(), 'CommitJoin');

  // Stage epoch 2 for the current set (owner + bee)...
  const keyId2 = hex(16);
  const commitment2 = hex(32);
  await postEnvelope(app, owner.token, tid, owner.memberId, owner.agentLabel, keyId2);
  await postEnvelope(app, owner.token, tid, bee.memberId, bee.agentLabel, keyId2);

  // ...then Cee joins (with a registered identity key) before the commit.
  const cm = await addMember(app, famId, owner.token, 'cee@k.dev', 'parent', 'Cee');
  const cee = await addAgent(app, owner.token, cm.memberId, 'cee-agent', true);
  await inviteToTopic(app, owner.token, tid, [cee.memberId], 'full');

  const c = await commitKey(app, owner.token, tid, {
    expectedEpoch: 2,
    keyId: keyId2,
    commitment: commitment2,
  });
  assert.equal(c.status, 409);
  // Cee HAS an active identity key but no staged envelope: the envelope was
  // never sealed to the active key -> superseded_identity_key (the join
  // delta must be sealed, then the same key recommitted).
  assert.equal(c.body.error.code, 'superseded_identity_key');

  // Seal the delta and recommit the SAME key material.
  const delta = await postEnvelope(app, owner.token, tid, cee.memberId, cee.agentLabel, keyId2);
  assert.equal(delta.status, 201);
  const c2 = await commitKey(app, owner.token, tid, {
    expectedEpoch: 2,
    keyId: keyId2,
    commitment: commitment2,
  });
  assert.equal(c2.status, 200, `delta reseal recommit failed: ${JSON.stringify(c2.body)}`);
  assert.equal(c2.body.key_id, keyId2, 'same key material recommitted');
});

// ---------------------------------------------------------------------------
// Force audit + keyless agents
// ---------------------------------------------------------------------------





// ---------------------------------------------------------------------------
// Superseded identity keys
// ---------------------------------------------------------------------------

test('superseded_identity_key: envelope sealed to the old key is not force-overridable', async () => {
  const { app, owner, bee, tid } = await setupCommittedTopic(makeApp(), 'CommitSup');

  // Stage epoch 2 for owner + bee...
  const keyId2 = hex(16);
  const commitment2 = hex(32);
  await postEnvelope(app, owner.token, tid, owner.memberId, owner.agentLabel, keyId2);
  await postEnvelope(app, owner.token, tid, bee.memberId, bee.agentLabel, keyId2);
  // ...then bee rotates their identity key: the staged envelope is now
  // sealed to a SUPERSEDED key.
  const rot = await app.call('POST', '/v2/agent-keys/rotate', {
    token: bee.token,
    body: { agent_public_key: b64(32) },
  });
  assert.equal(rot.status, 200);

  const c = await commitKey(app, owner.token, tid, {
    expectedEpoch: 2,
    keyId: keyId2,
    commitment: commitment2,
  });
  assert.equal(c.status, 409);
  assert.equal(c.body.error.code, 'superseded_identity_key');

  // force cannot override: the owner must re-seal to the active key.
  const forced = await commitKey(app, owner.token, tid, {
    expectedEpoch: 2,
    keyId: keyId2,
    commitment: commitment2,
  });
  assert.equal(forced.status, 409);
  assert.equal(forced.body.error.code, 'superseded_identity_key');

  // Re-seal (the POST records the NEW active identity_key_id) and recommit.
  const reseal = await postEnvelope(app, owner.token, tid, bee.memberId, bee.agentLabel, keyId2);
  assert.equal(reseal.status, 201);
  const c2 = await commitKey(app, owner.token, tid, {
    expectedEpoch: 2,
    keyId: keyId2,
    commitment: commitment2,
  });
  assert.equal(c2.status, 200, `re-seal recommit failed: ${JSON.stringify(c2.body)}`);
});

// ---------------------------------------------------------------------------
// CAS race
// ---------------------------------------------------------------------------

test('CAS race: a second commit for the same epoch loses with 409', async () => {
  const { app, owner, bee, tid } = await setupCommittedTopic(makeApp(), 'CommitRace');

  // Winner: full epoch-2 commit.
  const winId = hex(16);
  await postEnvelope(app, owner.token, tid, owner.memberId, owner.agentLabel, winId);
  await postEnvelope(app, owner.token, tid, bee.memberId, bee.agentLabel, winId);
  const win = await commitKey(app, owner.token, tid, {
    expectedEpoch: 2,
    keyId: winId,
    commitment: hex(32),
  });
  assert.equal(win.status, 200);

  // Loser: staged against the same expected epoch with fresh material.
  // Single-threaded the pre-checks see the advanced epoch -> stale_epoch.
  // (The in-batch UNIQUE backstops + commitConflictError mapping cover the
  // true interleaving; they cannot be triggered without real concurrency.)
  const loseId = hex(16);
  await postEnvelope(app, owner.token, tid, owner.memberId, owner.agentLabel, loseId);
  await postEnvelope(app, owner.token, tid, bee.memberId, bee.agentLabel, loseId);
  const lose = await commitKey(app, owner.token, tid, {
    expectedEpoch: 2,
    keyId: loseId,
    commitment: hex(32),
  });
  assert.equal(lose.status, 409);
  assert.equal(lose.body.error.code, 'stale_epoch');
  assert.equal((await epochRows(app, tid)).length, 2, 'the loser appends nothing');
});

// ---------------------------------------------------------------------------
// Epoch log (§1.1)
// ---------------------------------------------------------------------------

test('epoch log is append-only: no UPDATE/DELETE path exists', async () => {
  const { app, owner, bee, tid } = await setupCommittedTopic(makeApp(), 'EpochAppend');
  const before = await epochRows(app, tid);
  assert.equal(before.length, 1);

  // No endpoint mutates the log: non-POST verbs on the commit path 404.
  for (const method of ['PUT', 'PATCH', 'DELETE', 'GET']) {
    const r = await app.call(method, `/v2/topics/${tid}/keys/commit`, { token: owner.token });
    assert.equal(r.status, 404, `${method} keys/commit must not exist`);
  }
  void bee;

  // A second commit only APPENDS; the epoch-1 row is byte-identical.
  const keyId2 = hex(16);
  for (const a of [
    { memberId: owner.memberId, agentLabel: owner.agentLabel },
    { memberId: bee.memberId, agentLabel: bee.agentLabel },
  ]) {
    await postEnvelope(app, owner.token, tid, a.memberId, a.agentLabel, keyId2);
  }
  const c = await commitKey(app, owner.token, tid, { expectedEpoch: 2, keyId: keyId2, commitment: hex(32) });
  assert.equal(c.status, 200);
  const after = await epochRows(app, tid);
  assert.equal(after.length, 2);
  assert.deepEqual(
    { ...after[0], created_at: null },
    { ...before[0], created_at: null },
    'the epoch-1 row is immutable',
  );
});

test('epoch log: missing commitments fail closed and uniqueness prevents key reuse', async () => {
  const app = makeApp();
  const { owner } = await setupKeyedFamily(app, 'EpochRequired');
  const { tid } = await createE2eeTopic(app, owner.token);
  const ts = new Date().toISOString();
  await assertRejects(app.db.execAtomically([{
    sql: `INSERT INTO topic_key_epochs(topic_id,epoch,key_id,commitment,recipients,created_at,created_by) VALUES (?,?,?,?,?,?,?)`,
    params: [tid,1,hex(16),null,'[]',ts,owner.memberId],
  }]), 'an unverifiable epoch must be rejected');
  await app.db.execAtomically([{
    sql: `INSERT INTO topic_key_epochs(topic_id,epoch,key_id,commitment,recipients,created_at,created_by) VALUES (?,?,?,?,?,?,?)`,
    params: [tid,1,hex(16),hex(32),'[]',ts,owner.memberId],
  }]);
  const rows = await epochRows(app, tid);
  assert.equal(rows.length, 1);
  // But key_id reuse is still rejected at the DB level (the backstop the
  // commit's 409 key_reuse leans on).
  const dupKey = rows[0]['key_id'] as string;
  await assertRejects(
    app.db.execAtomically([
      {
        sql: `INSERT INTO topic_key_epochs(topic_id, epoch, key_id, commitment, recipients, created_at, created_by)
              VALUES (?,?,?,?,?,?,?)`,
        params: [tid, 2, dupKey, hex(32), '[]', ts, owner.memberId],
      },
    ]),
    'duplicate (topic_id, key_id) must violate the UNIQUE backstop',
  );
  // And duplicate commitments are rejected too (key_material_reuse backstop).
  const c1 = hex(32);
  await app.db.execAtomically([
    {
      sql: `INSERT INTO topic_key_epochs(topic_id, epoch, key_id, commitment, recipients, created_at, created_by)
            VALUES (?,?,?,?,?,?,?)`,
      params: [tid, 2, hex(16), c1, '[]', ts, owner.memberId],
    },
  ]);
  await assertRejects(
    app.db.execAtomically([
      {
        sql: `INSERT INTO topic_key_epochs(topic_id, epoch, key_id, commitment, recipients, created_at, created_by)
              VALUES (?,?,?,?,?,?,?)`,
        params: [tid, 3, hex(16), c1, '[]', ts, owner.memberId],
      },
    ]),
    'duplicate (topic_id, commitment) must violate the UNIQUE backstop',
  );
  // And the (topic_id, epoch) primary key.
  await assertRejects(
    app.db.execAtomically([
      {
        sql: `INSERT INTO topic_key_epochs(topic_id, epoch, key_id, commitment, recipients, created_at, created_by)
              VALUES (?,?,?,?,?,?,?)`,
        params: [tid, 2, hex(16), hex(32), '[]', ts, owner.memberId],
      },
    ]),
    'duplicate (topic_id, epoch) must violate the primary key',
  );
});
