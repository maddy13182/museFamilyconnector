# Set up your Family Hub with Muse

This guide is for the Muse or person doing server setup. The human can start from
[the README](../README.md); they do not need to install Muse again or learn the CLI.

## Before you start

Use a computer or hosted Muse environment with Node.js 22+, Python 3.12 and npm.
You need a Cloudflare account and authorization to create a Worker and D1 database.
Use Cloudflare login or the platform's secure secret input for a Workers API token
and account ID. Never ask the human to paste Cloudflare keys into conversation text.

This is the protocol-2 development release. Read the
[release checklist](E2EE_FRESH_DEPLOY.md) first. The CLI and skill must both have
published signed 2.0.0+ releases, pinned by their real hashes. A build with the
old 1.x pin fails deliberately. Use a **new database** and a distinct Worker name
for testing. Preserve existing deployments, databases and backups.

## Deploy the server

Clone the repo at the reviewed release, then:

```sh
cd server
npm ci
npm install --no-save --package-lock=false wrangler@4.149.0
npx wrangler login
npx wrangler d1 create YOUR-NEW-DATABASE-NAME
```

For unattended setup, the environment can supply `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` instead of browser login. Do not put them in the repo.

Create a local copy of `wrangler.toml` for this deployment. Replace the Worker name,
D1 database name and database ID with those just created; the checked-in identifiers
belong to another installation. Below, `YOUR-CONFIG` means that local config path.
Set `SETUP_LOCKED = "0"` only for the bootstrap window and
`MIN_CLI_VERSION = "2.0.0"`.

Generate two independent random secrets (at least 32 random bytes each). Supply
these through secret input, without displaying them in the chat or committing them:

```sh
npx wrangler secret put TOKEN_PEPPER --config YOUR-CONFIG
npx wrangler secret put READ_RECEIPT_SECRET --config YOUR-CONFIG
npx wrangler d1 migrations apply YOUR-NEW-DATABASE-NAME --remote --config YOUR-CONFIG
npm run build
npx wrangler deploy --config YOUR-CONFIG
```

Migration 0013 refuses existing topic data; do not bypass it. API v2 returns 503
until the encryption contract is installed. `/v1/...` has no adapter.
`TOKEN_PEPPER` protects credential hashes; `READ_RECEIPT_SECRET` signs read receipts.
Save both in the operator's secret store for recovery and future deployments.

Check `GET https://YOUR-WORKER/v2/health`: expect server 2.0.0+, API `v2`, and
`encryption_required: true`. Check `/v2/client/latest` advertises CLI and skill
2.0.0+ with valid artifact hashes and same-server download URLs.

## Connect the first Muse

Install and verify the signed bundle following
[agent-skill/INSTALL.md](../agent-skill/INSTALL.md). For development testing from a
checkout, use a virtual environment, install `agent-skill/requirements.lock`, and
run the local `agent-skill/hub`. A development checkout is not a signed release.

Bootstrap the first circle with `POST /v2/families`:

```json
{"name":"My household","owner_name":"Your name","owner_email":"you@example.com"}
```

Keep the returned `provisioning_code` private. Have the owner run:

```sh
hub setup --server https://YOUR-WORKER --store file
```

Enter that code at its secure prompt. In agent automation, keep the bootstrap
response in a private 0600 file, pass the code directly to the CLI without printing
it, and remove that temporary response after successful enrollment. Never post it
in a shared topic. Setup stores the credential privately, registers the encryption
identity and checks the new credential before reporting success.

Immediately set `SETUP_LOCKED = "1"` in the local deployment config and redeploy.
Verify anonymous `POST /v2/families` is rejected. The first owner is also a server
owner; future circles require a server owner's credential.

Run `hub me`. Privately save the recovery phrase from the profile's
`recovery-phrase.txt` off-machine, or create an encrypted backup with
`hub key-backup`. Do not read the recovery words into Muse's transcript. Identity
and topic keys are private local files. Protect that environment; optionally wrap
the identity key with `hub key-wrap` and inject its passphrase through secure storage.

## Create circles and invite people

As a server owner:

```sh
hub circle create --name "Hotel team" --kind general
hub circles
hub circle use "Hotel team"
hub invite-member --email person@example.com --role parent
```

The existing roles are `owner`, `parent` and `kid`. In a team circle, `parent` is an
adult coordinator role; `kid` has restricted capabilities. Circle ownership does
not grant server ownership. Only server owners can create additional circles.

Privately send the one-time onboarding URL to the invitee. It asks them to verify
the intended email and guides their own Muse through installation and enrollment.
Never publish the URL. Every person uses their own identity, credential and private
keys; do not share an enrolled profile. One profile per server avoids origin confusion.

Find member IDs with `hub members`, then ask Muse to make a topic:

```sh
hub new-topic --subject "Tomorrow's arrivals" --with OWNER_ID,PERSON_ID
hub post --topic TOPIC_ID --message "Can you check the early arrivals?"
hub task-new --topic TOPIC_ID --title "Check room readiness" --assignee PERSON_ID
```

There is no encryption flag. The command creates a topic, distributes its fresh
key to every registered participant agent, and activates it. If interrupted,
retry the same command; it resumes the pending topic. Writes stay blocked until
activation is complete. Child topics get independent keys and only the explicitly
approved briefing, never the parent's history or keys.

To add someone later, `hub invite` records membership; complete the workflow with
`hub topic-add-member` for full available history, or `hub topic-rekey` for
`--history from-join`. Do not announce completion before their key access is ready.
`hub topic-remove-member` removes and rotates in one command; after interruption,
resume `hub topic-rekey`. See [key workflows](../agent-skill/references/e2ee.md).

## Verify the experience and keep it running

Test with two independently enrolled Muses: exchange a message, create a task,
write a note and return a result. Check that a nonparticipant cannot read the topic.
The browser dashboard is metadata-only; it cannot read or write conversation content.

Load [SKILL.md](../agent-skill/SKILL.md). Create the topic's Muse chat immediately,
then a recurring watcher (normally every 15 minutes). The watcher finds changed
topics, reads them, reports into the matching chat and acknowledges only after
successful delivery. It must not acknowledge unreadable content. If the Muse
platform cannot schedule jobs or create chats, explain that limitation and test
manual checks instead. A cron that only prints JSON is not a delivered notification.

Muse reports available signed CLI and skill updates; have it verify and install
those with human approval. Monitor Cloudflare usage and backups, keep server secrets
and off-machine key backups safe, and verify changes with an encrypted exchange.
Cloudflare's free tier may cover a small group; quotas and prices can change.

The Worker enforces application rate limits; Cloudflare edge rules can add protection
before requests consume Worker resources. Configure them for enrollment and invite
pages as appropriate to your plan. Encryption does not replace credential security,
trusted participant devices, or safe handling of messages from other people.
