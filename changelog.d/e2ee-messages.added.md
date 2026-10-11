## Added
- E2EE Phase 3 — encrypted messaging (CLI only; no server changes).
- CLI: `hub post` to an E2EE topic encrypts `(body, data)` with
  XChaCha20-Poly1305 under the topic key from the local keystore
  (`topic_keys/<topic_id>.json`). Each encrypted field is one wire string:
  `fh1.<key_id_hex>.<msg_id_hex>.<base64(nonce || ciphertext)>` — random
  192-bit nonce and random 128-bit client message id per field, ciphertext
  stored in the existing `entries.body`/`entries.data` columns (base64
  TEXT, opaque to the server). The AAD is the canonical byte string
  `b"fh-msg-v1" + NUL + topic_id + NUL + key_id_hex + NUL + msg_id_hex`, so
  ciphertext cannot be cut-and-pasted across topics or key rotations, and
  one message's ciphertext cannot be replayed as another entry. (The design
  asked for `seq` in the AAD; `seq` is assigned server-side at insert and
  unknowable before POST, so the client-chosen `msg_id` takes its place —
  see the `hub` source header for the full rationale.)
- CLI: `hub post` to an E2EE topic with no local topic key fails loudly
  with `hub key-request` guidance — nothing is posted, never plaintext.
- CLI: `hub read` / `hub sync` auto-detect E2EE topics (one topic-record
  fetch per topic per run, cached — never per entry) and decrypt after
  fetching, selecting the key by the plaintext `key_id` on each entry.
  Tampered or malformed ciphertext raises a loud error naming the entry
  (tamper evidence); a missing key shows a per-entry placeholder instead of
  ciphertext; server-written plaintext entries (e.g. redaction notices)
  pass through untouched. Plaintext topics behave byte-identically.
- CLI: `hub topics` decrypts E2EE topic subjects client-side for display
  (Phase 2 subject format); subjects show as `[encrypted]` when the key is
  not available locally.
- CLI: the local PII pre-scan (`check_pii`) is the enforcement point for
  E2EE topics — it runs on the plaintext body and the canonical data JSON
  before encrypting, since the server cannot scan ciphertext.
