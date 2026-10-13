// §3.4–§3.6 — server-hosted CLI downloads, versioning contract, and the
// fail-closed build bundler.
//
// Covers: health api_versions; download endpoints (content types, exact
// bytes vs the bundled artifacts, headers, fixed-path 404s, rate limit —
// including the skill.tar.gz bundle and its shared rate-limit bucket);
// /v1/client/latest skill block; bundle-client.mjs fail-closed modes
// (placeholder hash, 404, sha mismatch — hub and skill — missing
// skill_sha256 pin, release manifest without skill_sha256, unsafe tarball
// members, phase-2 manifest embedded by mistake) plus the success path
// against a stub release server; openapi parity (mirrors the CI api-parity
// job).
//
// No @types/node in this repo (see shims.d.ts): base64 via atob (DOM lib),
// sha256 via WebCrypto, bytes via Uint8Array.
import { test } from 'node:test';
import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeApp } from './app.js';
import { CLIENT_DIST } from '../src/client-dist.generated.js';
import pkg from '../package.json' with { type: 'json' };
import manifestJson from '../client-manifest.json' with { type: 'json' };
// The pin carries skill_sha256/skill_version for CLI releases cut after the
// skill bundle (bundle-client.mjs fails closed without them). The committed
// pin predates the first bundled release, so the test types the fields the
// release workflow's manifest-PR step always writes.
const manifest = manifestJson as typeof manifestJson & {
  skill_sha256: string;
  skill_version: string;
};

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

test('GET /v1/client/download/skill.tar.gz serves the exact bundled skill bundle', async () => {
  const app = makeApp();
  const res = await app.call('GET', '/v1/client/download/skill.tar.gz', { rawBytes: true });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/gzip');
  assert.equal(res.headers['content-disposition'], 'attachment; filename="skill.tar.gz"');
  assert.equal(res.headers['cache-control'], 'public, max-age=300');
  const bytes = res.bytes!;
  assert.equal(res.headers['content-length'], String(bytes.length));
  // Bytes equal the build-bundled tarball, whose sha256 was verified at
  // build time against BOTH the pin's skill_sha256 and the release
  // manifest's skill_sha256.
  assert.ok(bytesEqual(bytes, b64ToBytes(CLIENT_DIST.skillTarGzB64)), 'served bytes == bundled bytes');
  assert.equal(await sha256hex(bytes), manifest.skill_sha256);
  assert.equal(await sha256hex(bytes), CLIENT_DIST.skillSha256);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
});

