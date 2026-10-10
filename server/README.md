# Family Hub — API server (WS-1)

Cloudflare Worker (TypeScript, **zero runtime dependencies**) + SQLite (D1 in
production, stock SQLite anywhere else). Implements SPEC.md §§4–15, 17.

## Layout

```
server/
  wrangler.toml          # worker config — NO secrets here (see below)
  src/
    index.ts             # router + all /v1 handlers; exports handleRequest() for tests
    auth.ts              # THE choke point: resolveToken(); credential generation
    pii.ts               # card-Luhn + SSN scan (SPEC §11)
    validate.ts          # strict input validation for every endpoint
    db.ts                # D1 -> DbClient adapter (plain ? binds, atomic batches)
    types.ts             # DbClient interface, Env, HttpError, AuthContext
    ui.ts                # minimal human web UI served at /
  migrations/
    0001_init.sql        # full schema — plain SQLite, runs on D1 and stock SQLite
  test/
    sqlite.ts app.ts     # test harness: handleRequest() over node:sqlite
    pii|validate|auth|tasks|idempotency|integration.test.ts
  package.json           # one dev dependency: typescript
```

## Run tests (fully offline — no Cloudflare account needed)

```sh
cd server
npm install   # once; installs typescript only
npm test      # tsc build + node --test over in-memory SQLite
```

## Deploy

```sh
# 1. Create the D1 database and apply the schema
wrangler d1 create family-hub
#    -> copy the database_id into wrangler.toml
wrangler d1 execute family-hub --file=migrations/0001_init.sql

# 2. Set the pepper (256-bit random). NEVER commit this value.
openssl rand -hex 32
wrangler secret put TOKEN_PEPPER

# 3. Bootstrap (SETUP_LOCKED=0 in wrangler.toml), deploy, create the family ONCE:
wrangler deploy
curl -s https://<your-worker>.workers.dev/v1/families \
  -d '{"name":"Ramamurthy family","owner_name":"Mahesh Ramamurthy","owner_email":"harshika.mahesh@gmail.com"}'
#    -> save the provisioning_code; the owner's agent redeems it at
#       POST /v1/provisioning-codes/:code/redeem to get its bearer token.

# 4. LOCK setup, then redeploy:
#    wrangler.toml: SETUP_LOCKED = "1"
wrangler deploy

# 5. Rate limiting (SPEC §7): Cloudflare dashboard ->
#    Security -> WAF -> Rate limiting rules:
#      - 60 req/min per token (all /v1/*)
#      - 10 req/min per IP on /v1/invites/*/accept
#      - 5 req/min per IP on /v1/families
#    (In-worker durable per-IP limiting is intentionally NOT implemented:
#     workers have no durable per-IP store without KV, and SPEC assigns this
#     to the Cloudflare ruleset in front.)
```

## Portability

The worker uses no Cloudflare-only APIs in application code — only the D1
binding, behind the `DbClient` interface. The same handlers run against stock
SQLite (see `test/sqlite.ts`). Moving hosts = copying one SQLite file.

## Security notes

- `TOKEN_PEPPER` is a worker secret. Tokens/invite/provisioning codes are
  stored as `sha256(pepper || value)` — a DB read alone yields nothing usable.
- Every handler goes through `resolveToken()`; all queries are scoped by
  `(family_id, member_id)`. There is no code path that reads cross-family or
  cross-visibility data.
- Error responses are always `{error: {code, message}}`; 500s never leak
  stacks or SQL.
- Server logs must contain metadata only (ts, endpoint, token_id, status) —
  never bodies, tokens, or codes.

## SPEC gaps filled

See `SPEC_GAPS.md` for decisions made where SPEC was silent.
