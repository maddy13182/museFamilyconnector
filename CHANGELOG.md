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
## Added
- In-worker rate limiting for the two unauthenticated credential endpoints
  (`POST /v1/invites/:code/accept`, `POST /v1/provisioning-codes/:code/redeem`):
  10 attempts per 10 minutes per IP, then 429 with `Retry-After`. Backed by a
  fixed-window counter in D1 (migration 0007). workers.dev has no custom zone
  so Cloudflare's zone-based rate-limiting rules don't apply — this closes
  that gap. Legitimate use (1-2 attempts) is unaffected.
## Added
- E2EE Phase 1 — agent identity key infrastructure. **E2EE requires a fresh
  database — existing D1 data is not migrated** (clean slate at the v0.7.0
  deploy, on the owner's explicit go-ahead; the E2EE tables live in the base
  schema, `server/migrations/0001_init.sql`).
- Server: `agent_keys` table (one active X25519 public key per
  `(member_id, agent_label)`; rotation marks the old key superseded, never
  deleted), plus the Phase 2 schema placeholders `topics.e2ee` and
  `topic_key_envelopes`.
- Server: `POST /v1/provisioning-codes/:code/redeem` accepts an optional
  `agent_public_key` (standard base64, exactly 32 bytes when decoded; 400
  otherwise), stored bound to `(member_id, agent_label)` in the same atomic
  batch as the token issuance. Redeeming without it behaves exactly as
  before — plaintext topics keep working.
- Server: `GET /v1/agent-keys` key directory (authenticated; only keys of
  members the caller shares a circle with) and `POST /v1/agent-keys/rotate`
  (bearer-token-authenticated registration/rotation).
- CLI: `hub` now depends on PyNaCl and the `mnemonic` package (pinned in
  `agent-skill/requirements.txt`) — this ends the stdlib-only property.
  Key commands fail with a clear install message when they are missing;
  all other commands keep working without them.
- CLI: `hub setup` generates the agent's X25519 identity keypair locally
  (`~/.config/family-hub/profiles/<name>/agent.key`, mode 0600), registers
  the public key at redeem time, and prints a 24-word BIP-39 recovery
  phrase once.
- CLI: new commands `hub key-init` (generate + register for existing
  agents; idempotent), `hub key-backup` (Argon2id-encrypted backup file),
  and `hub key-restore` (from phrase or backup file). The private key never
  leaves the machine, is never printed, and never appears in logs.
## Added
- E2EE Phase 3 — encrypted messaging (CLI only; no server changes).
- CLI: `hub post` to an E2EE topic encrypts `(body, data)` with
  XChaCha20-Poly1305 under the topic key from the local keystore
  (`topic_keys/<topic_id>.json`). Each encrypted field is one wire string:
  `fh1.<key_id_hex>.<msg_id_hex>.<base64(nonce || ciphertext)>` — random
  192-bit nonce and random 128-bit client message id per field, ciphertext
  stored in the existing `entries.body`/`entries.data` columns (base64
  TEXT, opaque to the server). The AAD is the canonical byte string
  `b"fh-msg-v1" + NUL + topic_id + NUL + key_id_hex + NUL + msg_id_hex`, so
  ciphertext cannot be cut-and-pasted across topics or key rotations, and
  one message's ciphertext cannot be replayed as another entry. (The design
  asked for `seq` in the AAD; `seq` is assigned server-side at insert and
  unknowable before POST, so the client-chosen `msg_id` takes its place —
  see the `hub` source header for the full rationale.)
- CLI: `hub post` to an E2EE topic with no local topic key fails loudly
  with `hub key-request` guidance — nothing is posted, never plaintext.
- CLI: `hub read` / `hub sync` auto-detect E2EE topics (one topic-record
  fetch per topic per run, cached — never per entry) and decrypt after
  fetching, selecting the key by the plaintext `key_id` on each entry.
  Tampered or malformed ciphertext raises a loud error naming the entry
  (tamper evidence); a missing key shows a per-entry placeholder instead of
  ciphertext; server-written plaintext entries (e.g. redaction notices)
  pass through untouched. Plaintext topics behave byte-identically.
