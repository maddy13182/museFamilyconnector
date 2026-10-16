-- 0012: explicit server ownership, split from circle ownership.
--
-- Before this migration, "hub owner" was derived: any principal holding an
-- 'owner' role in any circle could create circles (F02). That conflates two
-- different powers: circle owners should manage only their own circle, while
-- creating circles on someone else's server is a server-operator power.
--
-- Going forward, circle creation (POST /v1/families while SETUP_LOCKED=1)
-- requires an explicit row here. Circle owners keep their circle-scoped
-- powers (invite, remove, transfer) but can no longer create circles.
-- Server ownership is managed only through the server control-plane API
-- (list / promote / demote) — never implicitly via circle membership.
--
-- Fresh spin-up: the unlocked bootstrap (POST /v1/families) creates the
-- principal, family, and owner member row in one atomic batch, and seeds
-- this table in the same batch — the operator is a server owner from the
-- very first transaction, with no second step to forget.
--
-- Backfill: every principal that holds (or held) an owner role becomes a
-- server owner, preserving exact pre-migration behavior at deploy time.
-- This deliberately does not filter on members.removed_at (added by a
-- separate migration): a removed member's tokens are revoked, so a
-- grandfathered principal without a credential is inert, and the control
-- plane can demote anything that shouldn't retain it.
CREATE TABLE server_owners(
  principal_id TEXT PRIMARY KEY REFERENCES principals(id),
  created_at TEXT NOT NULL,
  created_by TEXT NULL -- promoting principal; NULL for bootstrap/backfill
);

INSERT INTO server_owners(principal_id, created_at)
SELECT DISTINCT m.principal_id, MIN(m.created_at)
  FROM members m
 WHERE m.role = 'owner' AND m.principal_id IS NOT NULL
 GROUP BY m.principal_id;
