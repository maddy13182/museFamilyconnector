// Idempotent creates: POST /v1/families, /v1/topics, /v1/families/:id/invites
// honor Idempotency-Key; circle names are unique (case-insensitive).
import { test } from 'node:test';
import assert from 'node:assert';
import { makeApp } from './app.js';

async function bootstrapOwner(app: ReturnType<typeof makeApp>, name: string, email: string) {
  const fam = await app.call('POST', '/v1/families', {
    body: { name, owner_name: 'Owner', owner_email: email },
  });
  assert.equal(fam.status, 201);
  const red = await app.call(
    'POST',
    `/v1/provisioning-codes/${encodeURIComponent(fam.body.provisioning_code)}/redeem`,
    { body: {} },
  );
  assert.equal(red.status, 201);
  return { famId: fam.body.family.id as string, token: red.body.token as string };
}

test('duplicate circle name (case-insensitive) -> 409 circle_name_taken', async () => {
  const app = makeApp();
  await bootstrapOwner(app, 'Close Friends', 'a@t.dev');
  const dup = await app.call('POST', '/v1/families', {
    body: { name: 'close friends', owner_name: 'O2', owner_email: 'b@t.dev' },
  });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'circle_name_taken');
});

test('locked create: same Idempotency-Key twice -> one circle, deduped, fresh code', async () => {
  const app = makeApp();
  const { token } = await bootstrapOwner(app, 'Fam A', 'a@t.dev');
  app.env.SETUP_LOCKED = '1';

  const key = 'create-key-1';
  const first = await app.call('POST', '/v1/families', {
token,
    body: { name: 'Gym', kind: 'general' },
    headers: { 'idempotency-key': key },
  });
  assert.equal(first.status, 201);
  assert.equal(first.body.deduped, undefined);
  const fid = first.body.id as string;
  const code1 = first.body.provisioning_code as string;

  const second = await app.call('POST', '/v1/families', {
token,
    body: { name: 'Gym', kind: 'general' },
    headers: { 'idempotency-key': key },
  });
  assert.equal(second.status, 200);
  assert.equal(second.body.deduped, true);
  assert.equal(second.body.id, fid);
  const code2 = second.body.provisioning_code as string;
  assert.ok(code2 && code2 !== code1, 'dedup must mint a fresh code');

  // Only one circle row exists.
  const families = await app.call('GET', '/v1/families', { token });
  assert.equal(families.body.families.filter((f: any) => f.name === 'Gym').length, 1);

  // Both codes redeem (first was never delivered in the failure scenario).
  for (const code of [code1, code2]) {
    const red = await app.call(
      'POST',
      `/v1/provisioning-codes/${encodeURIComponent(code)}/redeem`,
      { body: {} },
    );
    assert.equal(red.status, 201);
  }
});

test('dedup after redeem revokes the orphaned token', async () => {
  const app = makeApp();
  const { token } = await bootstrapOwner(app, 'Fam A', 'a@t.dev');
  app.env.SETUP_LOCKED = '1';

  const key = 'create-key-orphan';
  const first = await app.call('POST', '/v1/families', {
token,
    body: { name: 'Book', kind: 'general' },
    headers: { 'idempotency-key': key },
  });
  const code1 = first.body.provisioning_code as string;
  // Redeem succeeded but the response was lost (client holds nothing).
  const red1 = await app.call(
    'POST',
    `/v1/provisioning-codes/${encodeURIComponent(code1)}/redeem`,
    { body: {} },
  );
  assert.equal(red1.status, 201);
  const orphanToken = red1.body.token as string;

  // Client retries the create with the same key.
  const second = await app.call('POST', '/v1/families', {
token,
    body: { name: 'Book', kind: 'general' },
    headers: { 'idempotency-key': key },
  });
  assert.equal(second.body.deduped, true);

  // The orphaned token is revoked: it no longer authenticates.
  const probe = await app.call('GET', '/v1/families', { token: orphanToken });
  assert.equal(probe.status, 401);

  // The fresh code works.
  const red2 = await app.call(
    'POST',
    `/v1/provisioning-codes/${encodeURIComponent(second.body.provisioning_code)}/redeem`,
    { body: {} },
  );
  assert.equal(red2.status, 201);
});

test('redeem of used code returns member + token_already_issued', async () => {
  const app = makeApp();
  const fam = await app.call('POST', '/v1/families', {
    body: { name: 'F', owner_name: 'M', owner_email: 'm@t.dev' },
  });
  const code = fam.body.provisioning_code as string;
  const path = `/v1/provisioning-codes/${encodeURIComponent(code)}/redeem`;
  const red1 = await app.call('POST', path, { body: {} });
  assert.equal(red1.status, 201);
  const red2 = await app.call('POST', path, { body: {} });
  assert.equal(red2.status, 409);
  assert.equal(red2.body.error.code, 'code_used');
  assert.equal(red2.body.token_already_issued, true);
  assert.ok(red2.body.member && red2.body.member.id);
});

test('topic create is idempotent with a key', async () => {
  const app = makeApp();
  const { token } = await bootstrapOwner(app, 'Fam A', 'a@t.dev');
  const key = 'topic-key-1';
  const mk = () =>
    app.call('POST', '/v1/topics', {
token,
      body: { subject: 'T', kind: 'group', participant_member_ids: [] },
      headers: { 'idempotency-key': key },
    });
  const first = await mk();
  assert.equal(first.status, 201);
  const second = await mk();
  assert.equal(second.status, 200);
  assert.equal(second.body.deduped, true);
  assert.equal(second.body.topic.id, first.body.topic.id);
});

test('invite create is idempotent with a key (fresh code on dedup)', async () => {
  const app = makeApp();
  const { token, famId } = await bootstrapOwner(app, 'Fam A', 'a@t.dev');
  const key = 'invite-key-1';
  const mk = () =>
    app.call('POST', `/v1/families/${famId}/invites`, {
token,
      body: { email: 'n@t.dev', role: 'parent' },
      headers: { 'idempotency-key': key },
    });
  const first = await mk();
  assert.equal(first.status, 201);
  const second = await mk();
  assert.equal(second.status, 200);
  assert.equal(second.body.deduped, true);
  assert.ok(second.body.invite_code && second.body.invite_code !== first.body.invite_code);
});
