- Server: new `GET /v1/sync/topics` replaces `GET /v1/sync` — per-topic
  cursor-is-ack sync (the watch's cursor only advances past entries it has
  actually delivered, so messages can no longer be silently skipped).
- Server: new receipt-bound acks — `POST /v1/ack` acknowledges specific
  entry receipts, and `hub` cursors bind to delivery, not to poll position.
- Server: new `POST /v1/keys/commit` — staged key envelopes are committed
  atomically with a monotonic `key_epoch` (CAS commit); the removed-member
  commit path is rejected with 409 `recipients_removed_key_burned` and the
  key is burned server-side instead.
- CLI: `hub sync` rewritten onto `/v1/sync/topics` — per-topic cursors,
  legacy cursor files are deleted without being read, and acks are
  receipt-bound.