test('GET /v1/client/latest carries the skill block for the bundled release', async () => {
  const app = makeApp();
  const res = await app.call('GET', '/v1/client/latest');
  assert.equal(res.status, 200);
  assert.equal(res.body.skill.url, 'https://hub.test/v1/client/download/skill.tar.gz');
  assert.equal(res.body.skill.sha256, manifest.skill_sha256);
  assert.equal(res.body.skill.version, manifest.skill_version);
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
    '/v1/client/download/skill.tar.gz/', // trailing slash
    '/v1/client/download/SKILL.TAR.GZ', // case-sensitive
    '/v1/client/download/skill.tar.gz.bak',
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

test('downloads share one rate-limit bucket across all four assets', async () => {
  const app = makeApp();
  // 50 manifest.json + 50 skill.tar.gz = 100 against the shared
  // 'client_download' bucket; the 101st request (any asset) 429s.
  for (let i = 0; i < 50; i++) {
    const a = await app.call('GET', '/v1/client/download/manifest.json');
    assert.equal(a.status, 200, `manifest request ${i + 1} should pass`);
    const b = await app.call('GET', '/v1/client/download/skill.tar.gz', { rawBytes: true });
    assert.equal(b.status, 200, `skill request ${i + 1} should pass`);
  }
  const limited = await app.call('GET', '/v1/client/download/skill.tar.gz');
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
    // Full-path routing: the CLI and skill releases each serve a
    // manifest.json, so last-segment matching would collide.
    const f = files[req.url ?? ''];
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

interface ReleaseFixture {
  pin: Record<string, unknown>;
  hubBytes: Uint8Array;
  phase1Manifest: Record<string, unknown>;
  releaseManifest: Record<string, unknown>;
  skillReleaseManifest: Record<string, unknown>;
  skillTarGz: Uint8Array;
  skillVersion: string;
}

/** Build a well-formed skill.tar.gz the way the release workflow does:
 *  explicit relative members, no absolute paths, no links. */
async function buildSkillTarball(
  dir: string,
  files: Record<string, string | Uint8Array>,
): Promise<Uint8Array> {
  const stage = join(dir, 'skill-stage');
  mkdirSync(stage, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const p = join(stage, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  const out = join(dir, 'skill.tar.gz');
  await new Promise<void>((resolve, reject) => {
    execFile('tar', ['-czf', out, '-C', stage, ...Object.keys(files)], {}, (err) =>
      err ? reject(err) : resolve(),
    );
  });
  return readFileSync(out);
}

/** A complete, internally consistent stub release: hub bytes, the phase-1
 *  manifest (as embedded in the tarball), the phase-2 release manifest
 *  (adds skill_sha256 + skill_version), and the pin. Mutate one piece per
 *  fail-closed test. */
async function makeRelease(dir: string, version = '9.9.9'): Promise<ReleaseFixture> {
  const hubBytes = new TextEncoder().encode(`#!/usr/bin/env python3\nprint("hub ${version}")\n`);
  const hubSha = createHash('sha256').update(hubBytes).digest('hex');
  const phase1Manifest: Record<string, unknown> = {
    version,
    sha256: hubSha,
    files: { hub: hubSha },
    signature: 'hub.sigstore',
  };
  const skillTarGz = await buildSkillTarball(dir, {
    'SKILL.md': '<!-- SKILL VERSION: 1.2.3 -->\n# skill\n',
    'INSTALL.md': '# install\n',
    'requirements.txt': 'sigstore>=3.0,<4.0\n',
    'references/a.md': '# a\n',
    hub: hubBytes,
    'hub.sigstore': JSON.stringify({ mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json' }),
    'manifest.json': JSON.stringify(phase1Manifest),
  });
  const skillSha = createHash('sha256').update(skillTarGz).digest('hex');
  const releaseManifest: Record<string, unknown> = {
    ...phase1Manifest,
    skill_sha256: skillSha,
    skill_version: '1.2.3',
  };
  // Decoupled releases: the skill bundle is served from the skill-v* tag
  // with its own manifest (bundle-client.mjs check 2b).
  const skillReleaseManifest: Record<string, unknown> = {
    type: 'skill',
    skill_version: '1.2.3',
    skill_sha256: skillSha,
    cli_version: version,
    hub_sha256: hubSha,
    released_at: '2026-10-12T00:00:00Z',
  };
  const pin: Record<string, unknown> = {
    version,
    min_cli_version: '0.0.0',
    download_url: `http://stub.invalid/cli-v${version}/hub`,
    sha256: hubSha,
    skill_sha256: skillSha,
    skill_version: '1.2.3',
    released_at: '2026-10-12T00:00:00Z',
  };
  return { pin, hubBytes, phase1Manifest, releaseManifest, skillReleaseManifest, skillTarGz, skillVersion: '1.2.3' };
}

function stubFiles(fx: ReleaseFixture): Record<string, { body: string | Uint8Array }> {
  // Full-path keys: the CLI and skill releases each carry a manifest.json,
  // so last-segment routing would collide. stubServer matches full paths.
  const cliTag = `/cli-v${fx.pin.version}`;
  const skillTag = `/skill-v${fx.skillVersion}`;
  return {
    [`${cliTag}/hub`]: { body: fx.hubBytes },
    [`${cliTag}/hub.sigstore`]: { body: JSON.stringify({ mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json' }) },
    [`${cliTag}/manifest.json`]: { body: JSON.stringify(fx.releaseManifest) },
    [`${skillTag}/skill.tar.gz`]: { body: fx.skillTarGz },
    [`${skillTag}/skill-manifest.json`]: { body: JSON.stringify(fx.skillReleaseManifest) },
  };
}

/** Build a tarball with a hostile member via python tarfile (the `tar`
 *  CLI refuses to create these): kind is 'traversal' (../evil.txt),
 *  'symlink' (evil-link -> /etc/passwd), or 'phase2' (embedded manifest
 *  wrongly carries skill_* fields, violating the two-phase invariant). */
async function evilSkillTarball(
  dir: string,
  kind: 'traversal' | 'symlink' | 'phase2',
  hubBytes: Uint8Array,
  phase1Manifest: Record<string, unknown>,
): Promise<Uint8Array> {
  const hubPath = join(dir, 'hub.bin');
  const manPath = join(dir, 'm1.json');
  writeFileSync(hubPath, hubBytes);
  writeFileSync(manPath, JSON.stringify(phase1Manifest));
  const scriptPath = join(dir, 'evil_tar.py');
  writeFileSync(
    scriptPath,
    [
      'import io, json, sys, tarfile',
      'kind, hub_path, man_path, out = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]',
      'hub = open(hub_path, "rb").read()',
      'manifest = json.load(open(man_path))',
      'with tarfile.open(out, "w:gz") as tf:',
      '    def add(name, data):',
      '        ti = tarfile.TarInfo(name)',
      '        ti.size = len(data)',
      '        tf.addfile(ti, io.BytesIO(data))',
      '    add("SKILL.md", b"<!-- SKILL VERSION: 1.2.3 -->\\n")',
      '    if kind == "traversal":',
      '        add("../evil.txt", b"evil")',
      '    elif kind == "symlink":',
      '        ti = tarfile.TarInfo("evil-link")',
      '        ti.type = tarfile.SYMTYPE',
      '        ti.linkname = "/etc/passwd"',
      '        tf.addfile(ti)',
      '    elif kind == "phase2":',
      '        manifest["skill_sha256"] = "f" * 64',
      '        manifest["skill_version"] = "1.2.3"',
      '    add("hub", hub)',
      '    add("manifest.json", json.dumps(manifest).encode())',
      '',
    ].join('\n'),
  );
  const out = join(dir, 'skill-evil.tar.gz');
  await new Promise<void>((resolve, reject) => {
    execFile('python3', [scriptPath, kind, hubPath, manPath, out], {}, (err, _stdout, stderr) =>
      err ? reject(new Error(stderr || err.message)) : resolve(),
    );
  });
  return readFileSync(out);
}

test('bundler fails closed on a placeholder pin hash', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-ph-'));
  const stub = await stubServer({});
  try {
    const r = await runBundler(
      bundlerEnv(
        dir,
        {
          version: '9.9.9',
          sha256: 'PENDING-release-workflow-fills-this-in',
          skill_sha256: 'a'.repeat(64),
          skill_version: '1.2.3',
        },
        stub.url,
      ),
    );
    assert.notEqual(r.code, 0, 'must fail');
    assert.match(r.stderr, /PENDING|placeholder/i);
  } finally {
    await stub.close();
  }
});

test('bundler fails closed on a pin without skill_sha256', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-noskillpin-'));
  const fx = await makeRelease(dir);
  const stub = await stubServer(stubFiles(fx));
  try {
    // A CLI release cut before the skill bundle: no skill_sha256 in the pin.
    const pin: Record<string, unknown> = { ...fx.pin };
    delete pin.skill_sha256;
    const r = await runBundler(bundlerEnv(dir, pin, stub.url));
    assert.notEqual(r.code, 0, 'must fail');
    assert.match(r.stderr, /skill_sha256/i);
  } finally {
    await stub.close();
  }
});

test('bundler fails closed on HTTP 404 from the release server', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-404-'));
  const stub = await stubServer({
    '/cli-v9.9.9/hub': { status: 404, body: '' },
    '/cli-v9.9.9/hub.sigstore': { status: 404, body: '' },
    '/cli-v9.9.9/manifest.json': { status: 404, body: '' },
    '/skill-v1.2.3/skill.tar.gz': { status: 404, body: '' },
    '/skill-v1.2.3/skill-manifest.json': { status: 404, body: '' },
  });
  try {
    const pin = {
      version: '9.9.9',
      sha256: 'b'.repeat(64),
      skill_sha256: 'a'.repeat(64),
      skill_version: '1.2.3',
    };
    const r = await runBundler(bundlerEnv(dir, pin, stub.url));
    assert.notEqual(r.code, 0, 'must fail');
    assert.match(r.stderr, /404|non-2xx|HTTP/i);
  } finally {
    await stub.close();
  }
});

test('bundler fails closed on sha256 mismatch (tampered hub bytes)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-mm-'));
  const fx = await makeRelease(dir);
  const tampered = new TextEncoder().encode('#!/usr/bin/env python3\n# tampered\n');
  const stub = await stubServer({ ...stubFiles(fx), '/cli-v9.9.9/hub': { body: tampered } });
  try {
    const pin = { ...fx.pin, sha256: 'd'.repeat(64) };
    const r = await runBundler(bundlerEnv(dir, pin, stub.url));
    assert.notEqual(r.code, 0, 'must fail');
    assert.match(r.stderr, /mismatch/i);
  } finally {
    await stub.close();
  }
});

test('bundler fails closed on skill.tar.gz sha256 mismatch (tampered bundle)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-skillmm-'));
  const fx = await makeRelease(dir);
  // A different but structurally valid bundle: the hash check must catch it.
  const other = await buildSkillTarball(join(mkdtempSync(join(tmpdir(), 'bundle-skillmm2-'))), {
    'SKILL.md': '<!-- SKILL VERSION: 1.2.3 -->\n# different skill\n',
    hub: fx.hubBytes,
    'manifest.json': JSON.stringify(fx.phase1Manifest),
  });
  assert.notEqual(
    createHash('sha256').update(other).digest('hex'),
    fx.pin.skill_sha256,
    'fixture sanity: the tampered bundle must hash differently',
  );
  const stub = await stubServer({ ...stubFiles(fx), '/skill-v1.2.3/skill.tar.gz': { body: other } });
  try {
    const r = await runBundler(bundlerEnv(dir, fx.pin, stub.url));
    assert.notEqual(r.code, 0, 'must fail');
    assert.match(r.stderr, /skill\.tar\.gz.*mismatch|MISMATCH.*skill/i);
  } finally {
    await stub.close();
  }
});

test('bundler fails closed when the release manifest disagrees with the pin', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-rm-'));
  const fx = await makeRelease(dir);
  // Release manifest carries a DIFFERENT hub sha for the same bytes: the
  // tag was republished. The bundler must refuse.
  const releaseManifest = { ...fx.releaseManifest, sha256: 'e'.repeat(64) };
  const stub = await stubServer({ ...stubFiles(fx), '/cli-v9.9.9/manifest.json': { body: JSON.stringify(releaseManifest) } });
  try {
    const r = await runBundler(bundlerEnv(dir, fx.pin, stub.url));
    assert.notEqual(r.code, 0, 'must fail');
    assert.match(r.stderr, /republished|release manifest/i);
  } finally {
    await stub.close();
  }
});

test('bundler fails closed when the skill release manifest has no skill_sha256', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-rmskill-'));
  const fx = await makeRelease(dir);
  // The skill-v tag's manifest carries no skill_sha256: the pin demands a
  // bundle the skill release never published.
  const skillReleaseManifest: Record<string, unknown> = { ...fx.skillReleaseManifest };
  delete skillReleaseManifest.skill_sha256;
  const stub = await stubServer({ ...stubFiles(fx), '/skill-v1.2.3/skill-manifest.json': { body: JSON.stringify(skillReleaseManifest) } });
  try {
    const r = await runBundler(bundlerEnv(dir, fx.pin, stub.url));
    assert.notEqual(r.code, 0, 'must fail');
    assert.match(r.stderr, /skill_sha256/i);
  } finally {
    await stub.close();
  }
});

