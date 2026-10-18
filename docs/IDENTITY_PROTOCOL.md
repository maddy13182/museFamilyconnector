# User identity and circle discovery protocol 1

This development release requires a fresh database. Versions of the server, CLI
and skill are 2.2.0. Publish and pin signed artifacts before deploying.

## One user and one Muse agent

Muse already links one user to one email and one agent running in a persistent
VM. Switching phones does not change that agent. On each server, `principals`
holds one user ID, normalized email and name; `agents` has exactly one agent per
user, with its stable ID, label and public encryption key. `members` maps that
user to circle IDs and circle-specific roles. One saved server credential serves
all those memberships. IDs are local to each server; no cross-server identity
merge is performed.

The token’s original member reference records where it registered. Every scoped
request uses `X-Circle-ID` to resolve the current active membership and role.
Removing one membership revokes topic participation in that circle and requires
rotation, while other circles and server-owner permissions survive.

## Invitation registration

1. The inviter provides name, email and role. The server creates a private,
   expiring invitation link.
2. The invited Muse reads the hosted installation instructions, verifies the
   bundle and loads the skill. It submits the invited email to the page to
   confirm the address and obtains the single-use membership code.
3. It saves its encryption identity, random candidate credential and pending
   operation privately before sending the name, matching email, public key and
   invitation code to the registration endpoint. No email is sent; there is no
   inbox-verification flow or email-service dependency.
4. One atomic transaction creates the user and its sole agent, circle membership,
   encryption-directory entry, credential and receipt, and consumes the code.
   An exact retry returns the same credential. Changed requests conflict.
5. Later circle joins send the existing agent credential and matching email with
   the new invitation. They add membership to the same user and preserve the
   identity, label, encryption key and credential. Names cannot rename an
   existing account during a join.

A different profile cannot create a second agent for an already registered
email. The agent must reuse its existing server credential. Preserve the VM’s
private backups; name/email knowledge alone cannot replace that credential or
recover historical topic keys. Interrupted registration uses `enroll --resume`.
Revoked credentials and removed memberships cannot be resurrected by replay.

Owner bootstrap uses its private setup code and matching owner email. After
bootstrap, authenticated server-owner circle creation adds membership directly;
it does not issue another provisioning code. There are no additional-agent,
device-approval, or email-recovery endpoints.

## Authorization failures

Circle names and IDs select a target; they never grant access. The server
resolves the bearer credential to its user, then checks that user’s active
membership before serving a roster or accepting a topic operation. Local profile
caches and claimed roles are not authorization evidence.

| Situation | API behavior |
| --- | --- |
| Missing, unknown or revoked credential | `401 unauthorized`; no circle directory or roster |
| Registered user with no active memberships | Circle/person discovery returns `200` with empty lists; roster/message requests return `403 not_a_member` |
| Member of A supplies B’s ID or name as circle context | `403 not_a_member`, including for nonexistent circle IDs; no roster or content |
| Member of A supplies a B topic ID while selecting A | `404 not_found`; no topic-existence disclosure or message write |

The CLI resolves an explicit `--circle` name/ID against the authenticated user’s
live membership list. A missing match exits nonzero before requesting that
circle’s roster or topic. Without an override, a topic ID is checked in the
selected circle; a denied topic lookup prevents the CLI from sending a post.
Direct API calls and forged local caches face the same server membership checks.
No credential means CLI failure before protected requests. Failed access attempts
leave stored messages unchanged.

## Discovery wire contract

Authenticated server-scoped operations:

- `GET /v2/discovery/circles?limit=50&cursor=...`
- `GET /v2/discovery/people?q=Lakshmi&limit=50&cursor=...`
- People lookup optionally accepts `circle_id` to restrict to an active shared
  circle. It never exposes memberships in circles the requester cannot access.

Both return an envelope:

```json
{
  "protocol_version": 1,
  "server": {"url": "https://your-hub.example"},
  "data": {"people": [
    {"user_id": "USER-ID", "name": "Lakshmi", "email": "person@example.com",
     "memberships": [
       {"user_id": "USER-ID", "circle_id": "CIRCLE-ID", "circle_name": "Family",
        "member_id": "MEMBERSHIP-ID", "role": "parent"}
     ]}
  ]},
  "page": {"limit": 50, "next_cursor": null},
  "request_id": "REQUEST-ID"
}
```

Circle results use `data.circles` and include `circle_id`, `member_id`, `user_id`,
`name`, `kind` and `role`. Limits are 1–100. Keyset cursors use the last item's
opaque stable ID; `null` means complete. Results are ordered by ID. Pagination
is a live view, not a snapshot: membership may change between calls. The client
validates the envelope version, response origin, item shape and cursor progress.
People discovery groups memberships in two bounded SQL queries per page, avoiding
one membership query per person. User search treats `%` and `_` literally.

All responses carry request and operation IDs in headers. Errors retain
`error.code` and `error.message`; callers must branch on codes, not parse prose.
The CLI retries reads and resumable/idempotent mutations with bounded backoff,
never arbitrary mutations. Enrollment keeps its operation ID across process
restarts; individual attempts get different request IDs. Logs/export contain
metadata, not credentials, keys or message bodies.

## Multiple independent servers

One profile pins one server origin, user/agent metadata, private credential and
local encryption material. The connector discovers only locally configured
servers; it cannot enumerate arbitrary servers a person might have joined.

```text
hub circles --json                  # this profile's server, structured output
hub circles --all-servers            # every configured profile
hub people --query Lakshmi          # visible users on this profile's server
hub people --query Lakshmi --all-servers
```

The client queries up to four profiles concurrently, follows pagination and
returns `protocol_version`, `complete`, `data`, `servers` and `errors`. Every
item includes `server_url` and `profile`. A failed profile yields a nonzero exit
status and `complete: false`, preserving successful profiles' results. A global
`FAMILY_HUB_TOKEN` or vault environment variable is **not broadcast** by an
all-server command; configure each profile's own credential file or vault helper.

Routing uses `(server_url, user_id)` for a person and
`(server_url, circle_id, member_id)` for the selected membership. IDs and email
addresses must never silently merge identities across independent servers.
Use one profile for this user on each server. Reuse it for every circle hosted
there; results retain the profile to make credential selection explicit.

If two users are named Lakshmi, show their allowed shared-circle context and ask
which person is intended. Even after resolving the user, select the intended
circle and topic; never guess or send to every matching person. Discovery is
read-only. Sending, topic creation and key grants still require the user's
instruction under the installed skill's conduct rules.

## Deployment requirements

The dynamic Cloudflare provisioner creates and binds D1 and generates/stores the
server’s internal secrets. The operator supplies only Cloudflare authorization
and setup details; no mail provider, API key or sender domain is needed. Retain
the migration chain and use a fresh database for the identity contract.
