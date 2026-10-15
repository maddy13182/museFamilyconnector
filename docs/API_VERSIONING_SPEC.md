> Historical design notes. Protocol 2 supersedes optional encryption, v1 routes,
> legacy subject formats and force commits described below. Use [INSTALL.md](INSTALL.md),
> [SECURITY.md](SECURITY.md) and [the encryption guide](../agent-skill/references/e2ee.md)
> for the implemented contract.

# API Versioning & Client Distribution Spec — v1.0

Status: accepted design (owner, 2026-10-11). This is the build contract for
`feat/api-versioning-server` + `feat/api-versioning-cli`, merging into
`feat/api-versioning-contract`. After this lands, the project is production.

Day-one versions: **server 0.12.0, CLI 0.10.0.**
**No backward compatibility with server 0.11.0 / CLI 0.9.0.** Clean break:
the single existing server will be upgraded (fresh database + re-enrollment
explicitly authorized if simpler). Do not write compat shims, fallbacks, or
dual-path code for the 0.11.0/0.9.0 pair.

## 1. The version contract ("one CLI, versioned protocol")

- **One CLI, one v1 API.** An agent installs exactly one CLI and never asks
  "which CLI for which server."
- **Compatibility rule.** The CLI declares a floor, `_MIN_SERVER_VERSION`.
  A CLI supports a server iff:
  1. `server_version >= _MIN_SERVER_VERSION`, AND
  2. the server's advertised `api_versions` includes an API major the CLI
     implements (v1 today).
  Outside this, **both sides fail loudly** with plain-language upgrade
  instructions. No silent breakage, no guessing.
- **Additive-only within v1.** New endpoints and new optional
  request/response fields are free. Existing shapes never change.
- **Breaking changes graduate to /v2.** The mechanism is built now (health
  advertises `api_versions`; router dispatches on API-major prefix); no v2
  routes are needed yet. When v2 arrives, v1 handlers are frozen
  (bug/security fixes only).
- **No museum of old versions.** A server that falls outside the window gets
  **upgraded** (code-only deploy; additive DB migrations — data is never at
  risk), never worked around with an old CLI.

> Note on an earlier sketch: a "[x.y−1, x.y+1] minor window" was considered
> and rejected — server and CLI have independent minor sequences (0.12.0 vs
> 0.10.0), so minor arithmetic across the two is incoherent. Floor +
> API-major negotiation is the mechanism.

## 2. Sources of truth (unchanged)

- Server version: `server/package.json` → reported by `GET /v2/health`.
- CLI version: `agent-skill/pyproject.toml` (contract C6); release stamp
  derived at build time; skill version from the `SKILL.md` header.
- **Pairing record:** `server/client-manifest.json` declares which CLI
  release a server build serves:
  `{version, sha256, min_cli_version, released_at, download_url}`.
  `download_url` is provenance (the GitHub release URL the build fetched
  from). The server's *responses* always use this server's own URLs.

## 3. Server changes (`feat/api-versioning-server`)

### 3.1 `GET /v2/health` — advertise the contract

Response: `{ok: true, version: SERVER_VERSION, api_versions: ["v1"]}`.
`api_versions` is the machine-readable contract; it becomes `["v1","v2"]`
if a breaking change ever lands. Unauthenticated (unchanged).

### 3.2 Version gate: 400 → 426

`gateClientVersion` rejection becomes **HTTP 426 (Upgrade Required)** with
code `client_too_old` (was 400). Keep the plain-language message naming the
upgrade path. Exemptions unchanged: `/v2/health` and `/v2/client/latest`
must stay reachable by outdated clients (self-heal path) — the four
download endpoints (§3.4) are likewise exempt: an outdated client must be
able to fetch its replacement.

### 3.3 Router: prefix dispatch ready for v2

Structure the `/v2/...` dispatch so `/v2/...` handlers can live alongside
later (e.g. dispatch on API-major prefix). No v2 endpoints now. v1 response
shapes are frozen from here on.

### 3.4 New download endpoints (public, unauthenticated)

The CLI binary is a public artifact (same precedent as `/v2/health` and
`/v2/client/latest`).

