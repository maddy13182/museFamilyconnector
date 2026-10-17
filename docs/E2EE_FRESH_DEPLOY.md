# Protocol 2: release and fresh-database checklist

This is a coordinated server, CLI and skill 2.0.0 release. No v1 API,
plaintext topics, old subject format, partial key activation or legacy-data
adapter is supported. Existing plaintext must never be described as encrypted.

## Release order

1. Review and merge the implementation only after CI passes.
2. Let the release workflow publish the signed CLI 2.0.0 and skill 2.0.0 artifacts.
3. Review and merge its manifest PR with real artifact hashes. Never invent hashes
   or disable bundle verification. `server/client-manifest.json` remains at its
   last published release until that PR; a production build deliberately refuses
   a CLI or skill pin below 2.0.0. Test fixtures exercise the real bundler locally.
4. Follow [automatic deployment](DEPLOY.md) to provision a new named hub in
   the intended Cloudflare account. The provisioner captures the database ID,
   installs generated secrets before the API, and writes an ignored local config.
   Never put a deployment's identifiers into the shared template.
5. The command applies every migration and verifies protocol 2 and its manifest.
   Migration 0013 refuses a database containing old topics; do not bypass it.
   Use `--bootstrap-file` to create the first circle behind its private bootstrap
   guard and re-lock setup. Preserve the private enrollment receipt and secrets.
6. Enroll participants with the v2 CLI/skill. Existing credentials, local identity
   files and historical data are not a supported migration path. Use a separate
   profile for a new server; preserve old profiles and backups independently.

## Existing development data

Keep the old database and its backups unless its owner separately approves deletion.
This runbook does not delete databases, migrate readable content, or authorize a
production cutover. A new empty database prevents accidental claims that old
plaintext has become confidential. Decide retention and eventual removal explicitly.

## Verify before inviting others

- `/v2/health` reports API `v2`, server 2.0.0+ and `encryption_required: true`.
- `/v1/...` returns 404; a database without the new contract returns 503.
- The server's published CLI and skill are both 2.0.0+ with verified hashes.
- Two independently enrolled profiles exchange a message and a task result.
- Subjects, message bodies/data, task text/results and child briefings appear only
  as ciphertext in storage. Metadata remains visible by design.
- A child participant cannot read the parent topic or receive its keys.
- A from-join participant cannot fetch older keys, including on an empty topic.
- Removal pauses new writes until rotation; the removed profile cannot read new content.
- Keys and recovery files have private permissions and a private off-machine backup.
- Muse's watcher reports into the correct topic chat and acknowledges only after
  successful delivery. Keep its scheduling and chat-tool limitations visible.
