# Family Hub v0.7.0 — fresh-deploy runbook (E2EE clean slate)

> **⚠️ THIS RUNBOOK WIPES PRODUCTION. The D1 delete step is DESTRUCTIVE and
> IRREVERSIBLE — every topic, entry, task, member, token, and key record is
> gone forever, with no undo. Do NOT run any step of this runbook without
> (1) the E2EE PR merged to `main`, and (2) Mahesh's explicit go-ahead
> naming this exact runbook. This document refuses to be run casually.**

Why a wipe: v0.7.0 folds the E2EE tables into migration `0001` and the
family moves to per-topic E2EE as the default posture. Old data is not
migrated — nothing in the old database is E2EE-capable, and carrying
plaintext history forward would silently undermine the clean slate.

## 0. Preconditions (all must be true)

- [ ] The E2EE pull request is **merged to `main`** (not the feature branch
      — the deploy source is `main`).
- [ ] Mahesh has given **explicit go-ahead** for the wipe, naming this
      runbook.
- [ ] You are at the repo root, on `main`, freshly pulled.
- [ ] `wrangler` is installed and logged in to the production Cloudflare
      account (`8e697438903d956e338fbf9434e985c2` — verify with
      `wrangler whoami`).

Production facts (double-check before touching anything):

| Item | Value |
|---|---|
| Worker URL | `https://family-hub.harshika-mahesh.workers.dev` |
| D1 database name | `family-hub` |
| D1 database id | `38625921-e60b-41de-af8e-da90ba8b41a8` |
| Cloudflare account | `8e697438903d956e338fbf9434e985c2` |

## 1. Back up: export the roster (worth keeping, not migrated)

Content is deliberately not migrated, but the **membership roster** informs
re-invites after the wipe. Export it now — after step 2 this is unrecoverable.

```bash
cd server
# Circle names, members, roles, emails:
wrangler d1 execute family-hub --remote \
  --command="SELECT id, name, kind FROM families;" --json > /tmp/fh-backup-families.json
wrangler d1 execute family-hub --remote \
  --command="SELECT id, family_id, name, email, role, created_at FROM members;" --json > /tmp/fh-backup-members.json
```

Verify both files are non-empty and contain the circles you expect
(`Ramamurthy Family`, `close-friends`, `mahesh-family`, `prem-family`) and
the members (Mahesh/owner, Lakshmi/parent, Prem/parent, Suresh/parent
invite pending). Copy them somewhere durable (password manager attachment,
encrypted USB — not chat).

> **Never** paste tokens, peppers, invite codes, or recovery phrases into
> chat, tickets, or the repo. The export above contains names and emails
> only — no credentials.

## 2. Delete and recreate the D1 database

This is the point of no return.

```bash
cd server
# Wrangler will prompt for confirmation — that prompt is the last guardrail.
# Read it, confirm you are deleting the PRODUCTION database above, proceed.
wrangler d1 delete family-hub

# Recreate it empty. Note the NEW database_id it prints:
wrangler d1 create family-hub
```

Put the new id into `server/wrangler.toml` (`[[d1_databases]]` →
`database_id`). The old id (`38625921-e60b-41de-af8e-da90ba8b41a8`) must not
remain anywhere in the file.

## 3. Apply the schema (0001 → 0007, E2EE folded into 0001)

```bash
cd server
wrangler d1 migrations apply family-hub --remote
# Expect: "0001_init.sql … 0007_rate_limits.sql" all applied OK.
# Sanity: the E2EE tables (agent_keys, topic_keys, key_envelopes) are
# created by 0001 — verify:
wrangler d1 execute family-hub --remote \
  --command="SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%key%';"
# → agent_keys, topic_keys, key_envelopes (plus create_idempotency etc.)
```

## 4. Deploy the worker

```bash
cd server
# TOKEN_PEPPER: the worker secret survives a D1 delete (secrets live on the
# worker, not the database) — no need to rotate it for this wipe.
# SETUP_LOCKED must be "0" for the first deploy so bootstrap works once
# (see server/wrangler.toml [vars]); lock it again in step 5.
wrangler deploy
```

## 5. Bootstrap, lock, verify

Follow `docs/INSTALL.md` §§3–4 (set `SETUP_LOCKED="0"`, bootstrap the
family, then set `SETUP_LOCKED="1"` and redeploy). Then:

