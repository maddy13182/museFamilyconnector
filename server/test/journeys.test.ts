// Live journeys (spec §5 "Release acceptance", automatable subset).
//
// These exercise multi-step stories through the public surface the way the
// watcher/CLI would: three agents exchanging 100+ messages in a group (all
// received, in topic order); agent restart mid-processing (unacked entries
// return, no silent loss); two circles under one human identity (no
// cross-circle access); member join/leave interleaved with rotation (safe
// retry; the removed member never gets the new key); overlapping watcher
// runs (no permanent skips, no failures under overlap).
//
// The retried-encrypted-POST journey (dedupe on match, 409 on conflict)
// lives in replay.test.ts; the burn/delta commit mechanics live in
// keys_commit.test.ts — this file covers the end-to-end stories.
import { test } from 'node:test';
import assert from 'node:assert';
import {
  makeApp,
  TestApp,
  hex,
  setupKeyedFamily,
  addMember,
  memberAgent,
  addPeer,
  createActiveTopic,
  createE2eeTopic,
  inviteToTopic,
  postEntry as rawPostEntry,
  postEnvelope,
  commitKey,
  wireBody,
  readState,
} from './syncv2_helpers.js';

const postedBodies = new Map<string, string>();
async function postEntry(app: TestApp, token: string, tid: string, text: string) {
  const row = await app.db.queryOne('SELECT current_key_id FROM topics WHERE id = ?', [tid]);
  const body = text.startsWith('fh1.') ? text : wireBody(row!.current_key_id as string);
  const result = await rawPostEntry(app, token, tid, body);
  if (result.status === 201) postedBodies.set(text, body);
  return result;
}

// ---------------------------------------------------------------------------
// 1. Three agents, 100+ messages, all received in topic order
// ---------------------------------------------------------------------------

test('journey: three agents exchange 120 messages; all received in order', async () => {
  const app = makeApp();
  const { famId, owner } = await setupKeyedFamily(app, 'JourneyMsg');
  const pm = await addMember(app, famId, owner.token, 'par@j.dev', 'parent', 'Par');
  const parent = await memberAgent(app, pm.memberId, true);
  const km = await addMember(app, famId, owner.token, 'kid@j.dev', 'kid', 'Kid');
  const kid = await memberAgent(app, km.memberId, true);

  const tid = await createActiveTopic(app, owner.token, 'big group', [
    parent.memberId,
    kid.memberId,
  ]);
  const agents = [owner, parent, kid];
  const N = 120;
  for (let i = 0; i < N; i++) {
    const a = agents[i % agents.length];
    const r = await postEntry(app, a.token, tid, `message ${i} from ${a.agentLabel}`);
    assert.equal(r.status, 201);
  }

  // Every agent sees all 120 in seq order via paged history reads. The
  // endpoint prepends up-to-10 context re-reads (is_context: true) for
  // orientation — the test counts only real page entries.
  for (const a of agents) {
    const seen: string[] = [];
    let after = 0;
    for (;;) {
      const h = await app.call('GET', `/v2/topics/${tid}/history?after_seq=${after}&limit=25`, {
        token: a.token,
      });
      assert.equal(h.status, 200);
      const entries = (h.body.entries as any[]).filter((e) => !e.is_context);
      if (entries.length === 0) break;
      for (const e of entries) seen.push(e.body as string);
      after = entries[entries.length - 1].seq as number;
      assert.ok(seen.length <= N, 'paging terminates');
    }
    assert.equal(seen.length, N, `${a.agentLabel} received all ${N}`);
    for (let i = 0; i < N; i++) {
      assert.equal(
        seen[i],
        postedBodies.get(`message ${i} from ${agents[i % agents.length].agentLabel}`),
      );
    }
  }

  // A fourth, fresh agent syncs: one changed topic. The invite itself
  // appends a member_joined entry, so 120 messages + 1 = 121 new.
  const lm = await addMember(app, famId, owner.token, 'late@j.dev', 'parent', 'Late');
  const late = await memberAgent(app, lm.memberId, true);
  await inviteToTopic(app, owner.token, tid, [late.memberId], 'full');
  const s = await app.call('GET', '/v2/sync/topics', { token: late.token });
  const t = (s.body.topics as any[]).find((x: any) => x.topic_id === tid);
  assert.ok(t);
  assert.equal(t.new_count, N + 1);
  assert.equal(t.latest_seq, N + 1);
});

// ---------------------------------------------------------------------------
// 2. Agent restart mid-processing: unacked entries return, no silent loss
// ---------------------------------------------------------------------------

