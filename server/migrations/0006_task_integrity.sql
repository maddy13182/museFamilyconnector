-- 0006: task integrity (audit Phase F).
--
-- 1. entries.kind gains 'task_updated' (F13: PATCH title/description/due_at
--    now emits an event). SQLite cannot ALTER a CHECK constraint, so the
--    table is rebuilt with the widened CHECK and every row is copied
--    verbatim — additive, no data loss. Indexes are recreated after the
--    rename (they are dropped with the old table).
--
--    Rebuild safety: D1 enforces foreign keys inside migrations (and
--    PRAGMA foreign_keys=OFF is a no-op there), and entries is a parent
--    table — idempotency_keys.entry_gseq REFERENCES entries(gseq). Dropping
--    entries while child rows exist would abort the migration, and
--    PRAGMA defer_foreign_keys does NOT help: the deferred violation binds
--    to the dropped table's identity, so COMMIT still fails after the
--    rename. The child rows are therefore backed up, deleted, and restored
--    around the rebuild; gseq values are preserved so the restored keys
--    keep pointing at the same entries.
--
-- 2. idx_entries_task_trail: expression index on
--    (topic_id, json_extract(data, '$.task_id'), seq) so the task trail is a
--    single indexed SQL query instead of a 5,000-row fetch filtered in code
--    (F13). The F06 visibility predicate already reads task_id through the
--    same json_extract expression.
--
-- Plain SQLite only (no D1-specific functions), mirroring 0001.

-- Back up the only child table of entries (24h retry keys; restored below).
CREATE TABLE idempotency_keys_0006_backup AS SELECT * FROM idempotency_keys;
DELETE FROM idempotency_keys;

CREATE TABLE entries_new(
  gseq INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id TEXT NOT NULL REFERENCES topics(id),
  seq INTEGER NOT NULL,
  ts TEXT NOT NULL,
  actor_member_id TEXT NOT NULL REFERENCES members(id),
  agent_label TEXT NOT NULL,
  token_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN (
    'message','briefing','member_joined','member_left','topic_spawned',
    'task_created','task_assigned','task_status','task_updated','task_note','task_done',
    'redaction',
    -- E2EE Phase 4 system kinds (client-posted, plaintext by design):
    -- key_rotated announces a topic-key rotation, key_request asks members
    -- for the current topic key, pending_key_distribution marks "member
    -- added, envelopes not yet sealed". Added here (not 0001) because this
    -- rebuild defines the effective constraint.
    'key_rotated','key_request','pending_key_distribution')),
  body TEXT NOT NULL,
  data TEXT NULL,            -- JSON, machine payloads
  reply_to_seq INTEGER NULL,
  UNIQUE(topic_id, seq)      -- lets writers re-read their row after insert
);
INSERT INTO entries_new SELECT * FROM entries;
DROP TABLE entries;
ALTER TABLE entries_new RENAME TO entries;

-- Restore the backed-up retry keys (gseq values were preserved verbatim).
INSERT INTO idempotency_keys SELECT * FROM idempotency_keys_0006_backup;
DROP TABLE idempotency_keys_0006_backup;

CREATE INDEX idx_entries_topic_seq ON entries(topic_id, seq);
CREATE INDEX idx_entries_gseq ON entries(gseq);
CREATE INDEX idx_entries_task_trail ON entries(topic_id, json_extract(data, '$.task_id'), seq);
