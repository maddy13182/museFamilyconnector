// POST /v1/topics/:tid/ack — receipt-bound, contiguous ack (spec §1.4).
//
// Covers: the happy path (history -> receipt -> ack advances); receipt HMAC
// verification (forgery -> 403 invalid_read_receipt); cross-agent receipt
// replay (403 — the member/agent/topic binding lives inside the HMAC);
// cross-topic receipt replay (403); contiguity enforcement (409
// noncontiguous_ack on gaps and over-acks); idempotent replay (seq <=
// effective -> no-op success); per-agent isolation (two agents, one member,
// independent acked_seq); 400 on missing/malformed fields; 404 cross-family.
import { test } from 'node:test';
import assert from 'node:assert';
import {
  makeApp,
  TestApp,
  setupKeyedFamily,
  addMember,
  addAgent,
  createPlainTopic,
  postEntry,
  readState,
} from './syncv2_helpers.js';

async function postN(app: TestApp, token: string, tid: string, n: number) {
  for (let i = 1; i <= n; i++) await postEntry(app, token, tid, `msg ${i}`);
}

/** history -> { read_through_seq, read_receipt } */
async function readPage(app: TestApp, token: string, tid: string, qs = '') {
  const h = await app.call('GET', `/v1/topics/${tid}/history${qs}`, { token });
  assert.equal(h.status, 200);
  return { through: h.body.read_through_seq as number, receipt: h.body.read_receipt as string };
}

async function ack(app: TestApp, token: string, tid: string, seq: number, receipt: string) {
  return app.call('POST', `/v1/topics/${tid}/ack`, {
    token,
    body: { seq, read_receipt: receipt },
  });
}

// ---------------------------------------------------------------------------
// Happy path + idempotent replay
// ---------------------------------------------------------------------------

test('ack advances read state; replay at/below effective is a no-op success', async () => {
  const app = makeApp();
  const { owner } = await setupKeyedFamily(app, 'AckFam1');
  const tid = await createPlainTopic(app, owner.token, 'ack topic');
  await postN(app, owner.token, tid, 5);

  const { through, receipt } = await readPage(app, owner.token, tid);
  assert.equal(through, 5);
  assert.match(receipt, /^fhrr1\./, 'receipt wire format');

  const r = await ack(app, owner.token, tid, 5, receipt);
  assert.equal(r.status, 200);
  assert.equal(r.body.acked_seq, 5);
  assert.equal(await readState(app, owner.memberId, owner.agentLabel, tid), 5);

  // Idempotent replay: seq <= effective -> no-op success, state unchanged.
  const r2 = await ack(app, owner.token, tid, 5, receipt);
  assert.equal(r2.status, 200);
  assert.equal(r2.body.acked_seq, 5);
  const r3 = await ack(app, owner.token, tid, 3, receipt);
  assert.equal(r3.status, 200);
  assert.equal(r3.body.acked_seq, 5, 'replay must never move the cursor backwards');
  assert.equal(await readState(app, owner.memberId, owner.agentLabel, tid), 5);
});

test('acks advance in order: partial then full', async () => {
  const app = makeApp();
  const { owner } = await setupKeyedFamily(app, 'AckFam2');
  const tid = await createPlainTopic(app, owner.token, 'ack topic 2');
  await postN(app, owner.token, tid, 6);

  const p1 = await readPage(app, owner.token, tid, '?after_seq=0&limit=3');
  assert.equal(p1.through, 3);
  const a1 = await ack(app, owner.token, tid, 3, p1.receipt);
  assert.equal(a1.status, 200);
  assert.equal(a1.body.acked_seq, 3);

  const p2 = await readPage(app, owner.token, tid, '?after_seq=3&limit=3');
  assert.equal(p2.through, 6);
  const a2 = await ack(app, owner.token, tid, 6, p2.receipt);
  assert.equal(a2.status, 200);
  assert.equal(a2.body.acked_seq, 6);
});

