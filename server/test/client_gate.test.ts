// WS-B — client version gate (B1), GET /v1/client/latest (B2), and key
// lineage in the audit log (B3).
//
// Covers: below-minimum 400 with the guidance message, the legacy
// `family-hub-agent/1.0` sentinel, non-CLI user-agent passthrough, gate-off
// default, /v1/client/latest shape + gate exemption, and key-fingerprint
// audit entries on registration / rotation (old fp → new fp) / revocation.
import { test } from 'node:test';
import assert from 'node:assert';
import { makeApp, TestApp } from './app.js';
import manifest from '../client-manifest.json' with { type: 'json' };

// No @types/node in this repo: random bytes via WebCrypto (DOM lib) and
// base64 via btoa (each input byte becomes one char — safe for 32 bytes).
function b64(n: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return btoa(String.fromCharCode(...bytes));
}

async function fpOf(publicKey: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(publicKey));
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return 'fp:' + hex.slice(0, 16);
}

function captureLogs() {
  const lines: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (m: unknown) => {
    lines.push(String(m));
  };
  console.error = (m: unknown) => {
    lines.push(String(m));
  };
  return {
    lines,
    restore() {
      console.log = origLog;
      console.error = origErr;
    },
  };
}

function parsed(lines: string[]): Record<string, unknown>[] {
  return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
}

function findLine(lines: Record<string, unknown>[], event: string): Record<string, unknown> {
  const line = lines.find((l) => l['event'] === event);
  if (!line) throw new Error(`expected a ${event} audit line`);
  return line;
}

async function setupOwner(app: TestApp): Promise<{
  token: string;
  memberId: string;
  famId: string;
}> {
  const fam = await app.call('POST', '/v1/families', {
    body: { name: `gate-${Date.now()}-${Math.random()}`, owner_name: 'Ow', owner_email: 'o@gate.dev' },
  });
  assert.equal(fam.status, 201);
  const red = await app.call(
    'POST',
    `/v1/provisioning-codes/${encodeURIComponent(fam.body.provisioning_code)}/redeem`,
    { body: {} },
  );
  assert.equal(red.status, 201);
  const memberId = red.body.member.id as string;
  const famRow = await app.db.queryOne('SELECT family_id FROM members WHERE id = ?', [memberId]);
  return {
    token: red.body.token as string,
    memberId,
    famId: famRow!['family_id'] as string,
  };
}

function gateOn(app: TestApp, min = '0.7.0'): void {
  app.env.MIN_CLI_VERSION = min;
}

// ---------------------------------------------------------------------------
// B1: client version gate.
// ---------------------------------------------------------------------------

test('gate is off by default: outdated CLI UA passes', async () => {
  const app = makeApp();
  const { token } = await setupOwner(app);
  const res = await app.call('GET', '/v1/me', {
    token,
    headers: { 'user-agent': 'family-hub-agent/0.0.1' },
  });
  assert.equal(res.status, 200);
});

