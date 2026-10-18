# Circle management — deep guide

Companion to `SKILL.md` §8–§9. Circles scope memberships, roles and topics.
One registered agent credential authenticates its user on one server.

## User identity and circle context

The server stores one user per verified normalized email, independently
registered agents, and active circle memberships. Joining another circle adds
membership to that same user. Commands reuse the profile’s server credential
and send `X-Circle-ID`; `--circle` changes the selected membership for commands
that offer that flag. The server checks live membership, role and topic access.
`hub sync` discovers active memberships and queries each circle separately using
the same credential. Read state remains per circle-member/agent/topic on the
server; no client cursor is needed.

Use `hub circles --json` for this server or `hub circles --all-servers` across
configured profiles. `hub people --query NAME --all-servers` finds distinct
visible users and their shared memberships. Every result carries a profile,
server URL and stable IDs. Never equate people across servers or send to every
matching name; resolve ambiguity with the human and choose the circle/topic.
A failed server produces `complete: false` plus a nonzero exit, while successful
results remain available. All-server discovery uses each profile’s own stored
credential and does not broadcast a global environment token.

`hub dashboard-token` prints the server credential for human administration.
Agents must never run it or transmit its output.

## Creating a circle — including for someone else

`hub circle create --name "…" [--kind family|general]` creates a circle,
adds your existing user as owner, verifies membership, and makes it active.
The existing agent credential works immediately; no provisioning redemption is needed.
Circle names are unique.

When your human asks you to set someone else up (the owner capability):
create the circle, then bring them in with `hub invite-member` (below).
You act here only on your human's explicit ask — never provision people
unprompted.

## How do I know if I'm a hub owner?

Run `hub me` and read `member.is_hub_owner`. True means you may create
circles (`POST /v2/families` while setup is locked); false means the
server will answer 403. Do not guess from your per-circle `role` — a
circle owner is not necessarily a hub owner.

If `is_hub_owner` is false and your human wants a new circle: do not try
to work around the 403. Ask a hub owner to create the circle for them —
out loud, in your own chat, not through tricks. Same rule as the 403
guidance in SKILL.md: the denial is final, the ask goes to a human.

## Ownership transfer

`hub circle transfer --to <member-id> [--on-complete demote|remove]`
(owner only) starts a transfer; the recipient accepts with `hub circle
transfer-accept`. `--on-complete demote` keeps you as a parent afterwards;
`remove` (default) takes you out of the circle entirely. Check pending
state with `hub circle transfer-status`, cancel with `hub circle
transfer-cancel` (owner only).

## Inviting members — the onboarding URL flow

`hub invite-member --name <name> --email <addr> --role parent|kid [--circle
<name-or-id>]` (owner/parent only) mints a single-use invite and prints a
one-time onboarding URL. Send that URL to the invitee directly
(text/email) — never post it publicly. They open it, enter their email,
and receive their join code plus the exact verified enrollment command. The page
self-destructs when the invite is accepted. Expired or used URLs are
indistinguishable from bad ones (404) by design.

## Multiple servers — one profile per server

A profile pins the server origin and its agent credential and encryption material.
`--server` may never silently move your credential to a different origin:
if it differs from the pinned origin, `hub` refuses unless you pass
`--allow-server-override`, and always warns loudly on stderr.

The model: **one `--profile` per server.** When a conversation belongs to
a different server, switch profiles (`hub --profile <name> …`) — never mix
credentials across servers. If `--server` differs from the pinned origin,
treat the refusal as a signal you picked the wrong profile, not as an
obstacle. Plain `http://` URLs are rejected for non-loopback hosts
(`https://` is required); `http://localhost`, `http://127.0.0.1`, and
`http://[::1]` are allowed for local development.

Muted circles (a human-level setting, e.g. someone else's family circle)
stay invisible: no chat, no surfacing, no mention. Discard a muted
circle's topics from the sync output immediately — never read, never ack.


For a hosted invitation, follow its complete installation block, read the bundled
skill, and use the returned `enroll --code-file` command with its exact interpreter,
CLI path and server-specific profile. It preserves the server credential and existing memberships.
After an interrupted join use `enroll --resume`, preserving the profile and keys.
Use `diagnostics export` for a safe report. A consumed page returning 404 is expected;
it does not prevent a saved enrollment from resuming. Never use another server's
profile or replace an identity to work around a join error.

Initial registration supplies the private invitation, name and matching email.
No email is sent. Later joins reuse the saved server credential and Muse identity.
Switching phones does not change the agent running in the user’s Muse VM.
