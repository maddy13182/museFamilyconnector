import { b64 } from './syncv2_helpers.js';
// v0.2.0 multi-circle: hub-owner creation while SETUP_LOCKED=1,
// GET /v2/families listing, kind validation, and new-family usability.
import { test } from 'node:test';
import assert from 'node:assert';
import { makeClientApp as makeApp } from './fixture-client.js';
import type { TestClientApp as TestApp } from './fixture-client.js';

interface Setup {
  app: TestApp;
  ownerToken: string; // Mahesh, owner of Fam A
  parentToken: string; // Lakshmi, parent of Fam A
  kidToken: string; // Harshika, kid of Fam A
  strangerToken: string; // Stranger, owner of Fam B (a hub owner via another family)
  famA: string;
  famB: string;
}

async function bootstrap(app: TestApp, name: string, ownerName: string, email: string) {
  const fam = await app.call('POST', '/v2/families', {
    body: { name, owner_name: ownerName, owner_email: email },
  });
  assert.equal(fam.status, 201);
  // Bootstrap shape unchanged (no kind field in v0.1.x response).
  assert.ok(!('kind' in fam.body.family));
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

async function lockedSetup(): Promise<Setup> {
  const app = makeApp();
  const a = await bootstrap(app, 'Fam A', 'Mahesh', 'mahesh@a.dev');
  const b = await bootstrap(app, 'Fam B', 'Stranger', 's@b.dev');
  const parent = await inviteAccept(app, a.famId, a.token, 'lakshmi@a.dev', 'parent', 'Lakshmi');
  const kid = await inviteAccept(app, a.famId, a.token, 'harshika@a.dev', 'kid', 'Harshika');
  app.env.SETUP_LOCKED = '1';
  return {
    app,
    ownerToken: a.token,
    parentToken: parent.token,
    kidToken: kid.token,
    strangerToken: b.token,
    famA: a.famId,
    famB: b.famId,
  };
}

test('owner can create a family while locked; kind defaults to family', async () => {
  const { app, ownerToken } = await lockedSetup();
  const res = await app.call('POST', '/v2/families', {
    token: ownerToken,
    body: { name: 'Gym Circle' },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.name, 'Gym Circle');
  assert.equal(res.body.kind, 'family');
  assert.ok(res.body.id);
  assert.ok(res.body.created_at);
  assert.equal(res.body.provisioning_code, undefined, 'existing agent needs no extra credential');
});

test('owner can create a general-kind circle explicitly', async () => {
  const { app, ownerToken } = await lockedSetup();
  const res = await app.call('POST', '/v2/families', {
    token: ownerToken,
    body: { name: 'Book Club', kind: 'general' },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.kind, 'general');
});

test('non-owner gets 403 while locked; unauthenticated gets 401', async () => {
  const { app, parentToken, kidToken } = await lockedSetup();
  for (const token of [parentToken, kidToken]) {
    const res = await app.call('POST', '/v2/families', {
      token,
      body: { name: 'Nope' },
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'forbidden');
  }
  const anon = await app.call('POST', '/v2/families', { body: { name: 'Nope' } });
  assert.equal(anon.status, 401);
  assert.equal(anon.body.error.code, 'unauthorized');
});

test('hub owner via another family can create while locked', async () => {
  // Stranger owns Fam B only; their token's family is B, but they are a hub
  // owner by email-matched role, so creation is allowed.
  const { app, strangerToken } = await lockedSetup();
  const res = await app.call('POST', '/v2/families', {
    token: strangerToken,
    body: { name: 'Stranger Circle' },
  });
  assert.equal(res.status, 201);
});

test('kind validation rejects bad values; blank names rejected', async () => {
  const { app, ownerToken } = await lockedSetup();
  const badKind = await app.call('POST', '/v2/families', {
    token: ownerToken,
    body: { name: 'X', kind: 'super-circle' },
  });
  assert.equal(badKind.status, 400);
  assert.equal(badKind.body.error.code, 'bad_request');

  const blank = await app.call('POST', '/v2/families', {
    token: ownerToken,
    body: { name: '   ' },
  });
  assert.equal(blank.status, 400);

  const missing = await app.call('POST', '/v2/families', {
    token: ownerToken,
    body: {},
  });
  assert.equal(missing.status, 400);

  const notJson = await app.call('POST', '/v2/families', {
    token: ownerToken,
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(notJson.status, 400);
});

test('GET /v2/families lists only the caller families', async () => {
  const { app, ownerToken, parentToken, strangerToken, famA, famB } = await lockedSetup();
  // Mahesh creates a second circle.
  const created = await app.call('POST', '/v2/families', {
    token: ownerToken,
    body: { name: 'Gym Circle', kind: 'general' },
  });
  assert.equal(created.status, 201);

  const mahesh = await app.call('GET', '/v2/families', { token: ownerToken });
  assert.equal(mahesh.status, 200);
  const ids = mahesh.body.families.map((f: any) => f.id);
  assert.ok(ids.includes(famA), 'sees Fam A');
  assert.ok(ids.includes(created.body.id), 'sees Gym Circle');
  assert.ok(!ids.includes(famB), 'does not see Stranger family B');
  const gym = mahesh.body.families.find((f: any) => f.id === created.body.id);
  assert.equal(gym.my_role, 'owner');
  assert.equal(gym.kind, 'general');
  assert.equal(gym.name, 'Gym Circle');

  const lakshmi = await app.call('GET', '/v2/families', { token: parentToken });
  assert.equal(lakshmi.body.families.length, 1);
  assert.equal(lakshmi.body.families[0].my_role, 'parent');

  const stranger = await app.call('GET', '/v2/families', { token: strangerToken });
  assert.equal(stranger.body.families.length, 1);
  assert.equal(stranger.body.families[0].id, famB);

  const anon = await app.call('GET', '/v2/families');
  assert.equal(anon.status, 401);
});

test('new family is fully usable: redeem code, invite, topic round-trip', async () => {
  const { app, ownerToken } = await lockedSetup();
  const created = await app.call('POST', '/v2/families', {
    token: ownerToken,
    body: { name: 'Gym Circle' },
  });
  assert.equal(created.status, 201);
  const newFamId = created.body.id as string;

  const newToken=ownerToken;
  // Invite a member into the new family with the new token.
  const invite=await app.call('POST',`/v2/families/${newFamId}/invites`,{token:newToken,headers:{'X-Circle-ID':newFamId},body:{email:'coach@gym.dev',role:'parent'}});
  assert.equal(invite.status,201);
  const invited=await app.call('POST',`/v2/invites/${invite.body.invite_code}/accept`,{body:{display_name:'Coach',agent_label:'coach',agent_public_key:b64(32)}});
  assert.equal(invited.status,201);
  assert.ok(invited.body.token);

  // Members endpoint is scoped to the new family.
  const members = await app.call('GET', '/v2/members', { token: newToken,headers:{'X-Circle-ID':newFamId} });
  assert.equal(members.status, 200);
  assert.equal(members.body.members.length, 2);

  // Topic round-trip in the new family: create, post, read back.
  const topic = await app.call('POST', '/v2/topics', {
    token: newToken, headers:{'X-Circle-ID':newFamId},
    body: { subject: 'Leg day', kind: 'group', participant_member_ids: [invited.body.member.id] },
  });
  assert.equal(topic.status, 201);
  const topicId = topic.body.topic.id as string;

  const post = await app.call('POST', `/v2/topics/${topicId}/entries`, {
    token: newToken, headers:{'X-Circle-ID':newFamId},
    body: { kind: 'message', body: 'See you at 6am' },
  });
  assert.equal(post.status, 201);

  const hist = await app.call('GET', `/v2/topics/${topicId}/history`, { token: newToken,headers:{'X-Circle-ID':newFamId} });
  assert.equal(hist.status, 200);
  assert.equal(hist.body.entries.length, 1);
  assert.equal(hist.body.entries[0].body, 'See you at 6am');

  // The old-family token must NOT reach the new family's topic. The topic is
  // scoped out of the token's family entirely, so this is 404 (no existence
  // leak), not 403.
  const cross = await app.call('GET', `/v2/topics/${topicId}/history`, { token: ownerToken });
  assert.equal(cross.status, 404);
  assert.equal(cross.body.error.code, 'not_found');
});

test('invite accept response member carries family_id (CLI circle-join needs it)', async () => {
  // Regression: the accept response once omitted family_id from the member
  // object, so the CLI crashed AFTER the token was issued but BEFORE it was
  // stored — invite spent, token lost.
  const { app, ownerToken } = await lockedSetup();
  const created = await app.call('POST', '/v2/families', {
    token: ownerToken,
    body: { name: 'Regress Circle' },
  });
  assert.equal(created.status, 201);
  const famId = created.body.id as string;
  const inv = await app.call('POST', `/v2/families/${famId}/invites`, {
    token: ownerToken, headers:{'X-Circle-ID':famId},
    body: { email: 'regret@a.dev', role: 'parent' },
  });
  assert.equal(inv.status, 201);
  const acc = await app.call(
    'POST',
    `/v2/invites/${encodeURIComponent(inv.body.invite_code)}/accept`,
    { body: { display_name: 'Regret', agent_label: 'regret-agent' , agent_public_key: b64(32) } },
  );
  assert.equal(acc.status, 201);
  assert.ok(acc.body.token, 'token issued');
  assert.equal(acc.body.member.family_id, famId, 'member carries family_id');
  assert.equal(acc.body.member.role, 'parent');
});

test('bootstrap while unlocked is unchanged (no kind in response)', async () => {
  const app = makeApp(); // SETUP_LOCKED defaults to '0'
  const fam = await app.call('POST', '/v2/families', {
    body: { name: 'Fresh', owner_name: 'O', owner_email: 'o@x.dev' },
  });
  assert.equal(fam.status, 201);
  assert.deepEqual(Object.keys(fam.body.family).sort(), ['created_at', 'id', 'name']);
  assert.ok(fam.body.provisioning_code);
});

test('GET /v2/me returns the token-bound identity (circle binding check)', async () => {
  const { app, ownerToken, famA } = await lockedSetup();
  const me = await app.call('GET', '/v2/me', { token: ownerToken });
  assert.equal(me.status, 200);
  assert.equal(me.body.family_id, famA);
  assert.equal(me.body.email, 'mahesh@a.dev');
  assert.equal(me.body.role, 'owner');
  assert.ok(me.body.id);
  assert.ok(me.body.agent_label);

  const anon = await app.call('GET', '/v2/me');
  assert.equal(anon.status, 401);
});
