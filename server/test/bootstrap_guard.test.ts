import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp } from './app.js';

test('provisioned bootstrap requires its private capability even during the setup window', async () => {
  const app = makeApp();
  app.env.BOOTSTRAP_SECRET = 'bootstrap-test-capability';
  const body = { name: 'First circle', owner_name: 'Owner', owner_email: 'owner@example.test' };
  try {
    assert.equal((await app.call('POST', '/v2/families', { body })).status, 403);
    assert.equal((await app.call('POST', '/v2/families', {
      body, headers: { 'X-Bootstrap-Secret': 'wrong-capability' },
    })).status, 403);
    assert.equal((await app.db.queryOne('SELECT COUNT(*) AS n FROM families'))?.['n'], 0);
    const created = await app.call('POST', '/v2/families', {
      body, headers: { 'X-Bootstrap-Secret': app.env.BOOTSTRAP_SECRET },
    });
    assert.equal(created.status, 201);
    assert.ok(created.body.provisioning_code);
    app.env.SETUP_LOCKED = '1';
    assert.equal((await app.call('POST', '/v2/families', {
      body: { ...body, name: 'Unauthorized second circle' },
      headers: { 'X-Bootstrap-Secret': app.env.BOOTSTRAP_SECRET },
    })).status, 401);
    assert.equal((await app.db.queryOne('SELECT COUNT(*) AS n FROM families'))?.['n'], 1);
  } finally {
    app.raw.close();
  }
});
