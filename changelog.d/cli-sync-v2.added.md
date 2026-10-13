- CLI: new `hub sync` — per-topic cursor-is-ack sync against
  `/v1/sync/topics` (legacy `_sync_one_circle` path and old cursor files
  removed).
- CLI: `hub read` and `hub ack` now operate on receipt-bound entries.
- CLI: `hub rekey` / key commands work through the staged-envelope +
  `/v1/keys/commit` lifecycle (staged envelopes invisible pre-commit,
  commit-time epoch CAS).
- CLI: new `hub token-revoke` — emergency credential revocation backed by
  the kept `POST /v1/auth/revoke` endpoint.
- CLI: minimum server floor raised to 0.14.0 — `hub` refuses to talk to
  servers older than 0.14.0 (first server with the sync-v2 flows and the
  enforced E2EE lifecycle).
