- CLI: `hub upgrade` now ends with a skill-docs refresh phase (contract
  §3.6). The server advertises a versioned skill bundle
  (`/v1/client/download/skill.tar.gz`) in the `GET /v1/client/latest`
  manifest's new `skill` block (`{url, sha256, version}`); when the
  server's skill version is newer than the installed one, the CLI
  downloads the tarball (same-origin pinned https, like the release
  assets), verifies its sha256 against the manifest **before**
  extraction, extracts fail-closed (absolute paths, `..` components,
  symlinks/hardlinks, and non-regular members are all rejected with
  nothing written), and copies only the doc allowlist — `SKILL.md`,
  `INSTALL.md`, `requirements.txt`, `references/` — into the skill dir.
  The binary flow owns `hub`/`hub.sigstore`/`manifest.json` and is never
  written by this phase; credentials (`config.json`, token files,
  `*.key`, profiles) are never within reach of the copy. The phase runs
  whether or not the binary was upgraded (skill and CLI versions are
  independent) and is a no-op when the docs are current or no `SKILL.md`
  sits next to the CLI. `GET /v1/client/latest` without a valid `skill`
  block is now a hard failure, and `_MIN_SERVER_VERSION` is 0.13.0 —
  the first server that serves the bundle. Clean break, no backcompat.