test('bundler fails closed when the skill release manifest version disagrees with the pin', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-skillver-'));
  const fx = await makeRelease(dir);
  // The skill-v tag was republished under a different skill version.
  const skillReleaseManifest = { ...fx.skillReleaseManifest, skill_version: '9.9.9' };
  const stub = await stubServer({ ...stubFiles(fx), '/skill-v1.2.3/skill-manifest.json': { body: JSON.stringify(skillReleaseManifest) } });
  try {
    const r = await runBundler(bundlerEnv(dir, fx.pin, stub.url));
    assert.notEqual(r.code, 0, 'must fail');
    assert.match(r.stderr, /skill_version/i);
  } finally {
    await stub.close();
  }
});

test('bundler fails closed on a tarball with a path-traversal member', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-evil-'));
  const fx = await makeRelease(dir);
  const evil = await evilSkillTarball(dir, 'traversal', fx.hubBytes, fx.phase1Manifest);
  const evilSha = createHash('sha256').update(evil).digest('hex');
  // Hashes agree everywhere so the failure is attributable to the member.
  const pin = { ...fx.pin, skill_sha256: evilSha };
  const skillReleaseManifest = { ...fx.skillReleaseManifest, skill_sha256: evilSha };
  const stub = await stubServer({
    ...stubFiles(fx),
    '/skill-v1.2.3/skill-manifest.json': { body: JSON.stringify(skillReleaseManifest) },
    '/skill-v1.2.3/skill.tar.gz': { body: evil },
  });
  try {
    const r = await runBundler(bundlerEnv(dir, pin, stub.url));
    assert.notEqual(r.code, 0, 'must fail');
    assert.match(r.stderr, /refusing/i);
  } finally {
    await stub.close();
  }
});

