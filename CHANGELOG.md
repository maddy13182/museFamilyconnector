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
- Server: fixed credential-lifecycle gaps (audit F01/F04/F05/F17). Minting a provisioning code for another member is now owner-only (self-mint still allowed for every role), and a parent can no longer mint for, or revoke the token of, an owner-role member. Revocation is immediate and unconditional — it overwrites any future rotation-grace timestamp — and rotating an already-retired (grace-window) credential is denied. Redeeming a provisioning code or accepting an invite is now an atomic conditional consume, so concurrent uses of the same code produce exactly one token/member. New `issued_by_token_id` lineage on provisioning codes and agent tokens (migration 0004, additive): revoking a token expires its pending codes and revokes its one-level descendant tokens (grandchildren are out of scope); rotated tokens are replacements, not delegations, so they are not cascade targets.
- CLI: `hub setup` and `hub circle join` now validate the credential sink (writable profile directory, a vault helper that parses and exists on PATH, a settable env var) *before* redeeming the single-use invite code, and verify the new token with `GET /v1/me` before reporting success — a failed persist can no longer silently burn the code. Failures say plainly whether the code may be consumed and to ask an owner for a fresh one.
- CLI (security): the enrollment server origin is now pinned — `--server` no longer silently redirects the stored credential; a differing override requires `--allow-server-override` and always prints a loud stderr warning. Plain `http://` URLs are rejected for non-loopback hosts (`https://` required; `http://localhost` / `127.0.0.1` / `[::1]` still allowed for development), including in the HTTP transport itself.
- Docs: `hub dashboard-token` is now documented as a human admin command — agents must never run it or transmit its output; the skill's agent-facing commands never print raw credentials.
- Server (security): cross-circle identity is now keyed by stable principal IDs (audit F02). Migration 0005 (additive) adds a `principals` table and a nullable `members.principal_id`, backfilled one principal per distinct member email — the backfill's documented trust assumption, since email was the de-facto identity when those rows were created. `isHubOwner` and `GET /v1/families` now match on `principal_id`, never the email string: a member row that merely shares an email with another circle's owner gains no hub-owner powers, sees none of that circle's metadata, and cannot create circles while setup is locked. New member rows get a fresh principal (an invite code proves code possession, not email ownership); the only post-migration cross-circle linking path is locked circle creation, which carries the already-verified caller's principal onto the new member row. Emails remain plain attributes for invites and display, never identity keys. Behavior note: accepting an invite no longer links the new membership to existing memberships that share the email — each token's circle list reflects only its own verified principal chain.
- Server: dashboard "Create group topic with me" now resolves your identity via `GET /v1/me` (the member bound to your token) instead of taking the first member in the roster — previously a non-owner clicking it could create a topic that disclosed to the owner.
- Server: every worker response now carries security headers (`Content-Security-Policy`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`). The dashboard's inline script/style keep working — the policy documents why `'unsafe-inline'` is accepted there.
- CLI: `hub me` now reports the active circle's member from the server (`GET /v1/me`) instead of the stale locally cached record.
- Docs: `docs/openapi.yaml` re-aligned with the actual server — documented the missing `GET /v1/me` and `GET /v1/families` endpoints, the real `rotate` (`grace_until`) and `revoke` (`{ok: true}`) response shapes, `family_id` on roster member objects, the idempotent-retry (`deduped`) variants, the extra fields on code-reuse 409s, and `has_more` on `/v1/sync`; removed the fictional `setup_locked` error code.
- Docs: rate limiting is now described honestly — the worker enforces no rate limits; throttling comes only from Cloudflare edge rules the operator configures (`docs/INSTALL.md` §5). The free plan's single rule should guard provisioning-code redemption, the highest-value endpoint.
- Server: task list (`GET /v1/topics/:tid/tasks`), task detail
  (`GET /v1/tasks/:tid`), and topic export now honor the topic's from-join
  history floor — a member invited with `history_from: from_join` no longer
  sees tasks created before they joined.
- Server: the from-join cutoff (`history_from_seq`) is now computed inside
  the same atomic transaction as the membership insert, closing a race where
  a stale cutoff could expose entries posted between the read and the insert.
- Server: the PII scanner now also checks entry `data` (JSON string leaves,
  recursively), task titles (create and patch), and task completion results;
  hits are rejected with 422 as before.
- Server: owner redaction now also scrubs PII-shaped string leaves in entry
  `data` (structure-preserving). Task rows have no redact endpoint — see
  `docs/SECURITY.md` "PII scanner — honest limits" for the documented gap.
- Server: `GET /v1/sync` pagination is now page-based instead of head-based.
  The cursor (`next_after_gseq`) is always the last returned entry's gseq —
  previously it jumped to the global max, silently skipping entries when the
  backlog exceeded `limit`. The endpoint fetches `limit`+1 rows, returns
  `has_more: true` while backlog remains, and no longer runs a second
  MAX query per poll. `max_gseq` is kept for contract compatibility as the
  max of the returned page.
- CLI: multi-circle `hub sync` no longer advances a circle's cursor before its
  output is emitted. Each circle's entries are held in memory and emitted
  first; cursors persist only after emission and only when every circle
  succeeded. If one circle fails, the others' entries are still shown, each
  failure is reported per circle, and the command exits non-zero — so a retry
  re-delivers the unacknowledged entries instead of losing them.
- Server: task state changes, their audit events, and idempotency outcomes now
  commit in a single atomic batch. Creating a task writes its `task_created`
  event in the same transaction (a failed event write can no longer leave an
  orphan task); completing a task writes `task_done` in the same batch as the
  status flip; PATCH writes `task_updated`/`task_assigned`/`task_status`
  alongside the update; and posting an entry writes its idempotency-key record
  in the same batch as the entry. Entry sequence numbers are computed inside
  the insert statement, with one automatic retry on a seq race.
- Server: `task_created` events now carry the full task fields (title,
  description, due date, status, owner, assignee, parent, creator,
  timestamps) so the log can reconstruct task state. PATCHing a task's
  title, description, or due date emits a new `task_updated` event with the
  changed fields (previously silent).
- Server: `GET /v1/tasks/:tid` now pages the entry trail (`after_seq`,
  `limit`, `has_more`, `next_after_seq`) via a single indexed SQL query on
  the new `idx_entries_task_trail` index, instead of fetching up to 5,000
  topic entries and filtering in code. Migration 0006 also widens the
  entries kind check to allow `task_updated` (table rebuilt, rows preserved).
- Server: completing a task with a malformed JSON body now returns 400
  instead of silently treating it as empty; an absent body still completes
  the task.
- Server: creating an open subtask under a completed or cancelled parent is
  now denied with 409 `parent_completed`, and the parent-status check is part
  of the insert itself. Completing a task (via `POST /done` or
  `PATCH status=done`) now enforces the open-subtask rule inside the update
  statement, so a subtask created between the check and the write can no
  longer slip through.
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
