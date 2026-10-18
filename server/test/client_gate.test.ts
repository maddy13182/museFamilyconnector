// WS-B — client version gate (B1), GET /v2/client/latest (B2), and key
// lineage in the audit log (B3).
//
// Covers: below-minimum 426 with the guidance message, the legacy
// `family-hub-agent/1.0` sentinel, non-CLI user-agent passthrough, gate-off
// default, /v2/client/latest shape + gate exemption, and key-fingerprint
// audit entries on registration / rotation (old fp → new fp) / revocation.
import { test } from 'node:test';
import assert from 'node:assert';
import { makeApp, TestApp } from './app.js';
import manifestJson from '../client-manifest.json' with { type: 'json' };
import pkg from '../package.json' with { type: 'json' };
// The pin carries skill_sha256/skill_version for CLI releases cut after the
// skill bundle (bundle-client.mjs fails closed without them). The committed
// pin predates the first bundled release, so the test types the fields the
// release workflow's manifest-PR step always writes.
const manifest = manifestJson as typeof manifestJson & {
  skill_sha256: string;
  skill_version: string;
};

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
  const fam = await app.call('POST', '/v2/families', {
    body: { name: `gate-${Date.now()}-${Math.random()}`, owner_name: 'Ow', owner_email: 'o@gate.dev' },
  });
  assert.equal(fam.status, 201);
  const red = await app.call(
    'POST',
    `/v2/provisioning-codes/${encodeURIComponent(fam.body.provisioning_code)}/redeem`,
    { body: { agent_public_key: b64(32) } },
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
  const res = await app.call('GET', '/v2/me', {
    token,
    headers: { 'user-agent': 'family-hub-agent/0.0.1' },
  });
  assert.equal(res.status, 200);
});

test('below-minimum CLI is rejected with 426 and the guidance message', async () => {
  const app = makeApp();
  gateOn(app);
  const res = await app.call('GET', '/v2/me', {
    headers: { 'user-agent': 'family-hub-agent/0.5.0' },
  });
  assert.equal(res.status, 426);
  assert.equal(res.body.error.code, 'client_too_old');
  assert.equal(
    res.body.error.message,
    'Client version 0.5.0 is below the required minimum 0.7.0. ' +
      "Update your CLI from this server's verified bundle (hub upgrade), then retry.",
  );
});

test('legacy family-hub-agent/1.0 sentinel is treated as 0.0.0', async () => {
  const app = makeApp();
  gateOn(app);
  const res = await app.call('GET', '/v2/me', {
    headers: { 'user-agent': 'family-hub-agent/1.0' },
  });
  assert.equal(res.status, 426);
  assert.equal(res.body.error.code, 'client_too_old');
  assert.match(res.body.error.message, /Client version 0\.0\.0 is below the required minimum 0\.7\.0/);
});

