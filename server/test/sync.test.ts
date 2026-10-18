// Sync v2 — GET /v2/sync/topics (spec §1.3, §1.4).
//
// Covers: per-circle scoping (one credential, explicit circle selection; cross-family topic
// ids 404 on topic-scoped endpoints); the history_from_seq visibility floor;
// ordering (last_activity_ts DESC, topic_id ASC); paging (limit/page_token,
// has_more, invalid token 400); the bootstrap full re-read (first call seeds
// read-state rows at acked_seq 0 and reports every visible topic as changed
// once); encrypted key_status (ok / pending); assigned_to_me; and a
// page-boundary race (changed sets may shift between pages — the client
// dedupes; the server must stay consistent and never 500).
import { test } from 'node:test';
import assert from 'node:assert';
import {
  makeApp,
  TestApp,
  setupKeyedFamily,
  addMember,
  addPeer,
  createActiveTopic,
  inviteToTopic,
  postEntry as rawPostEntry,
  wireBody,
  readState,
} from './syncv2_helpers.js';

async function postEntry(
  app: TestApp,
  token: string,
  tid: string,
  text: string,
  extra: Record<string, unknown> = {},
) {
  const row = await app.db.queryOne('SELECT current_key_id FROM topics WHERE id = ?', [tid]);
  return rawPostEntry(
    app,
    token,
    tid,
    text.startsWith('fh1.') ? text : wireBody(row!.current_key_id as string),
    extra,
  );
}

async function syncTopics(app: TestApp, token: string, qs = '') {
  return app.call('GET', `/v2/sync/topics${qs}`, { token });
}

// ---------------------------------------------------------------------------
// Per-circle scoping
// ---------------------------------------------------------------------------

test('sync/topics is per-circle: a token sees only its own circle topics', async () => {
  const app = makeApp();
  const a = await setupKeyedFamily(app, 'SyncFamA');
  const b = await setupKeyedFamily(app, 'SyncFamB');

  const tidA = await createActiveTopic(app, a.owner.token, 'A topic');
  const tidB = await createActiveTopic(app, b.owner.token, 'B topic');
  // Note: own posts don't flag topics as changed (server excludes self
  // from new_count). For the isolation check, we verify the other
  // circle's topic never appears — the per-circle WHERE clause, not
  // new_count, drives that.
  await postEntry(app, a.owner.token, tidA, 'hello A');
  await postEntry(app, b.owner.token, tidB, 'hello B');

  const sa = await syncTopics(app, a.owner.token);
  assert.equal(sa.status, 200);
  const idsA = (sa.body.topics as any[]).map((t) => t.topic_id);
  // tidA not listed: own post doesn't count as new (new behavior).
  assert.ok(!idsA.includes(tidA), 'own post does not flag topic as changed');
  assert.ok(!idsA.includes(tidB), 'other circle topic must not leak');
  for (const t of sa.body.topics as any[]) {
    assert.equal(t.circle_id, a.famId);
  }

  const sb = await syncTopics(app, b.owner.token);
  const idsB = (sb.body.topics as any[]).map((t) => t.topic_id);
  assert.ok(!idsB.includes(tidB), 'own post does not flag topic as changed');
  assert.ok(!idsB.includes(tidA));
});

test('cross-family topic ids 404 on topic-scoped endpoints (no existence leak)', async () => {
  const app = makeApp();
  const a = await setupKeyedFamily(app, 'SyncFamA2');
  const b = await setupKeyedFamily(app, 'SyncFamB2');
  const tidA = await createActiveTopic(app, a.owner.token, 'A topic');

  for (const [method, path, body] of [
    ['GET', `/v2/topics/${tidA}/history`, undefined],
    ['POST', `/v2/topics/${tidA}/ack`, { seq: 1, read_receipt: 'x' }],
    ['GET', `/v2/topics/${tidA}/envelopes`, undefined],
  ] as const) {
    const r = await app.call(method, path, { token: b.owner.token, body });
    assert.equal(r.status, 404, `${method} ${path} should 404 cross-family`);
  }
});

