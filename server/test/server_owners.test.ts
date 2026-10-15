import { b64 } from './syncv2_helpers.js';
// Server ownership control plane (migration 0012).
//
// The design under test: creating circles is a server-operator power gated
// on an explicit server_owners row — never derived from circle roles. A
// circle owner (even one who owns their circle outright, e.g. after an
// ownership transfer) cannot create circles and cannot touch this control
// plane. Fresh spin-up seeds the bootstrap operator in the same atomic
// batch as the principal/family/member rows: no gap, no second step.
import { test } from 'node:test';
import assert from 'node:assert';
import { makeClientApp as makeApp } from './fixture-client.js';
import type { TestClientApp as TestApp } from './fixture-client.js';

async function bootstrap(app: TestApp, name: string, ownerName: string, email: string) {
  const fam = await app.call('POST', '/v2/families', {
    body: { name, owner_name: ownerName, owner_email: email },
  });
  assert.equal(fam.status, 201);
  const red = await app.call(
    'POST',
    `/v2/provisioning-codes/${encodeURIComponent(fam.body.provisioning_code)}/redeem`,
    { body: { agent_public_key: b64(32) } },
  );
  assert.equal(red.status, 201);
  return { famId: fam.body.family.id as string, token: red.body.token as string };
}

async function inviteAccept(
  app: TestApp,
  famId: string,
  inviterToken: string,
  email: string,
  role: string,
  displayName: string,
) {
  const inv = await app.call('POST', `/v2/families/${famId}/invites`, {
    token: inviterToken,
    body: { email, role },
  });
  assert.equal(inv.status, 201);
  const acc = await app.call(
    'POST',
    `/v2/invites/${encodeURIComponent(inv.body.invite_code)}/accept`,
    { body: { display_name: displayName, agent_label: `${displayName.toLowerCase()}-agent` , agent_public_key: b64(32) } },
  );
  assert.equal(acc.status, 201);
  return { token: acc.body.token as string, memberId: acc.body.member.id as string };
}

async function lockedSetup() {
  const app = makeApp();
  const a = await bootstrap(app, 'Fam A', 'Mahesh', 'mahesh@a.dev');
  app.env.SETUP_LOCKED = '1';
  return { app, ownerToken: a.token, famId: a.famId };
}

test('bootstrap seeds the operator as a server owner (no gap)', async () => {
  const app = makeApp();
  const a = await bootstrap(app, 'Fam A', 'Mahesh', 'mahesh@a.dev');

  // The seed happened in the same atomic batch as the bootstrap itself.
  const rows = await app.db.queryAll(`SELECT * FROM server_owners`);
  assert.equal(rows.length, 1);

  const list = await app.call('GET', '/v2/server/owners', { token: a.token });
  assert.equal(list.status, 200);
  assert.equal(list.body.owners.length, 1);
  assert.equal(list.body.owners[0].principal_id, rows[0]['principal_id']);
  assert.equal(list.body.owners[0].name, 'Mahesh');
  assert.equal(list.body.owners[0].email, 'mahesh@a.dev');

  const me = await app.call('GET', '/v2/me', { token: a.token });
  assert.equal(me.body.is_hub_owner, true);
});

test('a circle owner who was not bootstrapped cannot create circles', async () => {
  // The Prem scenario: invited as an owner, accepts, owns the circle — but
  // was never a server owner, so circle creation stays 403.
  const { app, ownerToken, famId } = await lockedSetup();
  const prem = await inviteAccept(app, famId, ownerToken, 'prem@x.dev', 'owner', 'Prem');

  const create = await app.call('POST', '/v2/families', {
    token: prem.token,
    body: { name: 'Prem Circle' },
  });
  assert.equal(create.status, 403);
  assert.equal(create.body.error.code, 'forbidden');

  const list = await app.call('GET', '/v2/server/owners', { token: prem.token });
  assert.equal(list.status, 403);

  const me = await app.call('GET', '/v2/me', { token: prem.token });
  assert.equal(me.body.is_hub_owner, false);
});

