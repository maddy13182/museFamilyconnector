- Server: task state changes, their audit events, and idempotency outcomes now
  commit in a single atomic batch. Creating a task writes its `task_created`
  event in the same transaction (a failed event write can no longer leave an
  orphan task); completing a task writes `task_done` in the same batch as the
  status flip; PATCH writes `task_updated`/`task_assigned`/`task_status`
  alongside the update; and posting an entry writes its idempotency-key record
  in the same batch as the entry. Entry sequence numbers are computed inside
  the insert statement, with one automatic retry on a seq race.
- Server: `task_created` events now carry the full task fields (title,
  description, due date, status, owner, assignee, parent, creator,
  timestamps) so the log can reconstruct task state. PATCHing a task's
  title, description, or due date emits a new `task_updated` event with the
  changed fields (previously silent).
- Server: `GET /v1/tasks/:tid` now pages the entry trail (`after_seq`,
  `limit`, `has_more`, `next_after_seq`) via a single indexed SQL query on
  the new `idx_entries_task_trail` index, instead of fetching up to 5,000
  topic entries and filtering in code. Migration 0006 also widens the
  entries kind check to allow `task_updated` (table rebuilt, rows preserved).
- Server: completing a task with a malformed JSON body now returns 400
  instead of silently treating it as empty; an absent body still completes
  the task.
- Server: creating an open subtask under a completed or cancelled parent is
  now denied with 409 `parent_completed`, and the parent-status check is part
  of the insert itself. Completing a task (via `POST /done` or
  `PATCH status=done`) now enforces the open-subtask rule inside the update
  statement, so a subtask created between the check and the write can no
  longer slip through.