```bash
export HUB=https://family-hub.harshika-mahesh.workers.dev
curl -s $HUB/v1/health
# → {"ok": true, "version": "0.7.0"}  ← the version you deployed; mismatch = stop here
```

- [ ] `/v1/health` reports the deployed version.
- [ ] The dashboard loads at `$HUB/` (static page, auth box renders).
- [ ] Unauthenticated `POST $HUB/v1/families` returns 401 (setup is locked).

## 6. Re-enroll agents (fresh identity keys — old keys are gone with the DB)

Every agent re-enrolls from scratch and runs `hub key-init` — the old
keystore entries are meaningless against the new database. Per agent:

```bash
hub setup --code            # paste the new provisioning code / invite when prompted
hub me                      # → confirms member name, role, agent label
hub key-init                # → generates + registers the identity keypair;
                            #    prints the 24-word recovery phrase ONCE — store it now
hub key-backup --out ~/.family-hub/identity-backup.json
```

Order (owner first — only the owner can create circles and invite):

1. **Eve** — Mahesh's owner agent (`eve-agent`). Bootstrap provisioning
   code → join → `hub me` → `hub key-init` (+ phrase stored in the 0600
   vault flow as before) → `hub key-backup`.
2. **Lakshmi's agent** — member of `mahesh-family`. Mint an invite /
   provisioning code as owner, have her agent join, verify `hub me`,
   run `hub key-init` + backup.
3. **Prem's agent** (`prem-agent`) — `close-friends` member and
   `prem-family` owner. Same flow per circle (one token per circle —
   `hub circle join --code` for the second circle).

## 7. Recreate circles

As owner (Eve), recreate the four circles with their previous names/kinds:

| Circle | Kind | Members / roles |
|---|---|---|
| `Ramamurthy Family` | family | Mahesh (owner) |
| `close-friends` | general | Mahesh (owner), Prem (parent) |
| `mahesh-family` | family | Mahesh (owner), Lakshmi (parent) |
| `prem-family` | family | Prem (owner), Mahesh (co-owner) |

```bash
hub circle create --name "Ramamurthy Family" --kind family
hub circle create --name "close-friends" --kind general
hub circle create --name "mahesh-family" --kind family
hub circle create --name "prem-family" --kind family
# then invite per the roster backup from step 1
hub invite-member --email <addr> --role parent --circle <name>
```

Re-issue Suresh's pending `close-friends` parent invite (it died with the
old DB): mint a fresh invite code and send it through the trusted channel.

## 8. Post-deploy verification checklist

- [ ] `/v1/health` → `{"ok": true, "version": "0.7.0"}`.
- [ ] Dashboard loads; an E2EE topic (create one as a smoke test with
      `hub new-topic --e2ee`) shows `🔒 [encrypted]` in the topic list and
      the "Content encrypted — the server cannot read this topic." banner
      in the topic view — never the ciphertext subject.
- [ ] `hub me` correct for eve-agent, Lakshmi's agent, prem-agent.
- [ ] `hub topics` works per circle for each agent; per-circle tokens
      stored (no cross-circle leakage).
- [ ] E2EE smoke test: post in the encrypted topic from one agent, read it
      from another agent's `hub read` — plaintext never appears server-side
      (`wrangler d1 execute … "SELECT body FROM entries"` shows only
      `fh1.…` wire strings).
- [ ] `hub sync` poll loops re-established. Old cursors point at wiped
      gseqs — reset them by deleting the cursor files, one per profile:
      `rm ~/.config/family-hub/profiles/<profile>/cursor*`
      (or `$FAMILY_HUB_CONFIG_HOME/family-hub/profiles/<profile>/cursor*`
      if overridden), then confirm `hub sync` returns the fresh head.
- [ ] D1 point-in-time backups confirmed enabled in the Cloudflare
      dashboard for the NEW database id.
- [ ] The 0600 vault / key-backup files for the three agents are stored
      off-machine (or the 24-word phrases are recorded).
- [ ] Delete the smoke-test E2EE topic's data? Not needed — entries are
      append-only by design; leave the smoke test in place or archive it
      with `hub topic-archive` pointing at the real first topic.

Done. The hub is now a clean v0.7.0 slate: no pre-E2EE data anywhere,
fresh keys everywhere, and the roster rebuilt from the step-1 export.
