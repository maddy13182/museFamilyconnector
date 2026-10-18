# Muse setup guide

For an existing Muse user, do the setup work in the environment where Muse can
run tools. Do not ask the person to learn Wrangler or edit configuration files.
An invitee joining someone else's hub does not deploy a backend.

## Create a backend

1. Confirm this is a new hub. Get its name, the first circle's name, and the
   owner's display name and email. Check Git, Node.js 22.23.3+, npm and Python
   3.11+. Server provisioning may run on a computer; the skill must be installed
   where this person's Muse executes tools.
2. Help the person create a scoped Cloudflare API token and find their Account
   ID. Bind `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` through secure
   credential input. Never ask for the token in chat. See
   [required permissions](DEPLOY.md#credentials-and-prerequisites).
3. Ask for the circle name and owner name/email. Each user already has one
   Muse agent running in their VM. Use the private owner setup code; no email
   provider or inbox verification is required.
4. Save the first-circle details in a private JSON file, then run:

   ```sh
   npm run deploy:hub -- --name YOUR-HUB-NAME --bootstrap-file /PRIVATE/PATH/owner.json
   ```

   The file has exactly `name`, `owner_name`, and `owner_email`. Follow
   [the deployment guide](DEPLOY.md): this command creates the database, installs
   generated secrets, binds D1 to the Worker, migrates, deploys, discovers the URL,
   creates the first circle, and locks setup. Use the returned URL; never copy
   somebody else's database ID, Account ID, or workers.dev address.
5. Privately back up the generated deployment directory. It is ignored by Git.
   Preserve its state and secrets during updates. Never print `secrets.json` or
   `owner-enrollment.json` into the transcript. A stopped run is not success;
   rerun the same command to reconcile state. Stop if a prior bootstrap may have
   committed without its response.

## Connect the owner's Muse

Install the bundle served by this hub, following
[client installation](../agent-skill/INSTALL.md): verify archive hash before
extraction, then signature and CLI hash before executing the CLI. Install its
Python requirements in a virtual environment. Use that exact CLI path.

Pass the saved provisioning code directly from the private receipt into
`hub enroll --server DISCOVERED-URL --code-file PRIVATE-CODE-FILE --email OWNER-EMAIL` through its secure prompt;
[the deployment guide](DEPLOY.md#create-the-first-circle-without-opening-public-registration)
includes an example. Do not expose it in chat, argv, or shell history. If the user
is already connected to this server, use `hub circle join` for another circle;
do not overwrite their profile with setup. Use a separate profile for another server.

Read the installed `SKILL.md`, and confirm identity and circle with `hub me` and
`hub circles`. Preserve the encryption identity. Recovery words stay in private
files; arrange an off-machine backup outside model-visible output. Remove the
spent enrollment receipt only after a successful authenticated check.

## Make coordination work

- Create one Muse chat for each shared topic, with a durable mapping. Create the
  chat immediately for outgoing topics; own posts do not trigger incoming updates.
- Schedule one watcher per member, normally every 15 minutes. Follow the installed
  skill's complete discovery → read → report → acknowledge flow. Only acknowledge
  after the update is posted in the matching chat. If a background worker lacks
  chat tools, hand off to the main agent for posting and acknowledgement.
- Invite people to the intended circle with the documented `hub invite-member`
  command, using the person’s name, email and intended role. The human privately sends the returned
  onboarding link. Joining a circle does not expose every topic: add the member to
  the conversations they should see and finish distributing the encrypted keys.
- Test an encrypted message, approved reply, task, and result between two separate
  members. Verify delivery in each person's topic chat. A cron that only prints
  JSON does not establish that notifications work.

Tell the human the verified hub URL, circle, connected identity, and schedule.
If the Muse platform lacks scheduling or topic-chat support, explain the specific
limitation and verify manual checks instead. Then ask whom they want to invite.

## Join an existing hub

Follow [the invitation guide](AGENT_JOIN.md) and the page's installation steps.
Use the verified bundled CLI and read its skill; download alone does not load it.
Do not create a Cloudflare account or deploy another server for an invitee.
On failure, preserve `diagnostics.jsonl` and the current profile and identity.
Compare request/operation IDs with the operator's server logs before redeeming
another code. Do not infer a lost response from a `409` alone.

## Maintenance

For backend updates, use the saved checkout and the same deployment command, or
explicit `--existing` from a clean checkout. Both discover or preserve the database
binding and keep the existing secret values. Never replace them with repository
examples. Client updates follow the signed bundle/upgrade procedure separately.
Retest health, encrypted reads, and the topic watcher after an update.
