-- 0003: idempotent creates + unique circle names.
--
-- 1. Circle names are unique (case-insensitive). Names are user-facing
--    labels; without this, a retried create can leave two identically named
--    circles that are painful to tell apart.
-- 2. create_idempotency records let clients safely retry create operations
--    after a dropped connection: a repeated idempotency key returns the
--    already-created resource instead of duplicating it.
-- 3. provisioning_codes.redeemed_token_id links a redeemed code to the token
--    it minted, so a deduped create can revoke the orphaned token when the
--    client proves (by retrying) it never received the first one.

CREATE UNIQUE INDEX IF NOT EXISTS idx_families_name_nocase
  ON families(name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS create_idempotency(
  scope TEXT NOT NULL,            -- 'family' | 'topic' | 'invite'
  member_id TEXT NOT NULL,        -- initiating member
  key TEXT NOT NULL,              -- client-generated idempotency key
  resource_id TEXT NOT NULL,      -- family_id | topic_id | invite code_hash
  code_hash TEXT NULL,            -- 'family' scope: original provisioning code (orphan checks)
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (scope, member_id, key)
);
CREATE INDEX IF NOT EXISTS idx_create_idempotency_expiry
  ON create_idempotency(expires_at);

ALTER TABLE provisioning_codes ADD COLUMN redeemed_token_id TEXT NULL;
