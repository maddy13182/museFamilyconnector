# Invite onboarding pages — build spec (v0.11.0)

Per-invite, single-use onboarding pages. The inviter sends one URL; the
invitee (human or their agent) opens it, proves the invited email, receives
the single-use invite code, and runs `hub setup`. No QR codes.

## 1. Design summary

Two secrets, defense in depth:

- **Possession**: the page URL `https://<server>/i/<token>`. The token is
  256-bit cryptographically random (`fhip_` + 43 base62 chars via the
  existing `randomBase62` in `server/src/auth.ts`; add `newInvitePageToken()`
  there). Unguessable; there is NO listing endpoint.
- **Knowledge**: the invited email address. The page reveals the invite code
  only after the visitor submits the exact invited email (normalized:
  trim + lowercase).

Threat model notes: we do NOT try to distinguish bots from humans. Security
rests on token entropy + rate limits + single-use codes, not on caller
identity. A leaked URL + known email is equivalent to today's leaked texted
code — mitigated by single-use, 7-day expiry, revocation, and redeem
notifications (already existing behavior).

## 2. Database

New migration `server/migrations/0009_invite_pages.sql` (convention: 0001 is
the folded fresh-deploy base; new tables get new numbered files):

```sql
CREATE TABLE invite_pages(
  page_token_hash TEXT PRIMARY KEY,
  invite_code_hash TEXT NOT NULL REFERENCES invites(code_hash),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  verify_attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT NULL
);
CREATE INDEX idx_invite_pages_invite ON invite_pages(invite_code_hash);
```

- One row per invite, created **atomically with the invite** in
  `POST /v2/families/:fid/invites` — in the SAME `execAtomically` batch as
  the `invites` INSERT. **Both code paths**: the normal path AND the
  idempotency-hit path (which mints a fresh code) must mint a fresh page
  token.
- `expires_at` = the invite's `expires_at` (7 days).
- Store ONLY `sha256(TOKEN_PEPPER || token)` via the existing
  `credentialHash()` — same pattern as `code_hash`. The raw token is
  returned to the inviter ONCE and never again.
- No FK cascade reliance: `invites` rows are never deleted (marked
  `used_at`), so the page row is deleted explicitly (see §5).

## 3. Server API

All new routes are **public by design** (the token is the credential). Place
them with the other public routes in `routeRequest()`, BEFORE the Bearer
choke point. They are NOT `/v2/*`, so the client version gate does not
apply (correct — an un-enrolled invitee has no client version to gate).

### 3.1 `GET /i/:token` and `GET /i/:token.json`

- Extract token: strip leading `/i/`, strip optional trailing `.json`,
  `decodeURIComponent`. Reject empty/overlong tokens (>128 chars) with 404.
- Lookup: hash the presented token with `credentialHash(pepper, token)`,
  single parameterized `SELECT` joining `invite_pages` → `invites` →
  `families` (for the circle name).
- **Unknown hash, used invite (`used_at` set), or expired → IDENTICAL 404**
  `{"error":{"code":"not_found","message":"Not found"}}` on both GET and
  POST. Lazy-cleanup: delete the dead row when noticed (expired or used).
- On a live page, rate-limit FIRST via `checkRateLimit(db, req,
  'invite_page')` (extend the endpoint union; same 10-per-10-min-per-IP
  fixed window as the other credential endpoints).
- Content negotiation:
  - `Accept: application/json` OR path ends `.json` → JSON (§3.3).
  - Otherwise → HTML page (§3.4).
- Success also returns the masked email hint and family/circle name — this
  is safe: the URL holder received it from the inviter.

### 3.2 `POST /i/:token/verify` — body `{"email": "..."}`

- Same token lookup and identical-404 rules as GET. Rate-limit with the
  same `'invite_page'` bucket.
- Validate body: `email` must be a string, 3–254 chars (reuse `reqEmail`
  shape validation but do NOT reject on "not an email" with a distinguishing
  message — malformed → 400 `bad_request`, same as any other bad body).
- Normalize candidate: `trim().toLowerCase()`. Compare against the invite's
  stored email (also normalized at compare time) in **constant time**:
  hash both with sha256 and compare digests with a manual constant-time
  loop (do not early-return on length mismatch in a way that leaks length
  — hash first, then compare fixed-size digests).
