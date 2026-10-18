import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, TestApp } from './app.js';
import { handleRequest } from '../src/index.js';
import { issueEmailChallenge } from '../src/identity.js';
import { randomBase62 } from '../src/auth.js';

const publicKey = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const credential = () => 'fh_' + randomBase62(43);
async function owner(app: TestApp) {
  const created = await app.call('POST', '/v2/families', {
    body: { name: 'Family', owner_email: 'owner@example.test', owner_name: 'Owner' },
  });
  assert.equal(created.status, 201);
  const joined = await app.call(
    'POST',
    `/v2/provisioning-codes/${created.body.provisioning_code}/redeem`,
    { body: { agent_public_key: publicKey() } },
  );
  assert.equal(joined.status, 201);
  app.env.SETUP_LOCKED = '1';
  return { token: joined.body.token as string, circle: created.body.family.id as string, joined };
}
async function invite(app: TestApp, token: string, circle: string, email: string) {
  const result = await app.call('POST', `/v2/families/${circle}/invites`, {
    token,
    headers: { 'X-Circle-ID': circle },
    body: { email, role: 'parent' },
  });
  assert.equal(result.status, 201);
  return result.body.invite_code as string;
}
async function accept(
  app: TestApp,
  code: string,
  name: string,
  label: string,
  key: string,
  token?: string,
) {
  return app.call('POST', `/v2/invites/${code}/accept`, {
    token,
    body: {
      display_name: name,
      agent_label: label,
      agent_public_key: key,
      agent_token: token ?? credential(),
    },
  });
}

test('one user and one agent join two circles; server discovery is authoritative', async () => {
  const app = makeApp();
  const o = await owner(app);
  const second = await app.call('POST', '/v2/families', {
    token: o.token,
    body: { name: 'Hotel', kind: 'general' },
  });
  assert.equal(second.status, 201);
  assert.equal(second.body.provisioning_code, undefined);
  const key = publicKey();
  const first = await accept(
    app,
    await invite(app, o.token, o.circle, 'lakshmi@example.test'),
    'Lakshmi',
    'phone',
    key,
  );
  assert.equal(first.status, 201);
  const secondJoin = await accept(
    app,
    await invite(app, o.token, second.body.id, 'lakshmi@example.test'),
    'Untrusted rename',
    'ignored-label',
    key,
    first.body.token,
  );
  assert.equal(secondJoin.status, 201);
  assert.equal(secondJoin.body.token, first.body.token);
  assert.equal(secondJoin.body.user.id, first.body.user.id);
  assert.equal(secondJoin.body.user.name, 'Lakshmi');
  assert.equal(secondJoin.body.agent.id, first.body.agent.id);
  assert.equal(
    app.raw.prepare('SELECT count(*) n FROM principals WHERE email=?').get('lakshmi@example.test')!
      .n,
    1,
  );
  const circles = await app.call('GET', '/v2/discovery/circles?limit=1', {
    token: first.body.token,
  });
  assert.equal(circles.status, 200);
  assert.equal(circles.body.data.circles.length, 1);
  assert.ok(circles.body.page.next_cursor);
  const next = await app.call(
    'GET',
    '/v2/discovery/circles?limit=1&cursor=' + circles.body.page.next_cursor,
    { token: first.body.token },
  );
  assert.equal(next.body.data.circles.length, 1);
  assert.equal(next.body.page.next_cursor, null);
  assert.notEqual(next.body.data.circles[0].circle_id, circles.body.data.circles[0].circle_id);
  const keys = await app.call('GET', '/v2/agent-keys', {
    token: first.body.token,
    headers: { 'X-Circle-ID': second.body.id },
  });
  assert.ok(
    keys.body.keys.some(
      (k: any) => k.member_id === secondJoin.body.member.id && k.public_key === key,
    ),
  );
});

