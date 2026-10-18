# Set up your Family Hub with Muse

This guide is for the Muse or person doing server setup. The human can start from
[the README](../README.md); they do not need to install Muse again or learn the CLI.

## Before you start

Use a computer or hosted Muse environment with Node.js 22.23.3+, Python 3.12+, Git and npm.
You need a Cloudflare account and authorization to create a Worker and D1 database.
Use the platform's secure credential settings for `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`; the provisioner requires both. Browser login is not a
substitute for these inputs. Never ask the human to paste Cloudflare keys into
conversation text.

This is the protocol-2 development release. Read the
[release checklist](E2EE_FRESH_DEPLOY.md) first. The CLI and skill must both have
published signed 2.2.0+ releases, pinned by their real hashes. A build with the
pin below 2.2.0 fails deliberately; a checkout still pinning 2.0.0 is not ready
for deployment. Use a **new database** and a distinct Worker name
for testing. Preserve existing deployments, databases and backups.

## Deploy and connect the owner

Follow [the automatic deployment guide](DEPLOY.md) or
[the Muse checklist](MUSE_SETUP.md). `npm ci` installs the pinned Wrangler;
`npm run deploy:hub -- --name YOUR-HUB-NAME` creates and binds the database,
installs generated secrets, applies migrations, and deploys in your account.
Use `--bootstrap-file` to create the first circle behind a private bootstrap
guard and save its provisioning receipt directly to a private file.

No database or account ID belongs in the tracked Wrangler template. Use the
returned hub URL and generated deployment directory, never another user's
configuration. Preserve the directory for updates and private secret recovery.

Install and verify the hub's signed bundle following
[client installation](../agent-skill/INSTALL.md). Connect the owner's Muse with
the hosted guide's exact interpreter/CLI paths and server-specific profile:
`PYTHON CLI --profile PROFILE enroll --server DISCOVERED-HUB-URL --email OWNER-EMAIL`, feeding the code from the
private receipt to its secure prompt. The deployment guide includes a helper
example that never prints the code or places it in argv. Verify `hub me` and
`hub circles`. Back up the identity/recovery files privately off-machine.

## Create circles and invite people

As a server owner:

```sh
hub circle create --name "Hotel team" --kind general
hub circles
hub circle use "Hotel team"
hub invite-member --name "Person" --email person@example.com --role parent
```

The existing roles are `owner`, `parent` and `kid`. In a team circle, `parent` is an
adult coordinator role; `kid` has restricted capabilities. Circle ownership does
not grant server ownership. Only server owners can create additional circles.

Privately send the one-time onboarding URL to the invitee. It asks them to enter
the invited email for an address match and guides their own Muse through
installation and enrollment. No verification email is sent.
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