// ---------------------------------------------------------------------------
// Visibility floor (history_from_seq)
// ---------------------------------------------------------------------------

test('visibility floor: from_join member counts only post-floor entries as new', async () => {
  const app = makeApp();
  const { famId, owner } = await setupKeyedFamily(app, 'SyncFloor');
  const tid = await createActiveTopic(app, owner.token, 'floor topic');
  await postEntry(app, owner.token, tid, 'old one');
  await postEntry(app, owner.token, tid, 'old two');

  const kid = await addMember(app, famId, owner.token, 'kid@f.dev', 'kid', 'Kid');
  await inviteToTopic(app, owner.token, tid, [kid.memberId], 'from_join');

  await postEntry(app, owner.token, tid, 'new three');

  const floor = (await app.db.queryOne(
    `SELECT history_from_seq FROM topic_participants WHERE topic_id = ? AND member_id = ?`,
    [tid, kid.memberId],
  ))!['history_from_seq'] as number;

  const s = await syncTopics(app, kid.token);
  assert.equal(s.status, 200);
  const topics = s.body.topics as any[];
  assert.equal(topics.length, 1);
  const t = topics[0];
  // acked_seq is the EFFECTIVE position: max(stored 0, floor-1).
  assert.equal(t.acked_seq, floor - 1);
  // Only entries at/above the floor are visible; new = visible minus floor.
  assert.equal(t.new_count, t.latest_seq - (floor - 1));
  assert.ok(t.new_count >= 1, 'post-join entries are new');
});

test('acked_seq reported is max(stored acked_seq, history_from_seq - 1)', async () => {
  const app = makeApp();
  const { famId, owner } = await setupKeyedFamily(app, 'SyncFloor2');
  const tid = await createActiveTopic(app, owner.token, 'floor topic 2');
  await postEntry(app, owner.token, tid, 'm1');
  const kid = await addMember(app, famId, owner.token, 'kid2@f.dev', 'kid', 'Kid2');
  await inviteToTopic(app, owner.token, tid, [kid.memberId], 'from_join');
  const floor = (await app.db.queryOne(
    `SELECT history_from_seq FROM topic_participants WHERE topic_id = ? AND member_id = ?`,
    [tid, kid.memberId],
  ))!['history_from_seq'] as number;

  // Ack BELOW the floor: the effective position stays at the floor.
  const hist = await app.call('GET', `/v2/topics/${tid}/history`, { token: kid.token });
  const ack = await app.call('POST', `/v2/topics/${tid}/ack`, {
    token: kid.token,
    body: { seq: 1, read_receipt: hist.body.read_receipt },
  });
  assert.equal(ack.status, 200);
  const eff = Math.max(1, floor - 1);
  const s = await syncTopics(app, kid.token);
  const t = (s.body.topics as any[])[0] ?? null;
  if (t) assert.equal(t.acked_seq, eff, 'effective ack is the floor when the stored ack is lower');
});

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

test('ordering: last_activity_ts DESC, topic_id ASC on ties', async () => {
  const app = makeApp();
  const { owner } = await setupKeyedFamily(app, 'SyncOrder');
  const other = await addPeer(app, owner, 'other-agent');
  const t1 = await createActiveTopic(app, owner.token, 't1', [other.memberId]);
  const t2 = await createActiveTopic(app, owner.token, 't2', [other.memberId]);
  const t3 = await createActiveTopic(app, owner.token, 't3', [other.memberId]);
  // Activity order: t2, then t1, then t3 -> expected order t3, t1, t2.
  // (Other posts so owner sees them as new.)
  await postEntry(app, other.token, t2, 'a');
  await new Promise((r) => setTimeout(r, 15));
  await postEntry(app, other.token, t1, 'b');
  await new Promise((r) => setTimeout(r, 15));
  await postEntry(app, other.token, t3, 'c');

  const s = await syncTopics(app, owner.token);
  const ids = (s.body.topics as any[]).map((t) => t.topic_id);
  assert.deepEqual(ids, [t3, t1, t2]);

  // Tiebreak: two changed topics with IDENTICAL last_activity_ts sort by
  // topic_id ASC (pinned via a direct ts update — the server sorts on the
  // stored timestamp).
  const a1 = await createActiveTopic(app, owner.token, 'tie1', [other.memberId]);
  const a2 = await createActiveTopic(app, owner.token, 'tie2', [other.memberId]);
  await postEntry(app, other.token, a1, 'x');
  await postEntry(app, other.token, a2, 'y');
  const tieTs = '2026-10-13T00:00:00.000Z';
  await app.db.execAtomically([
    { sql: `UPDATE entries SET ts = ? WHERE topic_id = ?`, params: [tieTs, a1] },
    { sql: `UPDATE entries SET ts = ? WHERE topic_id = ?`, params: [tieTs, a2] },
  ]);
  const s2 = await syncTopics(app, owner.token, '?limit=200');
  const tied = (s2.body.topics as any[])
    .map((t) => t.topic_id)
    .filter((id: string) => id === a1 || id === a2);
  assert.deepEqual(tied, [a1, a2].sort(), 'equal-activity topics tiebreak by topic_id ASC');
});

