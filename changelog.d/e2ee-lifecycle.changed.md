- Server: E2EE key lifecycle is now staged — key envelopes are posted as
  staged (invisible pre-commit) and only take effect on `/v1/keys/commit`;
  stale keys can no longer become current without the monotonic epoch
  commit (N03).
- Server (N05): plaintext tasks/briefings are rejected inside E2EE topics —
  every E2EE write is ciphertext-enforced at write time, no exceptions.
- Server: write-time key gates — posting to an E2EE topic requires a
  current committed key; key fetch returns only the current key envelope.
- Server (R1): replay protection on key commits — a commit for an already
  superseded epoch is rejected instead of re-applied.
- Server: member removal on an E2EE topic sets `rotation_required`, and
  removing a member after a staged (uncommitted) key exists burns the
  staged key — writes pause until a fresh key is committed, so a removed
  party never receives future messages.
