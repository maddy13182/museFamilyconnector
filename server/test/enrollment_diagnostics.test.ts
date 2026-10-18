import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp } from './app.js';
import { b64 } from './syncv2_helpers.js';

test('enrollment arrival, batch completion and issuance correlate without credentials', async () => {
  const app = makeApp();
  const family = await app.call('POST', '/v2/families', {
    body: { name: 'Diagnostics', owner_name: 'Owner', owner_email: 'owner@diag.test' },
  });
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: string) => { lines.push(line); };
  try {
    const requestId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const path = `/v2/provisioning-codes/${family.body.provisioning_code}/redeem`;
    const result = await app.call('POST', path, {
      headers: { 'X-Request-ID': requestId, 'X-Operation-ID': operationId },
      body: { agent_public_key: b64(32) },
    });
    assert.equal(result.status, 201);
    assert.equal(result.headers['x-request-id'], requestId);
    const events = lines.map(line => JSON.parse(line));
    for (const event of ['request_received', 'enrollment_batch_completed', 'enrollment_issued', 'request']) {
      const record = events.find(row => row.event === event);
      assert.ok(record, event);
      assert.equal(record.request_id, requestId);
      assert.equal(record.operation_id, operationId);
    }
    assert.equal(events[0].event, 'request_received');
    const raw = lines.join('\n');
    assert.ok(!raw.includes(family.body.provisioning_code));
    assert.ok(!raw.includes(result.body.token));
    lines.length = 0;
    const retry = await app.call('POST', path, { body: { agent_public_key: b64(32) } });
    assert.equal(retry.status, 409);
    assert.ok(!lines.some(line => JSON.parse(line).event === 'enrollment_issued'));
    const invite = await app.call('POST', `/v2/families/${family.body.family.id}/invites`, {
      token: result.body.token, body: { email: 'joiner@diag.test', role: 'parent' },
    });
    assert.equal(invite.status, 201);
    lines.length = 0;
    const accepted = await app.call('POST', `/v2/invites/${invite.body.invite_code}/accept`, {
      body: { display_name: 'Joiner', agent_label: 'agent', agent_public_key: b64(32) },
    });
    assert.equal(accepted.status, 201);
    const issued = lines.map(line => JSON.parse(line)).find(row => row.event === 'enrollment_issued');
    assert.equal(issued.flow, 'invite');
    assert.equal(issued.token_id, accepted.body.token_id);
    assert.ok(!lines.join('\n').includes(accepted.body.token));
    assert.ok(!lines.join('\n').includes(invite.body.invite_code));
  } finally {
    console.log = original;
    app.raw.close();
  }
});


test('post-commit failure retains arrival and batch evidence without claiming response success', async () => {
  const app = makeApp();
  const family = await app.call('POST', '/v2/families', {
    body: { name: 'Interrupted', owner_name: 'Owner', owner_email: 'owner@interrupted.test' },
  });
  const lines: string[] = [];
  const original = console.log;
  const query = app.db.queryOne.bind(app.db);
  console.log = (line: string) => { lines.push(line); };
  app.db.queryOne = async (sql, params) => {
    if (sql.includes('SELECT t.token_id, t.member_id')) throw new Error('injected post-commit failure');
    return query(sql, params);
  };
  try {
    const result = await app.call('POST', `/v2/provisioning-codes/${family.body.provisioning_code}/redeem`, {
      body: { agent_public_key: b64(32) },
    });
    assert.equal(result.status, 500);
    const events = lines.map(line => JSON.parse(line));
    assert.ok(events.some(row => row.event === 'request_received'));
    assert.ok(events.some(row => row.event === 'enrollment_batch_completed'));
    assert.ok(!events.some(row => row.event === 'enrollment_issued'));
    const code = await query('SELECT used_at, redeemed_token_id FROM provisioning_codes');
    assert.ok(code?.used_at);
    assert.ok(code?.redeemed_token_id);
  } finally {
    console.log = original;
    app.raw.close();
  }
});
