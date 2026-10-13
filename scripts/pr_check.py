#!/usr/bin/env python3
"""PR check: version bumps and changelog fragments must match code changes.

Compares <base>...HEAD (default base: origin/main). Fails with a message on
stderr when:
  - functional code changed but the component's version was not bumped,
  - bundled skill docs changed (SKILL.md, references/, INSTALL.md,
    requirements.txt) but the SKILL VERSION header was not bumped
    (decoupled releases: doc changes ship via skill-v* releases),
  - a version was bumped but no changelog fragment was added,
  - a fragment has a bad name/type or is empty,
  - the bump level is smaller than the fragment types require
    (removed -> major, added/changed/deprecated -> minor, fixed/security -> patch).

Docs-only PRs (no functional changes) are exempt. Dependency-only bumps to
server/package.json that leave the version field untouched are not treated
as version bumps.

Usage: python3 scripts/pr_check.py [--base origin/main]
"""

import argparse
import json
import re
import subprocess
import sys

SEMVER_RE = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")
FRAG_RE = re.compile(r"^(?P<slug>[a-z0-9][a-z0-9-]*)\.(?P<type>[a-z]+)\.md$")

# Minimum bump level each fragment type requires: 2 = major, 1 = minor, 0 = patch.
TYPE_LEVEL = {
    "removed": 2,
    "added": 1,
    "changed": 1,
    "deprecated": 1,
    "fixed": 0,
    "security": 0,
}
LEVEL_NAME = {2: "major", 1: "minor", 0: "patch"}

SERVER_VERSION_FILE = "server/package.json"
SKILL_VERSION_FILE = "agent-skill/hub"
SKILL_VERSION_RE = re.compile(r'^VERSION = "([^"]+)"', re.M)
# Contract C6: pyproject.toml is the single source of truth for the CLI version.
SKILL_TOML_FILE = "agent-skill/pyproject.toml"
SKILL_TOML_VERSION_RE = re.compile(r'^version\s*=\s*"([^"]+)"', re.M)
# Decoupled releases: the skill ships on its own cadence. These are the
# agent-skill/ paths bundled into skill.tar.gz (see release.yml); changing
# any of them requires a SKILL VERSION header bump so the change ships.
SKILL_DOC_PATHS = (
    "agent-skill/SKILL.md",
    "agent-skill/INSTALL.md",
    "agent-skill/requirements.txt",
)
SKILL_DOCS_PREFIX = "agent-skill/references/"
SKILL_HEADER_FILE = "agent-skill/SKILL.md"
SKILL_HEADER_RE = re.compile(r"<!--\s*SKILL VERSION:\s*([0-9A-Za-z.\-+]+)\s*-->")


def sh(*args: str) -> str:
    return subprocess.run(args, capture_output=True, text=True, check=True).stdout


def semver(v: str) -> tuple[int, int, int]:
    m = SEMVER_RE.match(v or "")
    if not m:
        raise ValueError(f"not valid semver: {v!r}")
    return (int(m.group(1)), int(m.group(2)), int(m.group(3)))


def bump_level(old: tuple[int, int, int], new: tuple[int, int, int]) -> int:
    if new[0] != old[0]:
        return 2
    if new[1] != old[1]:
        return 1
    return 0


def file_at(ref: str, path: str) -> str | None:
    p = subprocess.run(
        ["git", "show", f"{ref}:{path}"], capture_output=True, text=True
    )
    return p.stdout if p.returncode == 0 else None


def server_version_at(ref: str | None) -> str:
    raw = file_at(ref, SERVER_VERSION_FILE) if ref else open(SERVER_VERSION_FILE).read()
    if raw is None:
        raise ValueError(f"{SERVER_VERSION_FILE} missing at {ref}")
    return json.loads(raw)["version"]


def skill_version_at(ref: str | None) -> str:
    # Contract C6: prefer pyproject.toml (single source of truth); fall back
    # to the legacy VERSION constant in agent-skill/hub for old branches.
    toml_raw = file_at(ref, SKILL_TOML_FILE) if ref else _read_worktree(SKILL_TOML_FILE)
    if toml_raw:
        m = SKILL_TOML_VERSION_RE.search(toml_raw)
        if m:
            return m.group(1)
    raw = file_at(ref, SKILL_VERSION_FILE) if ref else open(SKILL_VERSION_FILE).read()
    if raw is None:
        raise ValueError(f"{SKILL_VERSION_FILE} missing at {ref}")
    m = SKILL_VERSION_RE.search(raw)
    if not m:
        raise ValueError(f"no VERSION = ... constant in {SKILL_VERSION_FILE} at {ref or 'worktree'}")
    return m.group(1)


