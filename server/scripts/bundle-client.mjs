#!/usr/bin/env node
/**
 * bundle-client.mjs — fail-closed CLI artifact bundling.
 *
 * Reads server/client-manifest.json, downloads the hub artifacts
 * (hub, hub.sigstore, manifest.json) for the pinned CLI version from its
 * GitHub Release, verifies sha256(hub) against BOTH the pin AND the
 * release's own manifest.json, then downloads the skill bundle
 * (skill.tar.gz + the skill release's manifest.json) from the
 * skill-v{skill_version} tag — decoupled releases: the skill ships on its
 * own cadence. Verifies sha256(skill.tar.gz) against BOTH the pin's
 * skill_sha256 AND the skill release manifest's skill_sha256,
 * structurally validates the tarball (no absolute paths, no `..`, no
 * links, decompressed-size cap), then writes
 * server/src/client-dist.generated.ts (gitignored) exporting the four
 * artifacts as base64 string constants. index.ts serves them from the
 * generated module — no placeholders, no runtime fetch.
 *
 * FAILS CLOSED (non-zero exit, clear message) on: network error, HTTP 404
 * (or any non-200), placeholder hashes such as PENDING-*, a pin without
 * skill_sha256/skill_version (CLI releases cut before the skill bundle
 * carry no skill fields — cut a new CLI release; the release workflow
 * builds skill.tar.gz and the manifest-PR step pins its hash), sha256
 * mismatch (pin or release manifest, hub or tarball), an unsafe tarball
 * member, oversized artifacts, or malformed manifests.
 * Never embed placeholders: a failed bundle must stop the build.
 *
 * The two-phase release manifest (see .github/workflows/release.yml):
 * the tarball embeds the PHASE-1 manifest (no skill_* fields); the
 * release's manifest.json is phase-2 (adds skill_sha256 + skill_version).
 * The bundler machine-checks the invariant: the embedded manifest has no
 * skill_* fields, and its version/sha256 agree with the pin.
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
 *
 * `npm test` never hits the network: server/scripts/make-test-fixtures.mjs
 * builds a complete fixture release, serves it over loopback HTTP, and runs
 * this script with BUNDLE_CLIENT_MANIFEST_PATH + BUNDLE_CLIENT_BASE_URL, so
 * the real verification code executes against fixtures. See that script's
 * header for the chicken-and-egg reason.
 */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGunzip } from 'node:zlib';

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
  if (!/^[0-9a-f]{64}$/i.test(m.skill_sha256 ?? '')) {
    errs.push(
      `pin skill_sha256 ${JSON.stringify(m.skill_sha256)} is not a 64-hex digest ` +
        `(CLI releases cut before the skill bundle carry no skill_sha256 — ` +
        `cut a new CLI release; the release workflow builds skill.tar.gz and ` +
        `the manifest-PR step pins its hash)`,
    );
  }
  if (!/^\d+\.\d+\.\d+$/.test(m.skill_version ?? '')) {
    errs.push(`pin skill_version ${JSON.stringify(m.skill_version)} is not x.y.z`);
  }
  if (errs.length) fail(`client-manifest.json pin is unusable: ${errs.join('; ')}`);
  return {
    version: m.version,
    sha256: m.sha256.toLowerCase(),
    skillSha256: m.skill_sha256.toLowerCase(),
    skillVersion: m.skill_version,
  };
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

const MAX_SKILL_TARBALL_DECOMPRESSED_BYTES = 64 * 1024 * 1024; // 64 MiB — the real bundle is < 1 MiB.
const MAX_TAR_MEMBERS = 1024;

/** gunzip with a hard cap on decompressed bytes (zip-bomb protection).
 *  The installer extracts the bundle, so an unbounded decompression here
 *  would be a disk-fill vector at build time. */
function gunzipCapped(buf) {
  return new Promise((resolve, reject) => {
    const gunzip = createGunzip();
    const chunks = [];
    let total = 0;
    let settled = false;
    const done = (fn, arg) => {
      if (!settled) {
        settled = true;
        fn(arg);
      }
    };
    gunzip.on('data', (c) => {
      total += c.length;
      if (total > MAX_SKILL_TARBALL_DECOMPRESSED_BYTES) {
        gunzip.destroy();
        done(reject, new Error(
          `decompressed size exceeds the ${MAX_SKILL_TARBALL_DECOMPRESSED_BYTES} byte cap (possible zip bomb)`,
        ));
        return;
      }
      chunks.push(c);
    });
    gunzip.on('end', () => done(resolve, Buffer.concat(chunks)));
    gunzip.on('error', (e) => done(reject, e));
    gunzip.end(buf);
  });
}

/**
 * Minimal ustar walk over the decompressed tarball. Fails closed (via
 * fail()) on anything the release workflow cannot produce: absolute paths,
 * `..` segments, symlinks/hardlinks, GNU long-name entries, non-octal
 * sizes, or member-count overflow. The installer extracts with plain
 * `tar -xzf`, so every member must be a plain relative file-or-dir path —
 * anything else is either tampering or a build bug, and both stop the
 * build. Returns a Map of member name → bytes for the invariant checks.
 */