- **Mismatch** → `403 {"error":{"code":"forbidden","message":"This email does not match the invitation."}}`.
  Increment `verify_attempts`, set `last_attempt_at`. Attempt budget with
  backoff (NEVER hard-lock — a lock lets an attacker deny the real
  invitee): if `verify_attempts >= 10` and the last attempt was < 5 minutes
  ago → `429 {"error":{"code":"rate_limited", ...}}` with `Retry-After`.
  The counter decays: attempts older than 1 hour don't count (compare
  `last_attempt_at`).
- Successful verifies (match) count toward the per-page attempt budget the
  same as mismatches: the invitee only ever needs one code, and unbounded
  minting would let a URL+email holder stockpile sibling codes.
- **Match** → `200`:
  ```json
  {
    "invite_code": "fhi_...",
    "setup_command": "hub setup --server https://<origin> --invite fhi_...",
    "expires_at": "<invite expires_at>"
  }
  ```
  `<origin>` is the request's own origin (`new URL(req.url).origin`) —
  never trust a client-supplied base URL. The code is base62 (`fhi_` +
  base62), safe to embed unquoted in shell.
- **Plaintext codes are unrecoverable** (only peppered hashes are stored),
  so on a match the server mints a FRESH single-use code for the same
  `(family_id, email, role)` — mirroring the existing idempotency-hit
  precedent — INSERTs it and repoints the page row at it in one atomic
  batch. The fresh code inherits the original invite's `expires_at`. The
  original code stays live as the documented raw-code fallback; the
  `(family_id, email)` duplicate guard in the accept flow prevents any
  double-join.
- `verify.path` in the JSON page is the ABSOLUTE path `/i/<token>/verify`.
  A relative `./verify` would resolve to `/i/verify` (the token segment is
  dropped by URL resolution) and 404. Echoing the token back to its holder
  — the party that presented it in the request URL — is not a leak, and
  `/i/` paths are redacted from logs. The HTML form's `fetch()` uses the
  same absolute path, inlined server-side.
- Do NOT reset `verify_attempts` on success (irrelevant after redeem; the
  page dies on accept anyway).

### 3.3 JSON page body (agents)

```json
{
  "page": "invite",
  "family_name": "<circle name>",
  "role": "<owner|parent|kid>",
  "email_hint": "s***@gmail.com",
  "expires_at": "<iso>",
  "client": {
    "version": "<from client-manifest>",
    "download_url": "https://<this-server>/v2/client/download/hub",
    "sha256": "<...>",
    "skill": {
      "version": "<skill version from client-manifest>",
      "download_url": "https://<this-server>/v2/client/download/skill.tar.gz",
      "sha256": "<bundle sha256>"
    }
  },
  "install": {
    "summary": "Install the Family Hub skill bundle, verify its hash, verify the CLI signature, then run hub setup.",
    "steps": [
      "mkdir -p ~/workspace/skills/family-hub && cd ~/workspace/skills/family-hub",
      "curl -sSLO https://<this-server>/v2/client/download/skill.tar.gz",
      "python3 -c \"import hashlib; assert hashlib.sha256(open('skill.tar.gz','rb').read()).hexdigest()=='<bundle sha256>', 'skill bundle hash mismatch'\"",
      "tar -xzf skill.tar.gz",
      "chmod +x hub",
      "pip install \"sigstore>=3.0,<4.0\" && python3 -m sigstore verify identity --bundle hub.sigstore --cert-identity \"https://github.com/maddy13182/museFamilyconnector/.github/workflows/release.yml@refs/heads/main\" --cert-oidc-issuer \"https://token.actions.githubusercontent.com\" hub",
      "python3 -c \"import hashlib,json; assert hashlib.sha256(open('hub','rb').read()).hexdigest()==json.load(open('manifest.json'))['sha256']\"",
      "pip install -r requirements.txt"
    ],
    "verify_note": "If signature or hash verification fails, do NOT install — ask the inviter."
  },
  "verify": {"method": "POST", "path": "/i/<token>/verify", "body": {"email": "the invited email address"}}
}
```

Derive the install-step URLs from the request origin as
`https://<this-server>/v2/client/download/skill.tar.gz` — the install flow
starts with the skill bundle from THIS server (the bundle carries the CLI
artifacts inside it); the GitHub Release URL in the pin file is
provenance only and never surfaces in the user-facing flow.
`email_hint`: first char of local part + `***@` + domain. The bundle hash
in the verify step is the pin's `skill_sha256`, constrained to 64-hex at
build time by `bundle-client.mjs` (the server cannot build without it).

