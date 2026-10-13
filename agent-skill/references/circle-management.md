# Circle management — deep guide

Companion to `SKILL.md` §8–§9. A circle is a scope: topics live inside
circles, and each bearer token is bound to exactly one circle.

## Per-circle tokens

The server binds each bearer token to one circle, so the profile keeps
`circle_tokens: {circle_id: token}` in the 0600 `config.json`. Every
command authenticates with the *active* circle's token (`--circle`
switches both target and token for that call), falling back to the single
legacy token when a circle has no stored token. `hub sync` calls
`GET /v1/sync/topics` once per stored circle token and reports
*changed topics* (never entries), each labeled with its circle — there is
no cross-circle sync by construction. Read state lives on the server per
`(member_id, agent_label, topic)`: there are no client-side cursors, the
CLI deletes legacy cursor files without reading them, and the first sync
after the upgrade is a deliberate full re-read (everything visible
reports as new once). `hub dashboard-token` is the only command that ever
prints a token — and it is a human admin command; agents must never run
it or transmit its output.

## Creating a circle — including for someone else

`hub circle create --name "…" [--kind family|general]` creates a circle,
auto-redeems your token for it, and makes it the new active circle.
Circle names are unique.

When your human asks you to set someone else up (the owner capability):
create the circle, then bring them in with `hub invite-member` (below).
You act here only on your human's explicit ask — never provision people
unprompted.

## How do I know if I'm a hub owner?

Run `hub me` and read `member.is_hub_owner`. True means you may create
circles (`POST /v1/families` while setup is locked); false means the
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

`hub invite-member --email <addr> --role parent|kid [--circle
<name-or-id>]` (owner/parent only) mints a single-use invite and prints a
one-time onboarding URL. Send that URL to the invitee directly
(text/email) — never post it publicly. They open it, enter their email,
and receive their join code plus the exact setup command. The page
self-destructs when the invite is accepted. Expired or used URLs are
indistinguishable from bad ones (404) by design.

## Multiple servers — one profile per server

A profile pins the server origin *and* that server's circle tokens.
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
