"""Unit tests for scripts/consolidate_changelog.py (stdlib only)."""

import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import consolidate_changelog as cc


def make_repo(files: dict[str, str]) -> Path:
    tmp = Path(tempfile.mkdtemp())
    (tmp / "changelog.d").mkdir()
    for name, body in files.items():
        (tmp / "changelog.d" / name).write_text(body)
    (tmp / "CHANGELOG.md").write_text(
        "# Changelog\n\n## [Unreleased]\n\n## [0.2.0] - 2026-10-10\n\n### Added\n- Old thing.\n"
    )
    return tmp


class TestConsolidate(unittest.TestCase):
    def test_no_fragments_is_noop(self):
        repo = make_repo({})
        before = (repo / "CHANGELOG.md").read_text()
        self.assertEqual(cc.consolidate(repo / "changelog.d", repo / "CHANGELOG.md"), 0)
        self.assertEqual((repo / "CHANGELOG.md").read_text(), before)

    def test_fragments_grouped_in_canonical_order(self):
        repo = make_repo(
            {
                "zzz.fixed.md": "- Fixed a bug.\n",
                "aaa.added.md": "- Added a thing.\n- Added another.\n",
            }
        )
        n = cc.consolidate(repo / "changelog.d", repo / "CHANGELOG.md")
        self.assertEqual(n, 2)
        text = (repo / "CHANGELOG.md").read_text()
        # Added section comes before Fixed (canonical order), both under Unreleased.
        unreleased = text.split("## [Unreleased]")[1].split("## [0.2.0]")[0]
        self.assertLess(unreleased.index("### Added"), unreleased.index("### Fixed"))
        self.assertIn("- Added a thing.", unreleased)
        self.assertIn("- Fixed a bug.", unreleased)
        # Fragments deleted; README kept.
        self.assertEqual(
            sorted(p.name for p in (repo / "changelog.d").glob("*.md")), []
        )

    def test_appends_to_existing_section(self):
        repo = make_repo({"one.fixed.md": "- New fix.\n"})
        # Pre-seed a Fixed section under Unreleased.
        cl = repo / "CHANGELOG.md"
        cl.write_text(
            "# Changelog\n\n## [Unreleased]\n\n### Fixed\n- Earlier fix.\n\n## [0.2.0] - 2026-10-10\n"
        )
        cc.consolidate(repo / "changelog.d", cl)
        body = cl.read_text().split("## [Unreleased]")[1].split("## [0.2.0]")[0]
        self.assertIn("- Earlier fix.", body)
        self.assertIn("- New fix.", body)
        self.assertEqual(body.count("### Fixed"), 1)

    def test_bad_fragment_name_rejected(self):
        repo = make_repo({"nope.md": "- x\n"})
        with self.assertRaises(ValueError):
            cc.consolidate(repo / "changelog.d", repo / "CHANGELOG.md")

    def test_bad_fragment_type_rejected(self):
        repo = make_repo({"thing.bogus.md": "- x\n"})
        with self.assertRaises(ValueError):
            cc.consolidate(repo / "changelog.d", repo / "CHANGELOG.md")

    def test_empty_fragment_rejected(self):
        repo = make_repo({"thing.fixed.md": "   \n"})
        with self.assertRaises(ValueError):
            cc.consolidate(repo / "changelog.d", repo / "CHANGELOG.md")

    def test_missing_unreleased_rejected(self):
        repo = make_repo({"thing.fixed.md": "- x\n"})
        (repo / "CHANGELOG.md").write_text("# Changelog\n\n## [0.2.0]\n")
        with self.assertRaises(ValueError):
            cc.consolidate(repo / "changelog.d", repo / "CHANGELOG.md")


if __name__ == "__main__":
    unittest.main()
