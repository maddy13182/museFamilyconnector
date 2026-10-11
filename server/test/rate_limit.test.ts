// Rate limiting on unauthenticated credential endpoints.
import { test } from 'node:test';
import assert from 'node:assert';
import { makeApp } from './app.js';

const IP = { headers: { 'CF-Connecting-IP': '10.9.9.9' } };
const IP2 = { headers: { 'CF-Connecting-IP': '10.9.9.10' } };

test('code redeem is rate-limited per IP (10 per 10 min)', async () => {
  const app = makeApp();
  // 10 bad-code attempts from one IP: processed (404), not throttled.
  for (let i = 0; i < 10; i++) {
    const r = await app.call('POST', '/v1/provisioning-codes/fhp_badcode/redeem', {
      ...IP,
      body: {},
    });
    assert.equal(r.status, 404, `attempt ${i + 1} should process, got ${r.status}`);
  }
  // 11th attempt: throttled.
  const limited = await app.call('POST', '/v1/provisioning-codes/fhp_badcode/redeem', {
    ...IP,
    body: {},
  });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, 'rate_limited');
  assert.match(limited.body.error.message, /try again in \d+ seconds/i);
});

test('rate limit is per-IP: another IP is unaffected', async () => {
  const app = makeApp();
  for (let i = 0; i < 10; i++) {
    await app.call('POST', '/v1/provisioning-codes/fhp_badcode/redeem', {
      ...IP,
      body: {},
    });
  }
  const other = await app.call('POST', '/v1/provisioning-codes/fhp_badcode/redeem', {
    ...IP2,
    body: {},
  });
  assert.equal(other.status, 404, 'different IP should not be throttled');
});

test('invite accept is rate-limited too', async () => {
  const app = makeApp();
  for (let i = 0; i < 10; i++) {
    await app.call('POST', '/v1/invites/fhi_badcode/accept', {
      ...IP,
      body: { display_name: 'X', agent_label: 'x-agent' },
    });
  }
  const limited = await app.call('POST', '/v1/invites/fhi_badcode/accept', {
    ...IP,
    body: { display_name: 'X', agent_label: 'x-agent' },
  });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, 'rate_limited');
});

test('legitimate redeem under the limit still works', async () => {
  const app = makeApp();
  const fam = await app.call('POST', '/v1/families', {
    body: { name: 'Rate Fam', owner_name: 'Mahesh', owner_email: 'r@test.dev' },
  });
  assert.equal(fam.status, 201);
  const code = fam.body.provisioning_code as string;
  // A few bad attempts first (under the limit)...
  for (let i = 0; i < 3; i++) {
    await app.call('POST', '/v1/provisioning-codes/fhp_badcode/redeem', {
      ...IP,
      body: {},
    });
  }
  // ...then the real code still redeems fine.
  const ok = await app.call(
    'POST',
    `/v1/provisioning-codes/${encodeURIComponent(code)}/redeem`,
    { ...IP, body: {} },
  );
  assert.equal(ok.status, 201);
  assert.ok(ok.body.token);
});
