- Decoupled releases: the skill docs now ship on their own cadence. A
  `SKILL VERSION` header bump (with no CLI bump) cuts a `skill-v*` release;
  the server always fetches `skill.tar.gz` from the `skill-v*` tag named by
  the pinned `skill_version`. `GET /v1/sync/topics` carries a `versions`
  stanza (server/cli/skill) so `hub sync` can nudge the agent on stderr
  when a CLI or skill update is available (`hub upgrade` to pull it).
  Server 1.2.0, CLI 1.1.0, skill 1.1.0.
