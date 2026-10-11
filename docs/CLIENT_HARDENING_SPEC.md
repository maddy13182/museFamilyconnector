# Client Hardening — Build Spec

## 1. Goal

Harden the Family Hub agent client (`hub` CLI) across five dimensions:
packaging/versioning, server-side client gating, release management,
key-at-rest protection, and tamper-evidence — with **zero regressions**
to existing behavior.

## 2. Non-goals / honest limits

- A client running on a machine where the attacker has root **cannot** be
  made tamper-proof: root can read `agent.key` and the bearer token
  directly off disk, which is easier than tampering with the CLI. The
  tamper-evidence work here defends the **supply chain** (what gets
  installed), **accidental corruption**, **casual tampering**, and
  **stale clients** — not a root-level adversary. This limit is
  documented, not hand-waved.
- No container distribution. The artifact is a single-file `hub` script
  (plus pinned deps), distributed via GitHub Releases.
- No server-side key escrow. Private keys never leave the client machine.

## 3. Workstream contracts

### WS-A — Packaging & versioning (`agent-skill/`)

- Add `agent-skill/pyproject.toml` with the CLI version as the **single
  source of truth** (replacing the `VERSION = "x.y.z"` constant in
  `agent-skill/hub`). The `hub` script must read its version from the
  installed metadata / the TOML — never hardcode it in two places.
- Locked dependencies with hashes: add `agent-skill/requirements.lock`
  (via `pip-compile --generate-hashes` or `uv lock`); keep the pinned
  `requirements.txt` as the human-readable source. CI installs from the
  lock file.
- `agent-skill/SKILL.md` gets a version header (`<!-- SKILL VERSION:
  x.y.z -->`) versioned **in lockstep** with the CLI. Mismatched
  skill/CLI versions must be detectable (`hub --version` prints both).
- CLI sends its real version on every request:
  `User-Agent: family-hub-agent/<semver>` (e.g.
  `family-hub-agent/0.7.0`). The hardcoded `family-hub-agent/1.0`
  string is removed.
- Update `docs/VERSIONING.md`: the CLI version source changes from
  "`agent-skill/hub` → `VERSION`" to "`agent-skill/pyproject.toml`".
- Tests: version reporting (`--version`, User-Agent header value),
  lockfile freshness (CI fails if `requirements.txt` and the lock
  disagree).

### WS-B — Server side (`server/`)

**B1. Client version gate.**
- Parse `User-Agent: family-hub-agent/<semver>` on API requests.
- The exact legacy string `family-hub-agent/1.0` is a sentinel: it
  predates real versioning and must be treated as version `0.0.0`
  (always below any minimum).
- Requests **without** a `family-hub-agent` UA (browser dashboard,
  curl) are never gated.
- If the parsed version is below the configured minimum
  (`MIN_CLI_VERSION` in `server/wrangler.toml`, default `"0.0.0"` =
  gate off), reject with **400** and a guidance message following the
  existing pattern, e.g.:
  `Client version 0.5.0 is below the required minimum 0.7.0. Update
  your CLI: see agent-skill/INSTALL.md (hub upgrade), then retry.`
- Rollout note: the default stays off until agents have upgraded; the
  deploy runbook raises it deliberately. Never ship a deploy that
  bricks the currently-installed fleet.

**B2. `GET /v1/client/latest`.**
- Returns the current CLI release the server knows about, sourced from
  a repo-controlled manifest at `server/client-manifest.json` (loaded
  at worker startup; no D1 read on the hot path):
  ```json
  {
    "version": "0.7.0",
    "min_cli_version": "0.7.0",
    "download_url": "https://github.com/maddy13182/museFamilyconnector/releases/download/cli-v0.7.0/hub",
    "sha256": "<hex of the released hub artifact>",
    "released_at": "2026-10-11T22:00:00Z"
  }
  ```
- This ties the CLI release to the deployed server: the manifest is
  updated by the release workflow (WS-C), and the server only
  advertises what the manifest says.
- Document the endpoint in `docs/openapi.yaml`.

**B3. Key lineage in the audit log.**
- Record the key **fingerprint** (first 16 hex chars of
  SHA-256(public_key), prefixed `fp:`) on every key lifecycle event:
  registration, rotation (old fp → new fp), revocation.
- Chain: `key fp → agent_label → member_id → circle_id`, all present
  in the audit entry, so any message can be traced end-to-end.
- Tests for each event type.

### WS-C — Release management

- New workflow `.github/workflows/release.yml`: on **merge to `main`**,
  if the CLI version in `agent-skill/pyproject.toml` is newer than the
  latest `cli-v*` GitHub Release tag, then:
  1. Build the `hub` artifact (the single script; deps are installed
     from the lockfile at install time, not bundled).
  2. Compute sha256; sign the artifact with **sigstore**
     (`sigstore-python`, keyless OIDC — no long-lived keys).
  3. Create GitHub Release `cli-v<x.y.z>` with the artifact, the
     `.sigstore` bundle, and a `manifest.json`
     (`{version, sha256, files}`).
  4. Update `server/client-manifest.json` in the repo with the new
     version/url/sha256 and commit back to `main` with `[skip ci]` in
     the message (must not trigger a second release run).
- The workflow must request only the permissions it needs
  (`contents: write`, `id-token: write`).
