import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp } from './app.js';
import { handleRequest } from '../src/index.js';
import { b64 } from './syncv2_helpers.js';

function credential() {
  return 'fh_' + b64(32).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
async function prepare() {
  const app = makeApp();
  const created = await app.call('POST', '/v2/families', {
    body: { name: 'Resume', owner_name: 'Owner', owner_email: 'owner@resume.test' },
  });
  const path = `/v2/provisioning-codes/${created.body.provisioning_code}/redeem`;
  const body = { agent_public_key: b64(32), agent_token: credential() };
  return { app, path, body, created };
}

test('exact provisioning retries return the same active credential, including concurrent requests', async () => {
  const { app, path, body } = await prepare();
  try {
    const replies = await Promise.all([
      app.call('POST', path, { body }),
      app.call('POST', path, { body }),
    ]);
    assert.deepEqual(replies.map((r) => r.status).sort(), [200, 201]);
    assert.equal(replies[0].body.token, body.agent_token);
    assert.equal(replies[0].body.token_id, replies[1].body.token_id);
    assert.equal((await app.db.queryOne('SELECT COUNT(*) n FROM agent_tokens'))?.n, 1);
    const stored = await app.db.queryOne('SELECT * FROM enrollment_receipts');
    assert.ok(!JSON.stringify(stored).includes(body.agent_token));
    const changed = await app.call('POST', path, { body: { ...body, agent_token: credential() } });
    assert.equal(changed.status, 409);
    assert.equal(changed.body.member, undefined);
    assert.equal(
      (await app.call('POST', path, { body: { ...body, agent_public_key: b64(32) } })).status,
      409,
    );
    await app.db.execAtomically([
      { sql: 'UPDATE agent_tokens SET revoked_at = ?', params: ['2000-01-01T00:00:00Z'] },
    ]);
    assert.equal((await app.call('POST', path, { body })).status, 401);
    assert.equal((await app.db.queryOne('SELECT COUNT(*) n FROM agent_tokens'))?.n, 1);
  } finally {
    app.raw.close();
  }
});

test('invite replay preserves one membership and rejects changed names or removed members', async () => {
  const { app, path, body, created } = await prepare();
  try {
    const owner = await app.call('POST', path, { body });
    const invitation = await app.call('POST', `/v2/families/${created.body.family.id}/invites`, {
      token: owner.body.token,
      body: { email: 'person@resume.test', role: 'parent' },
    });
    const accept = `/v2/invites/${invitation.body.invite_code}/accept`;
    const request = {
      agent_public_key: b64(32),
      agent_token: credential(),
      display_name: 'Person',
      agent_label: 'muse-agent',
    };
    const first = await app.call('POST', accept, { body: request });
    assert.equal(first.status, 201);
    assert.equal((await app.call('POST', accept, { body: request })).status, 200);
    assert.equal(
      (await app.call('POST', accept, { body: { ...request, display_name: 'Different' } })).status,
      409,
    );
    assert.equal((await app.db.queryOne('SELECT COUNT(*) n FROM members'))?.n, 2);
    await app.call(
      'DELETE',
      `/v2/families/${created.body.family.id}/members/${first.body.member.id}`,
      { token: owner.body.token },
    );
    assert.equal((await app.call('POST', accept, { body: request })).status, 403);
  } finally {
    app.raw.close();
  }
});

test('receipt failure rolls back credential issuance and code consumption atomically', async () => {
  const { app, path, body } = await prepare();
  try {
    app.raw.exec(
      "CREATE TRIGGER fail_receipt BEFORE INSERT ON enrollment_receipts BEGIN SELECT RAISE(ABORT, 'injected'); END;",
    );
    assert.equal((await app.call('POST', path, { body })).status, 500);
    assert.equal((await app.db.queryOne('SELECT COUNT(*) n FROM agent_tokens'))?.n, 0);
    assert.equal((await app.db.queryOne('SELECT used_at FROM provisioning_codes'))?.used_at, null);
    app.raw.exec('DROP TRIGGER fail_receipt');
    assert.equal((await app.call('POST', path, { body })).status, 201);
  } finally {
    app.raw.close();
  }
});

test('missing client credential is rejected before consuming a code', async () => {
  const { app, path, body } = await prepare();
  try {
    const res = await handleRequest(
      new Request('https://hub.test' + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent_public_key: body.agent_public_key }),
      }),
      app.db,
      app.env,
    );
    assert.equal(res.status, 400);
    assert.equal((await app.db.queryOne('SELECT used_at FROM provisioning_codes'))?.used_at, null);
  } finally {
    app.raw.close();
  }
});
