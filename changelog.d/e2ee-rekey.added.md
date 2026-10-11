## Added
- E2EE Phase 4 — membership changes + re-keying. Server: `DELETE
  /v1/topics/:tid/participants/:mid` (owner/parent only, same 403 rule as the
  topic invite endpoint; appends a plaintext `member_left` system entry;
  removed members keep their old envelopes but can no longer be sent new
  ones), plus three client-postable plaintext system entry kinds
  (`key_rotated`, `key_request`, `pending_key_distribution`) for E2EE
  membership flows. CLI: `hub topic-add-member` (seals the current topic key
  for a new member's agents — current key only, never old keys; visible
  pending notice when they have no registered keys), `hub
  topic-remove-member`, `hub topic-rekey` (new key + fresh envelopes for all
  remaining agents, old keys retained locally, plaintext `key_rotated`
  announcement), `hub key-request` / `hub key-grant` (visible request, human-
  approved grant only — no auto-fulfillment), `hub key-fetch`, and `hub
  topic-key-status`. `hub sync` now refreshes key envelopes for E2EE topics
  before decrypting, so rotations land on first sight.