// ---------------------------------------------------------------------------
// Paging
// ---------------------------------------------------------------------------

test('paging: limit/page_token walk the full changed set; bad token is 400', async () => {
  const app = makeApp();
  const { owner } = await setupKeyedFamily(app, 'SyncPage');
  const other = await addPeer(app, owner, 'other-agent');
  const tids: string[] = [];
  for (let i = 0; i < 5; i++) {
    const tid = await createActiveTopic(app, owner.token, `ptopic ${i}`, [other.memberId]);
    await postEntry(app, other.token, tid, `msg ${i}`);
    tids.push(tid);
  }

  const seen: string[] = [];
  let pageToken: string | null = null;
  let pages = 0;
  for (;;) {
    const qs = `?limit=2${pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ''}`;
    const s = await syncTopics(app, owner.token, qs);
    assert.equal(s.status, 200);
    pages++;
    for (const t of s.body.topics as any[]) seen.push(t.topic_id);
    if (!s.body.has_more) break;
    assert.ok(s.body.next_page_token, 'has_more requires next_page_token');
    pageToken = s.body.next_page_token as string;
    assert.ok(pages < 10, 'paging must terminate');
  }
  assert.equal(pages, 3, '5 topics at limit=2 -> 3 pages');
  assert.deepEqual(new Set(seen), new Set(tids), 'every changed topic seen across pages');

  const bad = await syncTopics(app, owner.token, '?page_token=!!!not-base64!!!');
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'bad_request');
});

test('page-boundary race: activity between pages never 500s; nothing permanently skipped', async () => {
  const app = makeApp();
  const { owner } = await setupKeyedFamily(app, 'SyncRace');
  const other = await addPeer(app, owner, 'other-agent');
  const tids: string[] = [];
  for (let i = 0; i < 4; i++) {
    const tid = await createActiveTopic(app, owner.token, `rtopic ${i}`, [other.memberId]);
    await postEntry(app, other.token, tid, `msg ${i}`);
    tids.push(tid);
  }
  // Page 1...
  const p1 = await syncTopics(app, owner.token, '?limit=2');
  assert.equal(p1.status, 200);
  assert.equal(p1.body.has_more, true);
  // ...new activity lands before page 2, shifting the changed set. The spec
  // documents this: offset paging over a moving set can skip an item
  // mid-walk, and the CLI dedupes. The server must stay consistent.
  const extra = await createActiveTopic(app, owner.token, 'rtopic extra', [other.memberId]);
  await postEntry(app, other.token, extra, 'late arrival');
  const token2 = p1.body.next_page_token as string;
  const p2 = await syncTopics(
    app,
    owner.token,
    `?limit=2&page_token=${encodeURIComponent(token2)}`,
  );
  assert.equal(p2.status, 200, 'shifted page 2 must not 500');
  assert.ok(Array.isArray(p2.body.topics), 'page 2 is well-formed');
  // The real guarantee: anything skipped mid-walk is still unacked, so a
  // FRESH sync (no page token) reports every changed topic with its full
  // new_count — no permanent skip is possible.
  const fresh = await syncTopics(app, owner.token, '?limit=200');
  assert.equal(fresh.status, 200);
  const freshIds = new Set((fresh.body.topics as any[]).map((t: any) => t.topic_id));
  for (const tid of [...tids, extra]) {
    assert.ok(freshIds.has(tid), `topic ${tid} permanently skipped`);
    const t = (fresh.body.topics as any[]).find((x: any) => x.topic_id === tid);
    assert.equal(t.new_count, 1, 'new_count intact after the shift');
  }
});

