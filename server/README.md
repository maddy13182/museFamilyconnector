# Family Hub API server

A Cloudflare Worker with D1, required topic encryption, and API v2. Runtime SQL
uses the generic `env.DB` binding; the application contains no deployment's
database ID, account ID, or Worker URL.

## Test

```sh
cd server
npm ci
npm test
```

## Deploy in your account

Supply `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` through secure environment
settings, then:

```sh
npm run deploy:hub -- --name YOUR-HUB-NAME
```

This installs no global tools: Wrangler is pinned in package-lock.json and
installed by `npm ci`. The provisioner creates D1, generates a local config,
installs secrets, migrates and deploys, then verifies the discovered URL.
`wrangler.toml` is a generic template. Never add personal IDs to it.

See [automatic deployment](../docs/DEPLOY.md) for permissions, first-circle
bootstrap, private deployment state, and upgrades. A deliberate update from a
clean checkout uses `--existing`, which discovers the named Worker's real binding
and never creates a replacement. No resource is automatically deleted.

The server logs metadata and correlation IDs, not credentials or conversation
content. The browser dashboard shows metadata only. See the root README and
installed skill for circles, encrypted topics, and the complete update watcher.
