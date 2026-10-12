// §3.4–§3.6 — server-hosted CLI downloads, versioning contract, and the
// fail-closed build bundler.
//
// Covers: health api_versions; download endpoints (content types, exact
// bytes vs the bundled artifacts, headers, fixed-path 404s, rate limit);
// bundle-client.mjs fail-closed modes (placeholder hash, 404, sha mismatch)
// plus the success path against a stub release server; openapi parity
// (mirrors the CI api-parity job).
//
// No @types/node in this repo (see shims.d.ts): base64 via atob (DOM lib),
// sha256 via WebCrypto, bytes via Uint8Array.
import { test } from 'node:test';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeApp } from './app.js';
import { CLIENT_DIST } from '../src/client-dist.generated.js';
import pkg from '../package.json' with { type: 'json' };
import manifest from '../client-manifest.json' with { type: 'json' };

const HERE = dirname(fileURLToPath(import.meta.url));
// Tests run compiled from dist/test/; the script lives in server/scripts/.
const SCRIPT = join(HERE, '..', '..', 'scripts', 'bundle-client.mjs');
const REPO_ROOT = join(HERE, '..', '..', '..');

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Health: the version contract.
// ---------------------------------------------------------------------------

test('health advertises api_versions ["v1"] with the server version', async () => {
  const app = makeApp();
  const res = await app.call('GET', '/v1/health');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.api_versions, ['v1']);
  assert.equal(res.body.version, pkg.version);
});

// ---------------------------------------------------------------------------
// Download endpoints.
// ---------------------------------------------------------------------------

test('GET /v1/client/download/hub serves the exact pinned artifact bytes', async () => {
  const app = makeApp();
  const res = await app.call('GET', '/v1/client/download/hub', { rawBytes: true });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/octet-stream');
  assert.equal(res.headers['content-disposition'], 'attachment; filename="hub"');
  assert.equal(res.headers['cache-control'], 'public, max-age=300');
  const bytes = res.bytes!;
  assert.equal(res.headers['content-length'], String(bytes.length));
  // Bytes equal the build-bundled artifacts, whose sha256 was verified at
  // build time against the pin and the release manifest.
  assert.ok(bytesEqual(bytes, b64ToBytes(CLIENT_DIST.hubB64)), 'served bytes == bundled bytes');
  assert.equal(await sha256hex(bytes), manifest.sha256);
  assert.equal(await sha256hex(bytes), CLIENT_DIST.sha256);
  // Security headers ride along (nosniff kills content-type sniffing).
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
});

test('GET /v1/client/download/hub.sigstore serves JSON as an attachment', async () => {
  const app = makeApp();
  const res = await app.call('GET', '/v1/client/download/hub.sigstore');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/json');
  assert.equal(res.headers['content-disposition'], 'attachment; filename="hub.sigstore"');
  assert.equal(res.headers['cache-control'], 'public, max-age=300');
  const bundled = JSON.parse(new TextDecoder().decode(b64ToBytes(CLIENT_DIST.sigstoreB64)));
  assert.deepEqual(res.body, bundled);
});

test('GET /v1/client/download/manifest.json serves the release manifest', async () => {
  const app = makeApp();
  const res = await app.call('GET', '/v1/client/download/manifest.json');
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/json');
  assert.equal(res.headers['content-disposition'], 'attachment; filename="manifest.json"');
  assert.equal(res.headers['cache-control'], 'public, max-age=300');
  const bundled = JSON.parse(new TextDecoder().decode(b64ToBytes(CLIENT_DIST.manifestB64)));
  assert.deepEqual(res.body, bundled);
  assert.equal(res.body.version, manifest.version);
  assert.equal(res.body.sha256, manifest.sha256);
});

