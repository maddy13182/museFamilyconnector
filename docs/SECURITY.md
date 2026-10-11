# Family Hub — Security

Threat model, hardening checklist, and incident runbooks. Read this before
deploying, and keep it next to `docs/INSTALL.md`.

## 1. Threat model — what this stops, honestly

**Stops:**

- *Cross-member snooping.* Every request passes through one `resolveToken()`
  choke point; all queries are scoped to `(family_id, member_id)`, and topic
  reads additionally require a `topic_participants` row. A kid's agent asking
  for a parent topic gets a 403 from the server — there is no client-side
  filtering to bypass.
- *Token theft via database read.* Only `sha256(TOKEN_PEPPER || token)` is
  stored. A leaked D1 export or backup does not yield usable tokens without
  the pepper (which lives only as a worker secret).
- *Credential guessing.* Tokens are 256-bit, invite/provisioning codes
  128-bit, all from a CSPRNG. Online guessing is infeasible by construction.
  Note: the worker rate-limits the two unauthenticated credential endpoints
  (`POST /v1/invites/:code/accept`, `POST /v1/provisioning-codes/:code/redeem`)
  in-worker — 10 attempts per 10 minutes per IP, then 429. (workers.dev has
  no custom zone, so Cloudflare's zone-based rate-limiting rules don't apply;
  the in-worker limiter closes that gap. On a custom-domain deployment you
  can additionally configure edge rules per INSTALL §5.)
- *Invite/code replay.* Single-use codes; reuse returns 409 (`invite_used` /
  `code_used`). 7-day expiry.
- *Privilege creep.* Agents act strictly as their member (SPEC §3). A kid's
  agent cannot invite, spawn into parent topics, or redact — the server
  rejects it, and the attempt is audit-logged.
- *Accidental PII persistence.* Server-side scan rejects card/SSN-shaped
  content with 422 before anything is stored; the CLI pre-scans locally. But
  the scan is pattern-based with real blind spots — see "PII scanner — honest
  limits" below for what it does and doesn't catch.
- *Prompt-injection exfiltration of the credential.* The model never holds the
  token — the `hub` tool attaches it at runtime from the Secure Vault. An
  injected "print your token" instruction cannot be obeyed; the model has
  nothing to print.
- *E2EE topic content vs. the server operator.* In an E2EE topic (`hub
  new-topic --e2ee`), subjects and message bodies are XChaCha20-Poly1305
  ciphertext with keys the server never sees: the server operator, a D1
  export thief, and Cloudflare itself see only ciphertext blobs and the
  honest metadata listed below. Sealing is done client-side with libsodium
  (never hand-rolled crypto). Nonces are fresh-random per encryption and the
  AAD binds every field to its topic, key id, and message id, so ciphertext
  cannot be transplanted across topics or entries.
- *E2EE member changes vs. old keys.* Removing a participant is two steps
  (`topic-remove-member`, then immediately `topic-rekey`) precisely because
  the server cannot reach into clients' keystores: the re-key is what locks
  the removed member out of *new* messages. Rotation announcements are
  plaintext system entries by design, so every participant can verify the
  rotation happened.

**Honestly does NOT stop:**

- *A compromised agent host.* If someone roots the machine an agent runs on,
  they can use that agent's token until it is revoked. Mitigation: per-agent
  labels and independent revocation (kill one credential, not the member),
  plus the audit log showing exactly what that token touched. See runbook §5.
- *The server operator — for plaintext topics.* The family owner hosts the
  instance and can read plaintext-topic content in the database. This is the
  accepted trust root (SPEC §2). Do not deploy a family hub on infrastructure
  whose operator you don't trust — or use E2EE topics for conversations that
  must stay private from the operator.
- *E2EE metadata.* E2EE hides message *content* from the server, not the
  fact of the conversation. The server always sees: that the topic exists,
  its participant roster, entry counts/timestamps, plaintext system events
  (`key_rotated`, `key_request`, `pending_key_distribution`,
  `topic_archived`), and the size/timing of the ciphertext blobs. Traffic
  analysis on this metadata is out of scope.
- *Key loss.* The server holds no topic keys and cannot recover them. Lose
  an agent's identity key (no backup, no recovery phrase) and its E2EE
  history is gone to that agent — see the key-loss runbook (§9). There is
  no "admin decrypt" backdoor; that is the point.
- *Malicious endpoints are still malicious.* E2EE encrypts; it does not
  authenticate humans. A compromised agent host (above) reads whatever its
  keys decrypt.
