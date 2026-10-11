- E2EE Phase 5 — recovery (the abandonment antidote). Server: new
  client-postable plaintext system entry kind `topic_archived` for the
  total-loss case (entries CHECK widened in the 0006 rebuild; accepted on
  `POST /v1/topics/:id/entries` like the other E2EE system kinds).
  CLI: `hub recover [--topic <id>]` walks the recovery ladder inline and
  narrates every rung — rung 1 restores the identity key from a local
  key-backup file (conventional locations, `--backup-file`, or prompted
  path) or the 24-word recovery phrase; rung 2 re-registers a fresh keypair
  and posts a member-approved `key-request` (`--wait` polls for the grant,
  otherwise the command exits 2 with the request posted and waiting);
  rung 3 detects a missing/expired Bearer token and prints exact
  out-of-band provisioning-code instructions for a human to relay. Rungs
  are never silently skipped. CLI: `hub topic-archive --topic <id>
  --successor <new-id> --reason "…"` (explicit confirmation, `--yes` to
  bypass) posts the `topic_archived` entry naming the successor — the old
  topic is never deleted and stays readable for key-holders. SKILL.md
  gains the hard rule: never create a replacement topic for key-loss
  reasons without completing `hub recover` first.
