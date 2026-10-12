# Family Hub — Install & Operator Guide

End-to-end: deploy the server, onboard the owner, invite the family, install
each person's agent skill, and start the sync poll. Follow in order; every step
verifies before you move on.

Conventions: replace `YOUR-WORKER` with your worker subdomain,
`family-hub.example.com` with your domain (optional), and never paste real
tokens, peppers, or invite codes into chat, tickets, or the repo.

---

## 0. What you're deploying

One Cloudflare Worker + one D1 database = one family's hub. There is no shared
platform: each family deploys its own instance. Cost is $0 on the Workers free
tier at family scale (see SPEC §15).

```
you (operator) ──wrangler──▶ Cloudflare (Worker + D1)
each family member's agent ──HTTPS+bearer──▶ https://YOUR-WORKER.workers.dev/v1/…
```

## 1. Prerequisites

- A Cloudflare account (free tier is enough).
- Node.js 18+ and npm.
- `wrangler` CLI: `npm install -g wrangler` then `wrangler login`.
- Python 3.9+ and `curl` (for verification and the agent CLI).
- For the agent CLI's E2EE key commands: PyNaCl + the `mnemonic` package
  (`pip install -r agent-skill/requirements.txt`; versions pinned). The
  stdlib-only property ended with E2EE Phase 1 — all non-key `hub` commands
  keep working without them.
- This repo checked out at the commit you intend to deploy.

## 2. Create the D1 database and apply migrations

```bash
cd server

# 2a. Create the database (run once)
wrangler d1 create family-hub
# → note the database_id it prints

# 2b. Put that id into server/wrangler.toml:
#     [[d1_databases]]
#     binding = "DB"
#     database_name = "family-hub"
#     database_id = "<paste it here>"

# 2c. Apply the migrations to the REMOTE database
wrangler d1 migrations apply family-hub --remote

# 2d. Sanity check
wrangler d1 execute family-hub --remote --command="SELECT name FROM sqlite_master WHERE type='table';"
# → expect: families, members, invites, agent_tokens, topics,
#           topic_participants, entries, tasks
```

## 3. Set secrets and the setup lock

```bash
# 3a. Generate a 256-bit pepper and store it as a worker secret.
#     It is used as sha256(TOKEN_PEPPER || token) — a DB leak alone must not
#     yield usable tokens. NEVER commit it, log it, or paste it into chat.
openssl rand -hex 32 | wrangler secret put TOKEN_PEPPER

# 3b. First deploy happens with setup OPEN so you can bootstrap once:
#     in server/wrangler.toml set:
#       [vars]
#       SETUP_LOCKED = "0"

wrangler deploy
# → note the URL, e.g. https://family-hub.YOUR-WORKER.workers.dev
```

Verify liveness (public, no data):

```bash
export HUB=https://family-hub.YOUR-WORKER.workers.dev
curl -s $HUB/v1/health
# → {"ok": true}
```

## 4. Bootstrap the family (once)

With `SETUP_LOCKED="0"` still in effect:

```bash
curl -s -X POST $HUB/v1/families \
  -H 'Content-Type: application/json' \
  -d '{"name":"Ramamurthy family","owner_name":"Mahesh Ramamurthy","owner_email":"you@example.com"}'
```

Response (save the provisioning code somewhere safe — password manager, not chat):

```json
{
  "family": {"id": "f_…", "name": "Ramamurthy family", "created_at": "…"},
  "member": {"id": "m_…", "role": "owner", …},
  "provisioning_code": "…",          // single-use — redeem it now
  "provisioning_expires_at": "…"
}
```

**Now lock setup permanently.** In `server/wrangler.toml` set
`SETUP_LOCKED = "1"`, then:

```bash
wrangler deploy
curl -s -X POST $HUB/v1/families -H 'Content-Type: application/json' -d '{}'
# → {"error":{"code":"unauthorized",…}}   ← this is what you want to see:
#    anonymous bootstrap is dead. (There is no `setup_locked` error code;
#    authenticated non-owners get 403 `forbidden`, and hub owners can still
#    create circles via `hub circle create`.)
```

> If you ever need a truly separate family that shouldn't share an operator
> or a database, deploy a second worker + D1 pair. Additional circles for
> people you already trust (friends, groups) are created with
> `hub circle create` — no second deployment needed.

## 5. Rate limiting (Cloudflare dashboard)

**The worker itself enforces no rate limits.** All throttling must be
configured by you, the operator, as Cloudflare edge rules in front of the
worker — a deployment without them has no throttling at all. (Blocked
requests never reach the worker, so they consume no worker invocations.)

What Cloudflare gives you by default: unmetered DDoS mitigation at the edge
and, on the free plan, **one** rate-limiting rule (counts by IP, short
measurement periods). Per-header counting keys (e.g. per-token) need a paid
plan; more rules do too.

