// Version reporting + structured logging: /v1/health reports the
// server/package.json version (single source of truth), every log line
// carries it, and single-use codes never appear in log output.
import { test } from 'node:test';
import assert from 'node:assert';
import pkg from '../package.json' with { type: 'json' };
import { logEvent, redactPath } from '../src/index.js';
import { makeApp } from './app.js';

const SERVER_VERSION: string = pkg.version;

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

test('health reports the package.json version', async () => {
  const app = makeApp();
  const res = await app.call('GET', '/v1/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.version, SERVER_VERSION);
  assert.match(SERVER_VERSION, /^\d+\.\d+\.\d+$/);
});

test('redactPath hides invite and provisioning codes', () => {
  assert.equal(redactPath('/v1/invites/abc123/accept'), '/v1/invites/[redacted]/accept');
  assert.equal(
    redactPath('/v1/provisioning-codes/xyz789/redeem'),
    '/v1/provisioning-codes/[redacted]/redeem',
  );
  assert.equal(redactPath('/v1/topics'), '/v1/topics');
  assert.equal(redactPath('/v1/health'), '/v1/health');
});

test('logEvent emits version, ts, level, event on every line', () => {
  const cap = captureLogs();
  try {
    logEvent('info', 'request', { method: 'GET', path: '/v1/health', status: 200 });
    logEvent('error', 'request_error', { status: 500 });
  } finally {
    cap.restore();
  }
  assert.equal(cap.lines.length, 2);
  for (const line of parsed(cap.lines)) {
    assert.equal(line['v'], SERVER_VERSION);
    assert.ok(typeof line['ts'] === 'string' && line['ts'].length > 0);
    assert.ok(line['level'] === 'info' || line['level'] === 'error');
    assert.ok(typeof line['event'] === 'string');
  }
});

test('rejected token logs auth_rejected without leaking the token', async () => {
  const app = makeApp();
  const cap = captureLogs();
  let res;
  try {
    res = await app.call('GET', '/v1/topics', { token: 'bad-token-xyz' });
  } finally {
    cap.restore();
  }
  assert.equal(res.status, 401);
  const lines = parsed(cap.lines);
  assert.ok(
    lines.some((l) => l['event'] === 'auth_rejected' && l['status'] === 401),
    'expected an auth_rejected line',
  );
  assert.ok(
    lines.every((l) => !JSON.stringify(l).includes('bad-token-xyz')),
    'token must not appear in logs',
  );
  // Exactly one access line per request.
  assert.equal(lines.filter((l) => l['event'] === 'request').length, 1);
});

test('code-bearing paths are redacted in logs', async () => {
  const app = makeApp();
  const cap = captureLogs();
  try {
    await app.call('POST', '/v1/invites/SECRETCODE123/accept', { body: {} });
  } finally {
    cap.restore();
  }
  const lines = parsed(cap.lines);
  assert.ok(lines.length > 0);
  assert.ok(
    lines.every((l) => !JSON.stringify(l).includes('SECRETCODE123')),
    'invite code must not appear in logs',
  );
  assert.ok(
    lines.some((l) => typeof l['path'] === 'string' && (l['path'] as string).includes('[redacted]')),
    'expected a redacted path in logs',
  );
});

test('successful request logs one access line with version', async () => {
  const app = makeApp();
  const cap = captureLogs();
  try {
    await app.call('GET', '/v1/health');
  } finally {
    cap.restore();
  }
  const access = parsed(cap.lines).filter((l) => l['event'] === 'request');
  assert.equal(access.length, 1);
  assert.equal(access[0]['v'], SERVER_VERSION);
  assert.equal(access[0]['method'], 'GET');
  assert.equal(access[0]['path'], '/v1/health');
  assert.equal(access[0]['status'], 200);
  assert.ok(typeof access[0]['ms'] === 'number');
});