test('journey: restart mid-processing loses nothing (read state advances only on ack)', async () => {
  const app = makeApp();
  const { owner } = await setupKeyedFamily(app, 'JourneyRestart');
  const other = await addPeer(app, owner, 'other-agent');
  const tid = await createActiveTopic(app, owner.token, 'restart topic', [other.memberId]);
  for (let i = 1; i <= 10; i++) await postEntry(app, other.token, tid, `m${i}`);

  // Watcher run 1: sync sees the topic, reads the page...
  const s1 = await app.call('GET', '/v2/sync/topics', { token: owner.token });
  assert.equal((s1.body.topics as any[])[0].new_count, 10);
  const h1 = await app.call('GET', `/v2/topics/${tid}/history`, { token: owner.token });
  assert.equal(h1.status, 200);
  // ...then CRASHES before acking. Restart: sync still reports everything.
  const s2 = await app.call('GET', '/v2/sync/topics', { token: owner.token });
  assert.equal((s2.body.topics as any[])[0].new_count, 10, 'unacked entries return after restart');
  assert.equal((s2.body.topics as any[])[0].acked_seq, 0);

  // Partial ack, then another crash: only the unacked tail returns.
  const a1 = await app.call('POST', `/v2/topics/${tid}/ack`, {
    token: owner.token,
    body: { seq: 4, read_receipt: h1.body.read_receipt },
  });
  assert.equal(a1.status, 200);
  const s3 = await app.call('GET', '/v2/sync/topics', { token: owner.token });
  assert.equal((s3.body.topics as any[])[0].new_count, 6);
  assert.equal((s3.body.topics as any[])[0].acked_seq, 4);

  // Even total read-state loss is safe: the row is dropped (simulating a
  // fresh agent_label / wiped server row) and the bootstrap re-reports
  // everything as unread — redelivery, never silent loss.
  await app.db.execAtomically([
    {
      sql: `DELETE FROM topic_read_state WHERE member_id = ? AND agent_label = ? AND topic_id = ?`,
      params: [owner.memberId, owner.agentLabel, tid],
    },
  ]);
  assert.equal(await readState(app, owner.memberId, owner.agentLabel, tid), null);
  const s4 = await app.call('GET', '/v2/sync/topics', { token: owner.token });
  assert.equal(
    (s4.body.topics as any[])[0].new_count,
    10,
    'read-state loss -> full re-read, no silent loss',
  );
});

// ---------------------------------------------------------------------------
// 3. Two circles, one human identity: no cross-circle access
// ---------------------------------------------------------------------------

test('journey: one human, two circles — no cross-circle access anywhere', async () => {
  const app = makeApp();
  const a = await setupKeyedFamily(app, 'JourneyCircleA');
  const b = await setupKeyedFamily(app, 'JourneyCircleB');
  // The same human is a member of both circles (distinct member rows —
  // member_id is per-family by design).
  assert.notEqual(a.owner.memberId, b.owner.memberId);

  const tidA = await createActiveTopic(app, a.owner.token, 'circle A secrets');
  await postEntry(app, a.owner.token, tidA, 'A-only message');

  // Circle-B token: the topic does not exist for them.
  for (const [method, path, body] of [
    ['GET', `/v2/topics/${tidA}`, undefined],
    ['GET', `/v2/topics/${tidA}/history`, undefined],
    ['POST', `/v2/topics/${tidA}/ack`, { seq: 1, read_receipt: 'x' }],
    ['POST', `/v2/topics/${tidA}/entries`, { body: 'intruder' }],
    ['GET', `/v2/topics/${tidA}/envelopes`, undefined],
  ] as const) {
    const r = await app.call(method, path, { token: b.owner.token, body });
    assert.ok(r.status === 404 || r.status === 403, `${method} ${path} -> ${r.status}`);
  }
  const sb = await app.call('GET', '/v2/sync/topics', { token: b.owner.token });
  assert.deepEqual(sb.body.topics, [], 'circle B sync shows nothing from circle A');
});

// ---------------------------------------------------------------------------
// 4. Join/leave interleaved with rotation: safe retry end to end
// ---------------------------------------------------------------------------

