## Fixed
- E2EE security-review fixes. Server: `topics.current_key_id` is now the
  single source of truth for key election — `POST /v1/topics` with `e2ee=1`
  requires `initial_key_id` (the creator's key id), and introducing a new
  `key_id` via `POST /v1/topics/:id/envelopes` is an owner/parent-only
  rotation (403 otherwise) that advances `current_key_id` atomically; this
  stops a participant from downgrading victims to a removed member's key or
  hijacking encryption to an attacker key. Envelope re-POSTs now preserve
  the original `created_at` (no recency forgery). New `PATCH
  /v1/topics/:id/subject` (participant-only, E2EE-only) lets the CLI
  re-encrypt the subject with the topic-bound AAD immediately after creation.
  `POST /v1/topics/:id/entries` skips the server PII scan for well-formed
  `fh1.*` ciphertext bodies. CLI: sealed envelopes now bind
  `topic_id || 0x00 || key_id || topic_key` and cross-topic transplants are
  rejected, never stored; key election reads the server-advertised
  `current_key_id` instead of envelope recency; `hub topic-rekey` requires
  owner/parent role and fails loudly otherwise; `hub new-topic --e2ee` sends
  `initial_key_id` and does the topic-bound subject PATCH two-step;
  identity-key backup restore clamps Argon2 `opslimit`/`memlimit` from the
  backup file (loud error on violation, never an OOM crash).
