-- 0005: identity principals (audit F02).
--
-- Before this migration, email text was the de-facto cross-circle identity:
-- isHubOwner and GET /v1/families matched member rows by email string, so a
-- member row that merely SHARED an email with another circle's owner gained
-- hub-owner powers and visibility into that circle's metadata.
--
-- This migration introduces stable principal IDs. Going forward, all
-- authorization joins use members.principal_id; emails remain plain
-- attributes (invites, display) and are never identity keys.
--
-- TRUST ASSUMPTION (documented): the backfill groups by stored email — one
-- principal per distinct member email — because email was the identity model
-- in force when those rows were created, and the migration cannot
-- distinguish legitimate rows from colliding ones. Rows created after this
-- migration get a FRESH principal each (invite codes prove code possession,
-- not email ownership); the only post-migration cross-circle linking path is
-- locked circle creation, which carries the already-verified caller's
-- principal onto the new member row. reqEmail lowercases addresses, so the
-- stored values group deterministically; grouping uses the exact stored value
-- to preserve the join semantics the rows were created under.
--
-- Additive only: one new table, one nullable column, one index. No existing
-- column is altered or dropped.

CREATE TABLE principals(
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

ALTER TABLE members ADD COLUMN principal_id TEXT NULL REFERENCES principals(id);

CREATE INDEX IF NOT EXISTS idx_members_principal ON members(principal_id);

-- Backfill: one principal per distinct email. The random ids carry no
-- relation to the email (a principals id alone cannot be used to recover
-- one), so a mapping table joins them back onto members. (A TEMP table is
-- not used: D1's API rejects CREATE TEMP TABLE, so this uses a regular
-- table dropped at the end of the migration.)
CREATE TABLE _email_principal_mig(
  email TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL
);
INSERT INTO _email_principal_mig(email, principal_id)
  SELECT email, 'pr_' || lower(hex(randomblob(16)))
    FROM (SELECT DISTINCT email FROM members);
INSERT INTO principals(id, created_at)
  SELECT principal_id, strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM _email_principal_mig;
UPDATE members SET principal_id = (
  SELECT principal_id FROM _email_principal_mig ep WHERE ep.email = members.email
);
DROP TABLE _email_principal_mig;
