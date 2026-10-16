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
4. Prepare a fresh Worker configuration and a **new, empty D1 database**. Use a new
   Worker name if an older installation must remain available during testing.
   Do not overwrite the checked-in database ID or deploy into somebody else's hub.

   **CRITICAL — secrets before anything else.** Set these Cloudflare Worker
   secrets *before* deploying the worker bundle or creating any credentials:
   - `TOKEN_PEPPER` — random 256-bit hex; used to hash all tokens, provisioning
     codes, and invite codes. If lost, all credentials become unverifiable and
     the database must be wiped. Back it up in a password manager.
   - `READ_RECEIPT_SECRET` — random 256-bit hex; signs read receipts.

   A worker upload does NOT carry secrets with it. If you deploy before setting
   them, `env.TOKEN_PEPPER` will be empty and every authenticated endpoint will
   500. Worse: any credentials created during that window are hashed against an
   empty pepper and become permanently invalid once the real secret is set —
   you must wipe the database and start over. **Order is: secrets → deploy →
   migrate → bootstrap. Never bootstrap before secrets exist.**

5. Follow [INSTALL.md](INSTALL.md), applying every migration to that new database.
   Migration 0013 refuses a database containing topics. API v2 also verifies the
   installed encryption contract before serving data. Do not drop the guard.
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
