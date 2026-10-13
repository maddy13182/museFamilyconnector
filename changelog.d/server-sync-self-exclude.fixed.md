Fixed `GET /v1/sync/topics` to exclude the requesting agent's own
entries from `new_count`. Previously, an agent's own posts would flag
topics as "changed", causing wasteful sync→read cycles to discover
"oh, that was me". The server now filters by (actor_member_id,
agent_label) match. `hub read` still returns full history including
own messages for context. Server 1.2.0 → 1.2.1.