- Update `agent-skill/INSTALL.md` with two flows:
  - **First-time install:** download artifact from the GitHub Release
    → verify sigstore signature → verify sha256 against the release
    manifest → install → run `hub --version` self-check.
  - **Upgrade:** `hub upgrade` checks `GET /v1/client/latest`, compares
    versions, downloads the new artifact, verifies signature+hash,
    swaps it in **atomically**, keeps the previous binary for
    rollback (`hub rollback`), and runs the CLI self-test before
    cutting over.
- The server deploy runbook (`docs/DEPLOY.md`) gains a step: after
  deploying the worker, the manifest the server serves is whatever is
  in the repo at that deploy — verify `/v1/client/latest` after
  deploy.

### WS-D — Key wrapping at rest (`agent-skill/hub`)

- Encrypt `agent.key` with a key derived from a user passphrase via
  **Argon2id** (already available through the pinned PyNaCl).
- Wrapped format: magic header `FHWRAP1\n`, then
  `salt(16) || nonce || ciphertext` (XChaCha20-Poly1305 via PyNaCl).
  Wrong passphrase → clean "incorrect passphrase" error (MAC failure),
  never garbage output.
- Passphrase sourcing, in order: `FAMILY_HUB_KEY_PASSPHRASE` env var
  (for agents/cron — non-interactive), else interactive `getpass`
  prompt. Never from a CLI flag, never echoed, never logged.
- `hub key-wrap`: migrates an existing unwrapped `agent.key` to
  wrapped form (backs up the original to `agent.key.bak-0600` first,
  0600 throughout).
- Legacy unwrapped keys keep working but emit a loud deprecation
  warning on every use pointing at `hub key-wrap`. No silent
  behavior change, no broken cron jobs.
- **Ops note:** after wrapping, any automation (e.g. the 15-min watch
  cron) must export `FAMILY_HUB_KEY_PASSPHRASE` or it will block on
  the prompt. INSTALL.md documents this.
- Tests: wrap/unwrap round-trip, wrong-passphrase rejection, legacy
  detection + warning, env-var path, backup creation.

### WS-E — Tamper-evidence (`agent-skill/`)

- **Install-time verification** (part of the WS-C install flow, but
  WS-E owns the verification routine): a `hub verify-install`
  command that checks the installed `hub` file's sha256 against the
  release `manifest.json` and validates the sigstore bundle. Used by
  the installer and re-runnable any time.
- **Startup self-integrity check:** on startup, `hub` hashes its own
  file bytes and compares against the installed manifest's recorded
  hash. Mismatch → refuse to run with a clear error ("installed CLI
  does not match the signed release; reinstall from the GitHub
  Release"). Corrupt/missing manifest → warn, do not hard-fail
  (dev checkouts have no manifest).
- Document the limit (§2) in the code comments and INSTALL.md:
  this catches supply-chain/casual tampering, not root.

## 4. Interface contracts (cross-workstream)

| # | Contract | Owner(s) |
|---|---|---|
| C1 | `User-Agent: family-hub-agent/<semver>` on every CLI request | WS-A (send), WS-B (parse/gate) |
| C2 | `server/client-manifest.json` schema (§3 B2); release workflow is the only writer | WS-B (read), WS-C (write) |
| C3 | Release tag format `cli-v<x.y.z>`; asset names `hub`, `hub.sigstore`, `manifest.json` | WS-C (all) |
| C4 | Wrapped key magic `FHWRAP1\n`; env var `FAMILY_HUB_KEY_PASSPHRASE` | WS-D (all) |
| C5 | Integrity manifest schema: `{version, files: {hub: sha256}, signature: <sigstore bundle ref>}` installed next to the CLI | WS-C (install), WS-E (verify) |
| C6 | CLI version source: `agent-skill/pyproject.toml` (single source) | WS-A (all) |

## 5. Versioning

Per `docs/VERSIONING.md`: new API route (`GET /v1/client/latest`) and
new CLI capabilities are backwards-compatible features → **MINOR**
bumps, done as the **final commit** after all workstreams merge:

- Server `0.8.0` → `0.9.0` (`server/package.json`)
- Skill `0.6.0` → `0.7.0` (`agent-skill/pyproject.toml`)

Each workstream adds its own `changelog.d/<slug>.added.md` fragment(s).
The version-bump commit must satisfy the `version bump gate` CI check
(bump present + fragments present + level covers `added`).

## 6. Hard gates (all workstreams)

1. **No regressions:** full existing suites stay green —
   `npm test` (server) and `python3 -m unittest discover -s
   agent-skill/tests` (CLI). New tests for every new behavior.
2. **Security scans** on all changed code before merge: semgrep,
   bandit, `npm audit`. Fix findings; no silent waivers.
3. **Branch protection is on:** the PR needs all 5 checks green.
4. Nothing is pushed to `main` except via the PR. No deploy in this
   project — deploy stays gated behind Mahesh's explicit go-ahead.

## 7. Rollout order (after merge, for the deploy runbook)

1. Deploy server 0.9.0 (manifest ships with it; `MIN_CLI_VERSION`
   stays at its default until the fleet upgrades).
2. Upgrade agents' CLIs via the new install/upgrade flow; run
   `hub key-init` (unchanged) and `hub key-wrap` per profile.
3. Raise `MIN_CLI_VERSION` once the fleet reports ≥ the new version.
4. Rotate any keys suspected compromised via the existing recovery
   ladder; audit log now carries fingerprints for the trace.
