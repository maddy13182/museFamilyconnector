# Installing the family-hub skill (per person)

Each family member installs this on their own agent. The owner (Mahesh) does
it first, then invites everyone else.

## Prerequisites

- Python 3.8+.
- **PyNaCl + the `mnemonic` package** (pinned in `requirements.txt`):
  `pip install -r requirements.txt`. These are needed for the E2EE identity
  key commands (`setup` key generation, `key-init`, `key-backup`,
  `key-restore`). The stdlib-only property ended with E2EE Phase 1 — every
  other `hub` command keeps working without them, and key commands fail
  with a clear message telling you how to install them.
- An **invite code** from the family owner (sent over text/email — the code is
  single-use, expires in 7 days, and grants no read access by itself).

## Step 1 — Get the files

Copy this directory to your agent's skills folder (or just use it in place
from a checkout):

```sh
mkdir -p ~/workspace/skills/family-hub
cp -r /path/to/family-hub/agent-skill/* ~/workspace/skills/family-hub/
chmod +x ~/workspace/skills/family-hub/hub
```

## Step 2 — Run setup

```sh
hub setup
```

It asks for three things (or pass them as flags):

| Prompt | Flag | Notes |
|---|---|---|
| Hub server URL | `--server https://…` | From the owner |
| Invite code | `--invite <code>` | Asked securely (not echoed) |
| Display name | `--name "Lakshmi"` | Your name as the family sees it |
| Agent label | `--label "phone-agent"` | Which *agent* of yours this is |

On success the server returns your member record and **one** bearer token.
`hub setup` **never prints the token**. Where it lives depends on `--store`:

- `--store env` (default, recommended for Muse agents): hub stores nothing.
  Your agent harness injects `FAMILY_HUB_TOKEN` from your **Secure Vault**
  every time it runs `hub`. Save the token into the vault via your platform's
  secure flow right after setup — the server will never show it again.
- `--store file`: writes the token to a `0600` file under
  `~/.config/family-hub/profiles/<name>/token`. Simple, but anyone with your
  machine user can read it. Fine for a personal server, not for shared boxes.
- `--store vault-cmd`: hub runs your helper (e.g. `op read …`) on every
  invocation and takes the token from its stdout. Nothing stored at all.

Precedence at runtime is: `FAMILY_HUB_TOKEN` → vault helper → `0600` file.

## Step 3 — Poll on a schedule

Add a recurring job that runs `hub sync` about every 15 minutes. The agent
reads new entries and surfaces anything needing the human's attention.

Cron example (the scheduler injects the credential — **never paste the token
into the crontab**):

```cron
*/15 * * * * /home/you/workspace/skills/family-hub/hub sync --limit 200
```

With the platform scheduler / hooks: create a 15-minute cron whose command is
`hub sync`, with `FAMILY_HUB_TOKEN` bound from the Secure Vault (same binding
the agent's tool calls use). Multiple agents on one machine: give each its own
`--profile` so cursors don't collide.

## Step 4 — The 2-minute live check

```sh
hub me        # your identity: member, role, agent label (no credential shown)
hub topics    # topics you can see (empty is fine on day one)
hub sync      # [] means "caught up" — the cursor is stored for next time
```

Then read `SKILL.md` (or have your agent read it) — that's the whole manual.

## For non-Muse agents

Same `hub` binary works anywhere Python 3 exists. Provide the credential via
`FAMILY_HUB_TOKEN` in the process environment, or `--store file` during setup
for a persistent `0600` token file. Everything else (subcommands, JSON
output, exit codes) is framework-agnostic by design — see `docs/openapi.yaml`
for the raw REST contract.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `No credential found` | `hub setup` again, or export `FAMILY_HUB_TOKEN` |
| `Authentication failed` (exit 3) | Token revoked/rotated — re-run `hub setup` with a fresh invite, or ask the owner |
| `Access denied` (403) | You're not a participant — ask an owner/parent to invite you; don't work around it |
| `Blocked` (exit 4 / 422) | Your text tripped the PII scan — rephrase without card numbers/SSNs and retry |
| `Cannot reach the Hub server` | Check `--server` / config URL and network |
| `warning: token file … is readable by others` | `chmod 600` the file, or switch to `--store env` |
