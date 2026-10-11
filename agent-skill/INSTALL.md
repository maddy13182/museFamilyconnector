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

**Option A — signed release (recommended).** Every CLI release is cut by
the release workflow as `cli-v<x.y.z>` on GitHub, with three assets:
`hub` (the single-file script), `hub.sigstore` (the sigstore keyless
signature bundle), and `manifest.json` (`{version, sha256, files}`).

```sh
VER=0.7.0   # pick the version your owner tells you to install
BASE=https://github.com/maddy13182/museFamilyconnector/releases/download/cli-v$VER
mkdir -p ~/workspace/skills/family-hub && cd ~/workspace/skills/family-hub
curl -sSLO "$BASE/hub" -sSLO "$BASE/hub.sigstore" -sSLO "$BASE/manifest.json"
chmod +x hub
```

Verify **before** installing — in this order:

```sh
# 1. Signature: proves the artifact was built by this repo's release
#    workflow (keyless OIDC; no long-lived keys to steal).
pip install "sigstore>=3.0,<4.0"
python3 -m sigstore verify identity \
  --bundle hub.sigstore \
  --cert-identity "https://github.com/maddy13182/museFamilyconnector/.github/workflows/release.yml@refs/heads/main" \
  --cert-oidc-issuer "https://token.actions.githubusercontent.com" \
  hub

# 2. Hash: proves the bytes are exactly the released ones.
python3 - <<'EOF'
import hashlib, json
want = json.load(open("manifest.json"))["sha256"]
got = hashlib.sha256(open("hub", "rb").read()).hexdigest()
assert got == want, "sha256 MISMATCH — do not install"
print("sha256 OK:", got)
EOF
```

If either check fails, **do not install** — tell the family owner.

**Option B — copy from a checkout** (dev / owner machines only):

```sh
mkdir -p ~/workspace/skills/family-hub
cp -r /path/to/family-hub/agent-skill/* ~/workspace/skills/family-hub/
chmod +x ~/workspace/skills/family-hub/hub
```

Then install the pinned dependencies (the release bundles no deps —
they install from the lockfile at install time):

```sh
pip install -r ~/workspace/skills/family-hub/requirements.txt
```

## Step 1b — Self-check

```sh
hub --version   # prints the CLI version (and, once WS-A lands, the skill version too)
```

A mismatch between the installed `hub` and the skill files it lives
with is detectable here — keep them in lockstep (see "Upgrading" below).

## Upgrading — `hub upgrade`

`hub upgrade` asks the server what the current signed release is
(`GET /v1/client/latest`), and only when it is newer than the installed
CLI does it:

1. Download `hub`, `hub.sigstore`, and `manifest.json` from the GitHub
   Release.
2. Verify the sigstore signature (refuses if the `sigstore` package is
   missing — it will not skip verification).
3. Verify the sha256 against both the release manifest and the server
   manifest.
4. Run the candidate's self-test (`--version`) **before** cutting over.
5. Swap the new binary in **atomically**, keeping the previous binary as
   `hub.prev`, and run the self-test again after the swap.
6. Record the installed release next to the CLI (`manifest.json` +
   `hub.sigstore`) for `hub verify-install`.

No-op when already current:

```sh
hub upgrade
```

If the new binary fails its post-install self-test, the previous binary
is restored automatically. To go back manually at any time:

```sh
hub rollback   # restores hub.prev; the rolled-back-from binary becomes the new fallback
```

> **Honest limit.** The signature/hash checks defend the *supply chain*
> (what gets installed), accidental corruption, and casual tampering.
> They cannot stop a root-level adversary on this machine: root can read
> `agent.key` and the bearer token straight off disk, which is easier
> than tampering with the CLI. That is documented, not hand-waved.

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

> **Wrapped keys + cron.** If you wrapped the agent key with
> `hub key-wrap`, every non-interactive invocation (this cron included)
> must export `FAMILY_HUB_KEY_PASSPHRASE` — otherwise `hub` blocks on an
> interactive passphrase prompt and the job hangs. Bind it from the
> Secure Vault exactly like the token, never paste it into the crontab.

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
| `hub upgrade`: `sigstore` not installed | `pip install "sigstore>=3.0,<4.0"`, then retry — the upgrade refuses rather than skipping verification |
| `hub upgrade`: signature/sha256 FAILED | Do **not** install; the artifact may be tampered — tell the family owner |
| cron job hangs on a prompt | `agent.key` is wrapped and the job lacks `FAMILY_HUB_KEY_PASSPHRASE` — bind it from the Secure Vault (see Step 3) |
