- Server: circle names are now unique (case-insensitive) — `POST /v1/families`
  returns 409 `circle_name_taken` instead of creating a duplicate.
- Server: `POST /v1/families`, `/v1/topics`, and `/v1/families/:id/invites`
  honor `Idempotency-Key`. A repeated key returns the already-created
  resource (`deduped: true`) — for circles, with a freshly minted
  provisioning code, since the original code's plaintext is unrecoverable.
- Server: when a deduped circle create finds the original provisioning code
  was already redeemed, the orphaned token is revoked (the retry proves the
  client never received it).
- Server: redeeming an already-used provisioning/invite code now returns the
  member and `token_already_issued: true` instead of a bare error, so clients
  can guide recovery.
- CLI: exponential-backoff retry (1s/2s/4s + jitter, 3 retries) on dropped
  connections, timeouts, 429 and 5xx; 4xx never retried. All mutating POSTs
  auto-carry an idempotency key.
- CLI: `hub circle create` reuses one key across the create→redeem flow and
  loops back through dedup when a redeem response is lost; `hub circle join`
  explains the recovery step when a code was already used.
- Logging: server logs idempotency hits/stores, code minting, orphan
  revocation, and name conflicts; client `--debug` shows retry attempts with
  timestamps.
