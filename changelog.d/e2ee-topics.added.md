## Added
- E2EE Phase 2 — E2EE topics + key envelopes.
- Server: `POST /v1/topics` accepts optional `e2ee: 0|1` (default 0).
  `e2ee=1` requires the creator's agent to have a registered identity key in
  `agent_keys` (400 with `hub key-init` guidance otherwise); the subject may
  arrive already encrypted (opaque to the server, stored as-is).
- Server: `POST /v1/topics/:id/envelopes` — stores one sealed topic-key
  envelope per recipient agent. The caller must be a current participant
  (403 otherwise); the target `(member_id, agent_label)` must be a current
  participant with an ACTIVE (non-superseded) registered public key (400
  otherwise). The envelope blob is stored opaquely, never inspected.
  Re-POSTing the same `(topic_id, member_id, agent_label, key_id)` replaces
  the envelope (idempotent distribution).
- Server: `GET /v1/topics/:id/envelopes` — returns ONLY the caller's own
  envelopes (matched on the Bearer token's `(member_id, agent_label)`); 403
  for non-participants. One agent can never fetch another's envelopes.
- Server: plaintext topics (`e2ee` absent/0) behave exactly as before.
- CLI: `hub new-topic --e2ee --subject … --with …` — generates the 32-byte
  topic key + random 128-bit key_id locally, encrypts the subject with
  XChaCha20-Poly1305 (random 192-bit nonce prepended, base64; AAD is the
  fixed context `fh-topic-subject-v1` since the topic_id isn't known yet),
  seals one envelope per participant agent (`crypto_box_seal` over
  `key_id || topic_key`), verifies the round-trip by fetching and opening
  its own envelope, and stores `key_id → base64 topic key` at
  `~/.config/family-hub/profiles/<name>/topic_keys/<topic_id>.json` (0600).
  Fails with `hub key-init` guidance when the local keypair is missing
  (never auto-generated here). The topic key is registered for redaction and
  never printed.
