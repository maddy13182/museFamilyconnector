-- 0004: credential lineage for revocation cascades (audit F01/F04/F05/F17).
--
-- issued_by_token_id records the token under whose authority a credential
-- was issued:
--   provisioning_codes.issued_by_token_id — the token that minted the code.
--     NULL for bootstrap / locked-create codes minted without an auth
--     context (no issuing token exists in that flow).
--   agent_tokens.issued_by_token_id — the minter's token, inherited from
--     the redeemed provisioning code at redeem time. NULL for
--     invite-accepted tokens (the invite code, not a token, is the
--     credential) and for rotated tokens: rotation replaces a credential
--     rather than delegating authority, so a rotated token is deliberately
--     NOT a cascade target when the old token is revoked.
--
-- handleRevoke uses this lineage: revoking a token expires its pending
-- (unused, unexpired) provisioning codes and revokes its ONE-LEVEL
-- descendant tokens (documented limit — grandchildren survive).
--
-- Additive only: two nullable columns + two indexes. No existing column is
-- altered or dropped.

ALTER TABLE provisioning_codes ADD COLUMN issued_by_token_id TEXT NULL;
ALTER TABLE agent_tokens ADD COLUMN issued_by_token_id TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_provisioning_codes_issued_by
  ON provisioning_codes(issued_by_token_id);
CREATE INDEX IF NOT EXISTS idx_agent_tokens_issued_by
  ON agent_tokens(issued_by_token_id);