function checkTarMembers(tarBuf) {
  const members = new Map();
  let off = 0;
  let count = 0;
  while (off + 512 <= tarBuf.length) {
    const header = tarBuf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break; // end-of-archive zero block
    count += 1;
    if (count > MAX_TAR_MEMBERS) {
      fail(`skill.tar.gz: more than ${MAX_TAR_MEMBERS} members — refusing`);
    }
    const cstr = (a, b) => header.subarray(a, b).toString('utf8').replace(/\0.*$/s, '');
    const name = cstr(0, 100);
    const prefix = cstr(345, 500);
    if (prefix !== '') {
      fail(`skill.tar.gz: member ${JSON.stringify(name)} uses a ustar prefix field — refusing (the workflow never produces these)`);
    }
    if (name === '') fail('skill.tar.gz: tar member with an empty name — refusing');
    const sizeOct = cstr(124, 136).trim();
    if (!/^[0-7]+$/.test(sizeOct)) {
      fail(`skill.tar.gz: member ${JSON.stringify(name)} has a non-octal size — refusing`);
    }
    const size = parseInt(sizeOct, 8);
    const typeflag = String.fromCharCode(header[156]);
    if (typeflag !== '0' && typeflag !== '\0' && typeflag !== '5') {
      fail(
        `skill.tar.gz: refusing member ${JSON.stringify(name)} with typeflag ` +
          `${JSON.stringify(typeflag)} (only regular files and directories are allowed — ` +
          `no symlinks, hardlinks, or GNU long-name entries)`,
      );
    }
    const norm = name.endsWith('/') ? name.slice(0, -1) : name;
    const segs = norm.split('/');
    if (norm.startsWith('/') || norm.startsWith('./') || segs.some((s) => s === '' || s === '..')) {
      fail(`skill.tar.gz: refusing member with unsafe path ${JSON.stringify(name)}`);
    }
    const dataStart = off + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tarBuf.length) {
      fail(`skill.tar.gz: member ${JSON.stringify(name)} overruns the archive — refusing`);
    }
    if (typeflag === '0' || typeflag === '\0') {
      members.set(norm, Buffer.from(tarBuf.subarray(dataStart, dataEnd)));
    }
    off = dataStart + Math.ceil(size / 512) * 512;
  }
  if (count === 0) fail('skill.tar.gz: archive has no members — refusing');
  return members;
}