// ---------------------------------------------------------------------------
// Receipt verification (adversarial)
// ---------------------------------------------------------------------------

test('forged receipt -> 403 invalid_read_receipt', async () => {
  const app = makeApp();
  const { owner } = await setupKeyedFamily(app, 'AckForge');
  const tid = await createPlainTopic(app, owner.token, 'forge topic');
  await postN(app, owner.token, tid, 3);
  const { receipt } = await readPage(app, owner.token, tid);

  // Flip the last hex char of the MAC.
  const forged = receipt.slice(0, -1) + (receipt.endsWith('0') ? '1' : '0');
  const r = await ack(app, owner.token, tid, 3, forged);
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'invalid_read_receipt');
  assert.equal(await readState(app, owner.memberId, owner.agentLabel, tid), null);

  // Garbage receipts are 403, never 500; an empty receipt is 400
  // (the field is required).
  const empty = await app.call('POST', `/v1/topics/${tid}/ack`, {
    token: owner.token,
    body: { seq: 3, read_receipt: '' },
  });
  assert.equal(empty.status, 400);
  for (const bad of ['fhrr1.1.3', 'fhrr1.1.3.' + 'zz'.repeat(32), 'not-a-receipt']) {
    const rb = await app.call('POST', `/v1/topics/${tid}/ack`, {
      token: owner.token,
      body: { seq: 3, read_receipt: bad },
    });
    assert.equal(rb.status, 403, `receipt ${JSON.stringify(bad)}`);
  }
});

test('cross-agent receipt replay -> 403 (binding is inside the HMAC)', async () => {
  const app = makeApp();
  const { famId, owner } = await setupKeyedFamily(app, 'AckXAgent');
  const tid = await createPlainTopic(app, owner.token, 'xagent topic');
  await postN(app, owner.token, tid, 4);

  // Second agent for the SAME member (participants are per-member, so both
  // agents may read — but the receipt binds the agent_label).
  const agent2 = await addAgent(app, owner.token, owner.memberId, 'owner-second', false);

  const { receipt } = await readPage(app, owner.token, tid); // bound to owner-agent
  const r = await ack(app, agent2.token, tid, 4, receipt); // replayed by owner-second
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'invalid_read_receipt');
  assert.equal(await readState(app, owner.memberId, 'owner-second', tid), null);

  // The receipt works for the agent it was minted for.
  const ok = await ack(app, owner.token, tid, 4, receipt);
  assert.equal(ok.status, 200);
});

test('cross-topic receipt replay -> 403', async () => {
  const app = makeApp();
  const { owner } = await setupKeyedFamily(app, 'AckXTopic');
  const t1 = await createPlainTopic(app, owner.token, 'topic one');
  const t2 = await createPlainTopic(app, owner.token, 'topic two');
  await postN(app, owner.token, t1, 2);
  await postN(app, owner.token, t2, 2);

  const { receipt } = await readPage(app, owner.token, t1);
  const r = await ack(app, owner.token, t2, 2, receipt);
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'invalid_read_receipt');
});

// ---------------------------------------------------------------------------
// Contiguity
// ---------------------------------------------------------------------------

test('ack beyond the receipt through_seq -> 409 noncontiguous_ack', async () => {
  const app = makeApp();
  const { owner } = await setupKeyedFamily(app, 'AckContig1');
  const tid = await createPlainTopic(app, owner.token, 'contig topic');
  await postN(app, owner.token, tid, 6);

  // Receipt covers only seqs 1..3; acking 6 overruns it.
  const p = await readPage(app, owner.token, tid, '?after_seq=0&limit=3');
  const r = await ack(app, owner.token, tid, 6, p.receipt);
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'noncontiguous_ack');
  assert.equal(await readState(app, owner.memberId, owner.agentLabel, tid), null);
});

