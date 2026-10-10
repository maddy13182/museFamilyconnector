# Versioning policy

This project follows [Semantic Versioning 2.0.0](https://semver.org):
`MAJOR.MINOR.PATCH`, starting at `0.1.0`.

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

## Where the version lives (all three, always in sync)

1. `VERSION` — the canonical version, at the repo root.
2. `server/package.json` — the `version` field.
3. `agent-skill/hub` — the `VERSION = "x.y.z"` constant (reported by `hub --version`).

CI's `version-check` job fails the PR if these three disagree.

## How to release

1. Decide the bump per the table above.
2. Update all three version locations.
3. Add a `CHANGELOG.md` entry under a new version heading (see
   [Keep a Changelog](https://keepachangelog.com) format used there).
4. Open a PR. CI enforces: functional code changes require a version bump,
   and a version bump requires a changelog entry. Docs-only PRs are exempt
   from the bump requirement.
5. Merge via PR only — direct pushes to `main` are blocked by branch
   protection (see README's repository-settings checklist).

## Pre-1.0 note

Per SemVer, anything may break before `1.0.0`, but we still bump MINOR for
features and PATCH for fixes during `0.x` so families can tell releases
apart. The jump to `1.0.0` marks the API as stable.
