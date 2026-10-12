#!/usr/bin/env node
/**
 * bundle-client.mjs — fail-closed CLI artifact bundling.
 *
 * Reads server/client-manifest.json, downloads the three release artifacts
 * (hub, hub.sigstore, manifest.json) for the pinned CLI version from the
 * GitHub Release, verifies sha256(hub) against BOTH the pin AND the
 * release's own manifest.json, then writes
 * server/src/client-dist.generated.ts (gitignored) exporting the three
 * artifacts as base64 string constants. index.ts serves them from the
 * generated module — no placeholders, no runtime fetch.
 *
 * FAILS CLOSED (non-zero exit, clear message) on: network error, HTTP 404
 * (or any non-200), placeholder hashes such as PENDING-*, sha256 mismatch
 * (pin or release manifest), oversized artifacts, or malformed manifests.
 * Never embed placeholders: a failed bundle must stop the build.
 *
 * Downloads use the `curl` binary (not node:fetch): fetch() stalls on large
 * release-asset bodies behind some proxies; curl is preinstalled on the CI
 * runners and every dev machine. Missing curl = fail closed.
 *
 * Test-only override: BUNDLE_CLIENT_BASE_URL replaces the GitHub Release
 * base URL (e.g. a local stub server in tests). Never set this in CI or
 * deploy — it is equivalent to changing the manifest pin, so it buys an
 * attacker nothing they don't already have, but it must stay a test-only
 * knob.
 */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = dirname(HERE);

const DEFAULT_MANIFEST_PATH = join(SERVER_DIR, 'client-manifest.json');
const DEFAULT_OUT_PATH = join(SERVER_DIR, 'src', 'client-dist.generated.ts');
const DEFAULT_ASSET_BASE = 'https://github.com/maddy13182/museFamilyconnector/releases/download';

const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024; // 20 MiB — hub is ~0.25 MiB; anything bigger is wrong.
const CURL_MAX_TIME_S = 300;

function fail(msg) {
  console.error(`bundle-client: FATAL: ${msg}`);
  process.exit(1);
}

function readManifest(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (e) {
    fail(`cannot read manifest ${path}: ${e.message}`);
  }
  let m;
  try {
    m = JSON.parse(raw);
  } catch (e) {
    fail(`manifest ${path} is not valid JSON: ${e.message}`);
  }
  return m;
}

function checkPin(m) {
  const errs = [];
  if (!/^\d+\.\d+\.\d+$/.test(m.version ?? '')) {
    errs.push(`pin version ${JSON.stringify(m.version)} is not x.y.z`);
  }
  if (!/^[0-9a-f]{64}$/i.test(m.sha256 ?? '')) {
    errs.push(
      `pin sha256 ${JSON.stringify(m.sha256)} is not a 64-hex digest ` +
        `(placeholder hashes like PENDING-* are refused — the release workflow fills this in)`,
    );
  }
  if (errs.length) fail(`client-manifest.json pin is unusable: ${errs.join('; ')}`);
  return { version: m.version, sha256: m.sha256.toLowerCase() };
}

const MAX_REDIRECTS = 50; // curl -L follows GitHub's 302 to the signed asset URL

/** Short label for messages: host + pathname only, so signed query params
 *  in redirect URLs never land in build logs. */
function urlLabel(url) {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url.slice(0, 80);
  }
}

async function fetchBytes(url, tmpDir) {
  // curl, not node:fetch — fetch() stalls on large release-asset bodies
  // behind some proxies; curl is reliable in CI (ubuntu-latest) and here.
  const outFile = join(tmpDir, `artifact-${createHash('sha256').update(url).digest('hex').slice(0, 16)}`);
  const args = [
    '-sS', // silent but show errors
    '-L', // follow redirects (GitHub 302 → signed release-assets URL)
    '--max-redirs', '50',
    '--max-time', String(CURL_MAX_TIME_S),
    '--fail', // non-2xx (e.g. 404) → non-zero exit, no body written
    '-o', outFile,
    url,
  ];
  const res = await new Promise((resolve) => {
    execFile('curl', args, { timeout: (CURL_MAX_TIME_S + 30) * 1000 }, (err, stdout, stderr) =>
      resolve({ err, stdout, stderr }),
    );
  });
  if (res.err) {
    const detail = (res.stderr || res.err.message || '').trim().split('\n').slice(0, 3).join(' ');
    fail(
      `downloading ${urlLabel(url)}: ${detail || res.err.message} ` +
        `(refusing to embed a placeholder)`,
    );
  }
  const buf = readFileSync(outFile);
  if (buf.length === 0) fail(`downloading ${urlLabel(url)}: empty body`);
  if (buf.length > MAX_ARTIFACT_BYTES) {
    fail(
      `downloading ${urlLabel(url)}: ${buf.length} bytes exceeds the ${MAX_ARTIFACT_BYTES} byte cap`,
    );
  }
  return buf;
}