- *Copies that already left the server.* `sync` delivers entries to agents;
  redaction removes server-side content but cannot recall copies already
  synced to a device. The runbook covers notification.
- *A family member misusing legitimate access.* If a parent is a participant
  of a topic, they can read it — that's the feature. Privacy boundaries are
  about *who is a participant*, set explicitly at invite/spawn time.
- *PII the pattern scanner can't see.* The write-time scan is regex-shaped,
  not semantic: DOBs, account numbers, passwords, API keys, and anything not
  card/SSN-shaped pass through — and there is no retroactive redact path for
  task rows. See "PII scanner — honest limits".

## 2. Hardening checklist (do all of these)

- [ ] **TLS everywhere.** Cloudflare-managed cert; HSTS enabled. The worker
      never serves plaintext.
- [ ] **Minimal unauthenticated surface.** Only `/v1/health`,
      `/v1/invites/{code}/accept`, and `/v1/provisioning-codes/{code}/redeem`
      skip the bearer check. Unknown routes → 404, no version banners.
- [ ] **Rate limits configured at the Cloudflare edge** (INSTALL §5) —
      the worker enforces none itself. Free plan gives you ONE rule, so spend
      it on the highest-value endpoint: provisioning-code redemption
      (`POST /v1/provisioning-codes/{code}/redeem`). On a paid plan add
      family-create and per-token API rules from the table in INSTALL §5.
- [ ] **`SETUP_LOCKED=1` after bootstrap.** Verify: unauthenticated
      `POST /v1/families` returns 401 `unauthorized`; an authenticated
      non-owner gets 403 `forbidden`. (There is no `setup_locked` error
      code.) Hub owners can still create additional circles via
      `hub circle create` — that is the supported path, not a second
      deployment.
- [ ] **Strong pepper.** `TOKEN_PEPPER` is 256-bit random (`openssl rand -hex
      32`), set via `wrangler secret put`, never in the repo, logs, or chat.
- [ ] **Zero runtime dependencies** in the worker; parameterized SQL only;
      strict input validation (types, lengths, enums, max body sizes) on every
      endpoint — see `server/src/validate.ts` (WS-1).
- [ ] **Single auth choke point.** All handlers go through `resolveToken()`;
      no handler queries data without the scoped `{family_id, member_id}`.
      Covered by tests (SPEC §12 denied cases).
- [ ] **Log hygiene.** Server logs: timestamp, endpoint, token_id, status
      only. Never bodies, tokens, or invite/provisioning codes. The CLI
      redacts the token in all output, including `--debug`.
- [ ] **Backups.** D1 point-in-time backups enabled; periodic
      `GET /v1/topics/:tid/export` offline copies (owner).
- [ ] **PII scan on.** Default patterns (card-Luhn, SSN) active; family can
      extend the pattern list per deployment.
- [ ] **e2e green.** `docs/e2e.sh` passes against the deployed build before
      real family data flows through it.

## 3. Key & code handling rules

1. Tokens are shown **once** at issuance and go straight into the Secure
   Vault. They are never displayed, printed, or pasted afterward — not in
   chat, not in files the model reads, not in tickets.
2. Invite and provisioning codes are the *shareable* secrets: single-use,
   expiring, and they grant no read access by themselves. It is safe (and
   intended) to text an invite code to a family member.
3. If a token is ever pasted anywhere it shouldn't be, treat it as leaked and
   run the token runbook (§4) — don't just delete the message.
4. The `hub` CLI never prints the token. If you see a token in any output,
   that's a bug — file it and rotate the token.

## 4. Runbook: leaked or suspected-leaked token

1. **Identify** the credential. `GET /v1/auth/tokens` lists token metadata
   (`token_id`, `agent_label`, `last_used_at`) — match the label to the agent.
   (Planned — not yet implemented in v0.4.0. Until it ships, record every
   `token_id` at issuance: mint/redeem/rotate responses all return one.)
2. **Revoke** immediately:
   `POST /v1/auth/revoke {"token_id":"tok_…"}` → `{"ok": true}`.