| Method | Path | Content-Type | Notes |
|---|---|---|---|
| GET | `/v2/client/download/hub` | `application/octet-stream` | `Content-Disposition: attachment; filename="hub"` |
| GET | `/v2/client/download/hub.sigstore` | `application/json` | `attachment; filename="hub.sigstore"` |
| GET | `/v2/client/download/manifest.json` | `application/json` | `attachment; filename="manifest.json"` |
| GET | `/v2/client/download/skill.tar.gz` | `application/gzip` | `attachment; filename="skill.tar.gz"` — the versioned skill bundle (`SKILL.md`, `references/`, `INSTALL.md`, `requirements.txt`, plus the `hub` artifact, its sigstore bundle, and the release manifest) |

- **Fixed asset map only — no path parameters.** No traversal surface by
  construction. Any other path under `/v2/client/download/` → 404.
- `Content-Length` set; `Cache-Control: public, max-age=300` (bytes change
  when the manifest pin updates + server redeploys — must NOT be immutable).
- Apply the existing in-worker rate limiter (generous bucket); 429 uses the
  standard `{error: {code: "rate_limited", ...}}` envelope + `Retry-After`.
- Serve the artifacts bundled at build time (§3.6). The build fails closed,
  so these endpoints never serve placeholders.

### 3.5 `GET /v2/client/latest` — new shape, self-referential URLs

```json
{
  "version": "<cli version from pin>",
  "min_cli_version": "<pin min_cli_version>",
  "server_version": "<this build's SERVER_VERSION>",
  "sha256": "<pin sha256>",
  "released_at": "<pin released_at>",
  "download_url": "https://<this-server>/v2/client/download/hub",
  "assets": {
    "hub": "https://<this-server>/v2/client/download/hub",
    "sigstore": "https://<this-server>/v2/client/download/hub.sigstore",
    "manifest": "https://<this-server>/v2/client/download/manifest.json"
  },
  "skill": {
    "url": "https://<this-server>/v2/client/download/skill.tar.gz",
    "sha256": "<pin skill_sha256>",
    "version": "<pin skill_version>"
  }
}
```

`download_url` is kept (repointed at this server) for field continuity;
`assets.*` is the explicit contract the CLI uses. URLs are absolute,
derived from the request origin. `server_version` makes the pairing
machine-readable.

### 3.6 Build bundling (fail-closed)

- New script `server/scripts/bundle-client.mjs`, wired as
  `npm run bundle:client`, run before `npm run build` and in `pretest`.
- Reads `server/client-manifest.json`; derives the four GitHub release
  asset URLs for the pinned version; downloads `hub`, `hub.sigstore`,
  `manifest.json`, `skill.tar.gz`; verifies `sha256(hub)` equals the pin's
  `sha256` AND the release manifest's `sha256`; verifies
  `sha256(skill.tar.gz)` equals the pin's `skill_sha256` AND the release
  manifest's `skill_sha256`; structurally validates the tarball (relative
  paths only, no links, decompressed-size cap) and machine-checks the
  two-phase-manifest invariant (the tarball embeds the phase-1 manifest —
  no `skill_*` fields — whose version/sha256 agree with the pin).
- On success writes `server/src/client-dist.generated.ts` (**gitignored**)
  exporting the four artifacts as string constants; `index.ts` serves from
  it (follow the existing `client-manifest.json` import pattern).
- On **any** failure (network error, 404, placeholder hash such as
  `PENDING-*`, a pin without `skill_sha256`/`skill_version`, hash
  mismatch, unsafe tarball member) the script exits non-zero with a clear
  message and the build stops. Never embed placeholders.
- Refresh without code changes: update the pin in
  `server/client-manifest.json`, rebuild, redeploy.
- Tests: download-endpoint tests run against the bundled artifacts
  (`pretest` bundles first); pure unit tests may use fixtures.

### 3.7 `docs/openapi.yaml`

- Document the three download endpoints, the new `/v2/client/latest`
  shape, `api_versions` in health, and 426 + `client_too_old` in the
  `ErrorCode` enum.
- Fix the stale 429 prose (in-worker rate limiting has existed since
  v0.11.0; edge rules are additional, not the only source).

### 3.8 CI parity job

New job in `.github/workflows/ci.yml`: extract route patterns from the
dispatch block in `server/src/index.ts`, diff against `docs/openapi.yaml`
paths. Allowlist: `GET /` (dashboard HTML) and `x-spec-note: PROPOSED`
endpoints. Fail on undocumented routes or stale prose.

### 3.9 `release.yml`: manifest update via PR (owner decision 2026-10-11)

