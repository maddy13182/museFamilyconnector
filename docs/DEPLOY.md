# Deploy a hub in your own Cloudflare account

Muse can perform this procedure. The human supplies Cloudflare authorization
through secure environment settings; no database ID, Worker URL, or manual
Wrangler-file editing is required.

## Credentials and prerequisites

Use Linux, macOS, or Windows WSL with Node.js 22.23.3 or newer, npm, Git,
and Python 3.11 or newer. `npm ci` installs
the repository's pinned Wrangler locally; no global installation or browser login
is needed.

Bind these variables using the environment's secure credential settings:

- `CLOUDFLARE_API_TOKEN`: a Cloudflare **API token**, not the Global API Key.
  Restrict it to the intended account with **Workers Scripts: Edit**, **D1: Edit**,
  permissions. The Workers template alone may
  need D1 permission added. The token must be able to read those resources too.
- `CLOUDFLARE_ACCOUNT_ID`: the Account ID shown in the Cloudflare dashboard.
No email provider or sender domain is needed. Invitees confirm their invited
email using the private invitation; the server does not send verification emails.

Do not paste the API token into chat, source files, shell commands, or logs.
Wrangler and the provisioner inherit it from the environment. It is never stored
in the deployment directory. A temporary token can be revoked after setup;
future updates need a valid token for the same account.

## One command provisions the backend

Clone this repository, then run:

```sh
cd museFamilyconnector/server
npm ci
npm test
npm run deploy:hub -- --name YOUR-HUB-NAME
```

Choose a unique lowercase Worker name in your account, such as `our-family-hub`.
Names, accounts, database IDs, and URLs are deployment inputs or discovered
outputs. `server/wrangler.toml` is a portable template, not a live configuration.

The command:

1. Builds the Worker and verifies the published CLI/skill artifact pins.
2. Checks for conflicting resources before making changes.
3. Creates a D1 database in your account and captures its actual ID.
4. Generates a private local Wrangler configuration binding that database as
   `DB`. The Worker accesses it as `env.DB`, a Cloudflare resource binding,
   rather than a database-ID string used to make connections.
5. Generates independent `TOKEN_PEPPER`, `READ_RECEIPT_SECRET`, and
   `BOOTSTRAP_SECRET` values in a private local file.
6. Applies every D1 migration using the pinned Wrangler, then uses its
   `--secrets-file` support to deploy the real Worker and required secrets
   together, with public setup locked. An existing account subdomain is reused;
   if none exists, a unique workers.dev subdomain is created for the account.
7. Discovers the hub URL and verifies protocol 2, required encryption, and the
   client manifest. It prints the URL and the private deployment directory.

Settings live under `server/.deployments/ACCOUNT_ID/HUB_NAME/`, ignored by Git.
Files are private (`0600`):

| File | Purpose |
| --- | --- |
| `state.json` | Account, Worker, database identity, discovered URL, and progress |
| `wrangler.json` | Generated bindings and nonsecret runtime settings |
| `secrets.json` | Recovery copy of generated Worker secrets |
| `owner-enrollment.json` | Private first-owner provisioning receipt, when requested |

Privately back up this directory, especially `secrets.json`. Never commit it or
read its contents into a model transcript. Do not regenerate `TOKEN_PEPPER` during
an upgrade: that would invalidate existing credentials.

## Create the first circle without opening public registration

Muse can create a private JSON file containing the human-provided details:

```json
{"name":"Our family","owner_name":"Your name","owner_email":"you@example.com"}
```

Then run the same command with that file:

```sh
npm run deploy:hub -- --name YOUR-HUB-NAME --bootstrap-file /PRIVATE/PATH/owner.json
```

This can also be supplied on the initial deployment command. The command briefly
enables bootstrap behind the private `BOOTSTRAP_SECRET`, creates the first circle,
saves the response directly to `owner-enrollment.json`, and locks setup again.
An unauthenticated visitor cannot create a circle during that step. The API token
and bootstrap secret are never printed. The first owner also becomes a server owner.