def skill_header_version_at(ref: str | None) -> str:
    raw = file_at(ref, SKILL_HEADER_FILE) if ref else _read_worktree(SKILL_HEADER_FILE)
    if raw is None:
        raise ValueError(f"{SKILL_HEADER_FILE} missing at {ref}")
    m = SKILL_HEADER_RE.search(raw[:4096])
    if not m:
        raise ValueError(f"no SKILL VERSION header in {SKILL_HEADER_FILE} at {ref or 'worktree'}")
    return m.group(1)


def _read_worktree(path: str) -> str | None:
    try:
        with open(path) as fh:
            return fh.read()
    except OSError:
        return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="origin/main")
    args = ap.parse_args()
    base = args.base

    changed = sh("git", "diff", "--name-only", f"{base}...HEAD", "--").split()
    server_changed = any(
        p.startswith("server/src/") or p.startswith("server/migrations/") for p in changed
    )
    skill_changed = any(p == "agent-skill/hub" for p in changed)
    # Decoupled releases: bundled skill docs (SKILL.md, references/,
    # INSTALL.md, requirements.txt) ship via skill-v* releases, so a
    # change to any of them requires a SKILL VERSION header bump.
    skill_docs_changed = any(
        p in SKILL_DOC_PATHS or p.startswith(SKILL_DOCS_PREFIX) for p in changed
    )

    errors: list[str] = []

    # Per-component version checks.
    bumps: dict[str, tuple[tuple[int, int, int], tuple[int, int, int]]] = {}
    if server_changed:
        try:
            old, new = semver(server_version_at(base)), semver(server_version_at(None))
            if new <= old:
                errors.append(
                    f"server code changed but {SERVER_VERSION_FILE} version not bumped "
                    f"(base {'.'.join(map(str, old))}, now {'.'.join(map(str, new))})"
                )
            else:
                bumps["server"] = (old, new)
        except ValueError as e:
            errors.append(str(e))
    if skill_changed:
        try:
            old, new = semver(skill_version_at(base)), semver(skill_version_at(None))
            if new <= old:
                errors.append(
                    f"agent-skill/hub changed but its VERSION not bumped "
                    f"(base {'.'.join(map(str, old))}, now {'.'.join(map(str, new))})"
                )
            else:
                bumps["skill"] = (old, new)
        except ValueError as e:
            errors.append(str(e))
    if skill_docs_changed:
        try:
            old, new = semver(skill_header_version_at(base)), semver(
                skill_header_version_at(None)
            )
            if new <= old:
                errors.append(
                    f"skill docs changed but the SKILL VERSION header in "
                    f"{SKILL_HEADER_FILE} was not bumped "
                    f"(base {'.'.join(map(str, old))}, now {'.'.join(map(str, new))}); "
                    f"skill-only doc changes ship via skill-v* releases)"
                )
            else:
                bumps["skill_docs"] = (old, new)
        except ValueError as e:
            errors.append(str(e))

    # Fragments added in this PR.
    added = sh(
        "git", "diff", "--name-only", "--diff-filter=A", f"{base}...HEAD",
        "--", "changelog.d/",
    ).split()
    frag_types: list[str] = []
    for path in added:
        name = path.split("/", 1)[1] if "/" in path else path
        if name == "README.md":
            continue
        m = FRAG_RE.match(name)
        if not m or m.group("type") not in TYPE_LEVEL:
            errors.append(
                f"bad fragment {path}: want changelog.d/<slug>.<type>.md "
                f"with type in {sorted(TYPE_LEVEL)}"
            )
            continue
        body = open(path).read().strip()
        if not body:
            errors.append(f"empty fragment: {path}")
            continue
        frag_types.append(m.group("type"))

    if bumps and not frag_types:
        errors.append(
            "version bumped but no changelog fragment added; "
            "add changelog.d/<slug>.<type>.md (see changelog.d/README.md)"
        )

    # Bump level must cover the fragment types.
    if bumps and frag_types:
        required = max(TYPE_LEVEL[t] for t in frag_types)
        for comp, (old, new) in bumps.items():
            actual = bump_level(old, new)
            if actual < required:
                errors.append(
                    f"{comp} bump {'.'.join(map(str, old))} -> {'.'.join(map(str, new))} "
                    f"is {LEVEL_NAME[actual]} but fragments require "
                    f"{LEVEL_NAME[required]}"
                )

    if "CHANGELOG.md" in changed:
        print(
            "notice: CHANGELOG.md edited directly; prefer fragments in "
            "changelog.d/ (consolidated on merge)",
            file=sys.stderr,
        )

    if errors:
        for e in errors:
            print(f"::error::{e}")
        return 1
    print("pr check passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
