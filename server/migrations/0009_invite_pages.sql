-- 0009: per-invite onboarding pages (v0.11.0).
--
-- One invite_pages row is created atomically with each invite in
-- POST /v1/families/:fid/invites (normal AND idempotency-hit paths) and is
-- deleted when the invite is accepted (self-destruct), lazily when the
-- invite is used/expired, and must be deleted by any future invite-revoke
-- endpoint. There is no listing endpoint for these rows.
--
-- Storage: only sha256(TOKEN_PEPPER || page_token) is stored, same pattern
-- as invites.code_hash. The raw `fhip_`-prefixed token is returned to the
-- inviter exactly once, inside `onboarding_url`.
-- verify_attempts/last_attempt_at back the per-page email-guess budget
-- (429 with Retry-After at >=10 attempts within 5 minutes; never hard-lock).

CREATE TABLE invite_pages(
  page_token_hash TEXT PRIMARY KEY,
  invite_code_hash TEXT NOT NULL REFERENCES invites(code_hash),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  verify_attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT NULL
);
CREATE INDEX idx_invite_pages_invite ON invite_pages(invite_code_hash);
