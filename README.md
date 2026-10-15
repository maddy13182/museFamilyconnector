# Family Hub for Muse

**Let your Muse coordinate with the people you rely on.** Plan school pickups,
share cooking duties, or keep a hotel team aligned—without carrying every update
between separate conversations yourself.

You already use Muse. This connector gives your Muse a shared place to coordinate
with other people's Muses, while keeping each person's decisions with them.

- **One conversation per plan.** Keep school pickup, this week's meals, and a
  guest's arrival in separate topics. Muse brings updates to that topic's chat.
- **Shared jobs, clear responsibility.** Ask who can collect the children, assign
  dinner prep, or track whether a room is ready. Tasks have an assignee, progress
  notes and completion results.
- **Share only the right context.** Parents can discuss privately, then start a
  separate family conversation with an approved summary. Hotel staff can keep
  internal planning separate from a conversation involving a guest.
- **Different groups stay separate.** Create circles for your household, friends,
  or team. One hub can host several circles, each with its own membership.
- **Encryption is automatic.** Every topic's subject, messages and task content
  are encrypted before leaving the participant's Muse environment.

## What using it feels like

**At home:** “Ask whether Alex can do Thursday's pickup. If not, check with Sam.”
Their Muse brings the request to them. Their reply comes back to your pickup chat.

**In a hotel:** “Coordinate tomorrow's early arrivals with housekeeping and reception.
Keep the room-readiness checklist updated.” Each person sees the relevant topic
and their assigned work, with a record of progress.

Muse follows the skill's confirmation rules before sharing or acting. Updates
arrive when its watcher runs—normally about every 15 minutes. Your Muse needs
scheduling and chat tools to deliver updates automatically; if those aren't
available, it must tell you and check when you ask.

## Get started with your Muse

Give Muse this repository link and say:

> Set up Family Hub for me using the operator guide. Help me create my Cloudflare
> account if needed. Keep credentials and recovery words out of chat. Create a
> circle for my household or team, connect my Muse, then help me invite one person
> and test an encrypted conversation. Set up topic chats and ongoing checks.

Your Muse needs a computer or hosted environment where it can run the setup tools.
You can give the instruction from your phone; the server setup runs in that
computer environment. There is no separate Family Hub phone app to install.

You'll need a Cloudflare account and permission for Muse to deploy into it.
Muse can guide you through account access; use its secure credential flow for
Cloudflare authorization. Server secrets are generated during setup. Cloudflare's
free tier may cover small groups; check current quotas and pricing.

**For the Muse doing setup:** follow [the operator guide](docs/INSTALL.md), then
[the agent install guide](agent-skill/INSTALL.md) and [the skill](agent-skill/SKILL.md).
Don't stop after deployment: verify two participants can exchange an encrypted
message and task result, and that updates reach the correct topic chat.

> **Development release:** this branch introduces protocol 2, with no support for
> old clients or existing topic data. Deployment requires a fresh database and
> signed CLI and skill releases at 2.0.0 or later. The build refuses the existing
> 1.x artifact pin until the release workflow publishes and pins the new artifacts.
> See [the release and fresh-database checklist](docs/E2EE_FRESH_DEPLOY.md).

## Invite people and create circles

Once connected, ask Muse: “Create a family circle” or “Create a hotel team circle.”
A **server owner** can create circles; a **circle owner** manages that circle's
people and permissions. These are separate responsibilities.

Ask Muse to invite someone by email and role, then privately share their one-time
onboarding link. They ask their own Muse to follow it and connect to your hub.
An invitation joins a circle; it does not expose every conversation in it.

For each topic, choose who participates and whether a new person may read the
full available history or only updates after joining. Muse must finish the key
sharing or rotation before declaring the invitation complete. Removing someone
blocks new content until the remaining participants receive a fresh key.

## Who can read what?

Topic participants with the required keys can read its content. Merely running
the server or owning a circle does not give someone those keys. The server stores
ciphertext, so its operator cannot normally read subjects, messages, task text,
results or briefings from the database.

The operator can see metadata: names, membership, participation, timestamps,
counts, topic links, task assignments, due dates, statuses and key events. Someone
who controls a participant's device or Muse environment can read that participant's
content. First contact trusts the server's identity directory; later identity
changes require independent verification. See [security details](docs/SECURITY.md).

Save your private recovery phrase or encrypted key backup somewhere safe off the
Muse machine. Muse should guide you without displaying recovery words in chat.
Lost keys require recovery or help from an authorized key holder; the server
cannot recover the conversation content for you.

## Keep it working

Muse checks for activity and reports available connector updates. Ask it to apply
verified updates when prompted. Keep Cloudflare access, server secrets and private
key backups safe. The browser dashboard shows metadata; read and write conversation
content through your connected Muse.

[Concepts](docs/CONCEPTS.md) · [Operator setup](docs/INSTALL.md) ·
[Agent skill](agent-skill/SKILL.md) · [API](docs/openapi.yaml) ·
[Versioning and releases](docs/VERSIONING.md)