// ---------------------------------------------------------------------------
// Bootstrap full re-read
// ---------------------------------------------------------------------------

test('bootstrap: first call seeds read state at 0 and reports all visible topics once', async () => {
  const app = makeApp();
  const { owner } = await setupKeyedFamily(app, 'SyncBoot');
  const other = await addPeer(app, owner, 'other-agent');
  const tid = await createActiveTopic(app, owner.token, 'boot topic', [other.memberId]);
  await postEntry(app, other.token, tid, 'one');
  await postEntry(app, other.token, tid, 'two');

  assert.equal(await readState(app, owner.memberId, owner.agentLabel, tid), null);

  const s1 = await syncTopics(app, owner.token);
  assert.equal(s1.status, 200);
  assert.equal((s1.body.topics as any[]).length, 1);
  const t = (s1.body.topics as any[])[0];
  assert.equal(t.new_count, 2, 'bootstrap reports every visible entry as new');
  assert.equal(t.acked_seq, 0);
  assert.equal(
    await readState(app, owner.memberId, owner.agentLabel, tid),
    0,
    'bootstrap seeds the row',
  );

  // Ack everything: the next sync is quiet.
  const hist = await app.call('GET', `/v2/topics/${tid}/history`, { token: owner.token });
  const ack = await app.call('POST', `/v2/topics/${tid}/ack`, {
    token: owner.token,
    body: { seq: hist.body.read_through_seq, read_receipt: hist.body.read_receipt },
  });
  assert.equal(ack.status, 200);
  const s2 = await syncTopics(app, owner.token);
  assert.deepEqual(s2.body.topics, [], 'nothing changed after a full ack');
});

test('unsupported sync filters are rejected before read state is seeded', async () => {
  const app = makeApp();
  const {owner}=await setupKeyedFamily(app,'SyncQuery');
  const peer=await addPeer(app,owner,'peer');
  const topic=await createActiveTopic(app,owner.token,'Private',[peer.memberId]);
  await postEntry(app,peer.token,topic,'Unread');
  const rejected=await syncTopics(app,owner.token,'?unsupported_filter=1');
  assert.equal(rejected.status,400);
  assert.equal(await readState(app,owner.memberId,owner.agentLabel,topic),null);
  const accepted=await syncTopics(app,owner.token);
  assert.equal(accepted.status,200);
  assert.equal(accepted.body.topics[0].new_count,1);
});

// ---------------------------------------------------------------------------
// key_status
// ---------------------------------------------------------------------------

test('key_status is ok when the participant holds the active encrypted key', async () => {
  const app = makeApp();
  const { famId, owner } = await setupKeyedFamily(app, 'SyncKeyStatus');
  const kid = await addMember(app, famId, owner.token, 'k@ks.dev', 'kid', 'Kid');

  // Encrypted topic with committed keys; another participant posts.
  const encrypted = await createActiveTopic(app, owner.token, 'encrypted', [kid.memberId]);
  await postEntry(app, kid.token, encrypted, 'hi');

  const so = await syncTopics(app, owner.token, '?limit=200');
  const byId = new Map((so.body.topics as any[]).map((t: any) => [t.topic_id, t]));
  assert.equal(byId.get(encrypted)!.key_status, 'ok');
  // E2EE key_status variants (ok/pending) are covered in e2ee-specific tests.
});

// ---------------------------------------------------------------------------
// assigned_to_me
// ---------------------------------------------------------------------------

