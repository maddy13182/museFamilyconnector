-- Family Hub schema v0.1 — plain SQLite only (no D1-specific functions).
-- Tables families/members/invites/agent_tokens/topics/topic_participants/
-- entries/tasks are exactly per SPEC §5. Two extra tables below (SPEC gap):
--   provisioning_codes — SPEC §6 step 4 requires mint/redeem of per-agent
--     provisioning codes, but §13 lists no endpoints; both are implemented.
--   idempotency_keys — backs the Idempotency-Key header on POST entries (§9).
--
-- E2EE (v0.7.0+, clean slate): the agent_keys and topic_key_envelopes
-- tables and the topics.e2ee column below are part of the BASE schema.
-- They are NOT backfilled onto existing databases — E2EE requires a fresh
-- database (production D1 is wiped at the v0.7.0 deploy, on the owner's
-- explicit go-ahead). There is deliberately no 0008 migration.

CREATE TABLE families(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE members(
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('owner','parent','kid')),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_members_family ON members(family_id);

-- Single-use, expiring invite codes. Only the hash is stored:
-- sha256(TOKEN_PEPPER || code).
CREATE TABLE invites(
  code_hash TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id),
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('owner','parent','kid')),
  created_by TEXT NOT NULL REFERENCES members(id),
  expires_at TEXT NOT NULL,
  used_at TEXT NULL
);

-- Agent credentials. Only the hash is stored: sha256(TOKEN_PEPPER || token).
-- revoked_at in the FUTURE means "rotation grace": still valid until then.
CREATE TABLE agent_tokens(
  token_hash TEXT PRIMARY KEY,
  token_id TEXT NOT NULL UNIQUE,
  member_id TEXT NOT NULL REFERENCES members(id),
  agent_label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT NULL,
  last_used_at TEXT NULL
);
CREATE INDEX idx_agent_tokens_member ON agent_tokens(member_id);

-- Single-use, short-lived provisioning codes for minting extra agent tokens.
-- Only the hash is stored: sha256(TOKEN_PEPPER || code).
CREATE TABLE provisioning_codes(
  code_hash TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id),
  member_id TEXT NOT NULL REFERENCES members(id),
  agent_label TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES members(id),
  expires_at TEXT NOT NULL,
  used_at TEXT NULL
);

CREATE TABLE topics(
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id),
  subject TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('direct','group')),
  parents_only INTEGER NOT NULL DEFAULT 0,
  parent_topic_id TEXT NULL REFERENCES topics(id),
  link_visibility TEXT NOT NULL DEFAULT 'placeholder'
    CHECK(link_visibility IN ('placeholder','hidden')),
  -- E2EE (v0.7.0+, clean slate): 1 = end-to-end encrypted topic, 0 =
  -- plaintext. Per-topic opt-in; plaintext topics behave exactly as before.
  e2ee INTEGER NOT NULL DEFAULT 1 CHECK(e2ee = 1),
  -- E2EE key election (secfix F1): the key_id (32 hex chars) of the CURRENT
  -- topic key. Set at E2EE topic creation from the creator's initial_key_id;
  -- afterwards only an owner/parent may introduce a new key_id (rotation),
  -- which advances this column atomically with the envelope insert. NULL
  -- for plaintext topics. Clients elect the encryption key from this column,
  -- never from envelope recency (created_at is forgeable via re-POST).
  current_key_id TEXT NULL,
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_topics_family ON topics(family_id);

CREATE TABLE topic_participants(
  topic_id TEXT NOT NULL REFERENCES topics(id),
  member_id TEXT NOT NULL REFERENCES members(id),
  joined_at TEXT NOT NULL,
  history_from_seq INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(topic_id, member_id)
);
CREATE INDEX idx_participants_member ON topic_participants(member_id);

-- The unified, append-only log.
-- gseq = global family order (for /sync); seq = per-topic order.
CREATE TABLE entries(
  gseq INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id TEXT NOT NULL REFERENCES topics(id),
  seq INTEGER NOT NULL,
  ts TEXT NOT NULL,
  actor_member_id TEXT NOT NULL REFERENCES members(id),
  agent_label TEXT NOT NULL,
  token_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN (
    'message','briefing','member_joined','member_left','topic_spawned',
    'task_created','task_assigned','task_status','task_note','task_done',
    'redaction')),
  body TEXT NOT NULL,
  data TEXT NULL,            -- JSON, machine payloads
  reply_to_seq INTEGER NULL,
  UNIQUE(topic_id, seq)      -- lets writers re-read their row after insert
);
CREATE INDEX idx_entries_topic_seq ON entries(topic_id, seq);
CREATE INDEX idx_entries_gseq ON entries(gseq);

CREATE TABLE tasks(
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES topics(id),
  title TEXT NOT NULL,
  description TEXT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN
    ('open','in_progress','blocked','done','cancelled')),
  owner_member_id TEXT NOT NULL REFERENCES members(id),
  assignee_member_id TEXT NULL REFERENCES members(id),
  parent_task_id TEXT NULL REFERENCES tasks(id),
  due_at TEXT NULL,
  result TEXT NULL,          -- fh1 ciphertext of JSON, set on done
  created_by TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_tasks_topic ON tasks(topic_id);
CREATE INDEX idx_tasks_parent ON tasks(parent_task_id);

-- Idempotency-Key support for POST entries (§9). Keys expire; scoped per token.
CREATE TABLE idempotency_keys(
  token_id TEXT NOT NULL,
  key TEXT NOT NULL,
  entry_gseq INTEGER NOT NULL REFERENCES entries(gseq),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY(token_id, key)
);

-- E2EE agent identity public keys (Phase 1). Public keys are public: no
-- secrecy is needed and the column is deliberately NOT hashed. Rows are
-- never deleted — rotation marks the old row superseded so envelopes
-- sealed to it (Phase 2+) still resolve. At most one ACTIVE
-- (superseded_at IS NULL) row per (member_id, agent_label), enforced by
-- the partial unique index below.
CREATE TABLE agent_keys(
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES members(id),
  agent_label TEXT NOT NULL,
  public_key TEXT NOT NULL,      -- base64; must decode to exactly 32 bytes (X25519)
  created_at TEXT NOT NULL,
  superseded_at TEXT NULL        -- NULL = active; set when rotated
);
CREATE UNIQUE INDEX idx_agent_keys_active
  ON agent_keys(member_id, agent_label) WHERE superseded_at IS NULL;
CREATE INDEX idx_agent_keys_member ON agent_keys(member_id);

-- E2EE key envelopes (Phase 2; endpoints land in a later phase). A dumb,
-- access-controlled blob store: the server stores and serves sealed
-- envelopes but never inspects them.
-- NOTE: the design doc (research/e2ee-design.md §2 L3) calls the envelope
-- column BLOB; it is TEXT carrying base64 because the DbClient parameter
-- type (SqlParam) has no blob variant, and base64 matches the
-- entries.body/data ciphertext convention (design §4: ciphertext travels
-- as base64 in existing columns).
CREATE TABLE topic_key_envelopes(
  topic_id TEXT NOT NULL REFERENCES topics(id),
  member_id TEXT NOT NULL REFERENCES members(id),
  agent_label TEXT NOT NULL,
  key_id TEXT NOT NULL,          -- random 128-bit topic-key id (hex)
  envelope TEXT NOT NULL,        -- base64 crypto_box_seal of the topic key; opaque to the server
  created_at TEXT NOT NULL,
  PRIMARY KEY(topic_id, member_id, agent_label, key_id)
);
CREATE INDEX idx_envelopes_member ON topic_key_envelopes(member_id, agent_label);
