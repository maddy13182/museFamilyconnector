-- 0007: rate limiting for unauthenticated code endpoints.
--
-- The worker runs on workers.dev (no custom zone), so Cloudflare's
-- zone-based rate-limiting rules don't apply. This implements a fixed-window
-- counter in D1 for the two unauthenticated credential endpoints
-- (invite accept, provisioning-code redeem) — the only brute-force surface.
--
-- Design: one row per (ip, endpoint, window). The check is a single
-- UPSERT + SELECT; legitimate use is 1-2 attempts ever, so the limit is
-- generous (10 per 10 minutes). Exceeded -> 429 with Retry-After.
-- Rows expire via lazy delete on read; no background job needed.

CREATE TABLE rate_limits(
  key TEXT PRIMARY KEY,          -- ip || '|' || endpoint || '|' || window_start
  count INTEGER NOT NULL,
  window_start TEXT NOT NULL,    -- ISO timestamp of window start
  expires_at TEXT NOT NULL       -- ISO timestamp; rows older than this are ignored/deleted
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_expires ON rate_limits(expires_at);