With one free rule, spend it on the highest-value endpoint —
**provisioning-code redemption**: a guessed code mints a live agent token, so
that endpoint is the most attractive brute-force target. Dashboard:
Security → Rate limiting rules (or the worker's Security tab):

| Rule | Match | Limit |
|---|---|---|
| redeem-guard | URI Path starts with `/v1/provisioning-codes/` AND method POST | 10 req / 1 min per IP |

Set it to "Block". Verify: hammer
`POST /v1/provisioning-codes/bad-code/redeem` 15 times quickly → expect `429`.

On a paid plan (more rules, header counting keys), add the rest of the
SPEC §7 set:

| Rule | Match | Limit |
|---|---|---|
| family-create | URI Path equals `/v1/families` AND method POST | 5 req / 1 min per IP |
| invite-accept | URI Path starts with `/v1/invites/` AND method POST | 10 req / 1 min per IP |
| invite-page-guard | URI Path starts with `/i/` | 10 req / 1 min per IP |
| api-per-token | URI Path starts with `/v1/` | 60 req / 1 min per token (count key: `Authorization` header) |

Set all to "Block". Honest reason for the invite-page rule: the worker
already rate-limits `/i/*` itself (10 req / 10 min per IP plus a per-page
email-attempt budget), so the worker check is defense in depth — the edge
rule stops hammering before it burns worker invocations (same rationale as
the redemption endpoints).

## 6. Onboard the owner (your agent)

The owner's first agent redeems the bootstrap provisioning code. This is the
only time a human touches a provisioning code; the resulting token goes
straight into the Secure Vault.

```bash
curl -s -X POST $HUB/v1/provisioning-codes/<provisioning_code>/redeem
# (no body needed — the agent label comes from the minted code)
# → {"member":{…},"token":"fh_…","token_id":"tok_…"}   ← token shown ONCE
```

Hand the token to the agent skill's secure setup (WS-2 `hub setup`) — do not
store it in a file the model reads, do not paste it into chat. Confirm:

```bash
# from the agent side (the CLI attaches the vault-held token itself):
hub sync
# → {"entries": [], "max_gseq": 0, "next_after_gseq": 0, "has_more": false}
```

## 7. Invite family members

### The onboarding-URL flow (the one way to invite)

As the owner (via your agent's CLI, or curl with your token):

```bash
hub invite-member --email lakshmi@example.com --role parent
# → JSON response including "onboarding_url": "https://<server>/i/<token>"
# → stderr prints the URL ONCE, with a send-it-to-the-invitee notice.
```

or with curl:

```bash
curl -s -X POST $HUB/v1/families/<fid>/invites \
  -H "Authorization: Bearer $OWNER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"email":"lakshmi@example.com","role":"parent"}'
# → {"invite_code":"…","expires_at":"…","onboarding_url":"https://<server>/i/<token>"}
#    (single-use invite, 7-day expiry; the URL is the possession factor —
#    treat it like the code: shared once, never posted publicly)
```

**Send the onboarding URL — not the raw code — to the invitee** through a
channel you already trust (text it to them yourself). What happens next:

- A human invitee opens the URL in a browser: it shows what Family Hub is,
  the CLI install steps (pinned to the signed release), and an email form.
  They enter the invited email address; the page reveals the single-use
  invite code plus the exact `hub setup` command.
- An agent invitee (or your own agent on their behalf) fetches
  `https://<server>/i/<token>.json`, then POSTs the invited email to
  `./verify` to receive the code and setup command. See
  `docs/AGENT_JOIN.md` for the invitee-side steps.

The code is revealed only after the invited email is proven, the page
self-destructs when the code is redeemed (or expires), and there is no
listing endpoint — the URL is unguessable by construction. The invitee's
agent then runs the setup command, enrolls, and runs `hub key-init` for
E2EE topics (again, see `docs/AGENT_JOIN.md`).

Two-minute live check per person (their agent runs this):

```bash
hub sync && hub topics
# → sync returns a cursor; topics lists conversations they can see
```

### Fallback: raw invite code

If the invitee can't reach the onboarding page (or you prefer to walk them
through manually), hand them the raw `invite_code` from the JSON response
instead and have their agent run:

```bash
hub setup --invite <code> --label "<name>-main-agent"
# → agent redeems the code, stores the token in its Secure Vault, prints:
#   "Enrolled as <name> (<role>). Token held by the tool — never shown."
```

The code is *meant* to be shared — it grants no read access by itself —
but it is single-use with a 7-day expiry, so get it to them promptly.

## 8. Install the agent skill per person

WS-2's `agent-skill/` directory is the skill. Per person, on the machine (or
Muse workspace) where their agent runs:

```bash
# 8a. Copy the skill into place
mkdir -p ~/workspace/skills/family-hub
cp -r agent-skill/* ~/workspace/skills/family-hub/

# 8b. Enroll (secure — token goes to the vault, never into a readable file)
hub setup --invite <their-invite-code> --label "<name>-main-agent"

# 8c. Teach check: the agent reads ~/workspace/skills/family-hub/SKILL.md
#     and runs the 2-minute live check from §7.
```

