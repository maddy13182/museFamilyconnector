# Versioning policy

This project follows [Semantic Versioning 2.0.0](https://semver.org):
`MAJOR.MINOR.PATCH`, starting at `0.1.0`.

## One version per component, one source each

The server and the agent skill version **independently**. Each has exactly
one source of truth — never hardcode a version anywhere else:

| Component | Source | Reported by |
|---|---|---|
| Server (API + dashboard) | `server/package.json` → `version` | `GET /v1/health` (`version`), every log line (`v`) |
| Agent skill (CLI) | `agent-skill/pyproject.toml` → `version` (single source of truth, contract C6) | `hub --version` |

There is no repo-root `VERSION` file. The two components usually release
together, but a server-only change bumps only the server version and vice
versa.

## What bumps what

| Change | Bump | Examples |
|---|---|---|
| **Breaking** | MAJOR | Removing/renaming an API route; changing a request/response shape existing agents depend on; a D1 schema change old code can't read; removing a CLI command or changing its flags incompatibly |
| **Feature** (backwards-compatible) | MINOR | New API route; new CLI command; new optional request field; new dashboard capability |
| **Fix** (backwards-compatible) | PATCH | Bug fixes; **security fixes**; performance fixes; dependency pin updates with no behavior change |

- **Security fixes** bump PATCH (they're backwards-compatible fixes). If a
  security fix *must* break compatibility, it bumps MAJOR and the break is
  called out in the changelog. Security fixes are never bundled silently —
  they get their own release and their own changelog entry.
- **Docs, comments, CI/workflow changes, and repo hygiene do not bump** the
  version — they change no shipped behavior.

## Changelog fragments

Do not edit `CHANGELOG.md` directly in a PR. Instead add one fragment per
notable change in `changelog.d/`, named `<slug>.<type>.md` where type is one
of `added`, `changed`, `deprecated`, `removed`, `fixed`, `security`
(see `changelog.d/README.md`).

When the PR merges, the `Changelog` workflow runs
`scripts/consolidate_changelog.py`, which folds the fragments into
`CHANGELOG.md`'s `## [Unreleased]` section and deletes them. When cutting a
release, rename `## [Unreleased]` to `## [<version>] - <date>`; if the two
components released at different versions, name both
(e.g. `## [server 0.3.0 / skill 0.2.1] - 2026-10-11`).

## How to release

1. Decide the bump per the table above, per component.
2. Bump the component's version in its single source.
3. Add `changelog.d/` fragment(s).
4. Open a PR. CI enforces: functional code changes require a version bump,
   a bump requires fragment(s), and the bump level must cover the fragment
   types (`removed` → major, `added`/`changed`/`deprecated` → minor,
   `fixed`/`security` → patch). Docs-only PRs are exempt.
5. Merge via PR only — direct pushes to `main` are blocked by branch
   protection (see README's repository-settings checklist).

## Observability

The worker emits structured JSON logs (Workers Logs, enabled via
`[observability]` in `server/wrangler.toml`). Every line carries the server
version (`v`), so log streams can be correlated with releases. Invite and
provisioning codes in URL paths are redacted; query strings, tokens, and
bodies are never logged.

## Pre-1.0 note

Per SemVer, anything may break before `1.0.0`, but we still bump MINOR for
features and PATCH for fixes during `0.x` so families can tell releases
apart. The jump to `1.0.0` marks the API as stable.

## The version contract ("one CLI, versioned protocol")

- **One CLI, one v1 API.** An agent installs exactly one CLI and never asks
  "which CLI for which server."
- **Compatibility rule.** The CLI declares a floor, `_MIN_SERVER_VERSION`.
  A CLI supports a server iff:
  1. `server_version >= _MIN_SERVER_VERSION`, AND
  2. the server's advertised `api_versions` (from `GET /v1/health`) includes
     an API major the CLI implements (v1 today).
  Outside this, **both sides fail loudly** with plain-language upgrade
  instructions. No silent breakage, no guessing.
- **Additive-only within v1.** New endpoints and new optional
  request/response fields are free. Existing shapes never change.
- **Breaking changes graduate to /v2.** The mechanism is built in:
  `GET /v1/health` advertises `api_versions`, and the router dispatches on
  the API-major prefix. When v2 arrives, v1 handlers are frozen
  (bug/security fixes only).
- **No museum of old versions.** A server that falls outside the window gets
  **upgraded** (code-only deploy; additive DB migrations — data is never at
  risk), never worked around with an old CLI.

(The earlier "[x.y−1, x.y+1] minor window" sketch was rejected: server and
CLI have independent minor sequences (0.12.0 vs 0.10.0), so minor arithmetic
across the two is incoherent. Floor + API-major negotiation is the
mechanism.)

## Maintainer runbook: cutting a release

### Server release

1. Decide the bump per the table above; bump `server/package.json`.
2. Add `changelog.d/` fragment(s).
3. Open a PR. CI enforces the version gate, the build, the full test suite,
   semgrep/bandit, and the openapi parity check.
4. Merge via PR only.

### CLI release → manifest PR → deploy

1. Bump `agent-skill/pyproject.toml`; add fragment(s); merge to `main`.
2. The **Release CLI** workflow (`.github/workflows/release.yml`) builds the
   `hub` artifact, signs it with sigstore (keyless OIDC), writes the release
   manifest in **two phases** (phase 1 without skill fields → build
   `skill.tar.gz` embedding the phase-1 manifest → phase 2 rewrites the
   manifest adding `skill_sha256` + `skill_version`), and cuts the
   `cli-v<x.y.z>` GitHub Release with `hub`, `hub.sigstore`, `manifest.json`,
   **and `skill.tar.gz`**. It then opens a PR (`release/manifest-cli-v<x.y.z>`)
   updating `server/client-manifest.json` — never a direct push to `main`
   (branch protection rejects those, GH006). The workflow only acts when
   `pyproject.toml` is newer than the latest `cli-v*` tag, so merging the
   manifest PR triggers one no-op run — no loop.
   - **What the bundle contains:** `SKILL.md`, `references/` (recursive),
     `INSTALL.md`, `requirements.txt` from `agent-skill/`, plus the stamped
     `dist/hub`, `dist/hub.sigstore`, and the phase-1 `dist/manifest.json`.
     Inclusion is an explicit relative-path allowlist — `tests/`,
     `__pycache__/`, `pyproject.toml`, `requirements.lock`, `hub.prev*`,
     `*.pyc` are excluded by construction.
   - **The two-phase circularity is open:** the tarball embeds the phase-1
     manifest (its hub sha256 is identical in both phases; only the
     `skill_*` fields differ); the `manifest.json` uploaded to the release
     is phase-2. `skill_version` comes from the
     `<!-- SKILL VERSION: x.y.z -->` header of `agent-skill/SKILL.md`.
   - **Release cadence stays CLI-driven:** the workflow only cuts a release
     when `agent-skill/pyproject.toml` is newer than the latest `cli-v*`
     tag. A skill-only change (SKILL.md edit, skill version bump) ships
     with the next CLI release — bump `pyproject.toml` to force one.
3. **Owner merges the manifest PR.** `min_cli_version` in the pin is never
   raised automatically — raise it deliberately, only after the fleet
   reports at-or-above the new CLI version. The pin now also carries
   `skill_sha256` + `skill_version` for the bundle.
4. **Deploy the server.** The build runs `npm run bundle:client` first
   (`prebuild`): it downloads the four artifacts for the pinned version,
   verifies `sha256(hub)` against BOTH the pin and the release manifest,
   verifies `sha256(skill.tar.gz)` against BOTH the pin's `skill_sha256`
   and the release manifest's `skill_sha256`, structurally validates the
   tarball (relative paths only, no links, decompressed-size cap), and
   embeds everything into the worker
   (`server/src/client-dist.generated.ts`, gitignored). The build
   **fails closed** — network error, 404, placeholder hash, a pin without
   `skill_sha256`/`skill_version`, mismatch, or an unsafe tarball member
   stops the deploy with a clear message, so the worker never serves
   placeholders. The worker then serves the bundle at
   `GET /v1/client/download/skill.tar.gz` and advertises it in
   `GET /v1/client/latest` (`skill: {url, sha256, version}`).
5. **Set the production `MIN_CLI_VERSION` binding** (`server/wrangler.toml`
   `[vars]`, or the dashboard) to the new CLI version — only after the
   fleet has upgraded. The gate rejects outdated clients with
   **426 `client_too_old`** and a plain-language upgrade message;
   `/v1/health`, `/v1/client/latest`, and `/v1/client/download/*` stay
   reachable so an outdated client can always fetch its replacement.
6. Agents run `hub upgrade`, which downloads the new artifacts **from the
   server** (`/v1/client/latest` → `assets.*`, plus the `skill` block for
   the bundle) and verifies the sigstore seal + sha256 client-side before
   installing — the trust anchor is unchanged by the server-hosted
   transport (see `docs/API_VERSIONING_SPEC.md` §5).

### How the server↔CLI pairing is declared

`server/client-manifest.json` is the single pairing record:
`{version, sha256, min_cli_version, released_at, download_url, skill_sha256, skill_version}`.
`download_url` is **provenance** (the GitHub Release URL the build fetched
from) — the server's *responses* always use its own URLs
(`GET /v1/client/latest` derives absolute `/v1/client/download/*` URLs
from the request origin). To refresh the pairing without a code change:
update the pin, rebuild, redeploy. The `skill_*` fields are written by the
release workflow's manifest-PR step; `bundle-client.mjs` fails closed when
they are absent (a pin from a CLI release cut before the skill bundle
cannot produce a bundle — cut a new CLI release).
