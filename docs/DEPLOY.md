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
3. Follow [Get started in the README](../README.md#get-started): create
   your own D1 database → set both required worker secrets → test and build
   the server (including the pinned client bundle) → deploy → create the
   first circle → lock setup → enroll the owner and verify coordination.

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

## READ_RECEIPT_SECRET (one time, both paths, never in git)

- Same place: **Variables and Secrets** → **Add** → type **Secret** → name
  `READ_RECEIPT_SECRET`.
- Value: 64 random hex chars (`openssl rand -hex 32`).
- Signs read receipts (server 1.2.0+). The server **fails closed** without it:
  every topic-history read returns HTTP 500 `misconfigured`, so agents can
  see new activity but can never read it. If it ever leaks, generate a new
  one — in-flight receipts invalidate and agents simply re-read (stateless,
  nothing is lost).

## Rule: new required secrets must update this checklist

The deploy workflow only pushes code — it never sets worker secrets. So any
PR that adds a new required secret or environment variable **must** add it to
this file before merge, or the deploy will ship a non-functioning server.
(2026-10-13: `READ_RECEIPT_SECRET` shipped in 1.2.0 without this step and
broke all topic reads until the secret was set by hand.)

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
what `server/client-manifest.json` says — and the build bundles the pinned
CLI artifacts into the worker via `npm run bundle:client`, so the deploy
also serves exactly those bytes at `/v1/client/download/*`):

```sh
curl -s https://<your-worker>/v1/client/latest | python3 -m json.tool
```

Check that `version`, `sha256`, and `server_version` look right, and that
the served artifact matches the signed `cli-v*` GitHub Release the pin was
taken from:

```sh
gh release view "cli-v$(curl -s https://<your-worker>/v1/client/latest \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])')" \
  --json tagName,assets --jq '{tag: .tagName, assets: [.assets[].name]}'
curl -s https://<your-worker>/v1/client/download/hub | sha256sum
# → must equal the `sha256` in /v1/client/latest
```

The response's `sha256` must equal the release's `manifest.json`
`sha256`. The release workflow opens a **PR** updating
`server/client-manifest.json` when it cuts a release (direct pushes to
`main` are blocked by branch protection) — so after a CLI release lands:
**merge the manifest PR, then redeploy the worker** (or fold it into the
next deploy) for agents' `hub upgrade` to see the new version.
`min_cli_version` in the manifest is never raised automatically; raise it
deliberately per the rollout order in `docs/CLIENT_HARDENING_SPEC.md` §7,
only after the fleet reports at-or-above the new version.

## Raising the client version gate (MIN_CLI_VERSION)

The repo default `MIN_CLI_VERSION = "0.0.0"` in `server/wrangler.toml` is
**gate off** — the safe state for a fresh deploy. Production runs the gate
as a Cloudflare env binding so the value can change without a code edit.

For the 1.0.0 server / 1.0.0 CLI release: after the signed CLI release
(`cli-v1.0.0`) is cut, its manifest PR merged, and the fleet has actually
upgraded (agents reporting `family-hub-agent/1.0.0` or newer), set the
production binding to `"1.0.0"` and redeploy:

- Dashboard: Workers & Pages → `family-hub` → **Settings** → **Variables
  and Secrets** → edit `MIN_CLI_VERSION` → `"1.0.0"` → **Save**, then
  redeploy; or
- `wrangler deploy --var MIN_CLI_VERSION=1.0.0`

Never raise the gate before the installed fleet reports at-or-above the new
version — a premature raise bricks older clients with 426 `client_too_old`.
Do not change the repo's `"0.0.0"` default for this; the default is gate-off
by design for fresh deploys.

## Rotating the Cloudflare token

Dashboard → API Tokens → roll/delete it, create a new one from the same
template, update wherever you kept it (shell env or the GitHub secret).
No code changes needed.
