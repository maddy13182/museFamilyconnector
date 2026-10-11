- Server: task list (`GET /v1/topics/:tid/tasks`), task detail
  (`GET /v1/tasks/:tid`), and topic export now honor the topic's from-join
  history floor — a member invited with `history_from: from_join` no longer
  sees tasks created before they joined.
- Server: the from-join cutoff (`history_from_seq`) is now computed inside
  the same atomic transaction as the membership insert, closing a race where
  a stale cutoff could expose entries posted between the read and the insert.
- Server: the PII scanner now also checks entry `data` (JSON string leaves,
  recursively), task titles (create and patch), and task completion results;
  hits are rejected with 422 as before.
- Server: owner redaction now also scrubs PII-shaped string leaves in entry
  `data` (structure-preserving). Task rows have no redact endpoint — see
  `docs/SECURITY.md` "PII scanner — honest limits" for the documented gap.
