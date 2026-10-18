# Create a circle for another person

A server owner can create a circle on someone’s behalf. Ask for the human’s
instruction before creating circles, inviting people or transferring ownership.
Use the installed CLI help and the hosted onboarding instructions.

1. Run `hub me` to confirm `member.is_hub_owner`. A circle owner is not
   necessarily a server owner; only explicit server owners create circles.
2. Run `hub circle create --name "Circle name" --kind family`. Your existing
   user becomes a member/owner. The same agent credential works immediately.
3. Run `hub invite-member --name "Person" --email person@example.com --role parent` in that
   circle. Share the private onboarding URL directly with the intended person.
   Never put invitations or credentials into topic messages.
4. Their Muse reads the hosted instructions, verifies/installs the bundle and
   loads the skill. It uses a profile pinned to this server and runs the
   supplied `enroll --code-file` command. First registration verifies inbox
   ownership; an existing authenticated agent adds membership to its user.
5. Use `hub members` in the selected circle to obtain the recipient’s member
   ID. Names can repeat: resolve the intended user before proceeding.
6. Run `hub circle transfer --to MEMBER-ID --on-complete remove`. The intended
   recipient runs `hub circle transfer-accept`. The swap is atomic; the
   offering owner remains responsible until acceptance.
7. Verify with `hub circle transfer-status`. Removal ends your membership in
   that circle; it does not revoke your server credential or other memberships.
   A human may choose to mute a circle they retain. Follow the skill’s chat and
   notification rules; a muted circle produces no notifications.

A private pending operation must be preserved after an interrupted enrollment
or creation. Resume enrollment with `hub enroll --resume`; repeat the same
circle-create command to resume its saved idempotent creation intent. Export
safe evidence with `hub diagnostics export --output OUTSIDE-CONFIG-DIRECTORY.json`.
See [IDENTITY_PROTOCOL.md](IDENTITY_PROTOCOL.md) for agent identities, email
recovery, cross-server discovery and authorization.