function tsModule(hubB64, sigstoreB64, manifestB64, skillTarGzB64, meta) {
  // JSON.stringify gives us safely-escaped string literals for arbitrary
  // bytes; base64 keeps the TS source 7-bit clean.
  return `// AUTO-GENERATED by server/scripts/bundle-client.mjs — DO NOT EDIT.
// Pinned CLI ${meta.version} (sha256 ${meta.sha256}), skill bundle
// ${meta.skillVersion} (sha256 ${meta.skillSha256}), fetched from
// ${meta.assetBase}/cli-v${meta.version} and hash-verified at build time.
// Regenerate: npm run bundle:client (runs automatically before npm run build).
export const CLIENT_DIST = {
  version: ${JSON.stringify(meta.version)},
  sha256: ${JSON.stringify(meta.sha256)},
  hubB64: ${JSON.stringify(hubB64)},
  sigstoreB64: ${JSON.stringify(sigstoreB64)},
  manifestB64: ${JSON.stringify(manifestB64)},
  skillSha256: ${JSON.stringify(meta.skillSha256)},
  skillTarGzB64: ${JSON.stringify(skillTarGzB64)},
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
  // Decoupled releases: the skill bundle ships on its own cadence
  // (skill-v* tags), independent of the CLI release that carries the hub.
  // The pin's skill_version selects the tag; the pin's skill_sha256 is the
  // authority the downloaded bytes are checked against.
  const skillTag = `skill-v${pin.skillVersion}`;
  const skillBase = `${assetBase}/${skillTag}`;
  const urls = {
    hub: `${base}/hub`,
    sigstore: `${base}/hub.sigstore`,
    manifest: `${base}/manifest.json`,
    skill: `${skillBase}/skill.tar.gz`,
    skillManifest: `${skillBase}/skill-manifest.json`,
  };

  console.error(`bundle-client: fetching CLI ${tag} (pin sha256 ${pin.sha256.slice(0, 16)}…, skill sha256 ${pin.skillSha256.slice(0, 16)}…)`);
  const tmpDir = mkdtempSync(join(tmpdir(), 'bundle-client-'));
  const [hubBuf, sigstoreBuf, releaseManifestBuf, skillBuf, skillManifestBuf] =
    await Promise.all([
      fetchBytes(urls.hub, tmpDir),
      fetchBytes(urls.sigstore, tmpDir),
      fetchBytes(urls.manifest, tmpDir),
      fetchBytes(urls.skill, tmpDir),
      fetchBytes(urls.skillManifest, tmpDir),
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

  // 2b) The skill release's own manifest (from the skill-v* tag) must
  //     carry a valid skill_sha256 that agrees with the pin (TOCTOU across
  //     the two fetches, same as hub). Decoupled releases: the CLI
  //     release's manifest no longer speaks for the skill bundle.
  let skillManifest;
  try {
    skillManifest = JSON.parse(skillManifestBuf.toString('utf-8'));
  } catch (e) {
    fail(`skill release manifest.json is not valid JSON: ${e.message}`);
  }
  if (skillManifest.skill_version !== pin.skillVersion) {
    fail(
      `skill release manifest skill_version ${JSON.stringify(skillManifest.skill_version)} ` +
        `!= pin ${pin.skillVersion} — refusing to embed`,
    );
  }
  const releaseSkillSha = skillManifest.skill_sha256;
  if (!/^[0-9a-f]{64}$/i.test(releaseSkillSha ?? '')) {
    fail(`skill release manifest.json carries no valid skill_sha256 — refusing to embed`);
  }
  if (releaseSkillSha.toLowerCase() !== pin.skillSha256) {
    fail(
      `skill release manifest skill_sha256 ${releaseSkillSha} != pin skill_sha256 ` +
        `${pin.skillSha256} — the release was republished under the same tag; refusing to embed`,
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

  // 4) sha256(skill.tar.gz) must equal the pin's skill_sha256.
  const skillGot = sha256hex(skillBuf);
  if (skillGot !== pin.skillSha256) {
    fail(
      `sha256 MISMATCH: downloaded skill.tar.gz hashes to ${skillGot} but the pin demands ` +
        `${pin.skillSha256}. Possible tampering or a stale/mistyped pin — refusing to embed.`,
    );
  }

  // 5) Structural validation of the tarball: decompress under a cap
  //    (zip-bomb protection), then walk every member — plain relative
  //    file/dir paths only.
  let tarMembers;
  try {
    tarMembers = checkTarMembers(await gunzipCapped(skillBuf));
  } catch (e) {
    fail(`skill.tar.gz failed structural validation: ${e.message}`);
  }

  // 6) Two-phase-manifest invariant, machine-checked: the tarball embeds
  //    the PHASE-1 manifest (no skill_* fields), and its version/sha256
  //    agree with the pin. The embedded hub bytes must hash to the pin's
  //    hub sha256 — tying the bundle to the artifact verified in (1).
  const embeddedHub = tarMembers.get('hub');
  if (!embeddedHub) fail('skill.tar.gz: embedded hub member missing — refusing to embed');
  if (sha256hex(embeddedHub) !== pin.sha256) {
    fail(
      `skill.tar.gz: embedded hub hashes to ${sha256hex(embeddedHub)} but the pin demands ` +
        `${pin.sha256} — the bundle was not built from this release's hub; refusing to embed`,
    );
  }
  const embeddedManifestRaw = tarMembers.get('manifest.json');
  if (!embeddedManifestRaw) fail('skill.tar.gz: embedded manifest.json member missing — refusing to embed');
  let embeddedManifest;
  try {
    embeddedManifest = JSON.parse(embeddedManifestRaw.toString('utf-8'));
  } catch (e) {
    fail(`skill.tar.gz: embedded manifest.json is not valid JSON: ${e.message}`);
  }
  if ('skill_sha256' in embeddedManifest || 'skill_version' in embeddedManifest) {
    fail(
      'skill.tar.gz: embedded manifest.json carries skill_* fields — it must be the ' +
        'phase-1 manifest (see .github/workflows/release.yml); refusing to embed',
    );
  }
  if (embeddedManifest.version !== pin.version || embeddedManifest.sha256 !== pin.sha256) {
    fail(
      `skill.tar.gz: embedded manifest version/sha256 ` +
        `${JSON.stringify(embeddedManifest.version)}/${JSON.stringify(embeddedManifest.sha256)} ` +
        `!= pin ${pin.version}/${pin.sha256} — refusing to embed`,
    );
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    tsModule(
      hubBuf.toString('base64'),
      sigstoreBuf.toString('base64'),
      releaseManifestBuf.toString('base64'),
      skillBuf.toString('base64'),
      {
        version: pin.version,
        sha256: pin.sha256,
        skillSha256: pin.skillSha256,
        skillVersion: pin.skillVersion,
        assetBase,
      },
    ),
    'utf-8',
  );
  console.error(
    `bundle-client: OK — cli-v${pin.version} ` +
      `(hub ${hubBuf.length}B, sigstore ${sigstoreBuf.length}B, manifest ${releaseManifestBuf.length}B, ` +
      `skill.tar.gz ${skillBuf.length}B) → ${outPath}`,
  );
}

await main();
