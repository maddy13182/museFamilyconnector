# Changelog fragments

Instead of editing `CHANGELOG.md` directly in a PR, add one fragment file
per notable change here. Fragments are consolidated into `CHANGELOG.md`
automatically when the PR merges (see `scripts/consolidate_changelog.py`
and `.github/workflows/changelog.yml`).

## Naming

`<slug>.<type>.md` — for example `health-version.fixed.md`.

- **slug**: short kebab-case description of the change (`worker-logging`,
  `circle-switcher`).
- **type**: one of `added`, `changed`, `deprecated`, `removed`, `fixed`,
  `security` (the [Keep a Changelog](https://keepachangelog.com) sections).

## Content

One or more Markdown bullet points describing the change from the user's
point of view. No heading — the consolidation script files it under the
right section. If the change affects only one component, say so
(`Server:`, `CLI:`).

## Rules (enforced by the PR check)

- A PR that changes functional code must bump the affected component's
  version **and** add at least one fragment.
- The version bump must be at least what the fragment types require:
  `removed` → major, `added`/`changed`/`deprecated` → minor,
  `fixed`/`security` → patch.
- Docs-only PRs need neither a bump nor fragments.
