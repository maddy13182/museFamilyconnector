import { b64 } from './syncv2_helpers.js';
// Phase D (audit F02): identity principals.
//
// Cross-circle negative tests: a member in circle A whose email COLLIDES
// with circle B's owner email must NOT see B's metadata, must NOT pass the
// hub-owner check, and must NOT mint credentials for B's members.
// Plus migration 0005 backfill correctness: distinct emails -> distinct
// principals; the same email across circles -> one principal (the
// migration's documented trust assumption, preserving legitimate linking
// that existed before principals did).
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

interface Setup {
  app: TestApp;
  ownerToken: string; // Mahesh, owner of Fam A
  kidToken: string; // Harshika, kid of Fam A
  strangerToken: string; // Stranger, owner of Fam B
  famA: string;
  famB: string;
}

async function lockedSetup(): Promise<Setup> {
  const app = makeApp();
  const a = await bootstrap(app, 'Fam A', 'Mahesh', 'mahesh@a.dev');
  const b = await bootstrap(app, 'Fam B', 'Stranger', 's@b.dev');
  const kid = await inviteAccept(app, a.famId, a.token, 'harshika@a.dev', 'kid', 'Harshika');
  app.env.SETUP_LOCKED = '1';
  return {
    app,
    ownerToken: a.token,
    kidToken: kid.token,
    strangerToken: b.token,
    famA: a.famId,
    famB: b.famId,
  };
}

test('an unverified email collision cannot attach an agent to the existing user', async()=>{
 const {app,ownerToken,famA,famB,strangerToken}=await lockedSetup();
 const invite=await app.call('POST',`/v2/families/${famA}/invites`,{token:ownerToken,body:{email:'s@b.dev',role:'kid'}});
 const denied=await app.call('POST',`/v2/invites/${invite.body.invite_code}/accept`,{body:{display_name:'Impostor',agent_label:'evil',agent_public_key:b64(32),challenge_id:'invalid',verification_code:'invalid'}});
 assert.equal(denied.status,403);assert.equal(denied.body.error.code,'email_verification_required');
 assert.equal((await app.db.queryOne("SELECT count(*) n FROM members WHERE email='s@b.dev'"))?.n,1);
 const list=await app.call('GET','/v2/families',{token:strangerToken});assert.deepEqual(list.body.families.map((f:any)=>f.id),[famB]);
});


test('verified owner keeps cross-circle visibility via locked creation', async () => {
  const { app, ownerToken, kidToken, famA, famB } = await lockedSetup();
  const created = await app.call('POST', '/v2/families', {
    token: ownerToken,
    body: { name: 'Gym Circle' },
  });
  assert.equal(created.status, 201);

  // The new member row inherits the caller's verified principal, so the
  // caller's token lists the new circle alongside the old one.
  const linked = await app.db.queryAll(
    `SELECT family_id, principal_id FROM members WHERE email = 'mahesh@a.dev'`,
  );
  assert.equal(linked.length, 2);
  assert.equal(linked[0]['principal_id'], linked[1]['principal_id']);

  const list = await app.call('GET', '/v2/families', { token: ownerToken });
  assert.equal(list.status, 200);
  const ids = list.body.families.map((f: any) => f.id);
  assert.ok(ids.includes(famA), 'still sees Fam A');
  assert.ok(ids.includes(created.body.id), 'sees the new circle');
  assert.ok(!ids.includes(famB), 'does not see Stranger family B');
  const gym = list.body.families.find((f: any) => f.id === created.body.id);
  assert.equal(gym.my_role, 'owner');

  // A non-owner in A sees only A and cannot create circles while locked.
  const kidList = await app.call('GET', '/v2/families', { token: kidToken });
  assert.deepEqual(
    kidList.body.families.map((f: any) => f.id),
    [famA],
  );
  const kidCreate = await app.call('POST', '/v2/families', {
    token: kidToken,
    body: { name: 'Nope' },
  });
  assert.equal(kidCreate.status, 403);
});

test('GET /v2/me exposes is_hub_owner for agent discovery', async () => {
  const { app, ownerToken, kidToken, strangerToken } = await lockedSetup();

  const ownerMe = await app.call('GET', '/v2/me', { token: ownerToken });
  assert.equal(ownerMe.status, 200);
  assert.equal(ownerMe.body.is_hub_owner, true);
  assert.equal(ownerMe.body.role, 'owner');

  const kidMe = await app.call('GET', '/v2/me', { token: kidToken });
  assert.equal(kidMe.status, 200);
  assert.equal(kidMe.body.is_hub_owner, false);
  assert.equal(kidMe.body.role, 'kid');

  // Owner of a different circle is still a hub owner (any-circle rule).
  const strangerMe = await app.call('GET', '/v2/me', { token: strangerToken });
  assert.equal(strangerMe.status, 200);
  assert.equal(strangerMe.body.is_hub_owner, true);
});