- CLI: `hub topics` decrypts E2EE topic subjects client-side for display
  (Phase 2 subject format); subjects show as `[encrypted]` when the key is
  not available locally.
- CLI: the local PII pre-scan (`check_pii`) is the enforcement point for
  E2EE topics — it runs on the plaintext body and the canonical data JSON
  before encrypting, since the server cannot scan ciphertext.
- E2EE Phase 6 — polish. Server: the dashboard's E2EE topic view is now
  metadata-only with an honest, prominent "Content encrypted — the server
  cannot read this topic." label; encrypted subjects render as
  `🔒 [encrypted]` (never the ciphertext blob), encrypted bodies are hidden,
  plaintext system events (key rotations, archive notices) and the
  "retired → continues at <successor>" archive banner stay visible, and
  posting from the dashboard is disabled on encrypted topics. Key import
  into the dashboard is explicitly deferred (stated in the UI). Docs:
  `docs/CONCEPTS.md` states the per-topic E2EE trust model (content hidden,
  metadata visible, plaintext topics unchanged); `docs/SECURITY.md` gains
  the E2EE threat-model addition, key-management responsibilities, and the
  key-loss runbook (`hub recover` exit 2 documented as "parked, waiting on
  a human"); `docs/INSTALL.md` gains an E2EE setup section;
  `docs/AGENT_JOIN.md` gains the joining-agent E2EE section; and the new
  `docs/E2EE_FRESH_DEPLOY.md` is the step-by-step runbook for the v0.7.0
  clean-slate production deploy (D1 wipe, schema, re-enrollment).
  CLI/SKILL.md: identity key commands (`key-init`, `key-backup`,
  `key-restore`) and `new-topic --e2ee` added to the command reference.
- E2EE Phase 5 — recovery (the abandonment antidote). Server: new
  client-postable plaintext system entry kind `topic_archived` for the
  total-loss case (entries CHECK widened in the 0006 rebuild; accepted on
  `POST /v1/topics/:id/entries` like the other E2EE system kinds).
  CLI: `hub recover [--topic <id>]` walks the recovery ladder inline and
  narrates every rung — rung 1 restores the identity key from a local
  key-backup file (conventional locations, `--backup-file`, or prompted
  path) or the 24-word recovery phrase; rung 2 re-registers a fresh keypair
  and posts a member-approved `key-request` (`--wait` polls for the grant,
  otherwise the command exits 2 with the request posted and waiting);
  rung 3 detects a missing/expired Bearer token and prints exact
  out-of-band provisioning-code instructions for a human to relay. Rungs
  are never silently skipped. CLI: `hub topic-archive --topic <id>
  --successor <new-id> --reason "…"` (explicit confirmation, `--yes` to
  bypass) posts the `topic_archived` entry naming the successor — the old
  topic is never deleted and stays readable for key-holders. SKILL.md
  gains the hard rule: never create a replacement topic for key-loss
  reasons without completing `hub recover` first.
## Added
- E2EE Phase 4 — membership changes + re-keying. Server: `DELETE
  /v1/topics/:tid/participants/:mid` (owner/parent only, same 403 rule as the
  topic invite endpoint; appends a plaintext `member_left` system entry;
  removed members keep their old envelopes but can no longer be sent new
  ones), plus three client-postable plaintext system entry kinds
  (`key_rotated`, `key_request`, `pending_key_distribution`) for E2EE
  membership flows. CLI: `hub topic-add-member` (seals the current topic key
  for a new member's agents — current key only, never old keys; visible
  pending notice when they have no registered keys), `hub
  topic-remove-member`, `hub topic-rekey` (new key + fresh envelopes for all
  remaining agents, old keys retained locally, plaintext `key_rotated`
  announcement), `hub key-request` / `hub key-grant` (visible request, human-
  approved grant only — no auto-fulfillment), `hub key-fetch`, and `hub
  topic-key-status`. `hub sync` now refreshes key envelopes for E2EE topics
  before decrypting, so rotations land on first sight.
## Added
- E2EE Phase 2 — E2EE topics + key envelopes.
- Server: `POST /v1/topics` accepts optional `e2ee: 0|1` (default 0).
  `e2ee=1` requires the creator's agent to have a registered identity key in
  `agent_keys` (400 with `hub key-init` guidance otherwise); the subject may
  arrive already encrypted (opaque to the server, stored as-is).
- Server: `POST /v1/topics/:id/envelopes` — stores one sealed topic-key
  envelope per recipient agent. The caller must be a current participant
  (403 otherwise); the target `(member_id, agent_label)` must be a current
  participant with an ACTIVE (non-superseded) registered public key (400
  otherwise). The envelope blob is stored opaquely, never inspected.
  Re-POSTing the same `(topic_id, member_id, agent_label, key_id)` replaces
  the envelope (idempotent distribution).
- Server: `GET /v1/topics/:id/envelopes` — returns ONLY the caller's own
  envelopes (matched on the Bearer token's `(member_id, agent_label)`); 403
  for non-participants. One agent can never fetch another's envelopes.
- Server: plaintext topics (`e2ee` absent/0) behave exactly as before.
- CLI: `hub new-topic --e2ee --subject … --with …` — generates the 32-byte
  topic key + random 128-bit key_id locally, encrypts the subject with
  XChaCha20-Poly1305 (random 192-bit nonce prepended, base64; AAD is the
  fixed context `fh-topic-subject-v1` since the topic_id isn't known yet),
  seals one envelope per participant agent (`crypto_box_seal` over
  `key_id || topic_key`), verifies the round-trip by fetching and opening
  its own envelope, and stores `key_id → base64 topic key` at
  `~/.config/family-hub/profiles/<name>/topic_keys/<topic_id>.json` (0600).
  Fails with `hub key-init` guidance when the local keypair is missing
  (never auto-generated here). The topic key is registered for redaction and
  never printed.
- `Server:` circle ownership can now be handed over with a two-phase offer → accept flow: `POST /v1/families/:id/transfer` offers ownership to a member, `POST …/transfer/accept` accepts it — the owner swap is atomic — `POST …/transfer/cancel` withdraws a pending offer, and `GET …/transfer` shows the transfer status. Nothing changes until the offer is accepted, and a pending offer can be cancelled at any time.
- `CLI:` `hub circle transfer --to <member-id> [--on-complete remove]`, `hub circle transfer-accept`, `hub circle transfer-status`, and `hub circle transfer-cancel` mirror the server flow — e.g. to make someone else the owner of a circle you created on their behalf and then step down.
- Agents can now request a circle be provisioned and handed over through a documented agent-to-agent protocol: a `circle_request` message starts it, `circle_provisioned` confirms the circle and the pending transfer, and a 7-step runbook covers create → invite → out-of-band code delivery → join → offer → accept → verify-and-mute. Full protocol in `docs/CIRCLE_PROVISIONING.md`. Invite codes still travel out-of-band only — they are never posted on Hub topics.
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
## Fixed
- Invite-accept (`POST /v1/invites/:code/accept`) and circle-create
  (`POST /v1/families`) no longer hand-build member objects: both serialize
  through `publicMember()`, the single canonical member serializer. A
  hand-built object had omitted `family_id`, crashing the CLI's `circle join`
  after the token was issued but before it was saved (invite spent, token
  lost). Regression test asserts the field is present.
- CLI `circle join` hardening: the issued token is now treated as
  irreplaceable. If a redeem response ever lacks `family_id` again, the CLI
  resolves the circle via `GET /v1/families` with the new token instead of
  crashing; if even that fails, the token is persisted under a pending key
  with a precise recovery step rather than being dropped.
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
