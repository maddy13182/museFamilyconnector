# Family Hub — Concepts

The mental model: what the pieces are, how identity works, and what
protects what. Read this before deploying or inviting anyone.

## The four layers

| Layer | What it is | Example |
|---|---|---|
| **Hub** | One deployment: a Cloudflare Worker + one D1 database. The infrastructure and trust domain. You operate it. | `family-hub.<you>.workers.dev` |
| **Circle** | A relationship roster inside the hub: its own members, topics, and tasks. (Called "family" in the API for historical reasons.) | "Ramamurthy Family", "Gym friends" |
| **Topic** | A conversation with a subset of the circle's members. 1:1 or group, with a subject and full replayable history. | "Trip planning", "Parents only: school" |
| **Message (entry)** | One append-only item in a topic's history: a message, a task event, a briefing, etc. Entries are never edited or deleted (owners can redact content, which preserves the audit shape). | |

A hub can host many circles (v0.2.0+). The circle you bootstrap first is
usually your family; add more any time with `hub circle create` — no second
deployment needed.

## Roles — there is no "root admin"

There are exactly three roles. **Owner is the top tier** — there is no
separate root-admin above it:

| Role | Can do |
|---|---|
| `owner` | Everything: manage members and roles, create circles, revoke any token, redact entries |
| `parent` | Create topics, invite members, spawn linked threads, manage their own agents' tokens |
| `kid` | Participate in their topics, manage their own agents' tokens — nothing else |

The person who runs the bootstrap call becomes the first owner. Owners can
promote other members to owner.

## Two identities: the human and the agent

- **User identity (member)**: one row per human *per circle* —
  `id, circle_id, name, email, role`. Your permissions come from this row.
  The same human has a separate member row in each circle they belong to
  (possibly with different roles).
- **Agent identity**: the tuple `(member_id, agent_label, token)`. One human
  can have several agents (main agent, phone agent, a script) — each gets its
  **own** credential and label, e.g. "eve-agent acting for Mahesh".
  Permissions always come from the member; the label identifies *which*
  agent acted. Audit entries record `actor_member_id + agent_label +
  token_id`.

**Agents act strictly as their member.** An agent can never do what its human
could not — a kid's agent gets a 403 asking for a parent topic, from the
server, with no client-side filtering to bypass.

## Tokens: one per circle

The server binds each bearer token to exactly one `(member, circle)`.
Consequences:

- Your agent keeps **one token per circle** (the CLI stores them in
  `circle_tokens` in the 0600 profile config; the dashboard keeps a per-circle
  map in the browser). Commands authenticate with the *active* circle's token.
- Creating a circle returns a one-time provisioning code; the CLI
  auto-redeems it so the new circle works immediately.
- Joining someone else's circle means redeeming an invite/provisioning code
  for *that* circle (`hub circle join --code`), which mints a token bound to
  it. Listing circles (`GET /v2/families`) works with any of your tokens —
  the server scopes the list by your email.
- Tokens are 256-bit from a CSPRNG. The server stores only
  `sha256(TOKEN_PEPPER || token)` — a database leak alone yields nothing
  usable without the pepper, which lives only as a worker secret.

## Auth model in one paragraph

Every request carries `Authorization: Bearer fh_…` (except a tiny public
surface: health, and the single-use code-redemption endpoints). One
`resolveToken()` choke point maps the token to `(circle_id, member_id,
role)`; every data query is scoped to that pair, and topic reads additionally
require a `topic_participants` row. Unknown or revoked token → 401.
Authenticated but not a participant → 403, final — the CLI is instructed
never to work around it. Invite and provisioning codes are single-use,
expiring, and grant no read access by themselves; they exist to be shared,
unlike tokens.

## Encryption — stated honestly

- Every topic encrypts subjects, conversation content and task text locally.
  The server stores ciphertext and sealed key envelopes, not topic keys.
- The operator sees metadata: identities, membership, timestamps, task status,
  due dates and assignment. Owning the server alone does not decrypt content.
- A participant's Muse can read content it has keys for. Protect its environment
  and backups; removal cannot erase copies already received.
- A child topic receives independent keys and an approved briefing, never its
  parent's keys. From-join access excludes older epochs.
- First contact trusts the identity directory; later identity changes stop key
  sharing pending independent verification. See [SECURITY.md](SECURITY.md).
- Save the private recovery phrase off-machine or create an encrypted key backup.
  The CLI saves recovery words privately and never prints them into chat.

## What to save, and where

After setup you hold three kinds of secrets. Keep this list:

1. **`TOKEN_PEPPER`** — the 256-bit hex you generated. In a password manager,
   never in git/chat/logs. If it leaks, rotate it — every token in the hub
   invalidates and everyone re-enrolls (by design).
2. **Your Cloudflare API token** (if you use token-based deploys) — same
   handling as any API credential; rotate from the Cloudflare dashboard.
3. **Provisioning/invite codes** — short-lived by design (provisioning: 24h;
   invites: 7d; both single-use). Redeem promptly; a code sitting around is a
   code that can be intercepted.

Agent bearer tokens (`fh_…`) are shown **once** at issuance and go straight
into the agent's Secure Vault (or 0600 file). The one deliberate exception is
`hub dashboard-token`, which prints a circle's token so you can paste it into
the dashboard — treat its output like a password.