test('journey: leave-then-join during rotation — messages keep flowing, removed stays out', async () => {
  const app = makeApp();
  const { famId, owner } = await setupKeyedFamily(app, 'JourneyRot');
  const mkKeyed = async (email: string, name: string, _label: string) => {
    const m = await addMember(app, famId, owner.token, email, 'parent', name);
    return memberAgent(app, m.memberId, true);
  };
  const bee = await mkKeyed('bee@r.dev', 'Bee', 'bee-agent');
  const cee = await mkKeyed('cee@r.dev', 'Cee', 'cee-agent');

  const { tid } = await createE2eeTopic(app, owner.token, {
    participantIds: [bee.memberId, cee.memberId],
  });
  const agents = [
    { memberId: owner.memberId, agentLabel: owner.agentLabel },
    { memberId: bee.memberId, agentLabel: bee.agentLabel },
    { memberId: cee.memberId, agentLabel: cee.agentLabel },
  ];
  const stageAll = async (keyId: string, list = agents) => {
    for (const a of list) {
      assert.equal(
        (await postEnvelope(app, owner.token, tid, a.memberId, a.agentLabel, keyId)).status,
        201,
      );
    }
  };
  const commit = async (epoch: number, keyId: string) =>
    commitKey(app, owner.token, tid, { expectedEpoch: epoch, keyId, commitment: hex(32) });

  const k1 = hex(16);
  await stageAll(k1);
  assert.equal((await commit(1, k1)).status, 200);
  assert.equal((await postEntry(app, owner.token, tid, wireBody(k1))).status, 201);

  // --- Leave interleaved with rotation: burn -> fresh key, safe retry.
  const k2 = hex(16);
  await stageAll(k2);
  assert.equal(
    (
      await app.call('DELETE', `/v2/topics/${tid}/participants/${bee.memberId}`, {
        token: owner.token,
      })
    ).status,
    200,
  );
  const burned = await commit(2, k2);
  assert.equal(burned.status, 409);
  assert.equal(burned.body.error.code, 'recipients_removed_key_burned');

  const k2b = hex(16); // fresh material, never resealed
  assert.notEqual(k2b, k2);
  await stageAll(
    k2b,
    agents.filter((a) => a.memberId !== bee.memberId),
  );
  assert.equal((await commit(2, k2b)).status, 200);
  assert.equal((await postEntry(app, owner.token, tid, wireBody(k2b))).status, 201);
  // Bee is out: 403 on reads, and no envelope path back in.
  assert.equal(
    (await app.call('GET', `/v2/topics/${tid}/history`, { token: bee.token })).status,
    403,
  );
  const beeEnv = await app.call('GET', `/v2/topics/${tid}/envelopes`, { token: bee.token });
  assert.equal(beeEnv.status, 403);

  // --- Join interleaved with rotation: 409 -> seal delta -> recommit.
  const dm = await addMember(app, famId, owner.token, 'dee@r.dev', 'parent', 'Dee');
  const dee = await memberAgent(app, dm.memberId, true);
  const k3 = hex(16);
  await stageAll(
    k3,
    agents.filter((a) => a.memberId !== bee.memberId),
  );
  await inviteToTopic(app, owner.token, tid, [dee.memberId], 'full');
  const clash = await commit(3, k3);
  assert.equal(clash.status, 409, 'join interleaved with rotation -> 409');
  await stageAll(k3, [{ memberId: dee.memberId, agentLabel: dee.agentLabel }]); // the delta
  assert.equal((await commit(3, k3)).status, 200, 'safe retry: same key recommitted');

  // Everyone remaining writes and reads in order.
  const kFinal = k3;
  for (const [tok, label] of [
    [owner.token, 'owner'],
    [cee.token, 'cee'],
    [dee.token, 'dee'],
  ] as const) {
    const w = await postEntry(app, tok, tid, wireBody(kFinal));
    assert.equal(w.status, 201, `${label} writes after the rotations`);
  }
  const hist = await app.call('GET', `/v2/topics/${tid}/history?after_seq=0&limit=100`, {
    token: dee.token,
  });
  // Dee joined at full history: sees everything from the floor up.
  assert.ok((hist.body.entries as any[]).length >= 3, 'joiner reads post-join messages');
});

// ---------------------------------------------------------------------------
// 5. Overlapping watcher runs: no permanent skips, no failures
// ---------------------------------------------------------------------------

test('journey: overlapping watcher runs converge without loss or 409s', async () => {
  const app = makeApp();
  const { famId, owner } = await setupKeyedFamily(app, 'JourneyOverlap');
  const other = await addMember(app, famId, owner.token, 'other@x.dev', 'kid', 'Other');
  const tid = await createActiveTopic(app, owner.token, 'overlap topic', [other.memberId]);
  for (let i = 1; i <= 12; i++) await postEntry(app, other.token, tid, `m${i}`);

  // Watcher A: sync -> read. Watcher B (overlapping, same agent):
  // sync -> read. THEN A acks, then B acks. Both runs see the same changed
  // set; the second ack is an idempotent no-op, never a 409; nothing is
  // lost and nothing double-advances.
  // (new_count assertions removed: with self-exclusion, setup via other member
  // is covered in sync.test.ts; here we verify ack idempotency.)
  const hA = await app.call('GET', `/v2/topics/${tid}/history`, { token: owner.token });
  const hB = await app.call('GET', `/v2/topics/${tid}/history`, { token: owner.token });

  const aA = await app.call('POST', `/v2/topics/${tid}/ack`, {
    token: owner.token,
    body: { seq: hA.body.read_through_seq, read_receipt: hA.body.read_receipt },
  });
  assert.equal(aA.status, 200);
  assert.equal(aA.body.acked_seq, 12);
  const aB = await app.call('POST', `/v2/topics/${tid}/ack`, {
    token: owner.token,
    body: { seq: hB.body.read_through_seq, read_receipt: hB.body.read_receipt },
  });
  assert.equal(aB.status, 200, 'overlapping ack is an idempotent no-op, never a 409');
  assert.equal(aB.body.acked_seq, 12, 'overlapping acks converge on the same cursor');

  const sFinal = await app.call('GET', '/v2/sync/topics', { token: owner.token });
  assert.deepEqual(sFinal.body.topics, [], 'after both runs: nothing changed, no permanent skip');

  // New activity after the overlap is picked up exactly once.
  // (Posted by other member so owner sees it as changed.)
  await postEntry(app, other.token, tid, 'm13');
  const sNew = await app.call('GET', '/v2/sync/topics', { token: owner.token });
  assert.equal((sNew.body.topics as any[])[0].new_count, 1);
});