test('anything else under /v1/client/download/ 404s (fixed asset map)', async () => {
  const app = makeApp();
  for (const p of [
    '/v1/client/download/',
    '/v1/client/download/other',
    '/v1/client/download/hub/', // trailing slash
    '/v1/client/download/HUB', // case-sensitive
    '/v1/client/download/hub.sigstore.bak',
    '/v1/client/download/hub%00',
  ]) {
    const res = await app.call('GET', p);
    assert.equal(res.status, 404, `${p} must 404`);
    assert.equal(res.body.error.code, 'not_found');
  }
  // Encoded `..` is normalized by the URL parser BEFORE dispatch
  // (/v1/client/download/%2e%2e/health -> /v1/client/health) — it can only
  // resolve to another literal path string, and dispatch is exact-match, so
  // it lands on the unknown-path fallthrough (401 without a token), never
  // on an unregistered file. No traversal surface by construction.
  const trav = await app.call('GET', '/v1/client/download/%2e%2e/health');
  assert.equal(trav.status, 401);
});

test('downloads are rate-limited with the standard 429 envelope + Retry-After', async () => {
  const app = makeApp();
  // Generous bucket: 100 per 10 min per IP (endpoint-specific key, so this
  // test is isolated from the other download tests).
  for (let i = 0; i < 100; i++) {
    const r = await app.call('GET', '/v1/client/download/manifest.json');
    assert.equal(r.status, 200, `request ${i + 1} should pass`);
  }
  const limited = await app.call('GET', '/v1/client/download/manifest.json');
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, 'rate_limited');
  assert.ok(Number(limited.headers['retry-after']) > 0, 'Retry-After must be set');
});

// ---------------------------------------------------------------------------
// OpenAPI parity (mirrors the CI api-parity job).
// ---------------------------------------------------------------------------