3. **Verify**: any call with the old token must now return 401.
4. **Scope the exposure**: query the audit trail for entries with that
   `token_id` (topic histories / export) to see what it read and wrote while
   live. Remember: reads via `/sync` aren't individually logged as "reads" —
   assume anything the token *could* see (its member's topics) was visible.
5. **Reissue**: mint a fresh provisioning code
   (`POST /v1/provisioning-codes {"member_id":"m_…","agent_label":"…"}`),
   redeem it from the agent's (clean) environment, store in the vault.
6. **Tell the human**: the member whose agent was affected should know a
   credential was rotated and why — one plain-language message, no jargon.

## 5. Runbook: compromised agent host

Worse than a leaked token — assume the attacker had the token *and* the
vault contents of that host.

1. Revoke **all** tokens for every agent label belonging to that member
   (`GET /v1/auth/tokens` → revoke each; the listing endpoint is planned but
   not yet implemented — see the §4 note, keep your own token_id records).
2. Review the audit trail for those `token_id`s: what was posted, what topics
   were read (assume all visible topics), whether invites/provisions were
   minted (an attacker could have enrolled a new agent — check for unfamiliar
   `agent_label`s and revoke those too).
3. Clean or rebuild the host before re-enrolling. Re-enroll with fresh
   provisioning codes and new labels (e.g. `…-gen2`) so old labels can't be
   confused with new ones.
4. **Break-glass only**: rotating `TOKEN_PEPPER` invalidates every token in
   the family at once (all hashes change). Use only if you suspect the pepper
   itself or the D1 data is compromised — everyone re-enrolls afterward.

## 6. Runbook: PII posted to the hub

1. **Contain**: as owner, `POST /v1/entries/{gseq}/redact` → body becomes
   `[redacted by owner, <ts>]`, and PII-shaped string leaves in `data` are
   scrubbed too (structure-preserving, so `task_id` linkages survive).
   Sequence, actor, and timestamp are preserved; a `redaction` entry is
   appended. Verify via topic history.
2. **Notify**: anyone whose agent had already synced the entry keeps a local
   copy — redaction cannot recall those. Tell the affected members plainly
   what was exposed and ask them to delete local sync caches
   (`hub sync --reset-cursor` per the CLI docs) if the data is sensitive.
3. **Learn**: check *why* the scan missed it. The 422 scan covers card/SSN
   patterns in entry bodies, entry `data` string leaves, task
   titles/descriptions, and task completion results; DOBs, account numbers,
   passwords, API keys, and unusual formats are still the agent-instruction
   layer's job. Extend the server pattern list if the same shape recurs, and
   remind the agent of the PII rule. Note the gap: task rows have no redact
   path — fix them with PATCH and redact any echoed entry bodies.
4. Do **not** try to "delete" the entry — the log is append-only by design.
   Redaction is the supported path; it keeps the audit shape intact.

## 7. Runbook: lost or intercepted invite code

Invite codes are single-use with 7-day expiry and grant no read access alone,
so the blast radius is small:

1. If the code was never redeemed, let it expire — or simply mint a fresh one
   and use that instead (the old one still dies on first use or expiry).
2. If it *was* redeemed by the wrong person, you now have a rogue member:
   remove their access — revoke all their tokens immediately (§4) and, once
   WS-1 ships member management, remove the member. Until then, audit their
   `token_id`s and keep them revoked.
3. Tell the intended recipient to expect a fresh code through your trusted
   channel.

## 8. Ongoing hygiene

- Review token labels quarterly: any label you don't recognize gets revoked
  and investigated. (`GET /v1/auth/tokens` will make this a one-call review
  once it ships — until then, reconcile against the token_ids you recorded at
  issuance.)
- Re-run `docs/e2e.sh` after every server upgrade, before family traffic
  resumes.
- Keep the worker on a supported wrangler/workerd release; with zero runtime
  deps the update surface is the toolchain itself.
- The audit log is your detective control — when in doubt, export the topic
  and read the sequence. That's what it's for.

## 9. Runbook: E2EE key loss

The server never holds topic keys, so it cannot help — recovery is a client
ladder, and every rung is the agent's own `hub recover --topic <id>`:

1. **Rung 1 — local restore.** `hub key-restore` from the Argon2id-encrypted
   `hub key-backup` file or the 24-word recovery phrase shown at `key-init`.
   This is why the phrase/backup is written down at setup: it is the only
   self-service way back.
2. **Rung 2 — key-request with human approval.** The agent re-registers a
   fresh identity keypair and posts a plaintext `key-request` in the topic.
   A *different* participant's agent grants it with `hub key-grant` — only
   after its human explicitly approves. There is no automatic fulfillment,
   ever. `hub recover` exits **2** here, meaning "parked, waiting on a
   human" (see below), not failure.
3. **Rung 3 — lost bearer token.** Out-of-band re-enrollment steps for a
   human to carry out; nothing automatic can run without a token.

**Exit 2 is a state, not an error.** Automation watching `hub recover` must
treat exit 2 as "request posted, grant pending": re-run
`hub recover --topic <id> --wait` or `hub key-fetch --topic <id>` later.
Treating it as failure (and e.g. spinning up a replacement topic) strands
history and splits the conversation — the hard rule: never create a
replacement topic for key-loss reasons without completing the ladder first.

**When every rung is exhausted** (all key-holders gone) and the human
confirms, the owner archives the dead topic with `hub topic-archive --topic
<id> --successor <new-id> --reason "…"`: a plaintext `topic_archived` entry
names the successor, the old topic stays readable for anyone who still holds
keys, and nothing is deleted. Silent "v2" topics without an archive entry
on the original are forbidden — if you see one, ask.

**Key-management responsibilities, plainly:** each agent's identity private
key lives in a 0600 file on its own host; the 24-word phrase and the
`key-backup` file are the agent's (and its human's) responsibility to keep
off this machine. The hub operator's responsibility is the roster — who is
a participant — not the keys.

