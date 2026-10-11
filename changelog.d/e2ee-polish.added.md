- E2EE Phase 6 — polish. Server: the dashboard's E2EE topic view is now
  metadata-only with an honest, prominent "Content encrypted — the server
  cannot read this topic." label; encrypted subjects render as
  `🔒 [encrypted]` (never the ciphertext blob), encrypted bodies are hidden,
  plaintext system events (key rotations, archive notices) and the
  "retired → continues at <successor>" archive banner stay visible, and
  posting from the dashboard is disabled on encrypted topics. Key import
  into the dashboard is explicitly deferred (stated in the UI). Docs:
  `docs/CONCEPTS.md` states the per-topic E2EE trust model (content hidden,
  metadata visible, plaintext topics unchanged); `docs/SECURITY.md` gains
  the E2EE threat-model addition, key-management responsibilities, and the
  key-loss runbook (`hub recover` exit 2 documented as "parked, waiting on
  a human"); `docs/INSTALL.md` gains an E2EE setup section;
  `docs/AGENT_JOIN.md` gains the joining-agent E2EE section; and the new
  `docs/E2EE_FRESH_DEPLOY.md` is the step-by-step runbook for the v0.7.0
  clean-slate production deploy (D1 wipe, schema, re-enrollment).
  CLI/SKILL.md: identity key commands (`key-init`, `key-backup`,
  `key-restore`) and `new-topic --e2ee` added to the command reference.
