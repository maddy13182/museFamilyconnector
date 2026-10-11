- Fragmented changelog: PRs now add `changelog.d/<slug>.<type>.md` fragments
  instead of editing `CHANGELOG.md` directly; fragments are consolidated
  into `CHANGELOG.md` automatically on merge to `main`.
- Versioning is now per-component with a single source each: the server
  version lives only in `server/package.json`, the skill version only in
  `agent-skill/hub` (`VERSION` constant). The repo-root `VERSION` file is
  gone; the PR check validates each component's bump against its fragments.
