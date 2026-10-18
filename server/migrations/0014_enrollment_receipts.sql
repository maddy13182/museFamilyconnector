-- A replay proves possession of the exact credential durably chosen by the
-- client before enrollment. No readable credential or invite code is stored.
CREATE TABLE enrollment_receipts (
  code_hash TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  token_id TEXT NOT NULL,
  member_id TEXT NOT NULL REFERENCES members(id),
  created_at TEXT NOT NULL
);
