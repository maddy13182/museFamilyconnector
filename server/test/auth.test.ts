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
    {
      body: {
        display_name: 'Kid',
        agent_label: 'kid-agent',
        agent_public_key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE=',
      },
    },
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
  assert.equal(denied.status, 404);
});

test('revoked Muse credential is rejected on every protected operation', async () => {
  const { app, token, tokenId } = await bootstrap();
  const topic = await app.call('POST', '/v2/topics', {
    token,
    body: { subject: 'Private', kind: 'group', participant_member_ids: [] },
  });
  assert.equal(topic.status, 201);
  const tid = topic.body.topic.id;
  assert.equal(
    (await app.call('POST', '/v2/auth/revoke', { token, body: { token_id: tokenId } })).status,
    200,
  );
  for (const [method, path, body] of [
    ['GET', '/v2/me', undefined],
    ['GET', '/v2/members', undefined],
    ['GET', '/v2/discovery/circles', undefined],
    ['GET', `/v2/topics/${tid}/history`, undefined],
    ['POST', `/v2/topics/${tid}/entries`, { body: 'Private' }],
  ] as const) {
    assert.equal((await app.call(method, path, { token, body })).status, 401);
  }
});
