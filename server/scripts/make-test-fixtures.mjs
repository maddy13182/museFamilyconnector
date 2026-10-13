#!/usr/bin/env node
/**
 * make-test-fixtures.mjs — hermetic bundle fixtures for `npm test`.
 *
 * WHY THIS EXISTS (chicken-and-egg):
 * bundle-client.mjs FAILS CLOSED when the committed server/client-manifest.json
 * pin predates the first skill-bundle release (no skill_sha256/skill_version).
 * That ordering is inherent: the first real skill.tar.gz can only be cut by
 * the release workflow AFTER the bundle change merges, so the PR's own CI can
 * never satisfy the production invariant. CI must stay green and
 * deterministic, so `npm test` builds against locally-generated fixtures
 * instead of the network.
 *
 * What it does:
 *  1. Builds a complete, internally consistent fixture release in a temp
 *     dir — fixture hub bytes, phase-1 manifest (no skill_* fields, as
 *     embedded in the tarball), skill.tar.gz, phase-2 release manifest
 *     (adds skill_sha256 + skill_version), skill-release manifest (the
 *     skill-v* tag's manifest.json), and a fixture pin carrying the
 *     skill fields. Mirrors server/test/client_dist.test.ts's makeRelease().
 *  2. Serves the fixture release over a loopback HTTP server — hub
 *     artifacts under cli-v*, skill bundle under skill-v* (decoupled
 *     releases).
 *  3. Runs the REAL bundle-client.mjs with the test-only env knobs
 *     (BUNDLE_CLIENT_MANIFEST_PATH / BUNDLE_CLIENT_BASE_URL) so the actual
 *     bundler code — pin validation, hash checks against pin AND release
 *     manifest, tarball structural validation, two-phase invariant — executes
 *     against fixtures.
 *  4. Writes the fixture pin to server/.test-fixtures/pin.json (gitignored);
 *     package.json's `test` script copies it to dist/client-manifest.json so
 *     the suite's pin-dependent assertions run against the same fixture pin
 *     the bundle was built from.
 *
 * Production builds (`npm run build` → prebuild → bundle-client.mjs with no
 * overrides) always use the real pin and real GitHub releases, fail-closed.
 * The fail-closed behavior itself is covered by unit tests
 * (client_dist.test.ts: 'bundler fails closed on a pin without skill_sha256').
 */

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = dirname(HERE);
const BUNDLER = join(HERE, 'bundle-client.mjs');
const FIXTURE_DIR = join(SERVER_DIR, '.test-fixtures');

const FIXTURE_VERSION = '9.9.9';
const FIXTURE_SKILL_VERSION = '1.2.3';

function sha256hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function execTar(args) {
  return new Promise((resolve, reject) => {
    execFile('tar', args, {}, (err) => {
      if (err) {
        reject(
          new Error(
            `make-test-fixtures: 'tar' failed — it is required to build the fixture skill bundle: ${err.message}`,
          ),
        );
      } else resolve();
    });
  });
}

