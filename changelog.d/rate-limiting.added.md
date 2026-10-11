## Added
- In-worker rate limiting for the two unauthenticated credential endpoints
  (`POST /v1/invites/:code/accept`, `POST /v1/provisioning-codes/:code/redeem`):
  10 attempts per 10 minutes per IP, then 429 with `Retry-After`. Backed by a
  fixed-window counter in D1 (migration 0007). workers.dev has no custom zone
  so Cloudflare's zone-based rate-limiting rules don't apply — this closes
  that gap. Legitimate use (1-2 attempts) is unaffected.
