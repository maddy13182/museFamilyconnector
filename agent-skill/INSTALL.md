# Install and join with your Muse

Use the private invitation page from the circle owner. Ask Muse to read its
agent-facing JSON (`Accept: application/json`). If you already hold an owner
provisioning code, read `GET /v2/client/onboarding` on your server instead; skip the invite-page address-matching step.
Provide the owner email when registering with its setup code. The page and this bundle contain
all join instructions; no repository clone or Cloudflare account is needed.

## Install before accepting the invitation

Run tools in the environment where your Muse executes commands. You need Python
3.12+, virtual-environment support, curl, and permission to install Python packages.
Use Linux, macOS, or Windows WSL. If a prerequisite is missing, resolve it before
revealing or redeeming the invite code.

Follow the page's complete installation block in one shell. It supplies paths
specific to this server and the published CLI/skill versions. The block:

1. Creates a dedicated Python virtual environment.
2. Downloads `skill.tar.gz` from this server and verifies its SHA-256 against
   the page **before extraction**.
3. Extracts with Python's safe data filter.
4. Installs Sigstore into that virtual environment and verifies `hub.sigstore`
   against the release workflow identity specified by the page.
5. Checks the CLI hash against both the page and the embedded release manifest.
6. Installs the exact direct dependencies from `requirements.txt`, including
   PyNaCl and mnemonic, into the same virtual environment.
7. Runs the CLI's version check and `verify-install` using that environment.

Stop on any failure. Do not execute an unverified CLI, bypass signature checks,
or substitute a different `hub` executable found on PATH. Package and signature
verification can require external network access; the source repository is not
needed for instructions.

The bundle contains `hub`, its signature/manifest, `SKILL.md`, this guide,
`requirements.txt`, and `references/`. It does not contain preinstalled packages.
Keep these verified files together. Versioned installation directories can
coexist; credentials and identity keys live separately in a private profile.

## Load the skill

Read the installed `SKILL.md` completely. Register or load it using Muse's skill
mechanism, and configure its tool to call the **absolute venv Python path plus
absolute hub path** provided by the page. Downloading a skill is not loading it.
If Muse cannot register skills or execute tools, report that specific limitation.
Do not claim the connector is ready.

Below, `PYTHON`, `CLI`, and `PROFILE` mean the actual paths/profile supplied by
that page. Each agent tool call must specify them explicitly. Shell variables,
virtual-environment activation, and working directories do not carry across
independent calls or scheduled jobs.

## Accept the circle invitation

After installation and skill loading succeed:

1. Submit the invited email to the page's verify endpoint. This checks the
   exact invited address; it does not verify control of an email inbox.
2. Write the returned `invite_code` directly to a private `0600` file using a
   trusted tool. Never print it, put it in argv, or save the full page response.
3. Run the returned `enroll_command`, replacing the code-file path and display
   name. `muse-agent` is a generic label; choose another if desired.

The command has this form:

```text
PYTHON CLI --profile PROFILE enroll --server SERVER-URL --code-file PRIVATE-CODE-FILE --name "Your name" --email "invited@example.com" --label muse-agent
```

`enroll` chooses setup for a new profile or circle join for an already connected
profile. It preserves the server credential and adds a membership to the same user. Use one profile per server;
never overwrite another server's profile or send its token to this server.

First registration saves the encryption identity and private candidate credential
before sending the invitation, name and matching email. The server registers one
user and one Muse agent, adds the circle membership and consumes the invitation
in one transaction with a resumable receipt. No verification email is sent.
Later joins reuse the same user, agent and server credential. Use the existing
server profile; another phone still uses the same Muse VM and identity.

A private pending operation remains until the credential is stored and verified
with `/v2/me`. If interrupted, preserve the profile and run:

```text
PYTHON CLI --profile PROFILE enroll --resume
```

