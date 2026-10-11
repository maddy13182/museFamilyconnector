# Changelog

All notable changes to this project are documented here, in
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/) format.
Versioning policy: [`docs/VERSIONING.md`](docs/VERSIONING.md).

## [Unreleased]

### Added
- Fragmented changelog: PRs now add `changelog.d/<slug>.<type>.md` fragments
  instead of editing `CHANGELOG.md` directly; fragments are consolidated
  into `CHANGELOG.md` automatically on merge to `main`.
- Versioning is now per-component with a single source each: the server
  version lives only in `server/package.json`, the skill version only in
  `agent-skill/hub` (`VERSION` constant). The repo-root `VERSION` file is
  gone; the PR check validates each component's bump against its fragments.
- Server: structured JSON request/error logging in the worker — one line per
  request (method, path, status, duration) plus auth-rejection and error
  detail lines. Every line carries the server version; invite/provisioning
  codes in paths are redacted and query strings are never logged. Workers
  Logs enabled via `[observability]` in `wrangler.toml`.
- Server: circle names are now unique (case-insensitive) — `POST /v1/families`
  returns 409 `circle_name_taken` instead of creating a duplicate.
- Server: `POST /v1/families`, `/v1/topics`, and `/v1/families/:id/invites`
  honor `Idempotency-Key`. A repeated key returns the already-created
  resource (`deduped: true`) — for circles, with a freshly minted
  provisioning code, since the original code's plaintext is unrecoverable.
- Server: when a deduped circle create finds the original provisioning code
  was already redeemed, the orphaned token is revoked (the retry proves the
  client never received it).
- Server: redeeming an already-used provisioning/invite code now returns the
  member and `token_already_issued: true` instead of a bare error, so clients
  can guide recovery.
- CLI: exponential-backoff retry (1s/2s/4s + jitter, 3 retries) on dropped
  connections, timeouts, 429 and 5xx; 4xx never retried. All mutating POSTs
  auto-carry an idempotency key.
- CLI: `hub circle create` reuses one key across the create→redeem flow and
  loops back through dedup when a redeem response is lost; `hub circle join`
  explains the recovery step when a code was already used.
- Logging: server logs idempotency hits/stores, code minting, orphan
  revocation, and name conflicts; client `--debug` shows retry attempts with
  timestamps.
### Fixed
- Server: `GET /v1/health` now reports the server's actual release version
  (read from `server/package.json` at build time) instead of a stale
  hardcoded `0.1.0`.
## [0.2.0] - 2026-10-10

### Added
- Multi-circle support: one hub can now host many circles (families, friend
  groups, …). Hub owners may create additional circles after setup lock via
  `POST /v1/families` (`kind`: `family`|`general`, default `family`); the
  response includes a one-time provisioning code so the new circle is
  immediately usable.
- `GET /v1/families`: list the circles the caller belongs to (id, name, kind,
  my role, created_at).
- `GET /v1/me`: returns the identity bound to the calling token (member id,
  circle id, email, role, agent label) — lets clients verify which circle a
  token belongs to before storing it.
- Migration `0002`: `families.kind` column (defaults to `family`).
- CLI: `hub circles`, `hub circle create --name/--kind`, `hub circle use`,
  `hub circle join --code`, `hub dashboard-token --circle`, `--circle`
  override on commands, and per-circle token vault (`circle_tokens` in the
  0600 profile config). `hub sync` now covers every stored circle with
  per-circle cursors and circle-labeled entries. Creating a circle
  auto-redeems its provisioning code; `--debug` output scrubs tokens and
  codes; invite codes fall back to a `getpass` prompt instead of argv.
- Dashboard: header circle switcher with per-circle token map in
  localStorage; pasted tokens are verified live and must be bound to the
  active circle; wrong-token fetches are refused rather than mislabeled.

### Security
- Server: every new endpoint covered by 401/403 tests; all new queries
  parameterized; generic error codes (no internals leaked).
- CLI: tokens never logged/printed except via the explicit, warning-first
  `dashboard-token` command; config tmp files created 0600 from the first
  byte.
- Dashboard: unescaped entry field now escaped; Authorization header can no
  longer be overridden by caller headers; "forget token" clears all stored
  circle tokens and selection.

### Fixed
- `npm test` now wipes `dist/` first (`pretest`), so stale build artifacts
  from earlier checkouts can no longer poison the suite or race concurrent
  runs.
## [0.1.1] - 2026-10-10

### Fixed
- Bandit `nosec` annotations in the agent CLI (`import subprocess` and the
  vault-helper call) so the CI security scan passes clean. No behavior change.

## [0.1.0] - 2026-10-10

### Added
- Initial public release: Cloudflare Workers + D1 family agent hub.
- REST API: families, members, invites, provisioning codes, topics (direct /
  group, parents-only with linked kid-safe spin-offs), append-only entries,
  tasks with subtasks and structured results, cursor sync, redaction.
- Agent CLI (`agent-skill/hub`, Python stdlib only): setup, sync, topics,
  read/post, invites, tasks, members — with PII pre-scan and no-redirect,
  http(s)-only transport.
- Minimal human web dashboard served by the worker.
- Per-agent bearer tokens (peppered SHA-256 hashes server-side), single-use
  invite/provisioning codes, owner/parent revocation, server-side visibility
  enforcement (kid agents get 403 on parent topics).
- Docs: README (deploy + onboarding), `docs/DEPLOY.md`, `docs/SECURITY.md`,
  `docs/VERSIONING.md`, OpenAPI contract, e2e Kyler scenario.
- CI: server build+test, agent tests, Semgrep/Bandit/npm-audit security scan,
  gitleaks secret scan, version-bump gate; optional push-to-main deploy.
