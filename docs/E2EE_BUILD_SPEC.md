> Historical design notes. Protocol 2 supersedes optional encryption, v1 routes,
> legacy subject formats and force commits described below. Use [INSTALL.md](INSTALL.md),
> [SECURITY.md](SECURITY.md) and [the encryption guide](../agent-skill/references/e2ee.md)
> for the implemented contract.

# E2EE Build Spec — per-topic end-to-end encryption

**Source design:** `research/e2ee-design.md` (branch `design/agent-circles`, commit `a24b488`).
**Goal:** remove the infrastructure admin as a trust root for message content
confidentiality. After this build, an admin with full D1 access sees only
ciphertext and opaque envelopes for E2EE topics — never plaintext.
**Version:** server 0.7.0, skill 0.5.0 (minor: backwards-compatible, opt-in per topic).
**Non-goals:** metadata hiding, server-side search over E2EE content, PQ safety,
per-message ratcheting, server-side key escrow (all rejected in the design).

---

## Phase 1 — Key infrastructure

**Server:**
- Migration `0008`: `agent_keys(member_id, agent_label, public_key, created_at)`.
  Public keys are public; no secrecy needed.
- `POST /v2/provisioning-codes/:code/redeem` gains optional `agent_public_key`
  (32-byte X25519, base64). Stored bound to `(member_id, agent_label)` in the
  same atomic batch as the token. Absent = agent has no E2EE identity (can
  still use plaintext topics).
- `GET /v2/agent-keys?member_id=…` — key directory. Authenticated; returns
  public keys for members the caller shares a circle with. (Needed for
  envelope creation.)
- Key rotation: `POST /v2/agent-keys/rotate` with new public key, authenticated
  by Bearer <redacted> Old key marked superseded, not deleted (existing envelopes
  still reference it).

**CLI:**
- New dependency: **PyNaCl** (pinned version, constraints file). This ends the
  stdlib-only property — documented in the changelog and INSTALL.
- `hub setup`: generates X25519 keypair locally (`os.urandom`), stores private
  key at `~/.config/family-hub/profiles/<name>/agent.key` (mode 0600), sends
  public key at redeem. Prints a **24-word BIP-39 recovery phrase** — happy
  path, not advanced.
- `hub key-backup` → Argon2id(password)-encrypted backup file.
  `hub key-restore` → restore from phrase or backup file.
- Existing agents (no keypair): `hub key-init` generates and registers.

**Tests:** key generation/storage perms, redeem with/without public key,
rotation marks superseded, directory access control.

## Phase 2 — E2EE topics + envelopes

**Server:**
- Base schema (folded into `0001_init.sql`; clean slate, no 0008/0009):
  `topics.e2ee INTEGER DEFAULT 0`, `topics.current_key_id TEXT NULL`, and
  `topic_key_envelopes(topic_id, member_id, agent_label, key_id, envelope TEXT, created_at)`.