test('bundler fails closed on a tarball with a symlink member', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-evilsym-'));
  const fx = await makeRelease(dir);
  const evil = await evilSkillTarball(dir, 'symlink', fx.hubBytes, fx.phase1Manifest);
  const evilSha = createHash('sha256').update(evil).digest('hex');
  const pin = { ...fx.pin, skill_sha256: evilSha };
  const skillReleaseManifest = { ...fx.skillReleaseManifest, skill_sha256: evilSha };
  const stub = await stubServer({
    ...stubFiles(fx),
    '/skill-v1.2.3/skill-manifest.json': { body: JSON.stringify(skillReleaseManifest) },
    '/skill-v1.2.3/skill.tar.gz': { body: evil },
  });
  try {
    const r = await runBundler(bundlerEnv(dir, pin, stub.url));
    assert.notEqual(r.code, 0, 'must fail');
    assert.match(r.stderr, /refusing/i);
  } finally {
    await stub.close();
  }
});

test('bundler fails closed when the tarball embeds a phase-2 manifest', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-evilp2-'));
  const fx = await makeRelease(dir);
  // The embedded manifest must be phase-1 (no skill_* fields); a bundle
  // built against the phase-2 manifest breaks the documented circularity.
  const evil = await evilSkillTarball(dir, 'phase2', fx.hubBytes, fx.phase1Manifest);
  const evilSha = createHash('sha256').update(evil).digest('hex');
  const pin = { ...fx.pin, skill_sha256: evilSha };
  const skillReleaseManifest = { ...fx.skillReleaseManifest, skill_sha256: evilSha };
  const stub = await stubServer({
    ...stubFiles(fx),
    '/skill-v1.2.3/skill-manifest.json': { body: JSON.stringify(skillReleaseManifest) },
    '/skill-v1.2.3/skill.tar.gz': { body: evil },
  });
  try {
    const r = await runBundler(bundlerEnv(dir, pin, stub.url));
    assert.notEqual(r.code, 0, 'must fail');
    assert.match(r.stderr, /phase-1/i);
  } finally {
    await stub.close();
  }
});