Replace the direct `git push` of `server/client-manifest.json` to main
(rejected by branch protection — GH006, fails every release) with: create
branch `release/manifest-cli-vX.Y.Z`, commit the manifest update, push the
branch, open a PR with `gh`. No loop risk: the workflow only acts when
`pyproject.toml` is newer than the latest `cli-v*` tag, so merging the
manifest PR triggers one no-op run.

### 3.10 Version bump

`server/package.json` → `0.12.0`. Changelog fragments per the CI version
gate (see `docs/VERSIONING.md`).

### 3.11 Invite pages + docs referencing the old flow

`server/src/index.ts` (~line 1489) and the invite onboarding pages surface
install/download instructions — repoint them at this server's download
endpoints / `/v2/client/latest`. Grep the repo for
`github.com/maddy13182/museFamilyconnector/releases` and update every
user-facing reference: `docs/AGENT_JOIN.md`, `docs/DEPLOY.md`,
`docs/INSTALL.md`, `docs/MAINTAINERS.md`, `docs/CLIENT_HARDENING_SPEC.md`,
`docs/INVITE_PAGES_SPEC.md` (where they describe the download flow).
No conflicting parallel paths remain.

### 3.12 `docs/VERSIONING.md`

Add the window rule (§1) and a maintainer runbook: how to cut a release,
how the manifest gets updated (release → manifest PR → merge → deploy),
deploy steps (build bundles the pinned CLI; set the production
`MIN_CLI_VERSION` binding to the new CLI version), and how the
server↔CLI pairing is declared (`server/client-manifest.json`) and
refreshed.

## 4. CLI changes (`feat/api-versioning-cli`)

### 4.1 `_MIN_SERVER_VERSION`

Constant next to `VERSION` in `agent-skill/hub`, value `"0.12.0"`.
Bumped deliberately, covered by a CLI test. No backcompat with 0.11.0.

### 4.2 Per-invocation server check

Once per process invocation, `GET /v2/health` (unauthenticated, cheap;
result cached for the process — not per sub-request). Then:

- `server_version < _MIN_SERVER_VERSION` → fail **before any command**:
  `hub <cli-ver> needs server <floor>+ (this server runs <srv-ver>). Ask the server operator to upgrade.`
- Health missing `version`/`api_versions`, or unreachable `api_versions`
  not containing `"v1"` → treat as too old (clean failure; 0.11.0 has no
  `api_versions` and is therefore rejected — intended).
- Unreachable server → the existing clear connection error (not a version
  error). Never confuse the two.

### 4.3 `api_versions` selection

Read `api_versions` from health; select the highest API major the CLI
implements (v1 today) and prefix requests accordingly. No 404-probing
fallback (404 is ambiguous with "unknown id").

### 4.4 426 `client_too_old`

Add `client_too_old` to the known-codes set; surface the server's
plain-language upgrade-path message.

### 4.5 410 mapping

`_friendly_from_http`: `410 → ("expired", 1)`; trust the server codes
`invite_expired`, `code_expired`, `transfer_expired`,
`transfer_recipient_gone` when present.

### 4.6 `hub upgrade` — from the server, not GitHub

- Read `min_cli_version` from `/v2/client/latest` and surface it
  (e.g. "this server requires CLI ≥ x").
- Download all three assets from `assets.{hub,sigstore,manifest}` (this
  server), plus the skill bundle from the `skill` block (`skill.url`,
  verified against `skill.sha256`) when present — an older server predating
  the bundle omits the block, in which case skill-refresh is a no-op.
  **Remove** the `_release_asset_urls` GitHub-URL derivation —
  no conflicting parallel paths.
- Keep ALL existing verification, unchanged: sha256 against both the
  server manifest and the release manifest; sigstore verification (refuse,
  never skip, if `sigstore` is missing); candidate self-test before AND
  after the atomic cutover; `hub.prev` rollback. The bundle's sha256 is
  verified before extraction, the same way.
- The sigstore cert identity is unchanged — the bytes are the identical
  signed release artifacts; only the host changed, not the seal.

### 4.7 Docs

`agent-skill/INSTALL.md`: first-time install downloads from the server
(URLs from the invite page / `/v2/client/latest`); verification steps
unchanged. `agent-skill/SKILL.md`: update any references to the GitHub
download flow.

### 4.8 Version bump

