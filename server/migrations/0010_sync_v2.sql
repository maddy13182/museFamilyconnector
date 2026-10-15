-- 0010: sync v2 read state + E2EE key-epoch lifecycle (spec §1.1).
--
-- topic_read_state: per-(member, agent) read cursor. Missing row ≡ acked_seq
-- 0 (every visible entry unread). Written by POST /v2/topics/:tid/ack.
-- topic_key_epochs: immutable, append-only epoch log. One row per key epoch;
-- UNIQUE(topic_id, key_id) means a key_id can NEVER be reused at any epoch,
-- and UNIQUE(topic_id, commitment) rejects identical key material under a
-- fresh key_id. Every epoch has a SHA256 commitment; missing commitments
-- cannot be verified and are rejected.
-- topics.current_epoch / rotation_required and
-- topic_key_envelopes.identity_key_id back the staged-commit key lifecycle
-- (spec §1.4): envelopes are staged (never flip current_key_id on POST);
-- only keys/commit advances the epoch.

-- Per-agent read state. Missing row ≡ acked_seq 0 (all visible unread).
CREATE TABLE topic_read_state(
  member_id   TEXT NOT NULL REFERENCES members(id),
  agent_label TEXT NOT NULL,
  topic_id    TEXT NOT NULL REFERENCES topics(id),
  acked_seq INTEGER NOT NULL DEFAULT 0,   -- entries.seq, not gseq
  updated_at TEXT NOT NULL,
  PRIMARY KEY (member_id, agent_label, topic_id)
);
CREATE INDEX idx_read_state_member ON topic_read_state(member_id);

-- Immutable epoch log. Append-only: one row per key epoch.
-- UNIQUE(topic_id, key_id): a key_id can NEVER be reused at any epoch.
-- UNIQUE(topic_id, commitment): identical key material under a fresh key_id
-- is likewise rejected (commitment = SHA256(key)).
CREATE TABLE topic_key_epochs(
  topic_id       TEXT NOT NULL REFERENCES topics(id),
  epoch          INTEGER NOT NULL,
  key_id         TEXT NOT NULL,
  commitment     TEXT NOT NULL,  -- hex SHA256(topic_key)
  recipients     TEXT NOT NULL,  -- JSON array of [member_id, agent_label] that received envelopes
  created_at     TEXT NOT NULL,
  created_by     TEXT NOT NULL REFERENCES members(id),
  PRIMARY KEY (topic_id, epoch),
  UNIQUE (topic_id, key_id),
  UNIQUE (topic_id, commitment)
);

ALTER TABLE topics ADD COLUMN current_epoch INTEGER NOT NULL DEFAULT 0;
-- Removal / from-join transitions require a fresh key before new encrypted
-- writes are accepted (set by the removal handler and from-join accept for
-- E2EE topics; cleared by a successful keys/commit).
ALTER TABLE topics ADD COLUMN rotation_required INTEGER NOT NULL DEFAULT 0;

-- Which identity key version an envelope was sealed to (server-observed at
-- POST time). Lets the commit reject envelopes sealed to superseded keys.
ALTER TABLE topic_key_envelopes ADD COLUMN identity_key_id TEXT NULL;