If the process is killed or the final deploy fails, rerun the same command to
restore locked setup first. The private bootstrap guard remains required even
before relocking. If a bootstrap response was lost, the command stops for
investigation instead of issuing a duplicate request. Invited-agent enrollment separately supports exact retries through the persisted client operation and server receipt.

Read `GET /v2/client/onboarding` on the discovered hub URL. It contains the same
verified installation, exact interpreter/CLI paths, skill-loading, and enrollment
instructions as an invitation. Follow those steps and the bundled `INSTALL.md`;
no repository clone is needed for client instructions. Use its server-specific
profile for owner enrollment as well. Enroll the owner's
Muse using the saved provisioning code without displaying it or putting it in
shell history. For example, a trusted helper can pipe the private code to the
CLI's secure prompt:

```python
import json, subprocess
from pathlib import Path
receipt = json.loads(Path("PRIVATE-DEPLOYMENT-DIRECTORY/owner-enrollment.json").read_text())
subprocess.run(
    ["/ABSOLUTE/VENV/PYTHON", "/ABSOLUTE/PATH/TO/VERIFIED/hub", "--profile", "HOSTED-GUIDE-PROFILE", "enroll", "--server", "YOUR-DISCOVERED-HUB-URL", "--email", "YOUR-OWNER-EMAIL"],
    input=receipt["provisioning_code"] + "\n", text=True, check=True,
)
```

Use the CLI path installed for this Muse, not a guessed executable from `PATH`.
Do not print the receipt or recovery words. Keep the existing identity on retries.
Remove the spent receipt only after successful enrollment. See
[the Muse setup guide](MUSE_SETUP.md) for connection and conversation checks.

## Repeat runs and upgrades

Rerun the same command from the same checkout to reuse the recorded database,
Worker identity, and secrets. Interrupted resource creation is reconciled by the
saved intent and Cloudflare's actual resources. A database-binding or ownership
mismatch stops deployment. Nothing is automatically deleted or reset.

For an intentional update from a clean checkout or GitHub Actions:

```sh
npm run deploy:hub -- --name YOUR-EXISTING-HUB --existing
```

This explicitly discovers the named Worker's current `DB` binding and required
secret names. It applies migrations and deploys code while retaining that
binding and secret values. It refuses to create a replacement if the Worker
is missing. It does not retrieve secret values or bootstrap another owner.
Do not use it to convert a protocol-1 database: migration 0013 intentionally
rejects old topic data. Preserve old databases and create a distinct deployment.

The default minimum CLI version for new protocol-2 deployments is `2.2.0`.
Signed newer CLI/skill releases must be published and their manifest PR merged
before the backend can distribute those new bytes. Never invent artifact hashes.
Hosted invitations, resumable enrollment, and diagnostic export require the signed 2.2.0+ CLI and skill; the build refuses earlier artifact pins.

## GitHub Actions

The optional Deploy workflow updates an **existing** backend; first provisioning
uses the command above. Configure repository Actions secrets
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, plus repository variable
`CLOUDFLARE_HUB_NAME`. Every run rediscovers that Worker's binding. No deployment
ID or secret file needs to be committed or cached in GitHub.

## Recovery and verification

A failed command is not a completed install. Check its stage message and private
state. There is no automatic resource deletion or secret rotation. The provisioner
never prints raw API responses or subprocess output that might contain secrets.
After setup, verify `hub me`, `hub circles`, encrypted topic reads, and a real
exchange with another independently enrolled Muse. Configure the full
read → report in the topic chat → acknowledge watcher.

Identity/discovery protocol 1 requires a new database with the full migration
chain, including the fresh identity-contract guard. The provisioner verifies
these capabilities after deployment. Follow [IDENTITY_PROTOCOL.md](IDENTITY_PROTOCOL.md)
for the invitation registration and cross-server routing contracts.
