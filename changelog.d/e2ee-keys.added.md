## Added
- E2EE Phase 1 — agent identity key infrastructure. **E2EE requires a fresh
  database — existing D1 data is not migrated** (clean slate at the v0.7.0
  deploy, on the owner's explicit go-ahead; the E2EE tables live in the base
  schema, `server/migrations/0001_init.sql`).
- Server: `agent_keys` table (one active X25519 public key per
  `(member_id, agent_label)`; rotation marks the old key superseded, never
  deleted), plus the Phase 2 schema placeholders `topics.e2ee` and
  `topic_key_envelopes`.
- Server: `POST /v1/provisioning-codes/:code/redeem` accepts an optional
  `agent_public_key` (standard base64, exactly 32 bytes when decoded; 400
  otherwise), stored bound to `(member_id, agent_label)` in the same atomic
  batch as the token issuance. Redeeming without it behaves exactly as
  before — plaintext topics keep working.
- Server: `GET /v1/agent-keys` key directory (authenticated; only keys of
  members the caller shares a circle with) and `POST /v1/agent-keys/rotate`
  (bearer-token-authenticated registration/rotation).
- CLI: `hub` now depends on PyNaCl and the `mnemonic` package (pinned in
  `agent-skill/requirements.txt`) — this ends the stdlib-only property.
  Key commands fail with a clear install message when they are missing;
  all other commands keep working without them.
- CLI: `hub setup` generates the agent's X25519 identity keypair locally
  (`~/.config/family-hub/profiles/<name>/agent.key`, mode 0600), registers
  the public key at redeem time, and prints a 24-word BIP-39 recovery
  phrase once.
- CLI: new commands `hub key-init` (generate + register for existing
  agents; idempotent), `hub key-backup` (Argon2id-encrypted backup file),
  and `hub key-restore` (from phrase or backup file). The private key never
  leaves the machine, is never printed, and never appears in logs.
