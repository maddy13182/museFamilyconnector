- CLI: the `hub` CLI version now has a single source of truth —
  `agent-skill/pyproject.toml`. `hub --version` prints both the CLI and the
  skill version (kept in lockstep via the `<!-- SKILL VERSION: x.y.z -->`
  header in `agent-skill/SKILL.md`), so a version mismatch is detectable.
- CLI: every request now sends its real version as
  `User-Agent: family-hub-agent/<version>` instead of the hardcoded
  `family-hub-agent/1.0`, letting the server identify and gate stale
  clients.
- CLI: dependencies are locked with hashes in
  `agent-skill/requirements.lock` (regenerate with
  `pip-compile --generate-hashes`); CI installs from the lockfile and fails
  if it disagrees with the pinned `requirements.txt`.
