## Fixed
- Invite-accept (`POST /v1/invites/:code/accept`) now includes `family_id` in the
  response member object. It was missing, which crashed the CLI's `circle join`
  after the token was issued but before it was saved — the invite was spent
  and the token lost. Added a regression test asserting the field is present.
