import { b64 } from './syncv2_helpers.js';
// Credential revocation and invitation concurrency.
import { test } from 'node:test';
import assert from 'node:assert';
import { makeClientApp as makeApp } from './fixture-client.js';
import type { TestClientApp as TestApp } from './fixture-client.js';

interface Party {
  token: string;
  tokenId: string;
  memberId: string;
}

async function setupRoles(): Promise<{
  app: TestApp;
  famId: string;
  owner: Party;
  parent: Party;
  kid: Party;
}> {
  const app = makeApp();
  const fam = await app.call('POST', '/v2/families', {
    body: { name: 'Cred Fam', owner_name: 'Ow', owner_email: 'o@x.dev' },
  });
  assert.equal(fam.status, 201);
  const red = await app.call(
    'POST',
    `/v2/provisioning-codes/${encodeURIComponent(fam.body.provisioning_code)}/redeem`,
    { body: { agent_public_key: b64(32) } },
  );
  assert.equal(red.status, 201);
  const famId = (await app.db.queryOne('SELECT id FROM families', []))!['id'] as string;
  const owner: Party = {
    token: red.body.token as string,
    tokenId: red.body.token_id as string,
    memberId: red.body.member.id as string,
  };

  async function addMember(email: string, role: string, name: string): Promise<Party> {
    const inv = await app.call('POST', `/v2/families/${famId}/invites`, {
      token: owner.token,
      body: { email, role },
    });
    assert.equal(inv.status, 201);
    const acc = await app.call(
      'POST',
      `/v2/invites/${encodeURIComponent(inv.body.invite_code)}/accept`,
      { body: { display_name: name, agent_label: `${role}-agent`, agent_public_key: b64(32) } },
    );
    assert.equal(acc.status, 201);
    return {
      token: acc.body.token as string,
      tokenId: acc.body.token_id as string,
      memberId: acc.body.member.id as string,
    };
  }
  const parent = await addMember('p@x.dev', 'parent', 'Pa');
  const kid = await addMember('k@x.dev', 'kid', 'Ki');
  return { app, famId, owner, parent, kid };
}

async function meStatus(app: TestApp, token: string): Promise<number> {
  return (await app.call('GET', '/v2/me', { token })).status;
}

test('circle roles do not grant control of another user server credential', async () => {
  const { app, owner, parent, kid } = await setupRoles();
  for (const [caller, target] of [
    [parent, owner],
    [kid, owner],
    [owner, parent],
  ]) {
    const denied = await app.call('POST', '/v2/auth/revoke', {
      token: caller.token,
      body: { token_id: target.tokenId },
    });
    assert.equal(denied.status, 404);
    assert.equal(await meStatus(app, target.token), 200);
  }
  const revoked = await app.call('POST', '/v2/auth/revoke', {
    token: parent.token,
    body: { token_id: parent.tokenId },
  });
  assert.equal(revoked.status, 200);
  assert.equal(await meStatus(app, parent.token), 401);
  assert.equal(await meStatus(app, owner.token), 200);
});

test('F05: concurrent accept of one invite creates exactly one member', async () => {
  const { app, famId, owner } = await setupRoles();
  const inv = await app.call('POST', `/v2/families/${famId}/invites`, {
    token: owner.token,
    body: { email: 'race@x.dev', role: 'kid' },
  });
  assert.equal(inv.status, 201);
  const path = `/v2/invites/${encodeURIComponent(inv.body.invite_code)}/accept`;

  const [r1, r2] = await Promise.all([
    app.call('POST', path, {
      body: { display_name: 'R1', agent_label: 'r1', agent_public_key: b64(32) },
    }),
    app.call('POST', path, {
      body: { display_name: 'R2', agent_label: 'r2', agent_public_key: b64(32) },
    }),
  ]);
  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, [201, 409]);

  const loser = r1.status === 201 ? r2 : r1;
  assert.equal(loser.body.error.code, 'enrollment_conflict');

  const members = await app.db.queryAll(
    `SELECT id FROM members WHERE family_id = ? AND email = ?`,
    [famId, 'race@x.dev'],
  );
  assert.equal(members.length, 1);
  const tokens = await app.db.queryAll(`SELECT token_id FROM agent_tokens WHERE member_id = ?`, [
    members[0]['id'] as string,
  ]);
  assert.equal(tokens.length, 1);
});

test('bootstrap registration has one winner for different concurrent candidates', async () => {
  const app = makeApp();
  const fam = await app.call('POST', '/v2/families', {
    body: { name: 'Race', owner_name: 'Owner', owner_email: 'owner@race.test' },
  });
  const path = '/v2/provisioning-codes/' + fam.body.provisioning_code + '/redeem';
  const [one, two] = await Promise.all([
    app.call('POST', path, { body: { agent_public_key: b64(32) } }),
    app.call('POST', path, { body: { agent_public_key: b64(32) } }),
  ]);
  assert.deepEqual([one.status, two.status].sort(), [201, 409]);
  assert.equal((await app.db.queryOne('SELECT count(*) n FROM agents'))?.n, 1);
  assert.equal((await app.db.queryOne('SELECT count(*) n FROM agent_tokens'))?.n, 1);
});
