// Tests: Idempotency-Key on POST entries (SPEC §9).
import { test } from 'node:test';
import assert from 'node:assert';
import { makeApp } from './app.js';

test('same Idempotency-Key twice -> one entry, deduped:true, same gseq', async () => {
  const app = makeApp();
  const fam = await app.call('POST', '/v1/families', {
    body: { name: 'F', owner_name: 'M', owner_email: 'm@t.dev' },
  });
  const red = await app.call(
    'POST',
    `/v1/provisioning-codes/${encodeURIComponent(fam.body.provisioning_code)}/redeem`,
    { body: {} },
  );
  const token = red.body.token as string;
  const topic = await app.call('POST', '/v1/topics', {
    token,
    body: { subject: 'T', kind: 'group', participant_member_ids: [] },
  });
  const tid = topic.body.topic.id as string;

  const first = await app.call('POST', `/v1/topics/${tid}/entries`, {
    token,
    body: { body: 'hello' },
    headers: { 'idempotency-key': 'retry-1' },
  });
  assert.equal(first.status, 201);
  assert.equal(first.body.deduped, undefined);

  const second = await app.call('POST', `/v1/topics/${tid}/entries`, {
    token,
    body: { body: 'hello again (different body, same key)' },
    headers: { 'idempotency-key': 'retry-1' },
  });
  assert.equal(second.status, 200);
  assert.equal(second.body.deduped, true);
  assert.equal(second.body.entry.gseq, first.body.entry.gseq);

  const hist = await app.call('GET', `/v1/topics/${tid}/history`, { token });
  const messages = (hist.body.entries as any[]).filter((e) => e.kind === 'message');
  assert.equal(messages.length, 1);
});

test('different keys create different entries', async () => {
  const app = makeApp();
  const fam = await app.call('POST', '/v1/families', {
    body: { name: 'F', owner_name: 'M', owner_email: 'm@t.dev' },
  });
  const red = await app.call(
    'POST',
    `/v1/provisioning-codes/${encodeURIComponent(fam.body.provisioning_code)}/redeem`,
    { body: {} },
  );
  const token = red.body.token as string;
  const topic = await app.call('POST', '/v1/topics', {
    token,
    body: { subject: 'T', kind: 'group', participant_member_ids: [] },
  });
  const tid = topic.body.topic.id as string;
  for (const k of ['k1', 'k2']) {
    const r = await app.call('POST', `/v1/topics/${tid}/entries`, {
      token,
      body: { body: 'msg ' + k },
      headers: { 'idempotency-key': k },
    });
    assert.equal(r.status, 201);
  }
  const hist = await app.call('GET', `/v1/topics/${tid}/history`, { token });
  assert.equal((hist.body.entries as any[]).filter((e) => e.kind === 'message').length, 2);
});
