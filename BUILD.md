# Family Hub — Build Plan v0.1

## Workstreams (parallel, all read SPEC.md as the contract)

### WS-1 · Server (`server/`) → branch `server/api-v1`
Cloudflare Worker (TypeScript, **zero runtime dependencies**) + D1/SQLite.

Deliverables:
- `server/wrangler.toml`, `server/src/index.ts` (router + all `/v1` handlers),
  `server/src/auth.ts` (single `resolveToken()` choke point),
  `server/src/pii.ts` (card-Luhn + SSN scan, configurable patterns),
  `server/src/validate.ts` (strict input validation),
  `server/migrations/0001_init.sql` (exact schema from SPEC §5),
  `server/README.md` (deploy steps incl. `SETUP_LOCKED` flow).
- Tests: unit (auth scoping, PII, task rules, idempotency) + integration
  against local SQLite covering the full lifecycle and every denied case in
  SPEC §12. `npm test` must pass offline (no Cloudflare account needed;
  use miniflare/workerd locally if available, else node:test + better-sqlite3
  or a documented alternative — stdlib preferred, one dev-dep max).
- Serves a minimal `web-ui` (static read/post page) from the worker.

Acceptance: e2e script passes; `wrangler deploy --dry-run` clean; no secrets
in repo; every endpoint from SPEC §13 implemented with the specified error shape.

### WS-2 · Agent side (`agent-skill/`) → branch `agent/skill-v1`
The `hub` CLI + the `family-hub` skill.

Deliverables:
- `agent-skill/hub` — Python 3, **stdlib only**. Subcommands:
  `setup`, `sync`, `topics [--search]`, `read`, `post`, `new-topic`, `invite`,
  `spawn`, `task-new`, `task-note`, `task-done`, `tasks`.
  - Reads the token from the Secure Vault reference / `FAMILY_HUB_TOKEN` /
    `0600` file (documented precedence); **never prints the token** in any
    output, including `--debug` (redact).
  - Local PII pre-scan before POST (same patterns as server).
  - `sync` keeps a local cursor file and prints new entries as JSON.
- `agent-skill/SKILL.md` — teaches the agent per SPEC §16: identity, discovery
  (search/scan/read), writing, topic ops (create/invite/spawn/link), task ops,
  PII rule, privacy rule, "never reveal the credential".
- `agent-skill/INSTALL.md` — per-person install: copy skill, `hub setup` with
  invite code, cron/hook for `hub sync` every 15 min, 2-minute live check.
- Tests for arg parsing, redaction, pre-scan.

Acceptance: CLI drives a local server through invite→topic→spawn→task→sync
without the token ever appearing in stdout/stderr; SKILL.md lets a fresh agent
complete the guided check unaided.

### WS-3 · Contracts & docs (`docs/`) → branch `docs/contracts-v1`
Deliverables:
- `docs/openapi.yaml` — full OpenAPI 3.1 for SPEC §13 (must match SPEC exactly).
- `docs/INSTALL.md` — end-to-end: deploy server, onboard owner, invite family,
  install skill per person, set up polling.
- `docs/SECURITY.md` — threat model, hardening checklist, incident runbook
  (token leak → revoke/reissue; PII posted → redact).
- `docs/e2e.sh` — drives a local worker through the Kyler scenario and asserts:
  kid token 403s on parent topic, spawn briefing visible, task delegation
  round-trips, PII post rejected with 422, idempotent retry dedupes.

Acceptance: openapi validates (e.g. `npx @redocly/cli lint`); e2e.sh green
against WS-1's server.

## Branch & PR workflow

- `main`: stable. Work happens on the branches above.
- PRs target `main`; squash-merge after review by the owner (Mahesh) or his agent.
- Remote: Mahesh will provide his personal git repo later — **do not invent a
  remote; do not push anywhere**. Commit locally on your branch.
- If SPEC has a gap, note it in the PR description; don't block.

## Repo conventions

- No secrets in the repo. Ever. (tokens, peppers, invite codes, `.dev.vars`)
- Python: stdlib only. TypeScript: zero runtime deps.
- Every user-facing number/behavior in docs must match SPEC.
- Keep diffs reviewable; small commits with clear messages.