No new invitation is needed for that saved operation. Preserve its keys and
pending files. A 404 from a consumed invitation page is expected after acceptance.

## Verify and use the circle

Run the page's exact commands for `me`, `circles`, and `topics`. Check the person,
server, and intended circle. An empty topic list is normal before the inviter
adds this member to a conversation. Circle membership alone does not grant
access to every topic or its encrypted keys.

Ask the inviter to add the member to a test topic and finish key distribution.
Verify an approved message and reply in both people's matching Muse chats.
Enrollment already initializes the identity; do not create a replacement key.
Privately back up recovery information off-machine. Never read recovery phrases,
private keys, or credential files into model-visible output.

Follow `SKILL.md` for the complete discovery → read → report in the matching
topic chat → acknowledge workflow. Schedule it using the same interpreter,
CLI, profile, and credential access. Do not acknowledge before reporting. If
scheduling or topic-chat tools are unavailable, explain the limitation and
verify manual checks. Delete the spent private code file after successful checks.

## Export a troubleshooting report

Logging is automatic, including without `--debug`. Export an allowlisted report:

```text
PYTHON CLI --profile PROFILE diagnostics export --output PRIVATE-REPORT.json
```

It works offline before enrollment succeeds. Optionally select an invocation
with `--run-id RUN-ID`. Share only this report with the operator. It includes CLI
and skill versions, a CLI hash, request/operation IDs, attempt statuses, transport
failure types, JSON parsing, credential-save/verification milestones, and actual
CLI exit codes. It does not read configuration, token files, pending operation
contents, identity keys, or recovery phrases. The report is written `0600`.

The raw history is `<profile directory>/diagnostics.jsonl`, normally
`~/.config/family-hub/profiles/PROFILE/diagnostics.jsonl`. Recent history is bounded
to about 1 MiB. Export promptly after failure; more activity can discard old history.
A warning means logging could not write, and missing events are inconclusive.

| Server evidence | Client evidence | Meaning |
| --- | --- | --- |
| `request_received` | `http_attempt_started` | Compare the same request ID to establish arrival. |
| `enrollment_batch_completed` | No response yet | Database batch completed; a race loser may have inserted nothing. |
| `enrollment_issued` or `enrollment_resumed` | `http_response_received` | Confirm issuance/resumption and whether the client read its response. |
| `request` with `201`/`200` | `http_json_parsed` | Server prepared success; the client parsed it. |
| Issued credential | `credential_file_saved` / `credential_config_saved` | Local persistence calls completed. |
| Successful `/v2/me` | `credential_verified`, `enrollment_complete` | Stored credential verified and pending operation cleared. |

Missing logs alone cannot prove a request never happened. Never attach
`config.json`, token files, pending-operation files, `agent.key`, or recovery
phrases. `--debug` is a separate console trace and is not required for export.

## Updates

Use the installed CLI's `upgrade` command with the same venv interpreter. It
checks the server's signed artifacts, verifies signature/hashes, self-tests, and
installs atomically. If requirements change, install the refreshed
`requirements.txt` into that same environment before using the new skill. Read
the refreshed `SKILL.md` and reload it in Muse. Keep previous verified files until
the updated CLI, skill, and watcher checks succeed. `rollback` restores the prior
CLI when available. Neither operation should replace credentials or identities.

## Find circles and people across servers

Use `circles --json` for structured discovery on the selected server, or
`circles --all-servers` for all configured profiles. Use
`people --query NAME --all-servers` to find visible users and their shared
circle membership IDs. Results include `server_url` and `profile`; a nonzero
exit and `complete: false` mean some profiles failed, not that memberships
disappeared. All-server discovery uses each profile’s stored credential, never
a single environment token sent to every server.

One email identifies one user with one Muse agent per server. The Muse VM holds
the profile, server credential and encryption keys; changing phones does not
change that identity. Restore private backups if the VM loses credentials.
Never create another identity as a workaround for an interrupted enrollment.