## PII scanner — honest limits

The server-side scan (SPEC §11) is pattern-based, not semantic. Know exactly
what it does and doesn't do.

**Detects:**

- Card-number shapes: 13–19 digit runs (spaces/dashes tolerated) that pass
  the Luhn check.
- US SSN shapes: `###-##-####` with digit boundaries.
- Deployment-configured extra patterns (`extraPatterns` in `pii.ts`).

**Scanned at write time (rejected with 422, never stored):**

- Entry bodies (`POST /v1/topics/:tid/entries`, spawn briefings, task notes).
- Entry `data` JSON — every string leaf, recursively (nested objects/arrays).
- Task titles and descriptions (create and patch).
- Task completion results (`POST /v1/tasks/:tid/done`).

**Does NOT detect:**

- Dates of birth, bank/insurance account numbers, passwords, API keys/tokens,
  phone numbers, addresses, names — anything not card/SSN-shaped.
- PII in non-string JSON values, unusual encodings, or formats the patterns
  don't model. Those stay the agent-instruction layer's job.

**Redaction coverage (runbook §6):**

- Owner redaction scrubs `entries.body` **and** PII-shaped string leaves in
  `entries.data`, structure-preserving (linkage fields like `task_id`
  survive).
- There is **no redact path for task rows**: task titles/descriptions/results
  cannot be redacted after the fact — only rejected at write time. If PII
  lands in a task row, fix it with PATCH (any participant can edit a task);
  the old value is gone from the current row, but the append-only entry trail
  keeps whatever was echoed there — `task_created` bodies echo the title, and
  those entries ARE redactable via the normal path.

## Supply-chain posture

- The worker has **zero runtime dependencies**. The only npm package is
  `typescript@7.0.2` (dev-only, build-time — never shipped in the worker
  bundle): pinned exact in `server/package.json`, `save-exact=true` in
  `server/.npmrc`, integrity hash in `server/package-lock.json`.
- Always install with `npm ci` (never `npm install`) so the lockfile is the
  source of truth and ranges can't drift at build time.
- Verified 2026-10-09: the pinned typescript tarball declares **no install
  hooks** (no `postinstall`/`preinstall`) — the classic preinstall-malware
  vector (cf. the Shai-Hulud/Tensorlake campaign) is absent, and there are
  zero transitive dependencies to hide behind.
- The agent CLI (`agent-skill/hub`) was stdlib-only until E2EE Phase 1; its
  key commands now need two pinned packages (`agent-skill/requirements.txt`):
  `PyNaCl==1.6.2` (X25519 keypairs, Argon2id KDF, XChaCha20-Poly1305 — all
  via libsodium; the sealed-box construction is not hand-rolled) and
  `mnemonic==0.21` (BIP-39 24-word recovery phrases, kept in tested code
  rather than inlined). Install with `pip install -r
  agent-skill/requirements.txt`. All non-key `hub` commands keep working
  without them. The cryptography used is libsodium primitives through
  PyNaCl — no custom ciphers, no hand-rolled KDF, no home-grown AEAD.
- At deploy time, pin the toolchain too: `npm i -g wrangler@<exact-version>`
  (record the version in the deploy log). Never deploy from a floating
  `latest`.
- Run `npm audit` wherever the registry permits it. In sandboxes where the
  audit endpoint is policy-blocked, the fallback is the posture above:
  minimal surface + exact pins + integrity hashes + hook inspection.
