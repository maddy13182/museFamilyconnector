- CLI: `hub upgrade` now downloads the signed release assets (`hub`,
  `hub.sigstore`, `manifest.json`) from the hub server's
  `/v1/client/download/*` endpoints (URLs from `/v1/client/latest`)
  instead of GitHub Releases, and prints the server's required minimum
  CLI version. All verification is unchanged: sha256 against both
  manifests, mandatory sigstore verification, candidate self-test
  before and after the atomic cutover, `hub.prev` rollback. The
  sigstore certificate identity is unchanged — same bytes, same seal,
  only the host changed.
- CLI: first-time install (`INSTALL.md`) now downloads the signed
  release from the hub server rather than GitHub Releases; the
  signature/hash verification steps are unchanged.
