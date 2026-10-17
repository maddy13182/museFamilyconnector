# Installing the family-hub skill (per person)

Each family member installs this on their own agent. The owner (Mahesh) does
it first, then invites everyone else.

## Prerequisites

- Python 3.8+.
- **PyNaCl + mnemonic** are mandatory for normal use. Install from
  `requirements.txt` (exact direct dependency pins; checkout CI uses `requirements.lock`); no plaintext fallback.
- Protocol-2 server, CLI and skill (2.0.0+); older releases are incompatible.
- An **invite code** from the family owner (sent over text/email — the code is
  single-use, expires in 7 days, and grants no read access by itself).

## Step 1 — Get the files

**The one-bundle flow (recommended).** The server publishes the whole
installable skill as one signed bundle: `GET /v2/client/latest` names the
current skill version and its download URL (the manifest's `skill` block:
`{url, sha256, version}`). The bundle is `skill.tar.gz` — `SKILL.md`,
`references/`, `INSTALL.md`, `requirements.txt`, plus the signed `hub`
binary, its `hub.sigstore` signature bundle, and `manifest.json`.

Get the bundle URL and its expected sha256 from the family owner (both are
printed on your invite page), then:

```sh
mkdir -p ~/workspace/skills/family-hub && cd ~/workspace/skills/family-hub
curl -sSLO "<skill-bundle-url>"          # skill.tar.gz from your server
```

Verify **before** extracting or installing — in this order:

```sh
# 1. Hash: proves the bytes are exactly the published bundle.
python3 - <<'EOF'
import hashlib
want = "<sha256-from-the-invite-page>"   # or from GET /v2/client/latest
got = hashlib.sha256(open("skill.tar.gz", "rb").read()).hexdigest()
assert got == want, "sha256 MISMATCH — do not install"
print("sha256 OK:", got)
EOF

# 2. Extract, then verify the binary inside the bundle.
tar -xzf skill.tar.gz
chmod +x hub

# 3. Signature: proves the binary was built by this repo's release
#    workflow (keyless OIDC; no long-lived keys to steal).
pip install "sigstore>=3.0,<4.0"
python3 -m sigstore verify identity \
  --bundle hub.sigstore \
  --cert-identity "https://github.com/maddy13182/museFamilyconnector/.github/workflows/release.yml@refs/heads/main" \
  --cert-oidc-issuer "https://token.actions.githubusercontent.com" \
  hub

# 4. Hash: proves the binary bytes are exactly the released ones.
python3 - <<'EOF'
import hashlib, json
want = json.load(open("manifest.json"))["sha256"]
got = hashlib.sha256(open("hub", "rb").read()).hexdigest()
assert got == want, "sha256 MISMATCH — do not install"
print("sha256 OK:", got)
EOF
```

If **any** check fails, **do not install** — delete the files and tell the
family owner.

Then install the pinned dependencies (the bundle carries no installed
deps — they install from the lockfile at install time):

```sh
pip install -r ~/workspace/skills/family-hub/requirements.txt
```

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
(`GET /v2/client/latest` — which also states the server's required
minimum CLI version), and only when it is newer than the installed
CLI does it:

