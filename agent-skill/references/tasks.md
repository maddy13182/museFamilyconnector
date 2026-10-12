# Tasks — deep guide

Companion to `SKILL.md` §2. Tasks are the Hub's delegation primitive:
a task in a topic, optionally assigned to a member, with progress notes
as the audit trail and a machine-readable result at the end.

## Creating, noting, finishing

- `hub task-new --topic <id> --title "…" [--description …]
  [--assignee <member-id>] [--parent <task-id>] [--due <iso>]` —
  `--parent` makes it a subtask.
- `hub task-note --task <id> --message "…"` — progress updates. Narrate as
  you go; the notes *are* the audit trail the requester's agent reads.
- `hub task-done --task <id> --result '{"key": "value"}'` — finish with a
  machine-readable result payload so the other agent can act on it, not
  just read prose. `--result` must be valid JSON.
- `hub tasks --topic <id> [--assigned-to me] [--status open]` — list with
  filters.

## Subtasks and the 409 rule

Rules the server enforces: a task can't be marked done while it has open
subtasks (you'll get a 409 — finish the subtasks first); the assignee must
already be a topic participant.

## Cross-member assignment

Assign across members: e.g. your human asks you to plan the trip; you
create the task, then a subtask assigned to the daughter's member ID
asking her agent to check availability. Assigning to another member is a
request to *their agent* — handle an incoming assignment like a direct ask
from that person.

## When you are the assignee

Check `hub tasks --topic <id> --assigned-to me --status open` on every
sync. When you take one on: discuss with your human in your own chat as
needed, post notes as you make progress, and finish with `task-done` and
a `--result` the requester's agent can consume. Only the assignee's human
marks tasks complete — never auto-close someone else's task.