test('promote by member_id grants circle-creation power (idempotent)', async () => {
  const { app, ownerToken, famId } = await lockedSetup();
  const prem = await inviteAccept(app, famId, ownerToken, 'prem@x.dev', 'owner', 'Prem');

  const pro = await app.call('POST', '/v2/server/owners', {
    token: ownerToken,
    body: { member_id: prem.memberId },
  });
  assert.equal(pro.status, 201);
  assert.ok(pro.body.owner.principal_id);

  // Idempotent: promoting again returns the row, no duplicate.
  const again = await app.call('POST', '/v2/server/owners', {
    token: ownerToken,
    body: { member_id: prem.memberId },
  });
  assert.equal(again.status, 201);
  const count = await app.db.queryOne(`SELECT COUNT(*) AS c FROM server_owners`);
  assert.equal(count?.['c'], 2); // Mahesh (bootstrap) + Prem

  // Prem can now create circles.
  const create = await app.call('POST', '/v2/families', {
    token: prem.token,
    body: { name: 'Prem Circle' },
  });
  assert.equal(create.status, 201);

  const list = await app.call('GET', '/v2/server/owners', { token: ownerToken });
  assert.equal(list.body.owners.length, 2);
});

test('promote by principal_id; validations', async () => {
  const { app, ownerToken, famId } = await lockedSetup();
  const prem = await inviteAccept(app, famId, ownerToken, 'prem@x.dev', 'owner', 'Prem');
  const row = await app.db.queryOne(`SELECT principal_id FROM members WHERE id = ?`, [prem.memberId]);
  const principal = row?.['principal_id'] as string;
  assert.ok(principal);

  // 403: a non-server-owner cannot promote (even themselves) — checked
  // before Prem holds any server power.
  const evil = await app.call('POST', '/v2/server/owners', {
    token: prem.token,
    body: { member_id: prem.memberId },
  });
  assert.equal(evil.status, 403);

  const pro = await app.call('POST', '/v2/server/owners', {
    token: ownerToken,
    body: { principal_id: principal },
  });
  assert.equal(pro.status, 201);
  assert.equal(pro.body.owner.principal_id, principal);

  // 400: neither id given.
  const bad = await app.call('POST', '/v2/server/owners', { token: ownerToken, body: {} });
  assert.equal(bad.status, 400);

  // 404: unknown principal / member.
  const noPrin = await app.call('POST', '/v2/server/owners', {
    token: ownerToken,
    body: { principal_id: 'pr_doesnotexist' },
  });
  assert.equal(noPrin.status, 404);
  const noMem = await app.call('POST', '/v2/server/owners', {
    token: ownerToken,
    body: { member_id: '00000000-0000-0000-0000-000000000000' },
  });
  assert.equal(noMem.status, 404);
});

test('demote removes power; the last server owner is protected', async () => {
  const { app, ownerToken, famId } = await lockedSetup();
  const prem = await inviteAccept(app, famId, ownerToken, 'prem@x.dev', 'owner', 'Prem');
  const row = await app.db.queryOne(`SELECT principal_id FROM members WHERE id = ?`, [prem.memberId]);
  const premPrincipal = row?.['principal_id'] as string;

  // Promote, then demote.
  const pro = await app.call('POST', '/v2/server/owners', {
    token: ownerToken,
    body: { principal_id: premPrincipal },
  });
  assert.equal(pro.status, 201);
  const dem = await app.call(
    'DELETE',
    `/v2/server/owners/${encodeURIComponent(premPrincipal)}`,
    { token: ownerToken },
  );
  assert.equal(dem.status, 200);
  assert.equal(dem.body.removed, premPrincipal);

  // Power is gone again.
  const create = await app.call('POST', '/v2/families', {
    token: prem.token,
    body: { name: 'Nope' },
  });
  assert.equal(create.status, 403);

  // 400: cannot demote the last server owner (would lock everyone out).
  const meRow = await app.db.queryOne(
    `SELECT principal_id FROM members WHERE email = 'mahesh@a.dev' LIMIT 1`,
  );
  const maheshPrincipal = meRow?.['principal_id'] as string;
  const last = await app.call(
    'DELETE',
    `/v2/server/owners/${encodeURIComponent(maheshPrincipal)}`,
    { token: ownerToken },
  );
  assert.equal(last.status, 400);

  // 404: not a server owner.
  const missing = await app.call('DELETE', '/v2/server/owners/pr_nope', { token: ownerToken });
  assert.equal(missing.status, 404);

  // 403: a non-server-owner cannot demote.
  const evil = await app.call(
    'DELETE',
    `/v2/server/owners/${encodeURIComponent(maheshPrincipal)}`,
    { token: prem.token },
  );
  assert.equal(evil.status, 403);
});