async function main() {
  const work = mkdtempSync(join(tmpdir(), 'skill-fixtures-'));
  let server;
  try {
    // --- 1. Fixture artifacts -------------------------------------------
    const hubBytes = Buffer.from(
      `#!/usr/bin/env python3\nprint("hub ${FIXTURE_VERSION}")\n`,
    );
    const hubSha = sha256hex(hubBytes);
    const sigstoreBytes = Buffer.from(
      JSON.stringify({
        mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
      }),
    );
    // Phase-1 manifest: no skill_* fields — exactly what the tarball embeds.
    const phase1Manifest = {
      version: FIXTURE_VERSION,
      sha256: hubSha,
      files: { hub: hubSha },
      signature: 'hub.sigstore',
    };
    const phase1Bytes = Buffer.from(JSON.stringify(phase1Manifest));

    const stage = join(work, 'skill-stage');
    const members = {
      'SKILL.md': `<!-- SKILL VERSION: ${FIXTURE_SKILL_VERSION} -->\n# fixture skill\n`,
      'INSTALL.md': '# fixture install\n',
      'requirements.txt': 'sigstore>=3.0,<4.0\n',
      'references/a.md': '# a\n',
      hub: hubBytes,
      'hub.sigstore': sigstoreBytes,
      'manifest.json': phase1Bytes,
    };
    for (const [name, content] of Object.entries(members)) {
      const p = join(stage, name);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content);
    }
    const tarballPath = join(work, 'skill.tar.gz');
    await execTar(['-czf', tarballPath, '-C', stage, ...Object.keys(members)]);
    const tarballBytes = readFileSync(tarballPath);
    const skillSha = sha256hex(tarballBytes);

    // Phase-2 manifest: what the CLI release publishes (adds skill fields).
    const releaseManifest = {
      ...phase1Manifest,
      skill_sha256: skillSha,
      skill_version: FIXTURE_SKILL_VERSION,
    };
    const releaseManifestBytes = Buffer.from(JSON.stringify(releaseManifest));

    // Skill-release manifest: what a skill-v* release publishes. Decoupled
    // releases serve the skill bundle from the skill-v tag, not the cli-v tag.
    const skillReleaseManifest = {
      type: 'skill',
      skill_version: FIXTURE_SKILL_VERSION,
      skill_sha256: skillSha,
      cli_version: FIXTURE_VERSION,
      hub_sha256: hubSha,
      released_at: '2026-10-12T00:00:00Z',
    };
    const skillReleaseManifestBytes = Buffer.from(
      JSON.stringify(skillReleaseManifest),
    );

    // Fixture pin: what the manifest-PR step would write after a real release.
    const pin = {
      version: FIXTURE_VERSION,
      min_cli_version: '0.0.0',
      download_url: `http://127.0.0.1/cli-v${FIXTURE_VERSION}/hub`,
      sha256: hubSha,
      skill_sha256: skillSha,
      skill_version: FIXTURE_SKILL_VERSION,
      released_at: '2026-10-12T00:00:00Z',
    };

    // --- 2. Serve the fixture release over loopback HTTP ------------------
    // Decoupled releases: hub artifacts under cli-v*, skill bundle under skill-v*.
    const tag = `cli-v${FIXTURE_VERSION}`;
    const skillTag = `skill-v${FIXTURE_SKILL_VERSION}`;
    const files = {
      [`/${tag}/hub`]: { body: hubBytes, type: 'application/octet-stream' },
      [`/${tag}/hub.sigstore`]: {
        body: sigstoreBytes,
        type: 'application/octet-stream',
      },
      [`/${tag}/manifest.json`]: {
        body: releaseManifestBytes,
        type: 'application/json',
      },
      [`/${skillTag}/skill.tar.gz`]: {
        body: tarballBytes,
        type: 'application/gzip',
      },
      [`/${skillTag}/skill-manifest.json`]: {
        body: skillReleaseManifestBytes,
        type: 'application/json',
      },
    };
    server = createServer((req, res) => {
      const f = files[req.url ?? ''];
      if (!f) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, {
        'content-type': f.type,
        'content-length': String(f.body.length),
      });
      res.end(f.body);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    // --- 3. Run the real bundler against fixtures ------------------------
    const pinPath = join(work, 'pin.json');
    writeFileSync(pinPath, JSON.stringify(pin, null, 2));
    await new Promise((resolve, reject) => {
      execFile(
        'node',
        [BUNDLER],
        {
          env: {
            ...process.env,
            BUNDLE_CLIENT_MANIFEST_PATH: pinPath,
            BUNDLE_CLIENT_BASE_URL: baseUrl,
          },
        },
        (err, stdout, stderr) => {
          if (stdout) process.stdout.write(stdout);
          if (stderr) process.stderr.write(stderr);
          err ? reject(err) : resolve();
        },
      );
    });

    // --- 4. Persist the fixture pin for the test script's dist copy ------
    rmSync(FIXTURE_DIR, { recursive: true, force: true });
    mkdirSync(FIXTURE_DIR, { recursive: true });
    writeFileSync(join(FIXTURE_DIR, 'pin.json'), JSON.stringify(pin, null, 2));
    console.error(
      `make-test-fixtures: OK — fixture bundle built (skill ${skillSha.slice(0, 16)}…), ` +
        `pin written to .test-fixtures/pin.json`,
    );
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`make-test-fixtures: FATAL: ${err.message}`);
  process.exit(1);
});
