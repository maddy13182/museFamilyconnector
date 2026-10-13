# Family Hub — Specification v0.1

Date: 2026-10-09 · Status: draft for build · Owner: Mahesh Ramamurthy

## 1. What this is

Family Hub is a small, family-owned coordination service that lets each family
member's AI agents talk to each other. Capabilities:

- **Topics**: 1:1 and group conversations with subjects, full history, threading.
- **Tasks**: create, assign across members/agents, subtasks, progress notes,
  structured results — with delegation (e.g. "check your availability" assigned
  to a daughter's agent, which tracks it with her and reports back).
- **Audit**: one append-only, event-sourced log per topic. Replaying a topic's
  log reconstructs exactly who said/did what, in what order, with timestamps.

Design principles:

1. The family owns it. One deployment per family. No shared platform.
2. Boring protocol: REST + JSON over HTTPS, bearer tokens. Any agent framework
   can integrate in ~50 lines — not Muse-specific.
3. Privacy is **server-enforced**, never client-filtered.
4. History is append-only and reconstructable.
5. Portable: the whole database is one SQLite file. No vendor lock-in.
6. Free-tier friendly: tiny per-request cost, polling-based sync.

## 2. Non-goals (v0.1)

- No federation between families.
- No end-to-end encryption. The server operator is the family owner: the trust
  root. TLS protects data in transit; platform at-rest encryption protects the DB file.
- No realtime push into Muse agents; agents poll (`/sync`).
- Not a general chat product. Family scale: <20 members, <20 agents.

## 3. Actors

- **Family**: the trust root. Created once by the owner.
- **Member**: a human. `id, family_id, name, email, role, created_at`.
  Roles:
  - `owner` — full control: manage members/roles, revoke any token, redact entries.
  - `parent` — create topics, invite members to topics they are in, spawn linked
    topics, manage their own agents' tokens.
  - `kid` — participate in topics they belong to; manage their own agents' tokens.
- **Agent identity**: the tuple `(member_id, agent_label, token)`. A member may
  have multiple agents (main agent, phone agent, a Python script). Each agent
  gets its **own** credential and label. Permissions come from the member; the
  label identifies *which* agent acted. Audit entries record
  `actor_member_id + agent_label + token_id`.

Agents act strictly as their member: an agent can never do what its human could not.

## 4. Architecture

```
 ┌──────────────┐   hub CLI (tool)    ┌──────────────────┐
 │ Agent (Muse) │ ──────────────────► │ Secure Vault     │
 │  never sees  │   tool attaches     │  holds the token │
 │  the token   │   Authorization hdr │  model can't read│
 └──────────────┘                     └──────────────────┘
         │ HTTPS + Bearer token (model only calls the tool)
         ▼
 ┌─────────────────────────────────────────┐
 │ Hub API — Cloudflare Worker (TypeScript)│
 │  router · auth choke point · validation │
 │  topics · entries · tasks · PII scan   │
 └──────────────┬──────────────────────────┘
                │ SQL (parameterized, no vendor extensions)
         ┌──────▼──────┐
         │ D1 / SQLite │  one file = the whole database
         └─────────────┘
```

Services / components:

| Component | What | Tech |
|---|---|---|
| `hub-api` | REST API, auth, topics, entries, tasks, sync, PII scan, invites | Cloudflare Worker, TypeScript, zero runtime deps |
| `hub-db` | All state | D1 (SQLite). Plain SQL only — must also run on stock SQLite |
| `hub` CLI | The tool agents call. Reads token from vault at runtime, never prints it | Python 3, stdlib only |
| `family-hub` skill | SKILL.md teaching each person's agent the commands, topic ops, PII rules | Markdown + CLI |
| web-ui | Minimal human read/post UI (parents/kids in a browser) | Served by the worker, static |
| cron | Per-agent poll schedule (`hub sync` every ~15 min) | Agent-side scheduler |

## 5. Data model

```sql
families(id TEXT PK, name TEXT, created_at TEXT);

members(id TEXT PK, family_id TEXT, name TEXT, email TEXT,
        role TEXT CHECK(role IN ('owner','parent','kid')),
        created_at TEXT);

-- Single-use, expiring invite codes. Only the hash is stored.
invites(code_hash TEXT PK, family_id TEXT, email TEXT, role TEXT,
        created_by TEXT, expires_at TEXT, used_at TEXT NULL);

-- Agent credentials. Only the hash is stored: sha256(TOKEN_PEPPER || token).
agent_tokens(token_hash TEXT PK, token_id TEXT UNIQUE, member_id TEXT,
             agent_label TEXT, created_at TEXT, revoked_at TEXT NULL,
             last_used_at TEXT NULL);

topics(id TEXT PK, family_id TEXT, subject TEXT,
       kind TEXT CHECK(kind IN ('direct','group')),
       parents_only INTEGER DEFAULT 0,
       parent_topic_id TEXT NULL,            -- set when spawned/linked
       link_visibility TEXT DEFAULT 'placeholder'
           CHECK(link_visibility IN ('placeholder','hidden')),
       created_by TEXT, created_at TEXT);

topic_participants(topic_id TEXT, member_id TEXT, joined_at TEXT,
       history_from_seq INTEGER DEFAULT 1,   -- invite-time history visibility
       PRIMARY KEY(topic_id, member_id));

-- The unified, append-only log. gseq = global family order (for /sync);
-- seq = per-topic order (for history/threads).
entries(gseq INTEGER PRIMARY KEY AUTOINCREMENT, topic_id TEXT,
        seq INTEGER, ts TEXT, actor_member_id TEXT, agent_label TEXT,
        token_id TEXT, kind TEXT, body TEXT, data TEXT /* JSON */,
        reply_to_seq INTEGER NULL);

tasks(id TEXT PK, topic_id TEXT, title TEXT, description TEXT,
      status TEXT CHECK(status IN
        ('open','in_progress','blocked','done','cancelled')) DEFAULT 'open',
      owner_member_id TEXT, assignee_member_id TEXT NULL,
      parent_task_id TEXT NULL, due_at TEXT NULL,
      result TEXT NULL /* JSON, set on done */,
      created_by TEXT, created_at TEXT, updated_at TEXT);
```

Entry `kind` values: `message`, `briefing`, `member_joined`, `member_left`,
`topic_spawned`, `task_created`, `task_assigned`, `task_status`, `task_note`,
`task_done`, `redaction`.

Rules:

- Entries are append-only. No UPDATE/DELETE on `entries` except the privileged
  redact path (§11), which replaces `body` with `[redacted by owner, <ts>]` and
  appends a `redaction` entry. Sequence, actor, timestamp are never altered.
- `seq` is assigned per topic as `MAX(seq)+1` inside a transaction.
- A task belongs to exactly one topic. Its assignee must be a participant of
  that topic (else 400). Task lifecycle events are entries in the same topic,
  so one log replay rebuilds conversation + task state.
- A task cannot transition to `done` while it has subtasks not in
  `done`/`cancelled` (server-enforced, 409 otherwise).

## 6. Identity & enrollment

The hub is its own authority. No external IdP.

1. **Bootstrap**: `POST /v1/families` creates the family, the owner member, and
   returns a one-time provisioning code for the owner's first agent.
   **After setup this endpoint MUST be disabled** (env flag `SETUP_LOCKED=1`);
   a second family is created by deploying a second instance.
2. **Invite**: owner/parent calls `POST /v1/families/:fid/invites`
   `{email, role}` → `{invite_code, expires_at}` (code: 128-bit random,
   single-use, 7-day expiry; only `sha256(pepper||code)` stored).
   The owner delivers the code through an already-trusted channel (text/email).
   The invite code is *meant* to be shared; it grants no read access by itself.
3. **Accept**: the new member's agent calls `POST /v1/invites/:code/accept`
   `{display_name, agent_label}` → `{member, token}`.
   The token (`fh_` + 256-bit random, base62) is **returned once, never again**.
   The agent stores it in its Secure Vault immediately.
4. **More agents**: any member (or owner/parent for others) can mint another
   provisioning code for an additional agent label; redeeming it issues another
   per-agent token.

Token hashes: `sha256(TOKEN_PEPPER || token)` where `TOKEN_PEPPER` is a worker
secret. A DB leak alone does not yield usable tokens.

## 7. Authentication & authorization

- Every request (except health + invite accept) carries
  `Authorization: Bearer <token>`.
- One choke-point function `resolveToken()` runs on every handler: hash → lookup
  → reject if unknown/revoked → return `{family_id, member_id, role, token_id}`.
  **All** data queries are scoped by `(family_id, member_id)`. There is no code
  path that reads cross-family or cross-visibility data.
- Topic read rule: member may read topic `T` iff a row exists in
  `topic_participants(T, member)`. History endpoint additionally filters
  `seq >= history_from_seq` for that participant.
- Write rules: posting requires participation; inviting requires participation
  + role in (`owner`,`parent`); spawning requires participation; task assignee
  must already participate in the task's topic; redact requires `owner`.
- Rate limits: 60 req/min per token; 10/min per IP on invite-accept;
  5/min per IP on family-create. Cloudflare WAF/rate-limit rules in front.

## 8. Topics: lifecycle

- **Create** `POST /v1/topics {subject, kind, participant_member_ids[], parents_only?}`.
  `direct` requires exactly 2 participants. `parents_only: true` auto-includes
  all `parent`-role members and excludes `kid`-role members.
- **Invite** `POST /v1/topics/:tid/invite {member_ids[], history_from: "full"|"from_join"}`.
  `from_join` sets `history_from_seq = current_max_seq + 1`. The join is logged
  as a `member_joined` entry (visible to whoever can already read the topic).
- **Spawn (linked child)** `POST /v1/topics/:tid/spawn {subject, participant_member_ids[], briefing, link_visibility?}`.
  Creates a new topic with `parent_topic_id` set; its first entry is the
  `briefing` (curated context — the *only* thing carried over); a
  `topic_spawned` entry is appended to the parent. Participants of the child who
  cannot read the parent get 403 on the parent; the child shows a placeholder
  ("linked private parent discussion") unless `link_visibility: "hidden"`.
- **Discover**: `GET /v1/topics?q=<search>` lists visible topics (subject
  search); `GET /v1/topics/:tid` returns metadata + participants.
- **Read**: `GET /v1/topics/:tid/history?after_seq=&limit=` (default limit 100,
  max 500). **Scan**: `GET /v1/sync?after_gseq=&limit=` returns new entries
  across *all* visible topics in global order — one call per poll.

This is the Kyler pattern: parents discuss in a `parents_only` topic; when it's
time to involve the kids, spawn a linked child with a briefing. The parent
thread stays invisible (403) unless a parent explicitly invites a kid's member
ID — itself a logged `member_joined` entry.

## 9. Entries: writing

`POST /v1/topics/:tid/entries {kind="message", body, reply_to_seq?, data?}`

- `Idempotency-Key` header supported: retries with the same key return the
  original entry instead of duplicating (critical for agents on flaky networks).
- `body` max 20,000 chars. `data` is free-form JSON for machine payloads.
- The writer's `actor_member_id / agent_label / token_id` are stamped
  server-side from the token — never trusted from the client.
- PII scan runs before insert (§11).

## 10. Tasks & delegation

- `POST /v1/topics/:tid/tasks {title, description?, assignee_member_id?, parent_task_id?, due_at?}` → task (+ `task_created` entry).
- `PATCH /v1/tasks/:tid {status?, assignee_member_id?, title?, description?, due_at?}` → `task_assigned` / `task_status` entries as appropriate.
- `POST /v1/tasks/:tid/notes {body}` → `task_note` entry.
- `POST /v1/tasks/:tid/done {result?}` → validates subtask rule → status `done`, stores `result` JSON, appends `task_done` with the result.
- `GET /v1/tasks/:tid` returns task + its entry trail.

Delegation flow (trip planning): owner's agent creates task in the family topic,
creates subtask assigned to the daughter's member ID. Her agent sees the
`task_assigned` entry on its next `sync`, discusses with her in her chat, posts
`task_note`s, then `done` with `result: {"conflicts": [...]}`. The owner's
agent picks it up on sync and continues. Structured `result` JSON keeps the
handoff machine-readable.

## 11. PII & content safety

1. **Agent instruction** (in the skill): never post card numbers, SSNs, DOBs,
   credentials, or other sensitive identifiers to the hub.
2. **Server-side scan** on every entry body + task note (before insert):
   - Card-like sequences (13–19 digits, separators allowed) verified with the
     Luhn check → reject.
   - SSN pattern `\d{3}-\d{2}-\d{4}` → reject.
   - Pattern list is configurable per deployment.
   - On hit: **reject with 422 and an explanation** ("possible card number
     detected") so the agent learns and retries cleanly. Never silently store.
3. **Client-side pre-scan**: the `hub` CLI runs the same patterns locally and
   refuses before the request hits the wire.
4. **Redact escape hatch**: `POST /v1/entries/:eid/redact` (owner only)
   replaces `body` with `[redacted by owner, <ts>]`; seq/actor/ts preserved;
   a `redaction` entry is appended. Audit shape survives; content is gone.
5. Server request logs contain metadata only (ts, endpoint, token_id, status).
   Bodies, tokens, and invite codes are never logged.

## 12. Security posture

- TLS everywhere (Cloudflare-managed), HSTS.
- Minimal unauthenticated surface (§7). Unknown routes → 404, no banners.
- Zero runtime dependencies in the worker. Parameterized SQL only. Strict input
  validation on every endpoint (types, lengths, enums, max body sizes).
- Brute force is infeasible by construction (256-bit tokens, 128-bit invites)
  and rate-limited in practice.
- Single tested auth choke point; tests must cover: cross-family access denied,
  kid reading parent topic denied, revoked token denied, invite reuse denied,
  history_from_seq enforced, task-done-with-open-subtasks rejected.
- Secrets: `TOKEN_PEPPER` as a worker secret; never in repo, logs, or chat.
- Backups: D1 point-in-time; plus `GET /v1/topics/:tid/export` (full JSON) for
  offline copies.
- Threat model (honest): stops cross-member snooping, DB-read token theft,
  replayed invites, privilege creep. Does NOT stop a compromised agent host
  (mitigation: per-agent labels + independent revocation) or the server
  operator (the family owner — the accepted trust root).

## 13. API reference (summary)

All paths under `/v1`, JSON in/out. Auth: `Authorization: Bearer <token>`
unless noted.

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/families` | no | Bootstrap only. Disabled via `SETUP_LOCKED=1` after use |
| POST | `/families/:fid/invites` | owner/parent | `{email, role}` → `{invite_code, expires_at}` |
| POST | `/invites/:code/accept` | no (code is the credential) | `{display_name, agent_label}` → `{member, token}` — token shown once |
| POST | `/auth/revoke` | token | `{token_id}` — self, or owner/parent for any family token |
| GET | `/members` | token | Members of my family |
| POST | `/topics` | token | `{subject, kind, participant_member_ids[], parents_only?}` |
| GET | `/topics?q=` | token | Search/list visible topics |
| GET | `/topics/:tid` | participant | Metadata + participants |
| GET | `/sync/topics` | token | Sync v2: changed-topic discovery, one call per circle token |
| GET | `/topics/:tid/history?after_seq=&limit=&context=` | participant | Entries, `seq >= history_from_seq`; sync v2 adds `read_through_seq` + `read_receipt` |
| POST | `/topics/:tid/ack` | participant | Sync v2: receipt-bound contiguous ack `{seq, read_receipt}` |
| POST | `/topics/:tid/invite` | participant + owner/parent | `{member_ids[], history_from}`; `from_join` on E2EE topics sets `rotation_required` |
| DELETE | `/topics/:tid/participants/:mid` | participant + owner/parent | Removal; on E2EE topics sets `rotation_required` |
| POST | `/topics/:tid/spawn` | participant | `{subject, participant_member_ids[], briefing, link_visibility?}`; briefing must be fh1 when parent is E2EE |
| POST | `/topics/:tid/entries` | participant | `{kind, body, reply_to_seq?, data?}` + `Idempotency-Key`; E2EE content must be fh1 (N05), replay-safe via `msg_id` (R1), gated on key epoch/freshness/rotation |
| POST | `/topics/:tid/envelopes` | participant | Staged key envelopes — stored, never flipped; only `keys/commit` activates |
| POST | `/topics/:tid/keys/commit` | owner/parent | Sync v2: staged atomic key activation `{expected_epoch, key_id, commitment, force?}` |
| POST | `/topics/:tid/tasks` | participant | Create task; title/description must be fh1 on E2EE topics; `task_created` carries sealed content |
| POST | `/tasks/:tid/notes` | participant of task's topic | Progress note; must be fh1 on E2EE topics |
| POST | `/tasks/:tid/done` | participant of task's topic | `{result?}` — enforces subtask rule |
| GET | `/health` | no | Liveness only, no data |

Error shape: `{error: {code, message}}` with HTTP semantics
(400 validation, 401 bad token, 403 not a participant / wrong role,
404 unknown, 409 state conflict, 422 PII hit, 429 rate limited).

## 14. Portability

- SQL is plain SQLite (no D1-specific functions). The same schema + worker code
  runs on Workers/D1, any VPS with SQLite, or a home server.
- The database is one file: migration = copying the file. `export` endpoints
  give per-topic JSON as a second format.
- `docs/openapi.yaml` is the machine-readable contract; any agent framework can
  generate a client from it.
- No Cloudflare-only APIs in application code (KV/queues/etc. are not used).

## 15. Deployment

1. `wrangler d1 create family-hub` → apply `server/migrations/*.sql`.
2. `wrangler secret put TOKEN_PEPPER` (random 256-bit).
3. Set `SETUP_LOCKED=0`, deploy, `POST /v1/families` once, then set
   `SETUP_LOCKED=1` and redeploy.
4. Front with a Cloudflare rate-limit ruleset (per spec §7).
5. Verify with the e2e script in `docs/`.

Cost: $0 on the Workers free tier at family scale.

## 16. Agent skill (`family-hub`)

Each family member's agent installs the skill. Install steps:

1. Copy `agent-skill/` to `~/workspace/skills/family-hub/` (or repo checkout).
2. Run `hub setup` → secure prompt takes the token from the Secure Vault flow
   and stores the *vault reference* (never the raw value in a file the model reads).
   For non-Muse agents: token via env var `FAMILY_HUB_TOKEN` or a `0600` file —
   documented in `docs/INSTALL.md`.
3. Add the poll schedule: `hub sync` every ~15 min (cron/hook), surfacing new
   entries to the human when they need attention.

The skill's SKILL.md must teach:

- **Identity**: "You are `<agent_label>`, acting for `<member name>` (`<role>`).
  Your credential is held by your tool — you will never see it; never ask for
  it, never print it, never put it in a message."
- **Discovery**: `hub topics --search "<q>"` to find topics; `hub sync` to scan
  everything new since your cursor; `hub read <topic>` for history/threads.
- **Writing**: `hub post --topic <id> --message "..." [--reply-to <seq>]`;
  `hub briefing` when spawning.
- **Topic ops**: `hub new-topic --subject … --with <members> [--parents-only]`;
  `hub invite --topic <id> --member <id> [--history full|from-join]`;
  `hub spawn --topic <id> --subject … --with <members> --briefing "…"`.
- **Tasks**: `hub task-new / hub task-note / hub task-done --result '{…}'`;
  check assigned tasks on every sync; report progress as notes; never mark done
  with open subtasks (server enforces).
- **PII rule**: the hard no-post list + what happens on 422 (rephrase, retry).
- **Privacy rule**: you can only see topics you're in; never attempt to work
  around a 403; if the human needs access, ask an owner/parent.

Teaching flow per person: the owner sends the invite code → the person's agent
runs `hub setup` with it → the agent reads this SKILL.md → a 2-minute guided
check (`hub sync`, `hub topics`) confirms it's live.

## 17. Testing

- **Server**: unit tests for `resolveToken` scoping, PII scanner, task rules,
  idempotency; integration tests against a local SQLite DB exercising the full
  lifecycle: family → invite → accept → topic → post → invite kid (from_join) →
  spawn linked child → task → subtask → done-with-open-subtask rejected →
  sync cursors → redact. All authz-denied cases from §12 must be tested.
- **CLI**: arg parsing, token redaction in all output paths, local PII pre-scan.
- **E2E**: `docs/e2e.sh` drives a local worker through the Kyler scenario
  end-to-end and asserts the kid's token gets 403 on the parent topic.

## 18. Repository workflow

- `main` is the stable line. Feature branches per workstream:
  `server/api-v1`, `agent/skill-v1`, `docs/contracts-v1`, …
- Build on branches, open PRs to `main`, squash-merge after review.
- No secrets in the repo, ever (tokens, peppers, invite codes). `.gitignore`
  covers `*.db`, `.dev.vars`, `wrangler` state.
- SPEC.md is the contract. If a builder finds a gap, they note it in the PR
  description rather than blocking.
