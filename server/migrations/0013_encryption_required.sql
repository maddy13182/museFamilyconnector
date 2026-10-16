-- Protocol 2 is a deliberate clean-slate development release. Do not
-- reinterpret existing plaintext or old-format encrypted data as protected.
-- Deploy to a NEW database; an existing populated DB fails this guard.
CREATE TABLE encryption_contract (
  version INTEGER PRIMARY KEY CHECK(version = 2),
  empty_at_install INTEGER NOT NULL CHECK(empty_at_install = 1)
);
INSERT INTO encryption_contract VALUES (2, (SELECT COUNT(*) = 0 FROM topics));

ALTER TABLE topic_participants ADD COLUMN history_policy TEXT NOT NULL DEFAULT 'full' CHECK(history_policy IN ('full','from_join'));
ALTER TABLE topic_participants ADD COLUMN min_key_epoch INTEGER NOT NULL DEFAULT 1;
ALTER TABLE topics ADD COLUMN creation_fingerprint TEXT;
ALTER TABLE topics ADD COLUMN membership_version INTEGER NOT NULL DEFAULT 0;

-- Membership/key changes invalidate a key commit snapshot. These integrity
-- triggers run in the same transaction as the change, including revocation.
CREATE TRIGGER topic_participant_added AFTER INSERT ON topic_participants BEGIN
  UPDATE topics SET membership_version = membership_version + 1 WHERE id = NEW.topic_id;
END;
CREATE TRIGGER topic_participant_removed AFTER DELETE ON topic_participants BEGIN
  UPDATE topics SET membership_version = membership_version + 1 WHERE id = OLD.topic_id;
END;
CREATE TRIGGER agent_enrolled AFTER INSERT ON agent_tokens BEGIN
  UPDATE topics SET membership_version = membership_version + 1
    WHERE id IN (SELECT topic_id FROM topic_participants WHERE member_id = NEW.member_id);
END;
CREATE TRIGGER agent_revoked AFTER UPDATE OF revoked_at ON agent_tokens BEGIN
  UPDATE topics SET membership_version = membership_version + 1
    WHERE id IN (SELECT topic_id FROM topic_participants WHERE member_id = NEW.member_id);
END;
CREATE TRIGGER agent_identity_added AFTER INSERT ON agent_keys BEGIN
  UPDATE topics SET membership_version = membership_version + 1
    WHERE id IN (SELECT topic_id FROM topic_participants WHERE member_id = NEW.member_id);
END;
CREATE TRIGGER agent_identity_changed AFTER UPDATE OF superseded_at ON agent_keys BEGIN
  UPDATE topics SET membership_version = membership_version + 1
    WHERE id IN (SELECT topic_id FROM topic_participants WHERE member_id = NEW.member_id);
END;

-- Enforce content-write liveness at the actual SQL write, closing the
-- check-then-write race with a concurrent membership change or key commit.
CREATE TRIGGER encrypted_entry_write BEFORE INSERT ON entries
WHEN NEW.kind IN ('message', 'briefing', 'task_note', 'task_created') BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM topics WHERE id = NEW.topic_id AND current_epoch > 0
      AND rotation_required = 0 AND substr(NEW.body, 1, 4) = 'fh1.'
      AND substr(NEW.body, 5, 32) = current_key_id
  ) THEN RAISE(ABORT, 'encrypted_write_conflict') END;
END;
CREATE TRIGGER encrypted_task_create BEFORE INSERT ON tasks BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM topics WHERE id = NEW.topic_id AND current_epoch > 0
      AND rotation_required = 0 AND substr(NEW.title, 1, 4) = 'fh1.'
      AND substr(NEW.title, 5, 32) = current_key_id
      AND (NEW.description IS NULL OR
        (substr(NEW.description, 1, 4) = 'fh1.' AND substr(NEW.description, 5, 32) = current_key_id))
  ) THEN RAISE(ABORT, 'encrypted_write_conflict') END;
END;
CREATE TRIGGER encrypted_task_update BEFORE UPDATE ON tasks BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM topics WHERE id = NEW.topic_id AND current_epoch > 0
      AND rotation_required = 0
      AND (NEW.result IS OLD.result OR NEW.result IS NULL OR
        (substr(NEW.result, 1, 4) = 'fh1.' AND substr(NEW.result, 5, 32) = current_key_id))
  ) THEN RAISE(ABORT, 'encrypted_write_conflict') END;
END;

CREATE TABLE burned_topic_keys (
  topic_id TEXT NOT NULL REFERENCES topics(id),
  key_id TEXT NOT NULL,
  commitment TEXT NOT NULL,
  PRIMARY KEY(topic_id,key_id),
  UNIQUE(topic_id,commitment)
);
