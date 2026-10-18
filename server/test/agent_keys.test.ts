// E2EE Phase 1 — key infrastructure tests.
//
// Covers mandatory identity enrollment, malformed-key rejection without
// consuming the setup code, circle-scoped key directories and authenticated
// key rotation that preserves historical directory rows.
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
  const famId = (await app.db.queryOne('SELECT id FROM families WHERE name = ?', [name]))![
    'id'
  ] as string;
  const red = await app.call(
    'POST',
    `/v2/provisioning-codes/${encodeURIComponent(fam.body.provisioning_code)}/redeem`,
    { body: { agent_public_key: b64(32) } },
  );
  assert.equal(red.status, 201);
  return {
    famId,
    owner: {
      token: red.body.token as string,
      memberId: red.body.member.id as string,
      agentLabel: 'owner-agent',
    },
  };
}

function columnNames(app: TestApp, table: string): string[] {
  const rows = app.raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

test('fresh DB from the full migration chain carries the E2EE schema', async () => {
  // freshDb() applies the complete migration chain, mirroring
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
  const indexes = app.raw.prepare(`PRAGMA index_list(agent_keys)`).all() as Array<{
    name: string;
    sql: string | null;
  }>;
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

test('owner registration stores the sole Muse identity and circle key directory entry', async () => {
  const app = makeApp();
  const { owner } = await setupFamily(app, 'Registration');
  const row = await app.db.queryOne('SELECT * FROM agent_keys WHERE member_id=?', [owner.memberId]);
  assert.ok(row);
  assert.equal(row!.agent_label, 'owner-agent');
  const agents = await app.db.queryAll(
    'SELECT id FROM agents WHERE user_id=(SELECT principal_id FROM members WHERE id=?)',
    [owner.memberId],
  );
  assert.equal(agents.length, 1);
});

test('malformed public keys never consume the owner setup code', async () => {
  const app = makeApp();
  let n = 0;
  for (const key of [
    b64(31),
    b64(33),
    '!!!not-base64!!!',
    b64url(32),
    b64(32).replace(/=+$/, ''),
    '',
    42,
  ]) {
    const name = 'Invalid-' + ++n;
    const fam = await app.call('POST', '/v2/families', {
      body: { name, owner_name: 'Owner', owner_email: name + '@example.test' },
    });
    assert.equal(fam.status, 201);
    const path = '/v2/provisioning-codes/' + fam.body.provisioning_code + '/redeem';
    const headers = { 'CF-Connecting-IP': '10.9.0.' + n };
    assert.equal(
      (await app.call('POST', path, { headers, body: { agent_public_key: key } })).status,
      400,
    );
    assert.equal(
      (await app.call('POST', path, { headers, body: { agent_public_key: b64(32) } })).status,
      201,
    );
  }
  assert.equal((await app.db.queryOne('SELECT count(*) n FROM agents'))?.n, 7);
});

test('key directory only exposes active members of the selected circle', async () => {
  const app = makeApp();
  const a = await setupFamily(app, 'Directory-A');
  const b = await setupFamily(app, 'Directory-B');
  assert.equal((await app.call('GET', '/v2/agent-keys')).status, 401);
  const directory = await app.call('GET', '/v2/agent-keys', { token: a.owner.token });
  assert.equal(directory.status, 200);
  assert.equal(directory.body.keys.length, 1);
  assert.equal(directory.body.keys[0].member_id, a.owner.memberId);
  assert.deepEqual(
    (
      await app.call('GET', '/v2/agent-keys?member_id=' + b.owner.memberId, {
        token: a.owner.token,
      })
    ).body.keys,
    [],
  );
  assert.equal(
    (await app.call('GET', '/v2/agent-keys', { token: b.owner.token })).body.keys[0].member_id,
    b.owner.memberId,
  );
});

test('key rotation preserves the Muse identity and supersedes old directory rows', async () => {
  const app = makeApp();
  const { owner } = await setupFamily(app, 'Rotation');
  const before = (await app.db.queryOne('SELECT * FROM agents'))!;
  assert.equal(
    (
      await app.call('POST', '/v2/agent-keys/rotate', {
        token: owner.token,
        body: { agent_public_key: 'bad' },
      })
    ).status,
    400,
  );
  const key = b64(32);
  assert.equal(
    (
      await app.call('POST', '/v2/agent-keys/rotate', {
        token: owner.token,
        body: { agent_public_key: key },
      })
    ).status,
    200,
  );
  const after = (await app.db.queryOne('SELECT * FROM agents'))!;
  assert.equal(after.id, before.id);
  assert.equal(after.public_key, key);
  const rows = await app.db.queryAll('SELECT * FROM agent_keys WHERE member_id=?', [
    owner.memberId,
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows.filter((r) => r.superseded_at === null).length, 1);
  assert.equal(rows.find((r) => r.superseded_at === null)!.public_key, key);
});