test('openapi parity: router patterns match docs/openapi.yaml', async () => {
  const r = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      'python3',
      [join(REPO_ROOT, 'scripts', 'check_openapi_parity.py')],
      { timeout: 60_000 },
      (err, stdout, stderr) => {
        resolve({ code: err ? 1 : 0, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
  assert.equal(r.code, 0, `parity check failed:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /openapi parity OK/);
});

// ---------------------------------------------------------------------------
// bundle-client.mjs: fail-closed.
// ---------------------------------------------------------------------------

function runBundler(env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const fullEnv: Record<string, string | undefined> = { ...process.env };
    for (const k of Object.keys(env)) fullEnv[k] = env[k];
    execFile(process.execPath, [SCRIPT], { env: fullEnv, timeout: 60_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? 1 : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** Stub "release server": serves per-filename bytes; status override per name. */
async function stubServer(
  files: Record<string, { status?: number; body: string | Uint8Array }>,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const name = (req.url ?? '').split('/').pop() ?? '';
    const f = files[name];
    if (!f || f.status === 404) {
      res.writeHead(404);
      res.end('nope');
      return;
    }
    res.writeHead(200);
    res.end(f.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

function bundlerEnv(dir: string, pin: unknown, baseUrl: string): Record<string, string> {
  const manifestPath = join(dir, 'client-manifest.json');
  writeFileSync(manifestPath, JSON.stringify(pin));
  return {
    BUNDLE_CLIENT_MANIFEST_PATH: manifestPath,
    BUNDLE_CLIENT_OUT_PATH: join(dir, 'client-dist.generated.ts'),
    BUNDLE_CLIENT_BASE_URL: baseUrl,
  };
}

test('bundler fails closed on a placeholder pin hash', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-ph-'));
  const stub = await stubServer({});
  try {
    const r = await runBundler(
      bundlerEnv(dir, { version: '9.9.9', sha256: 'PENDING-release-workflow-fills-this-in' }, stub.url),
    );
    assert.notEqual(r.code, 0, 'must fail');
    assert.match(r.stderr, /PENDING|placeholder/i);
  } finally {
    await stub.close();
  }
});

test('bundler fails closed on HTTP 404 from the release server', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-404-'));
  const stub = await stubServer({
    hub: { status: 404, body: '' },
    'hub.sigstore': { status: 404, body: '' },
    'manifest.json': { status: 404, body: '' },
  });
  try {
    const r = await runBundler(bundlerEnv(dir, { version: '9.9.9', sha256: 'b'.repeat(64) }, stub.url));
    assert.notEqual(r.code, 0, 'must fail');
    assert.match(r.stderr, /404|non-2xx|HTTP/i);
  } finally {
    await stub.close();
  }
});

test('bundler fails closed on sha256 mismatch (tampered bytes)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-mm-'));
  const hubBytes = new TextEncoder().encode('#!/usr/bin/env python3\n# tampered\n');
  const releaseManifest = JSON.stringify({
    version: '9.9.9',
    sha256: 'c'.repeat(64),
    files: { hub: 'c'.repeat(64) },
  });
  const stub = await stubServer({
    hub: { body: hubBytes },
    'hub.sigstore': { body: JSON.stringify({ bundle: true }) },
    'manifest.json': { body: releaseManifest },
  });
  try {
    const r = await runBundler(bundlerEnv(dir, { version: '9.9.9', sha256: 'd'.repeat(64) }, stub.url));
    assert.notEqual(r.code, 0, 'must fail');
    assert.match(r.stderr, /mismatch/i);
  } finally {
    await stub.close();
  }
});

test('bundler fails closed when the release manifest disagrees with the pin', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-rm-'));
  const hubBytes = new TextEncoder().encode('#!/usr/bin/env python3\nprint("hub")\n');
  const hubSha = createHash('sha256').update(hubBytes).digest('hex');
  // Release manifest carries a DIFFERENT sha for the same bytes: the tag
  // was republished. The bundler must refuse.
  const releaseManifest = JSON.stringify({ version: '9.9.9', sha256: 'e'.repeat(64), files: { hub: 'e'.repeat(64) } });
  const stub = await stubServer({
    hub: { body: hubBytes },
    'hub.sigstore': { body: JSON.stringify({ bundle: true }) },
    'manifest.json': { body: releaseManifest },
  });
  try {
    const r = await runBundler(bundlerEnv(dir, { version: '9.9.9', sha256: hubSha }, stub.url));
    assert.notEqual(r.code, 0, 'must fail');
    assert.match(r.stderr, /republished|release manifest/i);
  } finally {
    await stub.close();
  }
});

test('bundler succeeds against a stub release and embeds verified bytes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-ok-'));
  const hubBytes = new TextEncoder().encode('#!/usr/bin/env python3\nprint("hub 9.9.9")\n');
  const hubSha = createHash('sha256').update(hubBytes).digest('hex');
  const releaseManifest = JSON.stringify({ version: '9.9.9', sha256: hubSha, files: { hub: hubSha } });
  const sigstore = JSON.stringify({ mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json' });
  const stub = await stubServer({
    hub: { body: hubBytes },
    'hub.sigstore': { body: sigstore },
    'manifest.json': { body: releaseManifest },
  });
  try {
    const outPath = join(dir, 'client-dist.generated.ts');
    const r = await runBundler(bundlerEnv(dir, { version: '9.9.9', sha256: hubSha }, stub.url));
    assert.equal(r.code, 0, `must succeed, stderr: ${r.stderr}`);
    const src = readFileSync(outPath, 'utf-8');
    assert.ok(src.includes('"9.9.9"'), 'embeds the version');
    assert.ok(src.includes(hubSha), 'embeds the sha256');
    // The embedded bytes are exactly what was verified.
    const m = /hubB64: "([^"]+)"/.exec(src);
    if (!m || !m[1]) throw new Error('hubB64 missing from generated module');
    assert.ok(bytesEqual(b64ToBytes(m[1]), hubBytes), 'embedded bytes == verified bytes');
    // Cross-check with random bytes (no fixture reuse).
    const rnd = randomBytes(1024);
    assert.equal(createHash('sha256').update(rnd).digest('hex').length, 64);
  } finally {
    await stub.close();
  }
});