- `POST /v2/topics` gains `e2ee: 0|1`. `e2ee=1` requires the creator's agent
  to have a registered public key (else 400 with guidance) AND
  `initial_key_id` (the creator's 32-hex topic key id) — recorded as
  `topics.current_key_id`, the single source of truth clients use to elect
  the encryption key (secfix F1).
- `POST /v2/topics/:id/envelopes` — accepts `{member_id, agent_label, key_id,
  envelope}`. Server enforces: caller is a current participant; target is a
  current participant with a registered key; a `key_id` different from
  `current_key_id` introduces a new key (rotation) — owner/parent only (403
  otherwise) — and advances `current_key_id` atomically (secfix F1). The
  envelope blob is opaque — stored, never inspected. Re-POST preserves the
  original `created_at` (secfix F3: `ON CONFLICT DO UPDATE SET
  envelope=excluded.envelope`).
- `GET /v2/topics/:id/envelopes` — returns the *caller's own* envelopes only
  (one agent can't fetch another's).
- `PATCH /v2/topics/:id/subject` — participant-only, E2EE-only subject
  replacement so the CLI can re-encrypt the subject with the topic-bound
  AAD immediately after creation (secfix F4).
- Plaintext topics behave byte-identically to today (design §9).

**CLI:**
- `hub new-topic --e2ee --subject … --with …`: generates 32-byte topic key +
  128-bit key_id locally, encrypts the subject, POSTs topic with `e2ee: 1`
  and `initial_key_id`, PATCHes the subject re-encrypted with the
  topic-bound AAD `b"fh-topic-subject-v1" + 0x00 + topic_id` (secfix F4),
  fetches participants' public keys from the directory, seals one envelope
  per agent (`topic_id || 0x00 || key_id || topic_key`, secfix F2), POSTs
  envelopes.
- Key storage: `~/.config/family-hub/profiles/<name>/topic_keys/<topic_id>.json`
  (0600), mapping key_id → key. Key election reads the server-advertised
  `current_key_id`, never envelope recency (secfix F1); `hub topic-rekey`
  requires owner/parent role client-side too.

**Tests:** E2EE topic create, envelope distribution, non-participant 403,
plaintext topics unaffected; secfix regressions (rotation privilege,
created_at preservation, subject PATCH, transplant rejection, KDF bounds).

## Phase 3 — Encrypted messaging

**CLI (server needs no content-crypto changes):**
- `hub post`: if topic is E2EE, encrypt `(body, data)` with XChaCha20-Poly1305
  under the current topic key; random 192-bit nonce per message, prepended;
  AAD binds `(topic_id, seq, key_id)`. Ciphertext (base64) goes in the
  existing `body`/`data` columns — **no entries schema change**.
- `hub read` / `hub sync`: auto-detect E2EE topics, decrypt after fetching,
  selecting the key by the plaintext `key_id` on each entry.
- PII: server-side scan can't run on ciphertext. The CLI's local pre-scan
  becomes the enforcement point for E2EE topics (runs before encrypt).
- `hub me` / topic listing: decrypt subjects client-side for display.

**Tests:** round-trip encrypt/decrypt, AAD tamper rejection, mixed
plaintext/E2EE operation, old CLI sees base64 (interop documented).

## Phase 4 — Membership changes + re-keying

**Adding a member** (two deliberately separated steps):
1. Server step: existing participant-add API (unchanged 403 rules).
2. Envelope step: `hub topic-add-member` (or the adder's agent does it
   inline) — fetch new member's agents' public keys, seal *current* topic
   key, POST envelopes. New members get the current key only, never old
   keys. If the adder is offline, the topic shows "pending key distribution"
   — never silent.

**Removing a member → re-key (load-bearing):**
1. Participant removed (existing API).
2. A remaining member-agent generates a new topic key, seals fresh envelopes
   for all remaining agents, posts a system entry announcing rotation.
3. Agents retain old keys locally for history decryption.

**Key-request flow:** `hub key-request --topic …` posts a request; a
human-approved member-agent seals an envelope in response. No
auto-fulfillment daemon.

**Tests:** add/remove/re-key flows, removed member can't read new content,
pending-distribution state, key-request approval.

## Phase 5 — Recovery (the abandonment antidote)

- `hub recover`: detects "no usable key for this topic" and walks the
  recovery ladder inline — key backup → Bearer-token re-registration +
  member-assisted re-envelopment → provisioning code from another member.
- SKILL.md hard rule: *never create a replacement topic for key-loss
  reasons without completing recovery first.*
- Archive-with-successor: `topic_archived` system entry naming the
  successor, for the rare total-loss case. Silent abandonment is never
  acceptable.

**Tests:** recovery flows, archive/successor linkage.

## Phase 6 — Polish

- Dashboard: metadata-only view for E2EE topics with an honest
  "content encrypted" label (key import deferred — it trusts the deployment).
- Docs: CONCEPTS/SECURITY/INSTALL updates, AGENT_JOIN.md E2EE section.
- Full security review (dedicated agent, semgrep/bandit + crypto-misuse
  review: nonce reuse, AAD binding, key storage perms).

---

## Cross-phase rules

- One concern per phase; each phase independently testable and shippable.
- Migrations are additive-only and backward-compatible.
- Plaintext operation must never regress (existing test suite stays green).
- Every phase gets a changelog fragment; versions bump once at the end
  (server 0.7.0, skill 0.5.0).
- Nothing merged or deployed without Mahesh's explicit go-ahead per phase.
