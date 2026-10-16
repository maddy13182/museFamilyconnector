# Muse setup guide — Family Hub

This is the operational companion to the [README](../README.md#get-started).
It is for Muse carrying out an authorized setup, or an operator doing it
manually. The human-facing journey is: connect Cloudflare, name the first
circle, connect Muse, verify a conversation, then invite people.

## Before starting

- Confirm that the human asked to create a new hub. An invitation to an
  existing hub follows [Join an existing hub](#join-an-existing-hub) instead.
- Ask for the circle name and the owner's display name and email. The
  default circle kind is `family`; use `general` for additional team circles.
- The execution environment needs Git, Node.js 22+, npm, Python 3.12,
  `curl`, OpenSSL, and permission to install dependencies. Check these
  rather than asking the human to learn the tools. Server deployment may
  run from a computer; the skill and watcher must run where Muse can use them.
- Cloudflare is the external account needed for hosting. For a deployment
  without browser login, guide the human through creating an API token
  using **Edit Cloudflare Workers** and finding their Account ID; see
  [deployment credentials](DEPLOY.md#a-deploy-from-your-machine-recommended).
  Bind `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` through the
  environment's secure credential facilities. Do not request them in chat.
- Generate `TOKEN_PEPPER` and `READ_RECEIPT_SECRET` independently and store
  them as worker secrets with secure recovery copies. They are generated
  setup values, not additional accounts the human must create.
- Decide how credentials will persist **before** redeeming a single-use
  code. `--store env` requires a functioning secure-vault integration; it
  does not persist the returned token by itself. A trusted personal
  environment can use `--store file`. Read [storage options](../agent-skill/INSTALL.md).
- Enrollment can display an encryption recovery phrase. If this cannot be
  handled outside model-visible chat and logs, have the human complete the
  sensitive enrollment step privately. Never put recovery phrases or raw
  credentials in a chat or report.
- Use a new database in the human's account. Never deploy with the
  repository's existing database ID. Do not replace an existing hub unless
  the human explicitly requested that change.

## Deployment procedure

The browser-login commands below also work with the Cloudflare API token
and Account ID already bound in the environment; omit `wrangler login`
when using those credentials. Execute the steps in order, confirm each
result, and stop on failures. Do not claim setup is complete merely
because the worker deployed.

## 1. Download the project and sign in to Cloudflare

```bash
git clone https://github.com/maddy13182/museFamilyconnector.git family-hub
cd family-hub
npm install -g wrangler@4.149.0
wrangler login
cd server
npm ci
```

`wrangler login` opens a browser for Cloudflare sign-in. For an environment without a browser, the [deployment guide](DEPLOY.md) explains the API-token alternative. Keep credentials in secure storage rather than pasting them into chat.

## 2. Create your database and configure the server

From `family-hub/server`:

```bash
wrangler d1 create family-hub
```

Open `server/wrangler.toml` in the checkout and replace the existing `database_id` with **your newly created database's ID**. The ID in the repository belongs to an existing deployment; it is not yours.

In that same file, set `SETUP_LOCKED = "0"` for the first setup. Leave `MIN_CLI_VERSION` at its default for a fresh deployment.

Apply the database migrations and set **both required secrets**:

```bash
wrangler d1 migrations apply family-hub --remote
wrangler secret put TOKEN_PEPPER
wrangler secret put READ_RECEIPT_SECRET
```

For each secret prompt, generate a separate value with `openssl rand -hex 32` in a private terminal, save it in your password manager, and paste it at the prompt. Keep these values outside assistant-readable chat and logs. `TOKEN_PEPPER` protects stored access credentials; `READ_RECEIPT_SECRET` enables verified history reads. Without the second secret, reading conversations fails. Never commit either secret to the repository.

## 3. Verify the server, bundle its client, and deploy

Still in `server/`:

```bash
npm test
npm run build
wrangler deploy
```

The build downloads and checks the client artifacts pinned by the repository, so it needs access to GitHub release downloads. Stop and fix any failed test or build before deploying.

Cloudflare prints your hub's HTTPS URL, such as `https://family-hub.YOUR-SUBDOMAIN.workers.dev`. Save it: this is where your assistants connect.

## 4. Create the first circle, then close public setup

Replace the URL, circle name, owner name, and email below with your details:

```bash
curl --fail-with-body -sS -X POST 'https://YOUR-WORKER.workers.dev/v1/families' \
  -H 'Content-Type: application/json' \
  -d '{"name":"Our family","owner_name":"Your name","owner_email":"you@example.com"}'
```

The response includes a **one-time provisioning code** starting with `fhp_`. Save it securely for your own assistant's setup; it expires in 24 hours. This first circle makes you its owner.

Immediately set `SETUP_LOCKED = "1"` in `server/wrangler.toml` and run:

```bash
wrangler deploy
```

This closes public circle creation. Your hub owner can still create more circles after enrolling. A hotel operator can use the hotel name for the first circle, then create additional general-purpose circles below.

## 5. Install the skill and connect your own Muse

For the owner setting up from this checkout, run from the repository root in the environment where their Muse executes tools:

```bash
mkdir -p ~/workspace/skills/family-hub
cp -R agent-skill/. ~/workspace/skills/family-hub/
python3 -m venv ~/workspace/skills/family-hub/.venv
. ~/workspace/skills/family-hub/.venv/bin/activate
python -m pip install -r agent-skill/requirements.lock
chmod +x ~/workspace/skills/family-hub/hub
export PATH="$HOME/workspace/skills/family-hub:$PATH"
hub setup --server 'https://YOUR-WORKER.workers.dev' --store file
```

Enter your provisioning code at the secure prompt. This example saves the credential in a file restricted to your machine user; use a personal, trusted environment. If your Muse runs elsewhere, install the skill in **its** environment. A vault-based setup needs a working credential-storage integration before redeeming the code; see [installation options](../agent-skill/INSTALL.md).

Owner enrollment creates an encryption identity and shows its recovery phrase. Keep it in a password manager or on paper, outside assistant-readable chat and logs. If your assistant is helping, complete this step in a private terminal.

Tell your Muse to read `~/workspace/skills/family-hub/SKILL.md` and use that environment's `hub` tool. Check the connection:

```bash
hub me
hub circles
hub topics
hub sync
```

`hub me` should show your member and agent identity. An empty topic list is expected before you create a conversation. If a command fails, fix the connection before inviting people.

## 6. Configure ongoing updates

Ask your Muse:

> “Set up a check about every 15 minutes using the Family Hub skill. Read changed conversations, report anything needing my attention in the matching conversation chat, and acknowledge it only after the report is posted.”

The scheduled job needs the same skill, Python environment, and credential access as normal tool calls. It must process the full discovery → read → report → acknowledge flow; running `hub sync` alone discovers changes but does not deliver a report to you. If your platform has no scheduler, use manual checks.

## 7. Invite people

Ask your Muse to invite each person to the intended circle, or run:

```bash
hub invite-member --email 'partner@example.com' --role parent
hub invite-member --email 'child@example.com' --role kid
```

Send each person their **one-time onboarding URL** privately by text or email. Invites expire after seven days and can be used once. Members must also be added to the particular topics they should participate in; joining a circle does not reveal every conversation.

The permission names are family-oriented, including in general circles:

| Role | Use it for |
|---|---|
| `owner` | Someone who manages the circle's members, roles, and access |
| `parent` | An adult or trusted team coordinator who can start conversations and invite people |
| `kid` | A child or limited participant who participates in topics they are added to |

For a hotel, choose roles by the authority each staff member should have. Circle ownership and permission to create new circles are distinct: `hub me` reports `is_hub_owner`; new circles require that permission.

## Create a test conversation

Use `hub members` to find actual member IDs, then create a topic with the
owner (and a joined invitee when testing the two-person round trip):

```bash
hub members
hub new-topic --subject "First shared plan" --with MEMBER_ID_1,MEMBER_ID_2
hub post --topic TOPIC_ID --message "Let's confirm we can coordinate here."
```

Replace the IDs with the tool's results. For a solo owner check, use only
the owner's member ID. Immediately create and map the matching Muse chat,
and show the initial context there. The owner's own posts will not appear
as incoming changes, so do not wait for a watcher to create that chat.
After another member joins and approves a reply, verify that their
message is read, reported into the owner's topic chat, and acknowledged.

For encrypted topics, initialize every participant agent's keys and
follow the [E2EE guide](../agent-skill/references/e2ee.md) before creating
the topic with `--e2ee`.

## Optional dashboard access

The human can open the hub URL in a browser. To connect, the human runs
`hub dashboard-token` privately and pastes the circle's credential into
the dashboard. Agents must never run this command or transmit its output.
The browser stores the credential in local storage. The dashboard reads
and posts in ordinary topics the member belongs to; it has no encryption
keys and cannot display encrypted content.


## Join an existing hub

The human gives Muse a private onboarding URL and the invited email
address. Do not create another Cloudflare deployment for them.

1. Fetch the URL with `Accept: application/json`. Use the returned email
   verification endpoint to submit the human-provided invited address;
   this is an exact-address check, not an email inbox verification flow.
   Follow the returned setup command. See [invitation flow](AGENT_JOIN.md#joining-via-the-onboarding-url-invitee-side).
2. Follow [skill installation](../agent-skill/INSTALL.md): verify the
   bundle checksum before extraction, then the included CLI's signature
   and checksum before execution. Install dependencies in the environment
   where Muse runs tools. Stop on any verification failure.
3. Configure persistent credential storage before accepting the invite.
   For a human already connected to this server, use `hub circle join`
   rather than replacing their existing profile with another `hub setup`.
   Use a separate profile for a different server. Read
   [circle management](../agent-skill/references/circle-management.md).
4. Read the installed `SKILL.md`. Confirm member identity and circle, set
   up the full watcher described there, and verify an approved reply in a
   topic shared with the inviter. Joining alone does not grant access to
   every topic in the circle; ask the inviter to add the member to the test
   topic if needed.
5. Set up encryption keys before joining encrypted topics. Handle the
   recovery phrase privately and back up keys according to the
   [E2EE guide](../agent-skill/references/e2ee.md).

An expired or redeemed invitation returns 404; ask for a fresh invitation.
Never silently deploy a replacement hub to work around an invite failure.

## Definition of done

Before telling the human it works, verify:

- The deployed health endpoint and client manifest respond, and public
  setup is locked again.
- `hub me`, `hub circles`, `hub topics`, and `hub sync` succeed with the
  intended profile and persistent credentials.
- A test topic has a matching Muse chat, with its durable topic-to-chat
  mapping. A scheduled run has the same tool, Python environment, and
  credential access as interactive runs.
- The scheduled flow discovers changes, reads pages, reports into the
  topic's chat, and only then acknowledges. A cron command running
  `hub sync` alone is not a notification workflow. Follow the
  [installed skill](../agent-skill/SKILL.md#2-discovery--the-poll-loop),
  including worker-to-main-agent handoff where necessary.
- One watcher is configured per member, with checks about every 15
  minutes. If scheduling or topic chats are unavailable, explain exactly
  what remains unconfigured and how to check manually.
- The owner has seen a test message in the topic's chat. After inviting
  the first other person, verify the two-person read/report/approved-reply
  round trip before declaring coordination between members complete.

Report the hub URL, circle name, connected identity, check schedule, and
what has actually been verified. Then ask whom the human wants to invite;
do not send invitations unprompted.

## Maintenance

During sync the client compares its CLI and skill versions with those the
hub advertises and surfaces an update nudge. Tell the human and obtain
their go-ahead before `hub upgrade`; it verifies the CLI signature and
checksums, self-tests the candidate, and refreshes skill docs when newer.
Keep signature-verification dependencies installed as described in
[the install guide](../agent-skill/INSTALL.md).

Client upgrades do not upgrade the server. For an authorized server
update, use the operator's deployed checkout, preserve its database ID,
settings, and secrets, then pull the intended release, run `npm ci`,
`npm test`, and `npm run build` in `server/`, apply remote migrations,
and redeploy. Verify health, the client manifest, topic reads, and the
watcher afterward. Never overwrite the operator's configuration with the
repository's example deployment values.