test('client at or above the minimum passes the gate', async () => {
  const app = makeApp();
  gateOn(app);
  const { token } = await setupOwner(app);
  for (const v of ['0.7.0', '0.7.1', '1.2.3']) {
    const res = await app.call('GET', '/v2/me', {
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
  const browser = await app.call('GET', '/v2/me', {
    token,
    headers: {
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
    },
  });
  assert.equal(browser.status, 200);
  // curl.
  const curl = await app.call('GET', '/v2/me', {
    token,
    headers: { 'user-agent': 'curl/8.5.0' },
  });
  assert.equal(curl.status, 200);
  // No User-Agent header at all.
  const none = await app.call('GET', '/v2/me', { token });
  assert.equal(none.status, 200);
});

test('gate fires before auth (426, not 401) for old clients', async () => {
  const app = makeApp();
  gateOn(app);
  const res = await app.call('GET', '/v2/me', {
    headers: { 'user-agent': 'family-hub-agent/0.1.0' },
  });
  assert.equal(res.status, 426);
  assert.equal(res.body.error.code, 'client_too_old');
});

test('/v2/client/latest, /v2/health, and /v2/client/download/* are exempt from the gate', async () => {
  const app = makeApp();
  gateOn(app);
  const oldUA = { headers: { 'user-agent': 'family-hub-agent/0.0.1' } };
  const latest = await app.call('GET', '/v2/client/latest', oldUA);
  assert.equal(latest.status, 200);
  const health = await app.call('GET', '/v2/health', {
    headers: { 'user-agent': 'family-hub-agent/1.0' },
  });
  assert.equal(health.status, 200);
  for (const p of [
    '/v2/client/download/hub',
    '/v2/client/download/hub.sigstore',
    '/v2/client/download/manifest.json',
    '/v2/client/download/skill.tar.gz',
  ]) {
    const r = await app.call('GET', p, oldUA);
    assert.equal(r.status, 200, `${p} must stay reachable by outdated clients`);
  }
});

// ---------------------------------------------------------------------------
// B2: GET /v2/client/latest.
// ---------------------------------------------------------------------------

test('/v2/client/latest serves the manifest shape, publicly', async () => {
  const app = makeApp();
  const res = await app.call('GET', '/v2/client/latest');
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body).sort(), [
    'assets',
    'download_url',
    'min_cli_version',
    'released_at',
    'server_version',
    'sha256',
    'skill',
    'version',
  ]);
  assert.equal(res.body.version, manifest.version);
  assert.equal(res.body.min_cli_version, manifest.min_cli_version);
  assert.equal(res.body.server_version, pkg.version);
  assert.equal(res.body.sha256, manifest.sha256);
  assert.equal(res.body.released_at, manifest.released_at);
  // Self-referential: URLs point at THIS server's download endpoints,
  // derived from the request origin.
  assert.equal(res.body.download_url, 'https://hub.test/v2/client/download/hub');
  assert.deepEqual(res.body.assets, {
    hub: 'https://hub.test/v2/client/download/hub',
    sigstore: 'https://hub.test/v2/client/download/hub.sigstore',
    manifest: 'https://hub.test/v2/client/download/manifest.json',
  });
  // The skill block names the bundle URL, its build-verified sha256, and
  // the skill version (from the SKILL VERSION header, independent of CLI).
  assert.deepEqual(res.body.skill, {
    url: 'https://hub.test/v2/client/download/skill.tar.gz',
    sha256: manifest.skill_sha256,
    version: manifest.skill_version,
  });
  assert.match(res.body.version, /^\d+\.\d+\.\d+$/);
  assert.match(res.body.min_cli_version, /^\d+\.\d+\.\d+$/);
});

// ---------------------------------------------------------------------------
// B3: key lineage in the audit log.
// ---------------------------------------------------------------------------

test('key registration via redeem logs key_fp → agent_label → member_id → circle_id', async () => {
  const app = makeApp();
  const fam = await app.call('POST', '/v2/families', {
    body: { name: `reg-${Date.now()}`, owner_name: 'Ow', owner_email: 'o@reg.dev' },
  });
  assert.equal(fam.status, 201);
  const pubkey = b64(32);
  const cap = captureLogs();
  let red;
  try {
    red = await app.call(
      'POST',
      `/v2/provisioning-codes/${encodeURIComponent(fam.body.provisioning_code)}/redeem`,
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

test('rotation of an enrolled identity logs key_fp', async () => {
  const app = makeApp();
  const { token, memberId, famId } = await setupOwner(app);
  const pubkey = b64(32);
  const cap = captureLogs();
  let res;
  try {
    res = await app.call('POST', '/v2/agent-keys/rotate', {
      token,
      body: { agent_public_key: pubkey },
    });
  } finally {
    cap.restore();
  }
  assert.equal(res.status, 200);
  const line = findLine(parsed(cap.lines), 'agent_key_rotated');
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
  const r1 = await app.call('POST', '/v2/agent-keys/rotate', {
    token,
    body: { agent_public_key: first },
  });
  assert.equal(r1.status, 200);
  const cap = captureLogs();
  let r2;
  try {
    r2 = await app.call('POST', '/v2/agent-keys/rotate', {
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
  const reg = await app.call('POST', '/v2/agent-keys/rotate', {
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
    res = await app.call('POST', '/v2/auth/revoke', {
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
