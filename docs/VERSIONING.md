# Versioning policy

This project follows [Semantic Versioning 2.0.0](https://semver.org):
`MAJOR.MINOR.PATCH`, starting at `0.1.0`.

## One version per component, one source each

The server and the agent skill version **independently**. Each has exactly
one source of truth — never hardcode a version anywhere else:

| Component | Source | Reported by |
|---|---|---|
| Server (API + dashboard) | `server/package.json` → `version` | `GET /v1/health` (`version`), every log line (`v`) |
| Agent skill (CLI) | `agent-skill/hub` → `VERSION = "x.y.z"` | `hub --version` |

There is no repo-root `VERSION` file. The two components usually release
together, but a server-only change bumps only the server version and vice
versa.

## What bumps what

| Change | Bump | Examples |
|---|---|---|
| **Breaking** | MAJOR | Removing/renaming an API route; changing a request/response shape existing agents depend on; a D1 schema change old code can't read; removing a CLI command or changing its flags incompatibly |
| **Feature** (backwards-compatible) | MINOR | New API route; new CLI command; new optional request field; new dashboard capability |
| **Fix** (backwards-compatible) | PATCH | Bug fixes; **security fixes**; performance fixes; dependency pin updates with no behavior change |

- **Security fixes** bump PATCH (they're backwards-compatible fixes). If a
  security fix *must* break compatibility, it bumps MAJOR and the break is
  called out in the changelog. Security fixes are never bundled silently —
  they get their own release and their own changelog entry.
- **Docs, comments, CI/workflow changes, and repo hygiene do not bump** the
  version — they change no shipped behavior.

## Changelog fragments

Do not edit `CHANGELOG.md` directly in a PR. Instead add one fragment per
notable change in `changelog.d/`, named `<slug>.<type>.md` where type is one
of `added`, `changed`, `deprecated`, `removed`, `fixed`, `security`
(see `changelog.d/README.md`).

When the PR merges, the `Changelog` workflow runs
`scripts/consolidate_changelog.py`, which folds the fragments into
`CHANGELOG.md`'s `## [Unreleased]` section and deletes them. When cutting a
release, rename `## [Unreleased]` to `## [<version>] - <date>`; if the two
components released at different versions, name both
(e.g. `## [server 0.3.0 / skill 0.2.1] - 2026-10-11`).

## How to release

1. Decide the bump per the table above, per component.
2. Bump the component's version in its single source.
3. Add `changelog.d/` fragment(s).
4. Open a PR. CI enforces: functional code changes require a version bump,
   a bump requires fragment(s), and the bump level must cover the fragment
   types (`removed` → major, `added`/`changed`/`deprecated` → minor,
   `fixed`/`security` → patch). Docs-only PRs are exempt.
5. Merge via PR only — direct pushes to `main` are blocked by branch
   protection (see README's repository-settings checklist).

## Observability

The worker emits structured JSON logs (Workers Logs, enabled via
`[observability]` in `server/wrangler.toml`). Every line carries the server
version (`v`), so log streams can be correlated with releases. Invite and
provisioning codes in URL paths are redacted; query strings, tokens, and
bodies are never logged.

## Pre-1.0 note

Per SemVer, anything may break before `1.0.0`, but we still bump MINOR for
features and PATCH for fixes during `0.x` so families can tell releases
apart. The jump to `1.0.0` marks the API as stable.
