- Server: `GET /v1/sync` pagination is now page-based instead of head-based.
  The cursor (`next_after_gseq`) is always the last returned entry's gseq —
  previously it jumped to the global max, silently skipping entries when the
  backlog exceeded `limit`. The endpoint fetches `limit`+1 rows, returns
  `has_more: true` while backlog remains, and no longer runs a second
  MAX query per poll. `max_gseq` is kept for contract compatibility as the
  max of the returned page.
- CLI: multi-circle `hub sync` no longer advances a circle's cursor before its
  output is emitted. Each circle's entries are held in memory and emitted
  first; cursors persist only after emission and only when every circle
  succeeded. If one circle fails, the others' entries are still shown, each
  failure is reported per circle, and the command exits non-zero — so a retry
  re-delivers the unacknowledged entries instead of losing them.
