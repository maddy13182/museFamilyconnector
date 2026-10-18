# Joining a circle from a hosted invitation

The invitation URL is the entry point for Muse. Everything needed is served by
that backend or included in its verified skill bundle. An invitee does not clone
this repository, deploy infrastructure, or provide Cloudflare credentials.

## Inviter

Use the documented `invite-member` command in the intended circle. Privately send
the returned onboarding URL to the person. Do not put it in a shared topic.
The role controls circle permissions; separately add the member to the topics
they should see and finish distributing their encrypted keys.

## Invitee's Muse

1. Read the URL with `Accept: application/json`. It contains `client`,
   `install.steps`, `install.paths`, `install.commands`, complete
   `install.agent_instructions`, and the exact `verify` endpoint.
2. Check prerequisites and run the install block in order, stopping on error.
   It creates a venv, downloads from this server, checks the archive before
   extraction, verifies the CLI signature and both hashes, installs dependencies
   in that venv, and self-checks the CLI. Record its printed absolute paths.
3. Read and load the installed `SKILL.md` and `INSTALL.md`. Configure the tool
   command with the exact venv interpreter and CLI, including in scheduled jobs.
   If the platform cannot load skills, execute tools, create chats, or schedule
   updates, report the particular limitation instead of claiming completion.
4. Only then submit the invited email to `verify`. This is an address match,
   not email-inbox verification. Keep the response private. Write `invite_code`
   directly into a `0600` file; never display it or put it in argv.
5. Run the returned `enroll_command`, replacing the private code-file path and
   display name. It uses a server-specific profile and chooses setup versus
   joining an additional circle. It preserves existing circle credentials and
   rejects a profile pinned to another origin.
6. Check `me`, `circles`, and `topics` using the page's exact command paths. Ask
   the inviter to add this member to a test topic and finish key sharing. Test
   an approved message/reply in both people's Muse topic chats.
7. Configure the installed skill's full discovery/read/report/acknowledge watcher.
   Only acknowledge after reporting. Keep recovery information private and back
   it up off-machine. Remove the spent code file after authenticated checks pass.

## Interrupted enrollment

The CLI saves a fresh private credential and request before accepting the code.
The server commits membership, identity, credential hash, code consumption, and a
request-bound receipt atomically. Matching retries resume the same enrollment.
A changed request or credential, revoked token, or removed member cannot resume.

Preserve the profile and encryption identity and run the page's `resume_command`:
`enroll --resume` with the same profile. Do not repeat email verification, request
another invitation, regenerate keys, or delete pending files. A used invitation
page returning 404 is expected; the saved operation does not need the page again.

For investigation, run the page's `diagnostics_command`: `diagnostics export`
with the same profile and a private output path. It works offline before enrollment
succeeds. Share only that allowlisted report, never config, token, pending-operation,
identity-key, or recovery-phrase files. Match exported request/operation IDs with
server arrival, transaction, issuance/resumption, and completion events. Missing
logs alone are inconclusive.

These instructions require the fresh 2.2.0+ server, CLI, and skill. The backend
build refuses earlier artifact pins. Publish the signed release and merge its
manifest PR before deploying the fresh server.


To add another of your own agents while one still works, run on the working agent:

```bash
hub agent-invite --label phone --output /private/phone-approval.txt
```

Transfer that file privately to the new device. After installing the hosted bundle,
run `hub enroll --server SERVER-URL --code-file PRIVATE-FILE --label phone` in
the appropriate profile. This approval replaces another inbox verification.
It expires after 24 hours and stops working if its issuing credential is revoked.
Circle owners cannot approve another person's server login. Keep the approval
out of topic messages, shared chats and diagnostic exports.