1. Download `hub`, `hub.sigstore`, and `manifest.json` from the server's
   own download endpoints (`/v2/client/download/*`, the URLs in the
   manifest's `assets` map).
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

After the binary flow — whether or not the binary was upgraded — a
skill-docs refresh phase runs: when the server's skill bundle (the
manifest's `skill` block: `{url, sha256, version}`) is newer than the
installed skill docs, the tarball is downloaded (same-origin pinned),
its sha256 verified **before** extraction, and only the doc files —
`SKILL.md`, `INSTALL.md`, `requirements.txt`, `references/` — are
refreshed. Skill and CLI versions are independent, so docs can update
while the binary stays put. The refresh never touches `hub`,
`hub.sigstore`, `manifest.json`, or any credential files.

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
hub setup --store file
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

- `--store file` is the default: the CLI saves the credential in a private 0600
  profile file before continuing. Agent commands never print it.
- Environment and vault-helper lookup are available for an already-provisioned
  credential. They are runtime lookup methods only, not setup storage options. Setup always
  persists the newly minted credential privately; it rejects ephemeral enrollment
  sinks before consuming the code.

The identity recovery phrase is saved in a private `recovery-phrase.txt` file in
that profile, never printed. Save it privately off-machine; do not ask Muse to
read its words into chat. `hub key-backup` creates an encrypted backup too.

Precedence at runtime is: `FAMILY_HUB_TOKEN` → vault helper → `0600` file.

## Step 3 — Poll on a schedule

Schedule the **complete Muse workflow** about every 15 minutes: discover changed
topics with `hub sync`, read each topic, deliver its report to the matching Muse
chat, then acknowledge the successfully delivered read receipt. Scheduling only
the `hub sync` CLI prints JSON; it does not notify anybody.

On a platform with a background worker, have it prepare the per-topic report and
receipt for the main Muse agent, which posts to the chat before acknowledging.
If the worker has chat tools, it can deliver and acknowledge itself. If scheduling
or chat creation is unavailable, say so and use manual checks. Follow SKILL.md §2;
never claim that automatic notifications work until the human has received a test.

Use private profile storage or the platform's secure runtime credential injection.
Multiple agents on one machine need separate profiles and private keys. If the
identity is wrapped, supply `FAMILY_HUB_KEY_PASSPHRASE` from secure storage for
scheduled invocations; never paste it or the bearer credential into job text.

> **Wrapped keys + cron.** If you wrapped the agent key with
> `hub key-wrap`, every non-interactive invocation (this cron included)
> must export `FAMILY_HUB_KEY_PASSPHRASE` — otherwise `hub` blocks on an
> interactive passphrase prompt and the job hangs. Bind it from the
> Secure Vault exactly like the token, never paste it into the crontab.

## Step 4 — The 2-minute live check

```sh
hub me        # your identity: member, role, agent label (no credential shown)
hub topics    # topics you can see (empty is fine on day one)
hub sync      # empty output means "no changed topics"; the first run after
              # the 0.13 upgrade re-reads everything once (server-side
              # read state per agent per topic)
```

Then read `SKILL.md` (or have your agent read it) — that's the whole manual.

## Protecting the identity key at rest (`hub key-wrap`)

Your E2EE identity key lives at
`~/.config/family-hub/profiles/<name>/agent.key` (`0600`). By default it is
stored **unwrapped** (raw 32 bytes). `hub key-wrap` encrypts it in place
with a passphrase:

```sh
hub key-wrap
```

What happens:

1. The unwrapped original is backed up first to `agent.key.bak-0600`
   (`0600`). Nothing is overwritten until the backup exists.
2. You choose a passphrase (min 8 characters). It is **never** a CLI flag
   (it would land in `ps` / shell history) — it comes from the
   `FAMILY_HUB_KEY_PASSPHRASE` env var when set, otherwise an interactive
   prompt that never echoes. It is never logged and never appears in error
   messages.
3. The key is encrypted with a key derived from your passphrase via
   **Argon2id**, using **XChaCha20-Poly1305**. The wrapped file starts with
   the magic header `FHWRAP1`, then `salt(16) || nonce || ciphertext`.
4. `hub` proves the wrapped file decrypts back to the identical key
   **before** trusting it; on any failure the original is restored from the
   backup.

After wrapping, every `hub` command that needs the key detects the
`FHWRAP1` header automatically and asks for the passphrase (env var first,
prompt second). A wrong passphrase gives a clean "Incorrect passphrase"
error — never garbage output.

Legacy unwrapped keys keep working, but `hub` prints a loud deprecation
warning on every use pointing at `hub key-wrap`.

For scheduled agent workflows, bind the wrapped-key passphrase through the
scheduler's secret store. Missing passphrases can cause an interactive prompt;
configure unattended secret access before enabling the watcher. Never put literal
secrets in job commands, and schedule the complete read/report/ack workflow.

## For non-Muse agents

Same `hub` binary works anywhere Python 3 exists. Provide the credential via
`FAMILY_HUB_TOKEN` in the process environment, or `--store file` during setup
for a persistent `0600` token file. Everything else (subcommands, JSON
output, exit codes) is framework-agnostic by design — see `docs/openapi.yaml`
for the raw REST contract.

## Verifying your install (tamper-evidence)

The installed `hub` is a signed release. Two checks keep it honest:

- **`hub verify-install`** — re-runnable any time. It checks the installed
  `hub` file's sha256 against the release `manifest.json` installed next to
  it, then validates the sigstore bundle: the bundle must structurally be a
  sigstore bundle and must attest to exactly the installed bytes. If the
  `sigstore` CLI is installed, the full certificate + transparency-log chain
  is validated too; otherwise that step is reported as skipped (honestly —
  not as a pass). Clear `RESULT: PASS` / `RESULT: FAIL` output, exit 0 / 1.
- **Startup self-check** — every `hub` invocation hashes the CLI's own file
  bytes and compares against the manifest's recorded hash. On mismatch the
  CLI refuses to run (exit 5): `installed CLI does not match the signed
  release; reinstall from the server`. A missing or corrupt
  `manifest.json` (a dev checkout, or a hand-rolled copy) warns once on
  stderr and continues — it never hard-fails development.

**Honest limit.** These checks catch supply-chain tampering (a corrupted or
unofficially modified `hub` landing on this machine), accidental corruption,
and casual modification. They do **not** defend against an attacker with root
on this machine: root can read the bearer token and `agent.key` straight off
disk, which is easier than tampering with the CLI. No security theater — if
you suspect a host compromise, rotate credentials; the CLI refusing to run
is not the layer that saves you there.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `No credential found` | `hub setup` again, or export `FAMILY_HUB_TOKEN` |
| `Authentication failed` (exit 3) | Token revoked/rotated — re-run `hub setup` with a fresh invite, or ask the owner |
| `Access denied` (403) | You're not a participant — ask an owner/parent to invite you; don't work around it |
| `Blocked` (exit 4 / 422) | Your text tripped the PII scan — rephrase without card numbers/SSNs and retry |
| `Cannot reach the Hub server` | Check `--server` / config URL and network |
| `warning: token file … is readable by others` | `chmod 600` the file |
| `hub upgrade`: `sigstore` not installed | `pip install "sigstore>=3.0,<4.0"`, then retry — the upgrade refuses rather than skipping verification |
| `hub upgrade`: signature/sha256 FAILED | Do **not** install; the artifact may be tampered — tell the family owner |
| cron job hangs on a prompt | `agent.key` is wrapped and the job lacks `FAMILY_HUB_KEY_PASSPHRASE` — bind it from the Secure Vault (see Step 3) |
| `installed CLI does not match the signed release` (exit 5) | The `hub` file differs from the signed release — run `hub verify-install` for details, then reinstall from the server |
| `RESULT: FAIL` from `hub verify-install` | Reinstall from the server (artifact + `manifest.json` + `hub.sigstore` via `/v2/client/download/*`, or `hub upgrade`); don't keep using the failed copy |

### Enrollment diagnostics (recorded automatically)

The CLI records metadata for every HTTP attempt, retry, response, JSON parse,
credential save, and enrollment verification, even without `--debug`. Its private
`0600` log is `<profile directory>/diagnostics.jsonl` (normally
`~/.config/family-hub/profiles/default/diagnostics.jsonl`). History is discarded
when the file exceeds 1 MiB. Preserve it after a failure, before more commands.
A warning means the log could not be written; missing events are then inconclusive.

Each invocation has a `run_id`. Each HTTP call has an `operation_id` shared by
its retries, and each attempt has a distinct `request_id`. The CLI sends these
last two IDs to the server. Match them against Cloudflare Workers Logs:

| Evidence | What it establishes |
| --- | --- |
| CLI `http_attempt_started` | The CLI was about to send an attempt; arrival is not proven. |
| Server `request_received` | The handler received that attempt. |
| Server `enrollment_batch_started` / `enrollment_batch_completed` | The database batch started / completed; a conditional race loser may complete without issuing a token. |
| Server `enrollment_issued` | Post-batch checks confirmed this attempt issued the credential. |
| Server `request` with status `201` | The handler prepared success; client receipt is not proven. |
| CLI `http_response_received` / `http_json_parsed` | The CLI read the complete response / parsed its JSON. |
| CLI `credential_file_saved` / `credential_config_saved` | The corresponding local persistence call completed. |
| CLI `credential_verified` | The new credential successfully authenticated with `/v2/me`. |
| CLI `command_finished` | The actual CLI exit code, independent of shell pipelines. |

Persistent diagnostics exclude tokens, invite codes, bodies, names, email
addresses, keys, recovery phrases, and exception messages. Do not share your
configuration, credential files, or recovery phrase alongside the log. `--debug`
is a separate, more detailed console trace and is unnecessary for this history.
Absent events alone do not prove an event never happened: abrupt termination,
local storage failure, or telemetry delivery can interrupt recording. These
logs diagnose enrollment; they do not make single-use enrollment resumable.