test('email matching and invitation possession alone cannot attach to an existing user', async () => {
  const app = makeApp();
  const o = await owner(app);
  const code = await invite(app, o.token, o.circle, 'person@example.test');
  const body = {
    agent_token: credential(),
    agent_public_key: publicKey(),
    display_name: 'Person',
    agent_label: 'phone',
  };
  const raw = await handleRequest(
    new Request('https://hub.test/v2/invites/' + code + '/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    app.db,
    app.env,
  );
  assert.equal(raw.status, 400); // challenge_id is required before any identity is created
  assert.equal(
    app.raw.prepare('SELECT count(*) n FROM principals WHERE email=?').get('person@example.test')!
      .n,
    0,
  );
  assert.equal(
    app.raw
      .prepare('SELECT used_at FROM invites WHERE code_hash IS NOT NULL AND email=?')
      .get('person@example.test')!.used_at,
    null,
  );
  const attacker = await accept(app, code, 'Person', 'phone', body.agent_public_key, o.token);
  assert.equal(attacker.status, 403);
  assert.equal(attacker.body.error.code, 'identity_mismatch');
});

test('email proof is bound to the enrollment code, candidate credential and public key', async () => {
  const app = makeApp();
  const o = await owner(app);
  const code = await invite(app, o.token, o.circle, 'person@example.test');
  let proof = '';
  app.env.EMAIL_DELIVERY = async (_email, value) => {
    proof = value;
  };
  const token = credential();
  const key = publicKey();
  const challenge = await issueEmailChallenge(app.db, app.env, {
    enrollment_code: code,
    agent_token: token,
    agent_public_key: key,
  });
  const body = {
    agent_token: token,
    agent_public_key: key,
    display_name: 'Person',
    agent_label: 'phone',
    challenge_id: challenge.challenge_id,
    verification_code: proof,
  };
  const changed = await app.call('POST', '/v2/invites/' + code + '/accept', {
    body: { ...body, agent_token: credential() },
  });
  assert.equal(changed.status, 403);
  const accepted = await app.call('POST', '/v2/invites/' + code + '/accept', { body });
  assert.equal(accepted.status, 201);
  const replay = await app.call('POST', '/v2/invites/' + code + '/accept', { body });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.token, token);
});

test('people search separates duplicate names and exposes only shared active circles', async () => {
  const app = makeApp();
  const o = await owner(app);
  const one = await accept(
    app,
    await invite(app, o.token, o.circle, 'one@example.test'),
    'Lakshmi',
    'phone',
    publicKey(),
  );
  const two = await accept(
    app,
    await invite(app, o.token, o.circle, 'two@example.test'),
    'Lakshmi',
    'phone',
    publicKey(),
  );
  assert.equal(one.status, 201);
  assert.equal(two.status, 201);
  const hidden = await app.call('POST', '/v2/families', {
    token: o.token,
    body: { name: 'Hidden' },
  });
  assert.equal(hidden.status, 201);
  const outsider = await accept(
    app,
    await invite(app, o.token, hidden.body.id, 'secret@example.test'),
    'Lakshmi',
    'phone',
    publicKey(),
  );
  assert.equal(outsider.status, 201);
  const results = await app.call('GET', '/v2/discovery/people?q=Lakshmi', {
    token: one.body.token,
  });
  assert.equal(results.body.data.people.length, 2);
  assert.notEqual(results.body.data.people[0].user_id, results.body.data.people[1].user_id);
  assert.ok(
    results.body.data.people.every((p: any) =>
      p.memberships.every((m: any) => m.circle_id === o.circle),
    ),
  );
  assert.equal(
    (
      await app.call('GET', '/v2/discovery/people?circle_id=' + hidden.body.id, {
        token: one.body.token,
      })
    ).status,
    403,
  );
  assert.equal(
    (await app.call('GET', '/v2/discovery/people?q=%25', { token: one.body.token })).body.data
      .people.length,
    0,
  );
});

