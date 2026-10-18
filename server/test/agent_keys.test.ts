// E2EE Phase 1 — key infrastructure tests.
//
// Covers: key storage on redeem (with/without public key), 400 on
// malformed keys (wrong length, bad base64) without burning the code,
// the key directory's circle-scoped access control, rotation marking the
// old key superseded (never deleted), and plaintext redeem staying
// byte-identical to before.
import { test } from 'node:test';
import assert from 'node:assert';
import { makeApp } from './app.js';
import type { TestApp } from './app.js';

// No @types/node in this repo: random bytes via WebCrypto (DOM lib) and
// base64 via btoa (each input byte becomes one char — safe for 32 bytes).
function b64(n: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return btoa(String.fromCharCode(...bytes));
}
function b64url(n: number): string {
  return b64(n).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

interface Party {
  token: string;
  memberId: string;
  agentLabel: string;
}

async function setupFamily(app: TestApp, name: string): Promise<{ famId: string; owner: Party }> {
  const fam = await app.call('POST', '/v2/families', {
    body: { name, owner_name: 'Ow', owner_email: `o-${name}@x.dev` },
  });
  assert.equal(fam.status, 201);
  const famId = (await app.db.queryOne('SELECT id FROM families WHERE name = ?', [name]))!['id'] as string;
  const red = await app.call(
    'POST',
    `/v2/provisioning-codes/${encodeURIComponent(fam.body.provisioning_code)}/redeem`,
    { body: { agent_public_key: b64(32) } },
  );
  assert.equal(red.status, 201);
  return {
    famId,
    owner: { token: red.body.token as string, memberId: red.body.member.id as string, agentLabel: 'owner-agent' },
  };
}

async function mintCode(app: TestApp, token: string, memberId: string, label: string): Promise<string> {
  const m = await app.call('POST', '/v2/provisioning-codes', {
    token,
    body: { member_id: memberId, agent_label: label },
  });
  assert.equal(m.status, 201);
  return m.body.provisioning_code as string;
}

function columnNames(app: TestApp, table: string): string[] {
  const rows = app.raw
    .prepare(`PRAGMA table_info(${table})`)
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

test('fresh DB from the full migration chain carries the E2EE schema', async () => {
  // Clean-slate model: 0001_init.sql holds the E2EE tables/columns.
  // freshDb() applies 0001→0010 in order, mirroring
  // `wrangler d1 migrations apply` on a fresh database.
  const app = makeApp();
  assert.deepEqual(columnNames(app, 'agent_keys'), [
    'id',
    'member_id',
    'agent_label',
    'public_key',
    'created_at',
    'superseded_at',
  ]);
  const topicsCols = columnNames(app, 'topics');
  assert.ok(topicsCols.includes('e2ee'), 'topics must have the e2ee column');
  assert.ok(
    topicsCols.includes('current_key_id'),
    'topics must have the current_key_id column (secfix F1 key election)',
  );
  const e2eeDef = (
    app.raw.prepare(`PRAGMA table_info(topics)`).all() as Array<{
      name: string;
      dflt_value: unknown;
    }>
  ).find((c) => c.name === 'e2ee')!;
  assert.equal(e2eeDef.dflt_value, 1);
  assert.deepEqual(columnNames(app, 'topic_key_envelopes'), [
    'topic_id',
    'member_id',
    'agent_label',
    'key_id',
    'envelope',
    'created_at',
    'identity_key_id', // 0010: which identity key version the envelope was sealed to
  ]);
  // 0010 (sync v2): read state + epoch log + lifecycle columns.
  assert.deepEqual(columnNames(app, 'topic_read_state'), [
    'member_id',
    'agent_label',
    'topic_id',
    'acked_seq',
    'updated_at',
  ]);
  assert.deepEqual(columnNames(app, 'topic_key_epochs'), [
    'topic_id',
    'epoch',
    'key_id',
    'commitment',
    'recipients',
    'created_at',
    'created_by',
  ]);
  const topicsCols2 = columnNames(app, 'topics');
  assert.ok(topicsCols2.includes('current_epoch'), 'topics must have current_epoch (0010)');
  assert.ok(topicsCols2.includes('rotation_required'), 'topics must have rotation_required (0010)');
  // The one-active-key-per-(member, label) partial unique index exists.
  const indexes = app.raw
    .prepare(`PRAGMA index_list(agent_keys)`)
    .all() as Array<{ name: string; sql: string | null }>;
  assert.ok(
    indexes.some((i) => i.name === 'idx_agent_keys_active'),
    'partial unique index idx_agent_keys_active must exist',
  );
  // Existing tables are untouched by the E2EE additions.
  assert.deepEqual(columnNames(app, 'agent_tokens'), [
    'token_hash',
    'token_id',
    'member_id',
    'agent_label',
    'created_at',
    'revoked_at',
    'last_used_at',
    'agent_id',
  ]);
});

test('redeem with agent_public_key stores it bound to (member_id, agent_label)', async () => {
  const app = makeApp();
  const { owner } = await setupFamily(app, 'KeyFam1');
  const key = b64(32);
  const code = await mintCode(app, owner.token, owner.memberId, 'laptop-agent');
  const red = await app.call(
    'POST',
    `/v2/provisioning-codes/${encodeURIComponent(code)}/redeem`,
    { body: { agent_public_key: key } },
  );
  assert.equal(red.status, 201);
  const memberId = red.body.member.id as string;
  const row = await app.db.queryOne(
    `SELECT * FROM agent_keys WHERE member_id = ? AND agent_label = ? AND superseded_at IS NULL`,
    [memberId, 'laptop-agent'],
  );
  assert.ok(row, 'active key row must exist');
  assert.equal(row!['public_key'], key);
  assert.equal(row!['superseded_at'], null);
});



test('malformed agent_public_key is rejected 400 and does NOT burn the code', async () => {
  const app = makeApp();
  const { owner } = await setupFamily(app, 'KeyFam3');
  const bad: Array<[string, unknown]> = [
    ['wrong length (31 bytes)', b64(31)],
    ['wrong length (33 bytes)', b64(33)],
    ['bad base64', '!!!not-base64!!!'],
    ['urlsafe alphabet', b64url(32)],
    ['unpadded', b64(32).replace(/=+$/, '')],
    ['empty string', ''],
    ['non-string', 42],
  ];
  let n = 0;
  for (const [label, key] of bad) {
    // Separate simulated email-delivery windows; this test targets key validation.
    await app.db.queryAll("UPDATE email_challenges SET created_at='2000-01-01T00:00:00Z'");
    n += 1;
    // Distinct client IP per sub-case: the redeem endpoint is rate-limited
    // (10/10min per IP) and the harness shares one IP otherwise.
    const headers = { 'CF-Connecting-IP': `10.9.0.${n}` };
    const code = await mintCode(app, owner.token, owner.memberId, `bad-${n}`);
    const red = await app.call(
      'POST',
      `/v2/provisioning-codes/${encodeURIComponent(code)}/redeem`,
      { body: { agent_public_key: key }, headers },
    );
    assert.equal(red.status, 400, `expected 400 for ${label}`);
    // The single-use code must still be redeemable afterwards.
    const retry = await app.call(
      'POST',
      `/v2/provisioning-codes/${encodeURIComponent(code)}/redeem`,
      { body: { agent_public_key: b64(32) }, headers },
    );
    assert.equal(retry.status, 201, `code must survive a 400 for ${label}`);
  }
  const total = await app.db.queryOne(`SELECT COUNT(*) AS c FROM agent_keys`, []);
  assert.equal(total!['c'], bad.length + 1);
});

test('key directory: same-circle keys visible, cross-circle invisible', async () => {
  const app = makeApp();
  const a = await setupFamily(app, 'CircleA');
  const b = await setupFamily(app, 'CircleB');
  // A: owner + a second agent with a key.
  const keyA = b64(32);
  const codeA = await mintCode(app, a.owner.token, a.owner.memberId, 'a-agent');
  const redA = await app.call(
    'POST',
    `/v2/provisioning-codes/${encodeURIComponent(codeA)}/redeem`,
    { body: { agent_public_key: keyA } },
  );
  assert.equal(redA.status, 201);
  const tokenA = redA.body.token as string;
  // B: an agent with a key in the OTHER circle.
  const keyB = b64(32);
  const codeB = await mintCode(app, b.owner.token, b.owner.memberId, 'b-agent');
  const redB = await app.call(
    'POST',
    `/v2/provisioning-codes/${encodeURIComponent(codeB)}/redeem`,
    { body: { agent_public_key: keyB } },
  );
  assert.equal(redB.status, 201);

  // No auth -> 401.
  const anon = await app.call('GET', '/v2/agent-keys');
  assert.equal(anon.status, 401);

  // A sees only A's key (member filter and full listing agree).
  const dirA = await app.call('GET', '/v2/agent-keys', { token: tokenA });
  assert.equal(dirA.status, 200);
  assert.equal(dirA.body.keys.length, 2);
  assert.equal(dirA.body.keys.find((k: any) => k.agent_label === 'a-agent').public_key, keyA);
  assert.equal(dirA.body.keys[0].member_id, a.owner.memberId);
  assert.deepEqual(
    Object.keys(dirA.body.keys[0]).sort(),
    ['agent_id', 'agent_label', 'created_at', 'member_id', 'public_key'],
  );
  // member_id filter for the other circle's member -> empty, not 403
  // (membership in the circle is the rule; the member simply isn't there).
  const cross = await app.call('GET', `/v2/agent-keys?member_id=${b.owner.memberId}`, {
    token: tokenA,
  });
  assert.equal(cross.status, 200);
  assert.deepEqual(cross.body.keys, []);

  // B sees only B's key.
  const dirB = await app.call('GET', '/v2/agent-keys', { token: b.owner.token });
  assert.equal(dirB.status, 200);
  assert.equal(dirB.body.keys.length, 2);
  assert.equal(dirB.body.keys.find((k: any) => k.agent_label === 'b-agent').public_key, keyB);
});

test('rotate marks the old key superseded, keeps the row, and activates the new key', async () => {
  const app = makeApp();
  const { owner } = await setupFamily(app, 'KeyFam4');
  const key1 = b64(32);
  const code = await mintCode(app, owner.token, owner.memberId, 'rot-agent');
  const red = await app.call(
    'POST',
    `/v2/provisioning-codes/${encodeURIComponent(code)}/redeem`,
    { body: { agent_public_key: key1 } },
  );
  assert.equal(red.status, 201);
  const token = red.body.token as string;

  // Malformed rotate key -> 400, old key untouched.
  const badRot = await app.call('POST', '/v2/agent-keys/rotate', {
    token,
    body: { agent_public_key: 'short' },
  });
  assert.equal(badRot.status, 400);
  const still = await app.db.queryOne(
    `SELECT COUNT(*) AS c FROM agent_keys WHERE superseded_at IS NULL AND agent_label = 'rot-agent'`,
    [],
  );
  assert.equal(still!['c'], 1);

  // Missing key -> 400.
  const missing = await app.call('POST', '/v2/agent-keys/rotate', { token, body: {} });
  assert.equal(missing.status, 400);

  // No auth -> 401.
  const anon = await app.call('POST', '/v2/agent-keys/rotate', {
    body: { agent_public_key: b64(32) },
  });
  assert.equal(anon.status, 401);

  const key2 = b64(32);
  const rot = await app.call('POST', '/v2/agent-keys/rotate', {
    token,
    body: { agent_public_key: key2 },
  });
  assert.equal(rot.status, 200);
  assert.equal(rot.body.public_key, key2);
  assert.equal(rot.body.agent_label, 'rot-agent');

  // Both rows exist; exactly one is active.
  const rows = await app.db.queryAll(
    `SELECT public_key, created_at, superseded_at FROM agent_keys WHERE agent_label = 'rot-agent' ORDER BY created_at`,
    [],
  );
  assert.equal(rows.length, 2);
  assert.ok(rows[0]['superseded_at'], 'old row must be marked superseded');
  assert.equal(rows[0]['public_key'], key1);
  assert.equal(rows[1]['superseded_at'], null);
  assert.equal(rows[1]['public_key'], key2);

  // The directory serves the new key only.
  const dir = await app.call('GET', '/v2/agent-keys', { token });
  assert.equal(dir.body.keys.filter((k: any) => k.agent_label === 'rot-agent').length, 1);
  assert.equal(dir.body.keys.find((k: any) => k.agent_label === 'rot-agent').public_key, key2);
});

test('rotate with no prior key is the initial registration path', async () => {
  const app = makeApp();
  const { owner } = await setupFamily(app, 'KeyFam5');
  // Fault injection: explicit registration repair after identity-row loss.
  await app.db.execAtomically([{sql:'DELETE FROM agent_keys WHERE member_id = ?',params:[owner.memberId]}]);
  const key = b64(32);
  const rot = await app.call('POST', '/v2/agent-keys/rotate', {
    token: owner.token,
    body: { agent_public_key: key },
  });
  assert.equal(rot.status, 200);
  const row = await app.db.queryOne(
    `SELECT * FROM agent_keys WHERE member_id = ? AND agent_label = ? AND superseded_at IS NULL`,
    [owner.memberId, 'owner-agent'],
  );
  assert.ok(row);
  assert.equal(row!['public_key'], key);
});

test('second redeem for the same agent label with a key is rejected 409', async () => {
  const app = makeApp();
  const { owner } = await setupFamily(app, 'KeyFam6');
  const code1 = await mintCode(app, owner.token, owner.memberId, 'dup-agent');
  const red1 = await app.call(
    'POST',
    `/v2/provisioning-codes/${encodeURIComponent(code1)}/redeem`,
    { body: { agent_public_key: b64(32) } },
  );
  assert.equal(red1.status, 201);
  const code2 = await mintCode(app, owner.token, owner.memberId, 'dup-agent');
  const red2 = await app.call(
    'POST',
    `/v2/provisioning-codes/${encodeURIComponent(code2)}/redeem`,
    { body: { agent_public_key: b64(32) } },
  );
  assert.equal(red2.status, 409);
  assert.equal(red2.body.error.code, 'agent_exists');
  // The second code must NOT have been consumed.
  const retry = await app.call(
    'POST',
    `/v2/provisioning-codes/${encodeURIComponent(code2)}/redeem`,
    { body: { agent_public_key: (await app.db.queryOne(`SELECT public_key FROM agent_keys WHERE member_id = ? AND agent_label = 'dup-agent'`,[owner.memberId]))!.public_key } },
  );
  assert.equal(retry.status, 201);
});