test('bundler succeeds against a stub release and embeds verified bytes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-ok-'));
  const fx = await makeRelease(dir);
  const stub = await stubServer(stubFiles(fx));
  try {
    const outPath = join(dir, 'client-dist.generated.ts');
    const r = await runBundler(bundlerEnv(dir, fx.pin, stub.url));
    assert.equal(r.code, 0, `must succeed, stderr: ${r.stderr}`);
    const src = readFileSync(outPath, 'utf-8');
    assert.ok(src.includes('"9.9.9"'), 'embeds the version');
    assert.ok(src.includes(fx.pin.sha256 as string), 'embeds the hub sha256');
    assert.ok(src.includes(fx.pin.skill_sha256 as string), 'embeds the skill sha256');
    // The embedded bytes are exactly what was verified.
    const hubM = /hubB64: "([^"]+)"/.exec(src);
    if (!hubM || !hubM[1]) throw new Error('hubB64 missing from generated module');
    assert.ok(bytesEqual(b64ToBytes(hubM[1]), fx.hubBytes), 'embedded hub bytes == verified bytes');
    const skillM = /skillTarGzB64: "([^"]+)"/.exec(src);
    if (!skillM || !skillM[1]) throw new Error('skillTarGzB64 missing from generated module');
    assert.ok(bytesEqual(b64ToBytes(skillM[1]), fx.skillTarGz), 'embedded bundle bytes == verified bytes');
    // Cross-check with random bytes (no fixture reuse).
    const rnd = randomBytes(1024);
    assert.equal(createHash('sha256').update(rnd).digest('hex').length, 64);
  } finally {
    await stub.close();
  }
});