test('removing one membership preserves the agent and its other circle; circle authorization is checked on every request', async () => {
  const app = makeApp();
  const o = await owner(app);
  const second = await app.call('POST', '/v2/families', {
    token: o.token,
    body: { name: 'Hotel' },
  });
  const key = publicKey();
  const first = await accept(
    app,
    await invite(app, o.token, o.circle, 'person@example.test'),
    'Person',
    'phone',
    key,
  );
  const joined = await accept(
    app,
    await invite(app, o.token, second.body.id, 'person@example.test'),
    'Person',
    'phone',
    key,
    first.body.token,
  );
  assert.equal(joined.status, 201);
  const removed = await app.call(
    'DELETE',
    `/v2/families/${o.circle}/members/${first.body.member.id}`,
    { token: o.token, headers: { 'X-Circle-ID': o.circle } },
  );
  assert.equal(removed.status, 200);
  assert.equal(
    (
      await app.call('GET', '/v2/members', {
        token: first.body.token,
        headers: { 'X-Circle-ID': o.circle },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await app.call('GET', '/v2/members', {
        token: first.body.token,
        headers: { 'X-Circle-ID': second.body.id },
      })
    ).status,
    200,
  );
  const circles = await app.call('GET', '/v2/discovery/circles', { token: first.body.token });
  assert.equal(circles.body.data.circles.length, 1);
  assert.equal(circles.body.data.circles[0].circle_id, second.body.id);
});

test('email recovery adds an independent agent to the same user; agent revocation cannot cross users', async () => {
  const app = makeApp();
  const o = await owner(app);
  const joined = await accept(
    app,
    await invite(app, o.token, o.circle, 'person@example.test'),
    'Person',
    'phone',
    publicKey(),
  );
  let proof = '';
  app.env.EMAIL_DELIVERY = async (_email, value) => {
    proof = value;
  };
  const token = credential(),
    key = publicKey();
  const challenge = await app.call('POST', '/v2/identity/challenges', {
    body: { email: 'person@example.test', agent_token: token, agent_public_key: key },
  });
  assert.equal(challenge.status, 202);
  assert.equal(challenge.body.verification_code, undefined);
  const body = {
    email: 'person@example.test',
    agent_label: 'replacement',
    agent_token: token,
    agent_public_key: key,
    challenge_id: challenge.body.challenge_id,
    verification_code: proof,
  };
  const registered = await app.call('POST', '/v2/identity/agents', { body });
  assert.equal(registered.status, 201);
  assert.equal(registered.body.user.id, joined.body.user.id);
  assert.notEqual(registered.body.agent.id, joined.body.agent.id);
  assert.equal((await app.call('POST', '/v2/identity/agents', { body })).status, 200);
  const denied = await app.call('POST', `/v2/agents/${registered.body.agent.id}/revoke`, {
    token: o.token,
  });
  assert.equal(denied.status, 404);
  const revoked = await app.call('POST', `/v2/agents/${registered.body.agent.id}/revoke`, {
    token: joined.body.token,
  });
  assert.equal(revoked.status, 200);
  assert.equal((await app.call('GET', '/v2/me', { token })).status, 401);
  assert.equal((await app.call('GET', '/v2/me', { token: joined.body.token })).status, 200);
  assert.equal((await app.call('POST', '/v2/identity/agents', { body })).status, 401);
});

test('a full 100-person page stays within D1 parameter limits and resumes without skipped users', async () => {
  const app = makeApp();
  const o = await owner(app);
  const ts = new Date().toISOString();
  const ops = [];
  for (let i = 0; i < 101; i++) {
    const id = 'batch-' + String(i).padStart(3, '0'),
      email = id + '@example.test';
    ops.push({
      sql: 'INSERT INTO principals(id,email,name,created_at,email_verified_at) VALUES(?,?,?,?,?)',
      params: [id, email, 'Batch person', ts, ts],
    });
    ops.push({
      sql: "INSERT INTO members(id,family_id,principal_id,name,email,role,created_at) VALUES(?,?,?,?,?,'parent',?)",
      params: ['member-' + id, o.circle, id, 'Batch person', email, ts],
    });
  }
  await app.db.execAtomically(ops);
  const query = app.db.queryAll.bind(app.db);
  app.db.queryAll = async (sql, params = []) => {
    assert.ok(params.length <= 100, 'D1 parameter limit exceeded');
    return query(sql, params);
  };
  const page = await app.call('GET', '/v2/discovery/people?q=Batch&limit=100', { token: o.token });
  assert.equal(page.status, 200);
  assert.equal(page.body.data.people.length, 100);
  assert.equal(page.body.page.next_cursor, 'batch-099');
  const rest = await app.call(
    'GET',
    '/v2/discovery/people?q=Batch&limit=100&cursor=' + page.body.page.next_cursor,
    { token: o.token },
  );
  assert.equal(rest.body.data.people.length, 1);
  assert.equal(rest.body.data.people[0].user_id, 'batch-100');
  assert.equal(rest.body.page.next_cursor, null);
  assert.ok(page.body.data.people.every((user: any) => user.memberships.length === 1));
});

test('concurrent first registrations for the same verified email converge on one user across circles', async () => {
  const app = makeApp();
  const o = await owner(app);
  const second = await app.call('POST', '/v2/families', {
    token: o.token,
    body: { name: 'Second' },
  });
  assert.equal(second.status, 201);
  const code1 = await invite(app, o.token, o.circle, ' Person@Example.Test ');
  const code2 = await invite(app, o.token, second.body.id, 'person@example.test');
  const [one, two] = await Promise.all([
    accept(app, code1, 'Person', 'phone', publicKey()),
    accept(app, code2, 'Person', 'computer', publicKey()),
  ]);
  assert.equal(one.status, 201);
  assert.equal(two.status, 201);
  assert.equal(one.body.user.id, two.body.user.id);
  assert.notEqual(one.body.agent.id, two.body.agent.id);
  assert.equal(
    (await app.db.queryOne("SELECT count(*) n FROM principals WHERE email='person@example.test'"))
      ?.n,
    1,
  );
  const circles = await app.call('GET', '/v2/discovery/circles', { token: one.body.token });
  assert.equal(circles.body.data.circles.length, 2);
});

test('an existing own agent can approve another agent without repeating email verification', async () => {
  const app = makeApp();
  const o = await owner(app);
  const code = await app.call('POST', '/v2/provisioning-codes', {
    token: o.token,
    body: { member_id: o.joined.body.member.id, agent_label: 'computer' },
  });
  assert.equal(code.status, 201);
  app.env.EMAIL_DELIVERY = async () => {
    throw new Error('No email should be sent for existing agent approval');
  };
  const token = credential(),
    key = publicKey();
  const next = await app.call('POST', '/v2/identity/challenges', {
    body: {
      enrollment_code: code.body.provisioning_code,
      agent_token: token,
      agent_public_key: key,
    },
  });
  assert.equal(next.status, 202);
  assert.equal(next.body.next_action, 'redeem_agent_approval');
  assert.equal(next.body.challenge_id, undefined);
  const registered = await app.call(
    'POST',
    `/v2/provisioning-codes/${code.body.provisioning_code}/redeem`,
    { body: { agent_token: token, agent_public_key: key } },
  );
  assert.equal(registered.status, 201);
  assert.equal(registered.body.user.id, o.joined.body.user.id);
  assert.notEqual(registered.body.agent.id, o.joined.body.agent.id);
  assert.equal((await app.call('GET', '/v2/me', { token })).status, 200);
});

test('issuer revocation between approval check and commit leaves no partial agent or consumed code', async () => {
  const app = makeApp();
  const o = await owner(app);
  const code = await app.call('POST', '/v2/provisioning-codes', {
    token: o.token,
    body: { member_id: o.joined.body.member.id, agent_label: 'computer' },
  });
  const original = app.db.execAtomically.bind(app.db);
  let injected = false;
  app.db.execAtomically = async (ops) => {
    if (!injected && ops.some((op) => op.sql.includes('INSERT INTO enrollment_receipts'))) {
      injected = true;
      app.raw
        .prepare("UPDATE agent_tokens SET revoked_at='2000-01-01T00:00:00Z' WHERE token_id=?")
        .run(o.joined.body.token_id);
    }
    return original(ops);
  };
  const result = await app.call(
    'POST',
    `/v2/provisioning-codes/${code.body.provisioning_code}/redeem`,
    { body: { agent_token: credential(), agent_public_key: publicKey() } },
  );
  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, 'enrollment_state_changed');
  assert.equal((await app.db.queryOne('SELECT count(*) n FROM agents'))?.n, 1);
  assert.equal((await app.db.queryOne('SELECT count(*) n FROM agent_tokens'))?.n, 1);
  assert.equal(
    (await app.db.queryOne("SELECT used_at FROM provisioning_codes WHERE agent_label='computer'"))
      ?.used_at,
    null,
  );
});

test('proof expiry at commit rolls back user, membership, keys and credential together', async () => {
  const app = makeApp();
  const o = await owner(app);
  const code = await invite(app, o.token, o.circle, 'person@example.test');
  const original = app.db.execAtomically.bind(app.db);
  let injected = false;
  app.db.execAtomically = async (ops) => {
    if (!injected && ops.some((op) => op.sql.includes('INSERT INTO enrollment_receipts'))) {
      injected = true;
      app.raw
        .prepare("UPDATE email_challenges SET expires_at='2000-01-01T00:00:00Z' WHERE email=?")
        .run('person@example.test');
    }
    return original(ops);
  };
  const body = {
    display_name: 'Person',
    agent_label: 'phone',
    agent_token: credential(),
    agent_public_key: publicKey(),
  };
  const failed = await app.call('POST', `/v2/invites/${code}/accept`, { body });
  assert.equal(failed.status, 409);
  assert.equal(failed.body.error.code, 'enrollment_state_changed');
  assert.equal(
    (await app.db.queryOne("SELECT count(*) n FROM principals WHERE email='person@example.test'"))
      ?.n,
    0,
  );
  assert.equal(
    (await app.db.queryOne("SELECT count(*) n FROM members WHERE email='person@example.test'"))?.n,
    0,
  );
  assert.equal((await app.db.queryOne('SELECT count(*) n FROM agent_tokens'))?.n, 1);
  assert.equal(
    (await app.db.queryOne("SELECT used_at FROM invites WHERE email='person@example.test'"))
      ?.used_at,
    null,
  );
  app.raw
    .prepare("UPDATE email_challenges SET expires_at='2099-01-01T00:00:00Z' WHERE email=?")
    .run('person@example.test');
  assert.equal((await app.call('POST', `/v2/invites/${code}/accept`, { body })).status, 201);
});
