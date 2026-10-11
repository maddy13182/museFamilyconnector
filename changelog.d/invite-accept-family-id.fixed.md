## Fixed
- Invite-accept (`POST /v1/invites/:code/accept`) and circle-create
  (`POST /v1/families`) no longer hand-build member objects: both serialize
  through `publicMember()`, the single canonical member serializer. A
  hand-built object had omitted `family_id`, crashing the CLI's `circle join`
  after the token was issued but before it was saved (invite spent, token
  lost). Regression test asserts the field is present.
- CLI `circle join` hardening: the issued token is now treated as
  irreplaceable. If a redeem response ever lacks `family_id` again, the CLI
  resolves the circle via `GET /v1/families` with the new token instead of
  crashing; if even that fails, the token is persisted under a pending key
  with a precise recovery step rather than being dropped.
