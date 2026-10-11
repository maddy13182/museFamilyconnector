# Maintainer's checklist (repository settings)

One-time setup. All available on GitHub Free.

## 1. Branch protection for `main`

Settings → Branches → Add branch protection rule.

- Branch name pattern: `main`
- ☑ **Require a pull request before merging**
  - This blocks ALL direct pushes to `main` — including yours.
- ☑ **Do not allow bypassing the above settings**
  - Applies the rule to administrators too. Without this, you (as admin)
    could still push directly.
- ☑ **Require status checks to pass before merging**
  - ☑ Require branches to be up to date before merging (recommended)
  - Add these required checks (they appear in search after the CI workflow
    has run at least once — open any PR first if the list is empty):
    - `server build + test`
    - `agent CLI tests`
    - `security scan (semgrep + bandit)`
    - `secret scan (gitleaks)`
    - `version bump gate`
- Optional: **Require approvals** = 1 (you approve your own PRs; adds a
  deliberate click per merge — skip it if you want less friction, the
  status checks are the real gate).
- Leave **Lock branch** OFF — that would make `main` fully read-only and
  block even PR merges.

Result: nobody — not you, not anyone — can push to `main` directly.
Every change lands via PR, and a PR can only merge when all five CI jobs
are green.

## 2. Read-only for everyone else

A public repo with no collaborators is already read-only for the world:
non-collaborators cannot create branches, push, or commit. Nothing to
configure.

One honest limit: GitHub does not let public repos disable **forks**, so
anyone can fork and open a PR from their fork. You are never obliged to
merge — unwanted PRs just get closed unmerged.

## 3. Secret hygiene

- Settings → Code security → enable **Push protection** (blocks commits
  containing secrets) and **Secret scanning** (alerts on leaked secrets).
- Never add collaborators unless you mean to grant write access.

## 4. Releases

Follow `docs/VERSIONING.md`: bump `VERSION`, `server/package.json`, and
`agent-skill/hub`, add a `CHANGELOG.md` entry, merge via PR. The
`version bump gate` CI job enforces this automatically.