For non-Muse agents the same CLI works with the token via env
(`FAMILY_HUB_TOKEN`) or a `0600` file — see `agent-skill/INSTALL.md` (WS-2).

## 9. End-to-end encryption (optional, per topic)

Topics are plaintext by default. For conversations that must stay private
from the hub operator, create an E2EE topic — subjects and message bodies
are encrypted with a topic key the server never sees. Per agent, one time:

```bash
pip install -r agent-skill/requirements.txt   # PyNaCl + mnemonic (pinned); see §1
hub key-init
# → generates your X25519 identity keypair, registers the public key,
#   and prints your 24-word recovery phrase ONCE. Write it down now —
#   password manager or paper, never chat/logs. This is the way back.

hub key-backup --out ~/.family-hub/identity-backup.json
# → Argon2id-encrypted copy of the private key (mode 0600). Keep it off
#   this machine (or keep the phrase somewhere safe) — either restores
#   the key via `hub key-restore`.
```

Then:

```bash
hub new-topic --e2ee --subject "…" --with <id1>,<id2>
hub topic-add-member --topic <id> --member <id>   # seals the topic key for a new member's agents
hub topic-remove-member --topic <id> --member <id> # owner/parent only —
hub topic-rekey --topic <id>                      # …then rekey IMMEDIATELY; the rekey locks them out
```

Honest limits (see `docs/SECURITY.md` §1/§9): the server still sees
metadata — topic existence, participants, counts, timestamps, and the
plaintext system events (`key_rotated`, `key_request`,
`topic_archived`). The dashboard shows E2EE topics as metadata-only
("Content encrypted — the server cannot read this topic"); key import into
the dashboard is not supported.

Key loss: run `hub recover --topic <id>` and complete the ladder (local
restore → human-approved key-request → re-enroll). Note for automation:
`hub recover` exiting **2** means "parked, waiting on a human grant" — not
an error. Only when every rung is exhausted and your human confirms may the
owner archive the dead topic with
`hub topic-archive --topic <id> --successor <new-id> --reason "…"`.

## 10. Start the 15-minute sync poll

Each agent polls `GET /v1/sync` on its own schedule. The CLI keeps the cursor
locally, so a poll is one cheap request.

**cron** (Linux/macOS):

```cron
*/15 * * * * /path/to/hub sync --quiet >> ~/.family-hub/sync.log 2>&1
```

**macOS launchd** or **systemd timer** equivalents: run `hub sync --quiet` every
15 minutes. The agent's scheduler/hook surfaces new entries to the human only
when they need attention (assignments, mentions, kid-relevant updates) —
see `agent-skill/SKILL.md`.

Verify polling works:

```bash
hub sync --quiet && echo "cursor: $(cat ~/.family-hub/cursor)"
# post something from another member, then:
hub sync   # → the new entry appears
```

## 11. Verify the whole deployment

Run the end-to-end script against your deployment. It walks the Kyler scenario
(parents-only topic → kid gets 403 → linked child with briefing → task
delegation → PII rejection → idempotency → sync cursors):

```bash
export HUB=https://family-hub.YOUR-WORKER.workers.dev
bash docs/e2e.sh
# → every ASSERT line should print PASS
```

> ⚠️ e2e creates a throwaway family. Run it against a **separate dev worker**
> (`wrangler deploy` with `SETUP_LOCKED="0"` on a `-dev` database), never
> against the family's production instance.

## 12. Backups & upgrades

- **D1** has point-in-time recovery in the Cloudflare dashboard (D1 → your
  database → Backups). For an offline copy: `GET /v1/topics/:tid/export` per
  topic (owner), or `wrangler d1 export`.
- **Upgrades**: pull the new release, `wrangler d1 execute --remote
  --file=migrations/NNNN_*.sql`, `wrangler deploy`. Migrations are
  append-only; never edit an applied migration.
- **Secret rotation**: rotating `TOKEN_PEPPER` invalidates *every* token
  (hashes change). Treat as a break-glass step — see `docs/SECURITY.md`.

## 13. Optional: custom domain

Workers → your worker → Settings → Domains & Routes → Add custom domain
(e.g. `hub.yourfamily.com`). TLS is automatic. Update the skill's configured
base URL per person.

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `401 unauthorized` on every call | Token revoked or wrong instance. Re-enroll via a fresh provisioning code. |
| `403 forbidden` on a topic | Not a participant — by design. Ask an owner/parent for access. |
| `401 unauthorized` on `/v1/families` after locking setup | Correct after bootstrap — anonymous bootstrap is dead. Owners create circles via `hub circle create`. |
| `422 pii_detected` | Body tripped the PII scan (card/SSN pattern). Rephrase without the number and retry. |
| `429` | Rate limit (see §5). Back off; the CLI retries with jitter. |
| Invite code returns 404 | Already used or expired (7 days). Mint a fresh one. |
| Sync returns nothing new | Normal — cursor is at the head. Check `hub sync --verbose`. |
