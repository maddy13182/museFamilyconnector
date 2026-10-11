# Family Hub — Deploy guide

Two ways to deploy. **A** is the primary path (your agent deploys from your
machine, following the README). **B** is optional.

## A. Deploy from your machine (recommended)

You need:

1. A free Cloudflare account (dash.cloudflare.com).
2. Deploy credentials — either:
   - `wrangler login` (browser OAuth — nothing to copy), **or**
   - An API token + account ID, for agent-driven deploys with no browser:
     - Dashboard → profile → **My Profile** → **API Tokens** → **Create Token**
       → **Edit Cloudflare Workers** template → copy the token.
     - Dashboard overview → right sidebar → copy the **Account ID**.
     - Export them in your shell:
       ```bash
       export CLOUDFLARE_API_TOKEN="<paste>"
       export CLOUDFLARE_ACCOUNT_ID="<paste>"
       ```
3. Then follow the README steps 3–8: D1 create → pepper secret → `wrangler
   deploy` → bootstrap family → lock setup → test the dashboard.

No GitHub secrets involved. Nothing leaves your machine except the deploy
itself.

## B. Deploy from GitHub Actions (optional)

Push-to-`main` auto-deploys: build → test → D1 migrations → deploy.
PRs only run build + test.

Setup (one time):

1. Same Cloudflare account as above.
2. Repo → **Settings** → **Secrets and variables** → **Actions** → add:
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
3. That's it. The workflow skips gracefully when the secrets aren't set, so
   forks without them just don't deploy (no failing runs).

Secrets never appear in logs; the workflow passes them to wrangler as
environment variables only.

## TOKEN_PEPPER (one time, both paths, never in git)

- Workers & Pages → `family-hub` → **Settings** → **Variables and Secrets** →
  **Add** → type **Secret** → name `TOKEN_PEPPER`.
- Value: 64 random hex chars (`openssl rand -hex 32`).
- Mixed into every token/invite hash. If it ever leaks, generate a new one —
  all agent tokens invalidate and everyone re-enrolls (by design).

## Bootstrap (first deploy only, both paths)

1. Set `SETUP_LOCKED = "0"` in `server/wrangler.toml` and deploy. (The repo
   default is `"1"` — the safe state for a running instance — so a fresh
   clone must unlock it explicitly for the first deploy.)
2. `POST https://<your-worker>/v1/families`
   `{name, owner_name, owner_email}` → save the provisioning code; enroll your
   agent with it.
3. Set `SETUP_LOCKED = "1"`, redeploy. Unauthenticated `POST /v1/families`
   calls are now rejected. As an owner you can still create additional
   circles any time (`hub circle create`) — a second circle is not a second
   deployment. (Truly separate families that shouldn't share an operator
   still get their own worker + D1 pair.)

## Post-deploy: verify the client manifest

After deploying the worker, confirm `GET /v1/client/latest` serves the
manifest that is in the repo at that deploy (the server only advertises
what `server/client-manifest.json` says):

```sh
curl -s https://<your-worker>/v1/client/latest | python3 -m json.tool
```

Check that `version`, `sha256`, and `download_url` match the latest
signed `cli-v*` GitHub Release:

```sh
gh release view "cli-v$(curl -s https://<your-worker>/v1/client/latest \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])')" \
  --json tagName,assets --jq '{tag: .tagName, assets: [.assets[].name]}'
```

The response's `sha256` must equal the release's `manifest.json`
`sha256`. The release workflow updates `server/client-manifest.json`
automatically when it cuts a release (committed back to `main` with
`[skip ci]`, which intentionally skips re-deploying) — so after a CLI
release lands, **redeploy the worker** (or fold it into the next deploy)
for agents' `hub upgrade` to see the new version. `min_cli_version` in
the manifest is never raised automatically; raise it deliberately per the
rollout order in `docs/CLIENT_HARDENING_SPEC.md` §7, only after the fleet
reports at-or-above the new version.

## Rotating the Cloudflare token

Dashboard → API Tokens → roll/delete it, create a new one from the same
template, update wherever you kept it (shell env or the GitHub secret).
No code changes needed.