test('below-minimum CLI is rejected with 400 and the guidance message', async () => {
  const app = makeApp();
  gateOn(app);
  const res = await app.call('GET', '/v1/me', {
    headers: { 'user-agent': 'family-hub-agent/0.5.0' },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'client_too_old');
  assert.equal(
    res.body.error.message,
    'Client version 0.5.0 is below the required minimum 0.7.0. ' +
      'Update your CLI: see agent-skill/INSTALL.md (hub upgrade), then retry.',
  );
});

test('legacy family-hub-agent/1.0 sentinel is treated as 0.0.0', async () => {
  const app = makeApp();
  gateOn(app);
  const res = await app.call('GET', '/v1/me', {
    headers: { 'user-agent': 'family-hub-agent/1.0' },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'client_too_old');
  assert.match(res.body.error.message, /Client version 0\.0\.0 is below the required minimum 0\.7\.0/);
});

test('client at or above the minimum passes the gate', async () => {
  const app = makeApp();
  gateOn(app);
  const { token } = await setupOwner(app);
  for (const v of ['0.7.0', '0.7.1', '1.2.3']) {
    const res = await app.call('GET', '/v1/me', {
      token,
      headers: { 'user-agent': `family-hub-agent/${v}` },
    });
    assert.equal(res.status, 200, `UA family-hub-agent/${v} should pass`);
  }
});

test('non-CLI user agents are never gated', async () => {
  const app = makeApp();
  gateOn(app);
  const { token } = await setupOwner(app);
  // Browser dashboard UA.
  const browser = await app.call('GET', '/v1/me', {
    token,
    headers: {
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
    },
  });
  assert.equal(browser.status, 200);
  // curl.
  const curl = await app.call('GET', '/v1/me', {
    token,
    headers: { 'user-agent': 'curl/8.5.0' },
  });
  assert.equal(curl.status, 200);
  // No User-Agent header at all.
  const none = await app.call('GET', '/v1/me', { token });
  assert.equal(none.status, 200);
});

test('gate fires before auth (400, not 401) for old clients', async () => {
  const app = makeApp();
  gateOn(app);
  const res = await app.call('GET', '/v1/me', {
    headers: { 'user-agent': 'family-hub-agent/0.1.0' },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'client_too_old');
});

test('/v1/client/latest and /v1/health are exempt from the gate', async () => {
  const app = makeApp();
  gateOn(app);
  const latest = await app.call('GET', '/v1/client/latest', {
    headers: { 'user-agent': 'family-hub-agent/0.0.1' },
  });
  assert.equal(latest.status, 200);
  const health = await app.call('GET', '/v1/health', {
    headers: { 'user-agent': 'family-hub-agent/1.0' },
  });
  assert.equal(health.status, 200);
});

// ---------------------------------------------------------------------------
// B2: GET /v1/client/latest.
// ---------------------------------------------------------------------------

test('/v1/client/latest serves the manifest shape, publicly', async () => {
  const app = makeApp();
  const res = await app.call('GET', '/v1/client/latest');
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body).sort(), [
    'download_url',
    'min_cli_version',
    'released_at',
    'sha256',
    'version',
  ]);
  assert.equal(res.body.version, manifest.version);
  assert.equal(res.body.min_cli_version, manifest.min_cli_version);
  assert.equal(res.body.download_url, manifest.download_url);
  assert.equal(res.body.sha256, manifest.sha256);
  assert.equal(res.body.released_at, manifest.released_at);
  assert.match(res.body.version, /^\d+\.\d+\.\d+$/);
  assert.match(res.body.min_cli_version, /^\d+\.\d+\.\d+$/);
});

// ---------------------------------------------------------------------------
// B3: key lineage in the audit log.
// ---------------------------------------------------------------------------

test('key registration via redeem logs key_fp → agent_label → member_id → circle_id', async () => {
  const app = makeApp();
  const fam = await app.call('POST', '/v1/families', {
    body: { name: `reg-${Date.now()}`, owner_name: 'Ow', owner_email: 'o@reg.dev' },
  });
  assert.equal(fam.status, 201);
  const pubkey = b64(32);
  const cap = captureLogs();
  let red;
  try {
    red = await app.call(
      'POST',
      `/v1/provisioning-codes/${encodeURIComponent(fam.body.provisioning_code)}/redeem`,
      { body: { agent_public_key: pubkey } },
    );
  } finally {
    cap.restore();
  }
  assert.equal(red.status, 201);
  const line = findLine(parsed(cap.lines), 'agent_key_registered');
  assert.equal(line['key_fp'], await fpOf(pubkey));
  assert.equal(line['agent_label'], 'owner-agent');
  assert.equal(line['member_id'], red.body.member.id);
  assert.equal(line['family_id'], red.body.member.family_id);
});

test('initial registration via /v1/agent-keys/rotate logs key_fp', async () => {
  const app = makeApp();
  const { token, memberId, famId } = await setupOwner(app);
  const pubkey = b64(32);
  const cap = captureLogs();
  let res;
  try {
    res = await app.call('POST', '/v1/agent-keys/rotate', {
      token,
      body: { agent_public_key: pubkey },
    });
  } finally {
    cap.restore();
  }
  assert.equal(res.status, 200);
  const line = findLine(parsed(cap.lines), 'agent_key_registered');
  assert.equal(line['key_fp'], await fpOf(pubkey));
  assert.equal(line['agent_label'], 'owner-agent');
  assert.equal(line['member_id'], memberId);
  assert.equal(line['family_id'], famId);
});

test('rotation logs old fp → new fp with the full chain', async () => {
  const app = makeApp();
  const { token, memberId, famId } = await setupOwner(app);
  const first = b64(32);
  const second = b64(32);
  const r1 = await app.call('POST', '/v1/agent-keys/rotate', {
    token,
    body: { agent_public_key: first },
  });
  assert.equal(r1.status, 200);
  const cap = captureLogs();
  let r2;
  try {
    r2 = await app.call('POST', '/v1/agent-keys/rotate', {
      token,
      body: { agent_public_key: second },
    });
  } finally {
    cap.restore();
  }
  assert.equal(r2.status, 200);
  const line = findLine(parsed(cap.lines), 'agent_key_rotated');
  assert.equal(line['old_key_fp'], await fpOf(first));
  assert.equal(line['key_fp'], await fpOf(second));
  assert.equal(line['agent_label'], 'owner-agent');
  assert.equal(line['member_id'], memberId);
  assert.equal(line['family_id'], famId);
});

test('token revocation logs the active key fingerprint with the full chain', async () => {
  const app = makeApp();
  const { token, memberId, famId } = await setupOwner(app);
  const pubkey = b64(32);
  const reg = await app.call('POST', '/v1/agent-keys/rotate', {
    token,
    body: { agent_public_key: pubkey },
  });
  assert.equal(reg.status, 200);
  const tokenRow = await app.db.queryOne('SELECT token_id FROM agent_tokens WHERE member_id = ?', [
    memberId,
  ]);
  const cap = captureLogs();
  let res;
  try {
    res = await app.call('POST', '/v1/auth/revoke', {
      token,
      body: { token_id: tokenRow!['token_id'] },
    });
  } finally {
    cap.restore();
  }
  assert.equal(res.status, 200);
  const line = findLine(parsed(cap.lines), 'token_revoked');
  assert.equal(line['key_fp'], await fpOf(pubkey));
  assert.equal(line['agent_label'], 'owner-agent');
  assert.equal(line['member_id'], memberId);
  assert.equal(line['family_id'], famId);
});