test('ack with a from_seq gap -> 409 noncontiguous_ack', async () => {
  const app = makeApp();
  const { owner } = await setupKeyedFamily(app, 'AckContig2');
  const tid = await createPlainTopic(app, owner.token, 'contig topic 2');
  await postN(app, owner.token, tid, 9);

  // Read starting AFTER seq 5: the receipt's from_seq is 6, but the
  // effective ack is 0 — from_seq (6) > effective+1 (1): a gap.
  const p = await readPage(app, owner.token, tid, '?after_seq=5');
  assert.ok(p.receipt.startsWith('fhrr1.6.'), 'receipt from_seq is the requested boundary');
  const r = await ack(app, owner.token, tid, 9, p.receipt);
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'noncontiguous_ack');
});

// ---------------------------------------------------------------------------
// Per-agent isolation
// ---------------------------------------------------------------------------

test('two agents of one member keep independent acked_seq', async () => {
  const app = makeApp();
  const { owner } = await setupKeyedFamily(app, 'AckIso');
  const tid = await createPlainTopic(app, owner.token, 'iso topic');
  await postN(app, owner.token, tid, 8);
  const agent2 = await addAgent(app, owner.token, owner.memberId, 'owner-second', false);

  const r1 = await readPage(app, owner.token, tid);
  await ack(app, owner.token, tid, 8, r1.receipt);

  // Agent 2 is unaffected by agent 1's ack: everything still unread.
  const s = await app.call('GET', '/v1/sync/topics', { token: agent2.token });
  const t = (s.body.topics as any[]).find((x: any) => x.topic_id === tid);
  assert.ok(t, 'topic still changed for the second agent');
  assert.equal(t.new_count, 8);
  assert.equal(t.acked_seq, 0);

  const r2 = await readPage(app, agent2.token, tid);
  const a2 = await ack(app, agent2.token, tid, 5, r2.receipt);
  assert.equal(a2.status, 200);
  assert.equal(await readState(app, owner.memberId, 'owner-second', tid), 5);
  assert.equal(await readState(app, owner.memberId, owner.agentLabel, tid), 8);
});

// ---------------------------------------------------------------------------
// Validation + scoping
// ---------------------------------------------------------------------------

test('ack requires seq and read_receipt (400 otherwise)', async () => {
  const app = makeApp();
  const { owner } = await setupKeyedFamily(app, 'AckValid');
  const tid = await createPlainTopic(app, owner.token, 'valid topic');

  for (const body of [
    {},
    { seq: 1 },
    { read_receipt: 'x' },
    { seq: -1, read_receipt: 'x' },
    { seq: 1.5, read_receipt: 'x' },
    { seq: '1', read_receipt: 'x' },
    { seq: 1, read_receipt: '' },
    { seq: 1, read_receipt: 42 },
  ]) {
    const r = await app.call('POST', `/v1/topics/${tid}/ack`, { token: owner.token, body });
    assert.equal(r.status, 400, `body ${JSON.stringify(body)} must be 400`);
  }
});

test('ack on a cross-family topic id -> 404 (no existence leak)', async () => {
  const app = makeApp();
  const a = await setupKeyedFamily(app, 'AckFamA');
  const b = await setupKeyedFamily(app, 'AckFamB');
  const tidA = await createPlainTopic(app, a.owner.token, 'A topic');
  const r = await app.call('POST', `/v1/topics/${tidA}/ack`, {
    token: b.owner.token,
    body: { seq: 1, read_receipt: 'fhrr1.1.1.' + '0'.repeat(64) },
  });
  assert.equal(r.status, 404);
});

test('non-participant ack -> 403', async () => {
  const app = makeApp();
  const { famId, owner } = await setupKeyedFamily(app, 'AckNonPart');
  const tid = await createPlainTopic(app, owner.token, 'nonpart topic');
  const outsider = await addMember(app, famId, owner.token, 'out@a.dev', 'parent', 'Outsider');
  const r = await app.call('POST', `/v1/topics/${tid}/ack`, {
    token: outsider.token,
    body: { seq: 1, read_receipt: 'fhrr1.1.1.' + '0'.repeat(64) },
  });
  assert.equal(r.status, 403);
});
