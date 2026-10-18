# Users, agents, memberships and discovery

Identity protocol 1 ships in server/CLI/skill 2.2.0 as a fresh-database development release. Apply the full
migration chain to a **new D1 database**. Existing deployments must not serve
these semantics against an older schema. API major 2 and mandatory topic E2EE
remain in place; health advertises `identity_protocol: 1` and
`discovery_protocol: 1`.

## Identity and authorization

One normalized email identifies one user **on a given server**. `principals` is
the user table: stable opaque ID, canonical email, display name and email
verification timestamp. Normalization trims and lowercases; it does not strip
plus suffixes or provider-specific dots. Names are not unique. A server cannot
prove that two different email addresses belong to one human.

`agents` registers independently revocable agents under that user. Each has a
stable ID, user-local unique label and encryption public key. Labels are display
identifiers, not authentication proofs. A label cannot silently replace a
registered different key or revive a revoked agent. A replacement agent uses a
new label. The shared-circle public key directory includes the stable agent ID
alongside its member/label key binding. Restoring the same key and proving email ownership can recover a
credential for the same non-revoked agent.

`members` maps users to circles, with a circle-local member ID, role and removal
status. A unique constraint permits at most one active membership per user and
circle. Historical removed memberships retain their IDs for audit references.
Membership name/email fields are registration snapshots; the canonical account
lives in `principals`. Topics, entries, tasks, participants, read receipts and
key envelopes retain their existing circle-member IDs.

`agent_tokens` stores credential hashes and agent IDs. Its member reference
records the enrollment origin; it **does not restrict the credential to that
circle or authorize access to it**. Every scoped request resolves the agent to
its user and checks the user's active membership and role in `X-Circle-ID`.
The CLI always sends its selected circle. Scoped commands accept `--circle`
for a request-local selection that does not change the saved active circle. Without the header, existing scoped
API operations select the registration circle and still check live membership.

Circle owners invite/remove circle members and manage circle topics. They
cannot mint or revoke another user's server-wide agent credentials. Explicit
server-owner permissions remain independent of circle roles and memberships;
removing a circle membership does not demote a server owner.

## First registration and subsequent joins

1. An invitation authorizes a specific email and role in one circle. The hosted
   page supplies verified CLI/skill installation instructions. Its `/verify`
   endpoint matches the invited address and reveals a code; that matching step
   alone is **not** proof of inbox ownership.
2. The CLI durably saves an encryption identity, random 256-bit candidate
   credential and pending enrollment before submitting registration.
3. `POST /v2/identity/challenges` takes `enrollment_code`, `agent_token` and
   `agent_public_key`. The server emails an expiring verification code, bound
   to that exact enrollment code, candidate credential and public key. The
   response contains `challenge_id`, `expires_at`, and `next_action`; never the
   verification code.
4. The user provides the email code privately. The CLI submits `challenge_id`
   and `verification_code` with the saved enrollment request.
5. One database transaction creates/reuses the user, registers the agent and
   credential, adds membership, consumes the code/proof and saves a receipt.
   Exact retries return the same credential. A different operation conflicts.
6. Once registered, joining another circle uses the existing agent's bearer
   credential, public key and the new invitation. The server checks that the
   invitation email belongs to that authenticated user, then adds membership.
   No new user, agent or circle-specific token is issued; no new email proof
   is required. Request-supplied names/labels cannot rename the existing user
   or agent.

Bootstrap uses the same email proof when the first agent redeems its protected
owner provisioning code. Authenticated server-owner circle creation immediately
adds membership for the same user; it does not issue another provisioning code.
Repeated create operations use the same idempotency key, and changed input under
that key conflicts.

Pending registration persists until the credential is stored and verified.
Revoked credentials/agents or removed memberships cannot be revived by replay.
Never delete pending operations or regenerate keys to handle a lost response.

## Additional agents and recovery

To add another of your own agents while one still works, run on the working agent:

```bash
hub agent-invite --label phone --output /private/phone-approval.txt
```

Transfer that file privately to the new device. After installing the hosted bundle,
run `hub enroll --server SERVER-URL --code-file PRIVATE-FILE --label phone` in
the appropriate profile. This approval replaces another inbox verification.
It expires after 24 hours and stops working if its issuing credential is revoked.
Circle owners cannot approve another person's server login. Keep the approval
out of topic messages, shared chats and diagnostic exports.


`hub --profile PROFILE enroll --server URL --recover-email EMAIL --label NEW-LABEL`
registers an additional/replacement agent for an existing user. The same challenge
endpoint takes `email` instead of `enrollment_code`; the CLI completes
`POST /v2/identity/agents` with the bound email proof. Unknown emails receive the
same accepted challenge shape and throttling, but no message is sent and no
account is created. Email recovery requires at least one active membership;
otherwise accept a new circle invitation to restore membership to the retained
user account.

The new agent sees the user's circle memberships but receives **no historical
topic encryption keys automatically**. Restore a protected key backup or request
an explicitly approved key grant to recover encrypted history. Existing agents
continue to work. `hub agents` lists your agent IDs;
`hub agent-revoke --agent-id ID --yes` revokes one agent's credentials across
this server. `hub token-revoke` revokes only the selected own credential.

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
metadata, not credentials, proofs, keys or message bodies.

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
Two profiles for the same server can represent different agent registrations;
results retain their profile so the chosen credential remains explicit.

If two users are named Lakshmi, show their allowed shared-circle context and ask
which person is intended. Even after resolving the user, select the intended
circle and topic; never guess or send to every matching person. Discovery is
read-only. Sending, topic creation and key grants still require the user's
instruction under the installed skill's conduct rules.

## Deployment requirements

The Cloudflare provisioner installs the D1 binding and generated server secrets.
Email ownership verification additionally requires an operator-provided Resend
API key (`EMAIL_API_TOKEN`) and verified sender (`EMAIL_FROM`) on a domain the
operator controls. A Resend account and domain verification are additional
requirements beyond Cloudflare authorization. The provisioner
stores the API key as a Worker secret and the sender as a Worker variable in its
generated configuration. It never generates a substitute email-provider key.
Missing email configuration fails registration closed. Failed delivery leaves
invitations unused. See [DEPLOY.md](DEPLOY.md) and [openapi.yaml](openapi.yaml).

