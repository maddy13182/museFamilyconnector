-- Development-only identity replacement. Deploy to a fresh database.
CREATE TABLE identity_contract(version INTEGER PRIMARY KEY CHECK(version = 1), empty_at_install INTEGER NOT NULL CHECK(empty_at_install = 1));
INSERT INTO identity_contract VALUES(1, (SELECT count(*) = 0 FROM principals));
ALTER TABLE principals ADD COLUMN email TEXT NOT NULL DEFAULT '';
ALTER TABLE principals ADD COLUMN name TEXT NOT NULL DEFAULT '';
ALTER TABLE principals ADD COLUMN email_verified_at TEXT;
CREATE UNIQUE INDEX user_email ON principals(email);
CREATE UNIQUE INDEX user_circle ON members(principal_id, family_id) WHERE removed_at IS NULL;
CREATE TABLE agents(
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES principals(id),
 label TEXT NOT NULL,
 public_key TEXT NOT NULL,
 created_at TEXT NOT NULL,
 revoked_at TEXT,
 UNIQUE(user_id, label)
);
ALTER TABLE agent_tokens ADD COLUMN agent_id TEXT REFERENCES agents(id);
CREATE INDEX credentials_agent ON agent_tokens(agent_id);
CREATE TABLE email_challenges(
 id TEXT PRIMARY KEY,
 binding_hash TEXT NOT NULL,
 email TEXT NOT NULL,
 proof_hash TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 used_at TEXT,
 created_at TEXT NOT NULL
);
CREATE INDEX challenge_binding ON email_challenges(binding_hash);
-- Agent changes affect every circle membership belonging to the user.
DROP TRIGGER agent_enrolled;
DROP TRIGGER agent_revoked;
CREATE TRIGGER agent_enrolled AFTER INSERT ON agent_tokens BEGIN
 UPDATE topics SET membership_version = membership_version + 1
 WHERE id IN (SELECT p.topic_id FROM topic_participants p JOIN members m ON m.id = p.member_id
 JOIN agents a ON a.user_id = m.principal_id WHERE a.id = NEW.agent_id AND m.removed_at IS NULL);
END;
CREATE TRIGGER agent_revoked AFTER UPDATE OF revoked_at ON agent_tokens BEGIN
 UPDATE topics SET membership_version = membership_version + 1
 WHERE id IN (SELECT p.topic_id FROM topic_participants p JOIN members m ON m.id = p.member_id
 JOIN agents a ON a.user_id = m.principal_id WHERE a.id = NEW.agent_id AND m.removed_at IS NULL);
END;

-- These are independent agents, not delegated credentials. Revoking one
-- credential must not revoke another agent's issued credential.
DROP INDEX idx_agent_tokens_issued_by;
ALTER TABLE agent_tokens DROP COLUMN issued_by_token_id;

-- SQLite cannot add NOT NULL to an existing column with ALTER COLUMN.
-- Enforce the complete identity binding on every credential insertion.
CREATE TRIGGER credential_user_binding BEFORE INSERT ON agent_tokens BEGIN
 SELECT CASE WHEN NOT EXISTS(
  SELECT 1 FROM agents a JOIN members m ON m.principal_id=a.user_id
  WHERE a.id=NEW.agent_id AND a.revoked_at IS NULL AND m.id=NEW.member_id AND a.label=NEW.agent_label
 ) THEN RAISE(ABORT,'credential_identity_mismatch') END;
END;
CREATE TRIGGER user_account_fields BEFORE INSERT ON principals BEGIN
 SELECT CASE WHEN NEW.email='' OR NEW.email<>lower(trim(NEW.email)) OR trim(NEW.name)=''
 THEN RAISE(ABORT,'invalid_user_identity') END;
END;

CREATE INDEX challenge_email_time ON email_challenges(email,created_at);
CREATE INDEX challenge_expiry ON email_challenges(expires_at);