`agent-skill/pyproject.toml` → `0.10.0`; `SKILL.md` header in lockstep;
changelog fragments per the version gate.

## 5. Trust model (document; the server is a mirror, not an authority)

Trust comes from the **sigstore seal** (its certificate names this repo's
release workflow — unforgeable, even by a compromised server) plus the
**sha256**, both verified client-side **before** install. Serving the
artifacts from the server changes the transport, not the trust anchor.

Honest limits (as the existing docs state): a root-level adversary on the
client machine defeats everything (tokens and keys are read straight off
disk — easier than tampering with the CLI). A compromised server cannot
forge the seal for tampered bytes; the worst it can do is serve
stale-but-validly-signed artifacts, bounded by `MIN_CLI_VERSION`
enforcement on the server and the client's `_MIN_SERVER_VERSION` check.
The skill bundle rides the same trust: its sha256 is pinned in the release
manifest and verified client-side before extraction, and the tarball's
members are structurally constrained at build time (relative paths only,
no links) — a tampered bundle fails the hash, never the extractor.

## 6. Endpoint catalog (new/changed)

| Change | Method | Path | Auth | Success | Errors |
|---|---|---|---|---|---|
| new | GET | `/v2/client/download/hub` | no | 200 binary | 429 |
| new | GET | `/v2/client/download/hub.sigstore` | no | 200 JSON | 429 |
| new | GET | `/v2/client/download/manifest.json` | no | 200 JSON | 429 |
| new | GET | `/v2/client/download/skill.tar.gz` | no | 200 gzip tar | 429 |
| changed | GET | `/v2/client/latest` | no | 200 new shape (§3.5) | — |
| changed | GET | `/v2/health` | no | 200 + `api_versions` | — |
| changed | gate | all `/v2/*` (except health, client/latest, client/download/*) | — | — | **426** `client_too_old` (was 400) |

## 7. Testing requirements

- Server suite: 197/197 baseline must keep passing. New tests: health
  `api_versions`; 426 gate (update `client_gate.test.ts` expectations —
  intentional behavior change, not a weakening); download endpoints
  (content types, bytes equal the pinned artifacts, fixed-path 404s, rate
  limit — including `skill.tar.gz` and its shared bucket); `/v2/client/latest`
  shape (absolute server URLs, `server_version`, `skill` block); invite
  pages install steps (bundle-first flow — intentional behavior change,
  not a weakening: still assert no GitHub URLs, sigstore mention, hash
  verification, exact step count); build script fail-closed (bad hash, 404,
  placeholder, missing `skill_sha256` pin, skill mismatch, unsafe tarball
  member); openapi parity (covered by the CI job; add a local test if cheap).
- CLI suite: 318/318 baseline must keep passing. New tests:
  `_MIN_SERVER_VERSION` constant; too-old server fails before any command
  with the exact message; health missing `api_versions` → too old;
  unreachable server → connection error (not version error); 426
  `client_too_old` surfaces the upgrade message; 410 → `expired` with the
  four server codes; `upgrade` uses server asset URLs and surfaces
  `min_cli_version`.
- `semgrep` and `bandit`: zero findings (same bar as previous builds).
- Dedicated adversarial security review of the new/changed surface, with
  emphasis on: the unauthenticated download endpoints (traversal —
  impossible by construction, verify; cache semantics; rate-limit
  bypass; content-type sniffing), the build-time fetch (supply chain:
  what happens if the release is yanked mid-build; TOCTOU between verify
  and embed; the skill tarball: zip-bomb cap, traversal/symlink members,
  the two-phase-manifest circularity documented in the release workflow),
  the invite page's interpolated bundle hash (charset-constrained at build
  time), the CLI's per-invocation health check (can a captive
  portal / MITM cause a downgrade? — the seal still protects the
  artifacts; document it), and the trust-model claims in §5. Fix all
  findings before reporting.

## 8. Owner-server rollout (after merge, owner executes)

1. Merge → release workflow cuts `cli-v0.10.0` → manifest-update PR →
   owner merges (pin now 0.10.0 + real sha256).
2. Owner deploys server 0.12.0: build fetches and embeds cli-v0.10.0.
3. Owner sets production `MIN_CLI_VERSION` binding to `0.10.0`.
4. Agents run `hub upgrade` (served from the server, verified as ever).
5. Fresh database + re-enrollment explicitly authorized if simpler than
  migrating the throwaway data.