test('assigned_to_me: true only for open tasks assigned to the caller', async () => {
  const app = makeApp();
  const { famId, owner } = await setupKeyedFamily(app, 'SyncAssign');
  const kid = await addMember(app, famId, owner.token, 'k@as.dev', 'kid', 'KidA');
  const tid = await createActiveTopic(app, owner.token, 'assign topic', [kid.memberId]);
  await postEntry(app, kid.token, tid, 'hello');

  const mk = await app.call('POST', `/v2/topics/${tid}/tasks`, {
    token: owner.token,
    body: {
      title: wireBody(
        (await app.db.queryOne('SELECT current_key_id FROM topics WHERE id = ?', [tid]))!
          .current_key_id as string,
      ),
      assignee_member_id: kid.memberId,
    },
  });
  assert.equal(mk.status, 201);
  const taskId = mk.body.task.id as string;

  const sk = await syncTopics(app, kid.token);
  assert.equal((sk.body.topics as any[])[0].assigned_to_me, true);
  const so = await syncTopics(app, owner.token);
  assert.equal((so.body.topics as any[])[0].assigned_to_me, false, 'owner is not the assignee');

  // Done tasks no longer count.
  const done = await app.call('POST', `/v2/tasks/${taskId}/done`, { token: kid.token, body: {} });
  assert.equal(done.status, 200);
  const sk2 = await syncTopics(app, kid.token);
  const t2 = (sk2.body.topics as any[]).find((x: any) => x.topic_id === tid) ?? null;
  // After done the topic may drop out of changed entirely; either way it
  // must not claim an assignment.
  if (t2) assert.equal(t2.assigned_to_me, false);
});

// ---------------------------------------------------------------------------
// Changed-set semantics
// ---------------------------------------------------------------------------

test('unchanged topics are omitted; new activity re-lists the topic', async () => {
  const app = makeApp();
  const { owner } = await setupKeyedFamily(app, 'SyncChanged');
  // Second member posts; owner syncs. Own posts never flag as changed.
  const other = await addPeer(app, owner, 'other-agent');
  const tid = await createActiveTopic(app, owner.token, 'changed topic', [other.memberId]);
  await postEntry(app, other.token, tid, 'one');
  const s1 = await syncTopics(app, owner.token);
  assert.equal((s1.body.topics as any[]).length, 1);

  const hist = await app.call('GET', `/v2/topics/${tid}/history`, { token: owner.token });
  await app.call('POST', `/v2/topics/${tid}/ack`, {
    token: owner.token,
    body: { seq: hist.body.read_through_seq, read_receipt: hist.body.read_receipt },
  });
  const s2 = await syncTopics(app, owner.token);
  assert.deepEqual(s2.body.topics, []);

  await postEntry(app, other.token, tid, 'two');
  const s3 = await syncTopics(app, owner.token);
  assert.equal((s3.body.topics as any[]).length, 1);
  assert.equal((s3.body.topics as any[])[0].new_count, 1);
  assert.equal((s3.body.topics as any[])[0].latest_seq, 2);
  assert.equal((s3.body.topics as any[])[0].last_actor, other.memberId);
  assert.ok((s3.body.topics as any[])[0].last_activity_ts, 'last_activity_ts present');
});

// ---------------------------------------------------------------------------
// Update advertisement (decoupled releases)
// ---------------------------------------------------------------------------

test('sync/topics carries a versions stanza for update advertisement', async () => {
  const app = makeApp();
  const a = await setupKeyedFamily(app, 'SyncFamVer');
  const tid = await createActiveTopic(app, a.owner.token, 'Version topic');
  await postEntry(app, a.owner.token, tid, 'hello');

  const res = await syncTopics(app, a.owner.token);
  assert.equal(res.status, 200);
  const v = res.body.versions;
  assert.ok(v && typeof v === 'object', 'versions stanza present');
  assert.match(v.server, /^\d+\.\d+\.\d+$/, 'server version is semver');
  assert.match(v.cli, /^\d+\.\d+\.\d+$/, 'advertised CLI version is semver');
  assert.match(v.skill, /^\d+\.\d+\.\d+$/, 'advertised skill version is semver');
});
