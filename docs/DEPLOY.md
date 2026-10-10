# Family Hub — Deploy & CD setup

Every push to `main` deploys automatically: build → test → D1 migrations →
`wrangler deploy`. PRs run build + test only (no deploy, no secrets).

## One-time setup (about 10 minutes, all yours)

### 1. Cloudflare account
Create a free account at dash.cloudflare.com if you don't have one.

### 2. API token (least privilege)
- Top-right profile → **My Profile** → **API Tokens** → **Create Token**
- Use the **Edit Cloudflare Workers** template (Workers Scripts:Edit,
  Workers Routes:Edit, D1:Edit, Account Settings:Read — nothing more)
- Copy the token. You'll paste it into GitHub in the next step, then you can
  forget it — it lives only as a GitHub secret afterwards.

### 3. Account ID
Dashboard overview page → right sidebar → **Account ID** → copy it.

### 4. GitHub secrets
Repo → **Settings** → **Secrets and variables** → **Actions** →
**New repository secret** (add both):
- `CLOUDFLARE_API_TOKEN` → the token from step 2
- `CLOUDFLARE_ACCOUNT_ID` → the ID from step 3

Neither secret ever appears in logs; the workflows only pass them as
environment variables to wrangler.

### 5. D1 database (one time)
- Cloudflare dashboard → **Workers & Pages** → **D1 SQL Database** →
  **Create** → name it `family-hub` → copy the **database ID**.
- Put that ID into `server/wrangler.toml` (`database_id = "..."`), commit,
  push. The CD run will apply `server/migrations/` automatically from then on.

### 6. TOKEN_PEPPER (one time, never in git)
- Workers & Pages → `family-hub` → **Settings** → **Variables and Secrets** →
  **Add** → type **Secret** → name `TOKEN_PEPPER`.
- Value: 64 random hex chars. Generate with `openssl rand -hex 32` on any
  machine (or ask your agent to generate one for you to paste).
- This pepper is mixed into every token/invite hash. If it ever leaks,
  generate a new one — note this invalidates all existing tokens, so every
  agent re-enrolls (by design: one bad day, clean recovery).

## Bootstrap (first deploy only)

1. Push to `main` with `SETUP_LOCKED = "0"` (the default in wrangler.toml).
   CD deploys the worker.
2. Call `POST https://<your-worker>.workers.dev/v1/families`
   `{name, owner_name, owner_email}` → save the returned provisioning code.
   This creates the family and your owner member.
3. Set `SETUP_LOCKED = "1"` in `server/wrangler.toml`, commit, push.
   CD redeploys and the bootstrap endpoint is locked forever. A second
   family = a second deployment, never a second call.

## What CD does on every push to main

1. `npm ci` (lockfile only — reproducible)
2. `npm test` (build + 39 server tests; deploy stops here on failure)
3. `wrangler d1 migrations apply family-hub --remote` (idempotent)
4. `wrangler deploy` (pinned `wrangler@4.149.0`, pinned Node 22)

Manual re-deploy anytime: repo → **Actions** → **Deploy** → **Run workflow**.

## Rotating the Cloudflare token

If the API token ever leaks: Cloudflare dashboard → API Tokens → roll/delete
it, create a new one from the same template, update the
`CLOUDFLARE_API_TOKEN` GitHub secret. No code changes needed.
