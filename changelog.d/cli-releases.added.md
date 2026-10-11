- CLI: signed releases and self-upgrade. Merges to `main` now cut a signed
  CLI release (`cli-v<x.y.z>`) when the version in `agent-skill/pyproject.toml`
  is newer than the latest release tag: the `hub` artifact is sha256-hashed
  and signed with sigstore keyless OIDC, and the release carries
  `hub`, `hub.sigstore`, and `manifest.json`. The release workflow also
  updates `server/client-manifest.json` (committed back with `[skip ci]`),
  which is what `GET /v1/client/latest` advertises.
- CLI: new `hub upgrade` command — checks `GET /v1/client/latest`, downloads
  the new artifact only when newer, verifies the sigstore signature and
  sha256, self-tests the candidate before cutting over, swaps it in
  atomically, and keeps the previous binary for `hub rollback`. No-op when
  already current. `agent-skill/INSTALL.md` documents the first-time
  install flow (download → verify signature → verify sha256 → install →
  `hub --version` self-check) and the upgrade/rollback flows.
