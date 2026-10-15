import { b64 } from './syncv2_helpers.js';
// Unit/integration tests: the resolveToken() choke point (SPEC §7).
import { test } from 'node:test';
import assert from 'node:assert';
import { makeClientApp as makeApp } from './fixture-client.js';

async function bootstrap() {
  const app = makeApp();
  const fam = await app.call('POST', '/v2/families', {
    body: { name: 'Test Fam', owner_name: 'Mahesh', owner_email: 'm@test.dev' },
  });
  assert.equal(fam.status, 201);
  const code = fam.body.provisioning_code as string;
  const red = await app.call('POST', `/v2/provisioning-codes/${encodeURIComponent(code)}/redeem`, {
    body: { agent_public_key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE=' },
  });
  assert.equal(red.status, 201);
  return { app, token: red.body.token as string, tokenId: red.body.token_id as string };
}

test('valid token authenticates; unknown/missing token -> 401', async () => {
  const { app, token } = await bootstrap();
  const ok = await app.call('GET', '/v2/members', { token });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.members.length, 1);

  const unknown = await app.call('GET', '/v2/members', { token: 'fh_' + 'x'.repeat(43) });
  assert.equal(unknown.status, 401);
  assert.equal(unknown.body.error.code, 'unauthorized');

  const missing = await app.call('GET', '/v2/members');
  assert.equal(missing.status, 401);

  const malformed = await app.call('GET', '/v2/members', {
    headers: { authorization: 'Token abc' },
  });
  assert.equal(malformed.status, 401);
});

test('revoked token is rejected', async () => {
  const { app, token, tokenId } = await bootstrap();
  const rev = await app.call('POST', '/v2/auth/revoke', { token, body: { token_id: tokenId } });
  assert.equal(rev.status, 200);
  const after = await app.call('GET', '/v2/members', { token });
  assert.equal(after.status, 401);
});

test('non-owner cannot revoke another member token', async () => {
  const { app, token: ownerToken } = await bootstrap();
  // invite + accept a kid
  const famId = (await app.db.queryOne('SELECT id FROM families', []))!['id'] as string;
  const inv2 = await app.call('POST', `/v2/families/${famId}/invites`, {
    token: ownerToken,
    body: { email: 'kid@test.dev', role: 'kid' },
  });
  assert.equal(inv2.status, 201);
  const acc = await app.call(
    'POST',
    `/v2/invites/${encodeURIComponent(inv2.body.invite_code)}/accept`,
    { body: { display_name: 'Kid', agent_label: 'kid-agent' , agent_public_key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE=' } },
  );
  const kidToken = acc.body.token as string;
  const ownerTokenId = (await app.db.queryOne(
    `SELECT token_id FROM agent_tokens WHERE member_id = (SELECT id FROM members WHERE email='m@test.dev')`,
    [],
  ))!['token_id'] as string;
  const denied = await app.call('POST', '/v2/auth/revoke', {
    token: kidToken,
    body: { token_id: ownerTokenId },
  });
  assert.equal(denied.status, 403);
});

test('revoke e2e: revoked agent is locked out everywhere; the member re-enrolls cleanly', async () => {
  const { app, token: ownerToken } = await bootstrap();
  const famId = (await app.db.queryOne('SELECT id FROM families', []))!['id'] as string;
  const memberId = (await app.db.queryOne('SELECT id FROM members', []))!['id'] as string;

  // Second agent for the same member.
  const mint = await app.call('POST', '/v2/provisioning-codes', {
    token: ownerToken,
    body: { member_id: memberId, agent_label: 'second-agent' },
  });
  assert.equal(mint.status, 201);
  const red = await app.call(
    'POST',
    `/v2/provisioning-codes/${encodeURIComponent(mint.body.provisioning_code)}/redeem`,
    { body: { agent_public_key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE=' } },
  );
  assert.equal(red.status, 201);
  const token2 = red.body.token as string;
  const tokenId2 = red.body.token_id as string;

  // The second agent works: topics, entries, sync.
  const t = await app.call('POST', '/v2/topics', {
    token: token2,
    body: { subject: 't', kind: 'group', participant_member_ids: [] },
  });
  assert.equal(t.status, 201);
  const tid = t.body.topic.id as string;
  const post = await app.call('POST', `/v2/topics/${tid}/entries`, {
    token: token2,
    body: { body: 'hello' },
  });
  assert.equal(post.status, 201);
  const sync = await app.call('GET', '/v2/sync/topics', { token: token2 });
  assert.equal(sync.status, 200);

  // Self-revoke.
  const rev = await app.call('POST', '/v2/auth/revoke', {
    token: token2,
    body: { token_id: tokenId2 },
  });
  assert.equal(rev.status, 200);

  // Locked out everywhere: members, entries, sync, ack, history.
  for (const [method, path, body] of [
    ['GET', '/v2/members', undefined],
    ['POST', `/v2/topics/${tid}/entries`, { body: 'x' }],
    ['GET', '/v2/sync/topics', undefined],
    ['GET', `/v2/topics/${tid}/history`, undefined],
    ['POST', `/v2/topics/${tid}/ack`, { seq: 1, read_receipt: 'x' }],
  ] as const) {
    const r = await app.call(method, path, { token: token2, body });
    assert.equal(r.status, 401, `${method} ${path} must 401 after revoke`);
  }

  // The member re-enrolls a fresh agent and is fully functional again.
  const mint3 = await app.call('POST', '/v2/provisioning-codes', {
    token: ownerToken,
    body: { member_id: memberId, agent_label: 'third-agent' },
  });
  const red3 = await app.call(
    'POST',
    `/v2/provisioning-codes/${encodeURIComponent(mint3.body.provisioning_code)}/redeem`,
    { body: { agent_public_key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE=' } },
  );
  assert.equal(red3.status, 201);
  const token3 = red3.body.token as string;
  const me = await app.call('GET', '/v2/me', { token: token3 });
  assert.equal(me.status, 200);
  assert.equal(me.body.agent_label, 'third-agent');
  const sync3 = await app.call('GET', '/v2/sync/topics', { token: token3 });
  assert.equal(sync3.status, 200);
  assert.ok(
    (sync3.body.topics as any[]).some((x: any) => x.topic_id === tid),
    're-enrolled agent sees the member topics',
  );
  void famId;
});
