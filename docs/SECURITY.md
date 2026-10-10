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
  128-bit, all from a CSPRNG. Online guessing is infeasible by construction
  and rate-limited in practice (§4).
- *Invite/code replay.* Single-use codes; reuse returns 404. 7-day expiry.
- *Privilege creep.* Agents act strictly as their member (SPEC §3). A kid's
  agent cannot invite, spawn into parent topics, or redact — the server
  rejects it, and the attempt is audit-logged.
- *Accidental PII persistence.* Server-side scan rejects card/SSN-shaped
  content with 422 before anything is stored; the CLI pre-scans locally.
- *Prompt-injection exfiltration of the credential.* The model never holds the
  token — the `hub` tool attaches it at runtime from the Secure Vault. An
  injected "print your token" instruction cannot be obeyed; the model has
  nothing to print.

**Honestly does NOT stop:**

- *A compromised agent host.* If someone roots the machine an agent runs on,
  they can use that agent's token until it is revoked. Mitigation: per-agent
  labels and independent revocation (kill one credential, not the member),
  plus the audit log showing exactly what that token touched. See runbook §5.
- *The server operator.* The family owner hosts the instance and can read the
  database. This is the accepted trust root (SPEC §2: no end-to-end
  encryption in v0.1). Do not deploy a family hub on infrastructure whose
  operator you don't trust.
- *Copies that already left the server.* `sync` delivers entries to agents;
  redaction removes server-side content but cannot recall copies already
  synced to a device. The runbook covers notification.
- *A family member misusing legitimate access.* If a parent is a participant
  of a topic, they can read it — that's the feature. Privacy boundaries are
  about *who is a participant*, set explicitly at invite/spawn time.

## 2. Hardening checklist (do all of these)

- [ ] **TLS everywhere.** Cloudflare-managed cert; HSTS enabled. The worker
      never serves plaintext.
- [ ] **Minimal unauthenticated surface.** Only `/v1/health`,
      `/v1/invites/{code}/accept`, and `/v1/provision/{code}/accept` skip the
      bearer check. Unknown routes → 404, no version banners.
- [ ] **Rate limits in place** (INSTALL §5): 5/min/IP on family-create,
      10/min/IP on invite-accept, 60/min/token on the API.
- [ ] **`SETUP_LOCKED=1` after bootstrap.** Verify `POST /v1/families`
      returns 403 `setup_locked`.
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

1. **Identify** the credential. As owner/parent: `GET /v1/auth/tokens` lists
   token metadata (`token_id`, `agent_label`, `last_used_at`) — match the
   label to the agent. (If the label is unknown, list and check `last_used_at`
   for surprises.)
2. **Revoke** immediately:
   `POST /v1/auth/revoke {"token_id":"tok_…"}` → `{"revoked": true}`.
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
   (`GET /v1/auth/tokens` → revoke each).
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
   `[redacted by owner, <ts>]`. Sequence, actor, and timestamp are preserved;
   a `redaction` entry is appended. Verify via topic history.
2. **Notify**: anyone whose agent had already synced the entry keeps a local
   copy — redaction cannot recall those. Tell the affected members plainly
   what was exposed and ask them to delete local sync caches
   (`hub sync --reset-cursor` per the CLI docs) if the data is sensitive.
3. **Learn**: check *why* the scan missed it. The 422 scan covers card/SSN
   patterns; DOBs, account numbers, and IDs in unusual formats are the
   agent-instruction layer's job. Extend the server pattern list if the same
   shape recurs, and remind the agent of the PII rule.
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

- Review `GET /v1/auth/tokens` (owner) quarterly: any label you don't
  recognize gets revoked and investigated.
- Re-run `docs/e2e.sh` after every server upgrade, before family traffic
  resumes.
- Keep the worker on a supported wrangler/workerd release; with zero runtime
  deps the update surface is the toolchain itself.
- The audit log is your detective control — when in doubt, export the topic
  and read the sequence. That's what it's for.