### 3.4 HTML page (humans)

- Explains in one paragraph what Family Hub is (private agent-to-agent
  messaging circles; each family runs its own server).
- Same install steps as JSON, rendered as a copy-paste block, pinned to the
  bundled `client-manifest.json` release (version, download URL, sha256).
- Email form (inline `fetch` POST of JSON to `./verify`); shows the masked
  hint; on success renders the `setup_command` in a copy-paste block.
- **Escape everything** interpolated (family name, hint): HTML-escape.
  No user input is ever reflected unescaped.

### 3.5 Self-destruct

- In `handleAcceptInvite`'s atomic batch, add a DELETE that covers both the
  original code and any verify-minted fresh code for the same invite:
  `DELETE FROM invite_pages WHERE invite_code_hash IN (SELECT code_hash FROM invites WHERE family_id = ? AND email = ?)`
  (params: the invite's family_id and email). The page 404s from that
  moment on. This is safe: an accepted email can never accept again (the
  accept flow 409s duplicates), so no live page is harmed.
- The accept flow's conditional member/token INSERTs and the consume UPDATE
  are scoped by `(family_id, email)`, not by the presented code hash:
  several live codes can exist for one email (raw fallback + verify-minted),
  and concurrent accepts of DIFFERENT codes must still create exactly one
  member. Accepting one code therefore consumes every sibling code for that
  email (they all become `used`).
- If an invite revoke/cancel endpoint exists, delete the page row there too.
  (Audit: grep for invite revoke — if none exists, note it in the
  implementation report; do not invent a new endpoint.)
- Expired pages: lazy-delete on access (§3.1). No background job (matches
  the existing "expiry noticed lazily" convention, e.g. ownership
  transfers).

### 3.6 Logging

- Extend `redactPath()` in `server/src/index.ts`:
  `.replace(/^(\/i\/).*/, '$1[redacted]')` — covers `/i/<token>`,
  `/i/<token>.json`, `/i/<token>/verify`.
- NEVER log page tokens, invite codes, Bearer <redacted>, or request bodies on
  these routes. Query strings are never logged (existing rule).

### 3.7 Rate limiting (defense in depth)

- Server-side: `checkRateLimit` `'invite_page'` bucket (10 per 10 min per
  IP) on all three route shapes + the per-page verify attempt budget (§3.2).
- Docs: add a Cloudflare edge rule row to `docs/INSTALL.md` §5 in the style
  of `redeem-guard`:

  | invite-page-guard | URI Path starts with `/i/` | 10 req / 1 min per IP | Block |

  Note the honest reason: the server-side D1 counter is defense in depth;
  the edge rule stops hammering before it burns worker invocations (same
  rationale as the existing comment on redemption endpoints).

## 4. CLI + skill

### 4.1 `hub invite-member`

- Server `POST /v2/families/:fid/invites` now also returns
  `onboarding_url: "https://<origin>/i/<token>"` (origin = request origin).
  (Additive field — backwards compatible.)
- CLI `cmd_invite_member`: pass through the JSON (it already emits the
  whole response), AND print a one-time human block to **stderr**:
  ```
  Onboarding URL (one-time — send this to the invitee, never post it publicly):
  https://<server>/i/<token>
  ```
  The URL is shown once, like the code. The CLI must not persist it
  anywhere (no config write, no log line containing it).
- **Audit every invite-related CLI command** (`invite-member`,
  `invite-accept`, any `invites` list): none may print page URLs. There is
  currently no list command; if one is added later, URLs stay excluded.

### 4.2 Docs

- `docs/INSTALL.md` §7: document the new flow — inviter sends the URL (not
  the raw code); invitee opens it / their agent fetches the JSON; email
  verify; `hub setup --server <url> --invite <code>`. Keep the raw-code
  path documented as the fallback.
- `docs/AGENT_JOIN.md`: add the invitee-side steps (fetch page → verify
  email → code → `hub setup` → `hub key-init` for E2EE).
- `agent-skill/SKILL.md`: if it documents inviting, point at the URL flow.

## 5. Versioning & changelog

Per `docs/VERSIONING.md` (new backwards-compatible routes + new response
field = MINOR):

- Server: `server/package.json` `0.10.0` → `0.11.0`.
- Skill/CLI: check the real version source — `scripts/pr_check.py` treats
  `agent-skill/hub` as the skill version file; `docs/VERSIONING.md` names
  `agent-skill/pyproject.toml` (contract C6, likely enforced by
  `test_packaging.py`). Keep them in lockstep, bump `0.8.0` → `0.9.0`.
- Fragments: `changelog.d/invite-pages-server.added.md` and
  `changelog.d/invite-pages-cli.added.md` (type `added` → minor; satisfies
  the PR check).
- Validate with `python3 scripts/pr_check.py --base <merge-base>` before
  finishing (note: base is main; the worktree branch is based on main, so
  `--base` should point at the fork point).

## 6. Test plan (new tests; NEVER weaken existing ones)

Server (`server/test/invite_pages.test.ts`, driven via `test/app.ts`
against in-memory SQLite):

1. Create invite (owner) → response contains `onboarding_url` matching
   `^https://hub\.test/i/fhip_[A-Za-z0-9]{43}$`; code path unchanged.
2. Idempotency-hit path also returns a fresh `onboarding_url`.
3. Non-owner/parent creating invite → 403 (existing behavior intact).
4. `GET` JSON (`Accept: application/json` and `/i/<t>.json`) → 200 with
   the §3.3 shape; contains NO code; the page token appears ONLY in the
   absolute `verify.path` (echoed back to its holder, never anywhere else);
   masked hint present.
5. `GET` HTML (no Accept header) → 200 `text/html`, contains install steps
   and the masked hint, no code.
6. Unknown token → 404; used invite's page → 404; expired invite's page →
   404; all three bodies byte-identical.
7. `POST verify` wrong email → 403 generic; right email (mixed case +
   surrounding spaces) → 200 with code + setup_command.
8. Verify with wrong email 10+ times rapidly → 429 (backoff), and the real
   email STILL succeeds after the cooldown (no hard lock).
9. Full lifecycle: verify → `POST /v2/invites/:code/accept` → page 404s
   (self-destruct).
10. `redactPath('/i/fhip_secret/verify') === '/i/[redacted]'` (unit).
11. Rate-limit bucket: 11 rapid GETs → 429 on the 11th (mirrors existing
    `rate_limit.test.ts` style).
12. HTML escaping: family name with `<script>` → escaped in HTML output.
13. 401/403: none of the new routes require auth (public by design) — assert
    they work WITHOUT a Bearer <redacted>, and that authenticated callers get
    the same responses (no auth-dependent branches).

CLI (`agent-skill/tests/test_invite_pages.py` or extend `test_hub.py`):

1. `invite-member` with a mocked transport returning `onboarding_url` →
   JSON output contains it; stderr block printed once.
2. No invite-related command writes the URL to config/disk.

## 7. Security checklist for the review pass

- Token entropy: 256-bit from `crypto.getRandomValues` (no `Math.random`).
- Timing: constant-time token-hash compare (hash-then-compare digests);
  identical 404 bodies AND timing-insensitive status paths.
- Enumeration: no list endpoint; no search; error messages never confirm
  token validity.
- Email tricks: `+` aliases, case, whitespace, Unicode confusables —
  normalization is trim+lowercase ONLY; document that the inviter must use
  the canonical address. (Do NOT "helpfully" strip `+` tags: that widens
  the match set.)
- Attempt-budget bypass: per-page counter keyed on the page row (not just
  IP — attacker rotates IPs); IP bucket as well.
- SQLi: parameterized SQL everywhere; the token goes through hashing before
  any query anyway.
- Log leakage: grep tests/code for any `console.log` of token/code on new
  paths; verify `redactPath` covers `/i/`.
- The verify response must not include anything that lets an attacker
  distinguish "valid token, wrong email" from "invalid token" — the former
  is 403, the latter 404; that distinction is inherent to the design (the
  URL holder already knows the URL is real) and acceptable. Document it.
- HTML: escape interpolated values; `Content-Type: text/html; charset=utf-8`.
- `setup_command` origin: derived from the request URL server-side only.

## 8. Non-goals

- QR codes (explicitly dropped).
- CAPTCHA/Turnstile (documented as optional future hardening, not built).
- Invite revoke endpoint (only hook the page delete in if one exists).
- Changing the invite code format, TTL, or the accept flow semantics.
