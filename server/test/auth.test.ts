// Unit/integration tests: the resolveToken() choke point (SPEC §7).
import { test } from 'node:test';
import assert from 'node:assert';
import { makeApp } from './app.js';

async function bootstrap() {
  const app = makeApp();
  const fam = await app.call('POST', '/v1/families', {
    body: { name: 'Test Fam', owner_name: 'Mahesh', owner_email: 'm@test.dev' },
  });
  assert.equal(fam.status, 201);
  const code = fam.body.provisioning_code as string;
  const red = await app.call('POST', `/v1/provisioning-codes/${encodeURIComponent(code)}/redeem`, {
    body: {},
  });
  assert.equal(red.status, 201);
  return { app, token: red.body.token as string, tokenId: red.body.token_id as string };
}

test('valid token authenticates; unknown/missing token -> 401', async () => {
  const { app, token } = await bootstrap();
  const ok = await app.call('GET', '/v1/members', { token });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.members.length, 1);

  const unknown = await app.call('GET', '/v1/members', { token: 'fh_' + 'x'.repeat(43) });
  assert.equal(unknown.status, 401);
  assert.equal(unknown.body.error.code, 'unauthorized');

  const missing = await app.call('GET', '/v1/members');
  assert.equal(missing.status, 401);

  const malformed = await app.call('GET', '/v1/members', {
    headers: { authorization: 'Token abc' },
  });
  assert.equal(malformed.status, 401);
});

test('revoked token is rejected', async () => {
  const { app, token, tokenId } = await bootstrap();
  const rev = await app.call('POST', '/v1/auth/revoke', { token, body: { token_id: tokenId } });
  assert.equal(rev.status, 200);
  const after = await app.call('GET', '/v1/members', { token });
  assert.equal(after.status, 401);
});

test('rotate: new token works, old token keeps 24h grace', async () => {
  const { app, token } = await bootstrap();
  const rot = await app.call('POST', '/v1/auth/rotate', { token, body: {} });
  assert.equal(rot.status, 200);
  assert.ok((rot.body.token as string).startsWith('fh_'));

  const viaNew = await app.call('GET', '/v1/members', { token: rot.body.token });
  assert.equal(viaNew.status, 200);
  const viaOld = await app.call('GET', '/v1/members', { token });
  assert.equal(viaOld.status, 200); // grace period
  assert.notEqual(rot.body.token, token);
});

test('non-owner cannot revoke another member token', async () => {
  const { app, token: ownerToken } = await bootstrap();
  // invite + accept a kid
  const famId = (await app.db.queryOne('SELECT id FROM families', []))!['id'] as string;
  const inv2 = await app.call('POST', `/v1/families/${famId}/invites`, {
    token: ownerToken,
    body: { email: 'kid@test.dev', role: 'kid' },
  });
  assert.equal(inv2.status, 201);
  const acc = await app.call(
    'POST',
    `/v1/invites/${encodeURIComponent(inv2.body.invite_code)}/accept`,
    { body: { display_name: 'Kid', agent_label: 'kid-agent' } },
  );
  const kidToken = acc.body.token as string;
  const ownerTokenId = (await app.db.queryOne(
    `SELECT token_id FROM agent_tokens WHERE member_id = (SELECT id FROM members WHERE email='m@test.dev')`,
    [],
  ))!['token_id'] as string;
  const denied = await app.call('POST', '/v1/auth/revoke', {
    token: kidToken,
    body: { token_id: ownerTokenId },
  });
  assert.equal(denied.status, 403);
});
