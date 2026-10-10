# SPEC gaps found while building WS-1 (server/api-v1)

Decisions made where SPEC v0.1 was silent. None block the build; all are
documented here for review before merge to main.

1. **Provisioning endpoints missing from §13.** §6 step 4 requires minting and
   redeeming per-agent provisioning codes, but §13 lists no endpoints.
   Added:
   - `POST /v1/provisioning-codes {member_id, agent_label}` (auth: self, or
     owner/parent for others) → `{provisioning_code, expires_at}` (24h TTL).
   - `POST /v1/provisioning-codes/:code/redeem` (no auth; code is the
     credential) → `{token, token_id, member}`. Single-use, 24h expiry.

2. **`POST /v1/families` body unspecified.** Implemented as
   `{name, owner_name, owner_email}` → `{family, member, provisioning_code,
   provisioning_expires_at}`.

3. **`parents_only` auto-include scope.** §8 says "all parent-role members".
   Implemented as roles `owner` + `parent` (excluding the owner would lock the
   family owner out of parents-only topics). Creating a parents-only topic as
   a kid → 403; inviting a kid into one → 403.

4. **Topic creator participation.** Group topics: the creator is auto-added if
   not listed (an empty `participant_member_ids` is allowed and means
   "just me"). Direct topics: exactly 2 participants, and the creator must be
   one of them (400 otherwise).

5. **Rate limiting.** SPEC §7 assigns this to "Cloudflare WAF/rate-limit
   rules in front". Implemented as deployment config (README), not in-worker:
   workers have no durable per-IP store without KV, and an in-memory limiter
   would be per-isolate and misleading.

6. **Task completion paths.** Both `POST /v1/tasks/:tid/done` and
   `PATCH /v1/tasks/:tid {status:"done"}` enforce the subtask rule (409
   `subtasks_open`). Structured `result` JSON is only settable via `/done`.

7. **Rotate grace.** `POST /v1/auth/rotate` sets the old token's `revoked_at`
   to now+24h; `resolveToken()` treats a token with a *future* `revoked_at`
   as valid (the grace window), past as revoked.

8. **Idempotency-Key conflict.** Same key + different body returns the
   original entry with `deduped: true` (the key defines the operation).

9. **`GET /v1/topics/:tid/tasks` added** (not in §13) per WS-2 request:
   participant-only → `{"tasks": [...]}`. Assignee/status filtering stays
   client-side.

10. **`/v1/sync` envelope.** Returns `{entries, max_gseq, next_after_gseq}`
    (the two cursor fields carry the same value; both kept for compatibility).

11. **Spawn briefing required.** `POST /v1/topics/:tid/spawn` requires a
    non-empty `briefing` (it is the only content carried into the child topic)
    and PII-scans it.

12. **Task trail cap.** `GET /v1/tasks/:tid` trail is capped at 5000 entries
    (application-side filter on `data.task_id`, after `history_from_seq`).

13. **Invite roles.** Owner may invite any role; parent may invite
    `parent`/`kid` only (inviting `owner` → 403). Duplicate email in the
    family → 409 `already_member`.
