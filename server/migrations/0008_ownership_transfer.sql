-- 0008: two-phase circle ownership transfer (offer -> accept).
--
-- Ownership is a responsibility, never forced: the current owner offers it
-- to one existing member of the same circle, and that member must explicitly
-- accept. Exactly one pending transfer may exist per circle at a time.
--
-- on_complete decides what happens to the offering owner once the target
-- accepts: 'demote' drops them to parent (their tokens keep working);
-- 'remove' strips their owner role AND revokes all of their agent tokens
-- for the circle, ending their access entirely. The member row itself is
-- retained in both modes: invites, topics, entries, tasks and the audit
-- trail reference members(id) with NOT NULL foreign keys, so a physical
-- row DELETE would fail (test SQLite enforces FKs) or destroy circle
-- history. Revocation plus role removal IS the removal.
-- The accept handler applies the swap in a single atomic batch so a circle
-- never has zero owners.
--
-- Transfers expire after 7 days (expires_at); an expired transfer can no
-- longer be accepted (410) and is marked 'cancelled' when first noticed.
-- No background job: expiry is noticed lazily on read/mutate.

CREATE TABLE ownership_transfers(
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id),
  from_member_id TEXT NOT NULL REFERENCES members(id),  -- the offering owner
  to_member_id TEXT NOT NULL REFERENCES members(id),    -- the recipient
  on_complete TEXT NOT NULL CHECK(on_complete IN ('demote','remove')),
  status TEXT NOT NULL CHECK(status IN ('pending','completed','cancelled')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT NULL
);

CREATE INDEX idx_ownership_transfers_family_status
  ON ownership_transfers(family_id, status);

-- Enforce "exactly one pending transfer per circle" at the storage level, so
-- two racing offers cannot both land (the loser gets a UNIQUE violation,
-- which the offer handler converts to a clean 409 instead of a 500).
CREATE UNIQUE INDEX idx_ownership_transfers_one_pending
  ON ownership_transfers(family_id) WHERE status = 'pending';
