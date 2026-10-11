- CLI: new `hub key-wrap` command encrypts the E2EE identity key at rest
  with a passphrase. Passphrase-derived key via Argon2id (libsodium
  MODERATE limits) wrapping the 32-byte private key with
  XChaCha20-Poly1305; wrapped file format is `FHWRAP1\n` magic header
  followed by `salt(16) || nonce || ciphertext`. Passphrase comes from
  `FAMILY_HUB_KEY_PASSPHRASE` (for agents/cron) or an interactive
  `getpass` prompt — never a CLI flag, never echoed, never logged. The
  original key is backed up to `agent.key.bak-0600` (0600) before wrapping,
  and the wrapped file is verified to round-trip before it is trusted.
- CLI: `_load_identity_key` auto-detects the `FHWRAP1` magic header and
  unwraps; wrong passphrase surfaces a clean "Incorrect passphrase" error
  (Poly1305 MAC failure), never garbage. Legacy unwrapped keys keep
  working but emit a loud deprecation warning on every use pointing at
  `hub key-wrap`.
- CLI: ops note — after wrapping, automation (e.g. the 15-minute cron)
  must export `FAMILY_HUB_KEY_PASSPHRASE` or it will block on the prompt.
  Documented in `agent-skill/INSTALL.md`.
