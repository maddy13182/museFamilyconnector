"""Unit + integration tests for scripts/pr_check.py (stdlib only)."""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pr_check as pc


def git(*args: str, cwd: Path) -> str:
    return subprocess.run(
        ["git", *args], capture_output=True, text=True, check=True, cwd=cwd
    ).stdout


def init_repo() -> Path:
    tmp = Path(tempfile.mkdtemp())
    git("init", "-q", cwd=tmp)
    git("config", "user.email", "t@t", cwd=tmp)
    git("config", "user.name", "t", cwd=tmp)
    (tmp / "server").mkdir()
    (tmp / "server" / "src").mkdir()
    (tmp / "server" / "package.json").write_text(json.dumps({"version": "0.2.0"}))
    (tmp / "server" / "src" / "index.ts").write_text("// v1\n")
    (tmp / "agent-skill").mkdir()
    (tmp / "agent-skill" / "hub").write_text('#!/usr/bin/env python3\nVERSION = "0.2.0"\n')
    (tmp / "changelog.d").mkdir()
    (tmp / "changelog.d" / "README.md").write_text("fragments\n")
    (tmp / "CHANGELOG.md").write_text("# Changelog\n\n## [Unreleased]\n")
    git("add", "-A", cwd=tmp)
    git("commit", "-qm", "base", cwd=tmp)
    return tmp


def run_check(repo: Path, base: str = "main") -> tuple[int, str]:
    # pr_check.main uses argparse + sys.exit; drive it via subprocess for isolation.
    script = Path(__file__).resolve().parent.parent / "pr_check.py"
    p = subprocess.run(
        [sys.executable, str(script), "--base", base],
        capture_output=True,
        text=True,
        cwd=repo,
    )
    return p.returncode, p.stdout + p.stderr


class TestHelpers(unittest.TestCase):
    def test_semver(self):
        self.assertEqual(pc.semver("0.3.0"), (0, 3, 0))
        with self.assertRaises(ValueError):
            pc.semver("1.2")
        with self.assertRaises(ValueError):
            pc.semver("v1.2.3")

    def test_bump_level(self):
        self.assertEqual(pc.bump_level((0, 2, 0), (0, 2, 1)), 0)
        self.assertEqual(pc.bump_level((0, 2, 0), (0, 3, 0)), 1)
        self.assertEqual(pc.bump_level((0, 2, 0), (1, 0, 0)), 2)


class TestPrCheckIntegration(unittest.TestCase):
    def setUp(self):
        self.repo = init_repo()
        git("branch", "-M", "main", cwd=self.repo)
        git("checkout", "-qb", "feature", cwd=self.repo)

    def commit_all(self, msg: str = "change"):
        git("add", "-A", cwd=self.repo)
        git("commit", "-qm", msg, cwd=self.repo)

    def bump_server(self, version: str):
        p = self.repo / "server" / "package.json"
        d = json.loads(p.read_text())
        d["version"] = version
        p.write_text(json.dumps(d))

    def test_functional_change_without_bump_fails(self):
        (self.repo / "server" / "src" / "index.ts").write_text("// v2\n")
        self.commit_all()
        rc, out = run_check(self.repo)
        self.assertNotEqual(rc, 0)
        self.assertIn("not bumped", out)

    def test_bump_without_fragment_fails(self):
        (self.repo / "server" / "src" / "index.ts").write_text("// v2\n")
        self.bump_server("0.2.1")
        self.commit_all()
        rc, out = run_check(self.repo)
        self.assertNotEqual(rc, 0)
        self.assertIn("no changelog fragment", out)

    def test_bump_with_fragment_passes(self):
        (self.repo / "server" / "src" / "index.ts").write_text("// v2\n")
        self.bump_server("0.2.1")
        (self.repo / "changelog.d" / "thing.fixed.md").write_text("- Fixed.\n")
        self.commit_all()
        rc, out = run_check(self.repo)
        self.assertEqual(rc, 0, out)

    def test_added_fragment_requires_minor(self):
        (self.repo / "server" / "src" / "index.ts").write_text("// v2\n")
        self.bump_server("0.2.1")  # patch, but fragment is 'added'
        (self.repo / "changelog.d" / "thing.added.md").write_text("- Added.\n")
        self.commit_all()
        rc, out = run_check(self.repo)
        self.assertNotEqual(rc, 0)
        self.assertIn("require minor", out)

    def test_bad_fragment_name_fails(self):
        (self.repo / "server" / "src" / "index.ts").write_text("// v2\n")
        self.bump_server("0.3.0")
        (self.repo / "changelog.d" / "nope.md").write_text("- x\n")
        self.commit_all()
        rc, out = run_check(self.repo)
        self.assertNotEqual(rc, 0)
        self.assertIn("bad fragment", out)

    def test_skill_bump_independent(self):
        # Skill-only change: only the skill version must bump, not the server's.
        (self.repo / "agent-skill" / "hub").write_text(
            '#!/usr/bin/env python3\nVERSION = "0.3.0"\n# new command\n'
        )
        (self.repo / "changelog.d" / "thing.added.md").write_text("- CLI: new.\n")
        self.commit_all()
        rc, out = run_check(self.repo)
        self.assertEqual(rc, 0, out)

    def test_docs_only_passes_without_bump(self):
        (self.repo / "CHANGELOG.md").write_text("# Changelog\n\n## [Unreleased]\n- typo\n")
        self.commit_all("docs")
        rc, out = run_check(self.repo)
        self.assertEqual(rc, 0, out)


if __name__ == "__main__":
    unittest.main()