function sha256hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function tsModule(hubB64, sigstoreB64, manifestB64, meta) {
  // JSON.stringify gives us safely-escaped string literals for arbitrary
  // bytes; base64 keeps the TS source 7-bit clean.
  return `// AUTO-GENERATED by server/scripts/bundle-client.mjs — DO NOT EDIT.
// Pinned CLI ${meta.version} (sha256 ${meta.sha256}), fetched from
// ${meta.assetBase}/cli-v${meta.version} and hash-verified at build time.
// Regenerate: npm run bundle:client (runs automatically before npm run build).
export const CLIENT_DIST = {
  version: ${JSON.stringify(meta.version)},
  sha256: ${JSON.stringify(meta.sha256)},
  hubB64: ${JSON.stringify(hubB64)},
  sigstoreB64: ${JSON.stringify(sigstoreB64)},
  manifestB64: ${JSON.stringify(manifestB64)},
} as const;
`;
}

async function main() {
  const manifestPath = process.env.BUNDLE_CLIENT_MANIFEST_PATH ?? DEFAULT_MANIFEST_PATH;
  const outPath = process.env.BUNDLE_CLIENT_OUT_PATH ?? DEFAULT_OUT_PATH;
  const pin = checkPin(readManifest(manifestPath));
  const assetBase = process.env.BUNDLE_CLIENT_BASE_URL ?? DEFAULT_ASSET_BASE;
  if (!assetBase.startsWith('http://') && !assetBase.startsWith('https://')) {
    fail(`BUNDLE_CLIENT_BASE_URL must be http(s), got ${JSON.stringify(assetBase)}`);
  }
  const tag = `cli-v${pin.version}`;
  const base = `${assetBase}/${tag}`;
  const urls = { hub: `${base}/hub`, sigstore: `${base}/hub.sigstore`, manifest: `${base}/manifest.json` };

  console.error(`bundle-client: fetching CLI ${tag} (pin sha256 ${pin.sha256.slice(0, 16)}…)`);
  const tmpDir = mkdtempSync(join(tmpdir(), 'bundle-client-'));
  const [hubBuf, sigstoreBuf, releaseManifestBuf] = await Promise.all([
    fetchBytes(urls.hub, tmpDir),
    fetchBytes(urls.sigstore, tmpDir),
    fetchBytes(urls.manifest, tmpDir),
  ]);

  // 1) sha256(hub) must equal the pin.
  const got = sha256hex(hubBuf);
  if (got !== pin.sha256) {
    fail(
      `sha256 MISMATCH: downloaded hub hashes to ${got} but the pin demands ` +
        `${pin.sha256}. Possible tampering or a stale/mistyped pin — refusing to embed.`,
    );
  }

  // 2) The release's own manifest.json must agree (TOCTOU across the two
  //    fetches: we verify the bytes we downloaded, not a name).
  let releaseManifest;
  try {
    releaseManifest = JSON.parse(releaseManifestBuf.toString('utf-8'));
  } catch (e) {
    fail(`release manifest.json is not valid JSON: ${e.message}`);
  }
  const releaseSha = releaseManifest.sha256 ?? releaseManifest.files?.hub;
  if (releaseManifest.version !== pin.version) {
    fail(
      `release manifest version ${JSON.stringify(releaseManifest.version)} != pinned ` +
        `${pin.version} — refusing to embed mismatched artifacts`,
    );
  }
  if (!/^[0-9a-f]{64}$/i.test(releaseSha ?? '')) {
    fail(`release manifest.json carries no valid sha256 for hub — refusing to embed`);
  }
  if (releaseSha.toLowerCase() !== pin.sha256) {
    fail(
      `release manifest sha256 ${releaseSha} != pin sha256 ${pin.sha256} — ` +
        `the release was republished under the same tag; refusing to embed`,
    );
  }

  // 3) sigstore bundle must be non-empty parseable JSON (the CLI still
  //    verifies the seal client-side at install/upgrade time).
  try {
    const parsed = JSON.parse(sigstoreBuf.toString('utf-8'));
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
  } catch (e) {
    fail(`hub.sigstore is not a JSON bundle: ${e.message}`);
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    tsModule(hubBuf.toString('base64'), sigstoreBuf.toString('base64'), releaseManifestBuf.toString('base64'), {
      version: pin.version,
      sha256: pin.sha256,
      assetBase,
    }),
    'utf-8',
  );
  console.error(
    `bundle-client: OK — cli-v${pin.version} ` +
      `(hub ${hubBuf.length}B, sigstore ${sigstoreBuf.length}B, manifest ${releaseManifestBuf.length}B) → ${outPath}`,
  );
}

await main();
