#!/usr/bin/env python3
"""Tests for WS-A (client packaging & versioning).

- CLI version is read from the single source of truth
  (`agent-skill/pyproject.toml`, contract C6), never hardcoded.
- Skill version (SKILL.md header) is in lockstep with the CLI version.
- `hub --version` reports both; mismatch is detectable.
- Every request sends `User-Agent: family-hub-agent/<real version>`.
- `requirements.lock` agrees with `requirements.txt` (lockfile freshness;
  CI installs from the lockfile).

Run from the repo root:
    python3 -m unittest discover -s agent-skill/tests -v
"""

import importlib.util
import json
import os
import re
import subprocess
import sys
import unittest
from importlib.machinery import SourceFileLoader

HERE = os.path.dirname(os.path.abspath(__file__))
AGENT_SKILL = os.path.dirname(HERE)
HUB_PATH = os.path.join(HERE, "..", "hub")
PYPROJECT_PATH = os.path.join(AGENT_SKILL, "pyproject.toml")
SKILL_MD_PATH = os.path.join(AGENT_SKILL, "SKILL.md")
REQUIREMENTS_PATH = os.path.join(AGENT_SKILL, "requirements.txt")
LOCKFILE_PATH = os.path.join(AGENT_SKILL, "requirements.lock")

spec = importlib.util.spec_from_file_location(
    "hubcli_packaging", HUB_PATH, loader=SourceFileLoader("hubcli_packaging", HUB_PATH)
)
hub = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hub)


def _pyproject_version():
    with open(PYPROJECT_PATH, "r", encoding="utf-8") as f:
        text = f.read()
    match = re.search(r'^version\s*=\s*"([^"]+)"', text, re.M)
    assert match, "pyproject.toml must declare a version"
    return match.group(1)


class _Recorder:
    """Minimal transport that records the headers of every request."""

    def __init__(self):
        self.calls = []

    def __call__(self, method, url, headers, body_bytes):
        self.calls.append(dict(headers))
        return 200, json.dumps({"ok": True})


def _pins(path):
    """Parse `name==version` pins from a requirements file (comments ignored)."""
    pins = {}
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.split("#", 1)[0].strip().rstrip("\\").strip()
            if not line or line.startswith("--"):
                continue
            name, _, version = line.partition("==")
            name, version = name.strip().lower(), version.strip()
            if name and version:
                pins[name] = version
    return pins


class VersionSourceTests(unittest.TestCase):
    def test_version_is_not_hardcoded_in_hub(self):
        with open(HUB_PATH, "r", encoding="utf-8") as f:
            source = f.read()
        self.assertNotRegex(source, r'^VERSION\s*=\s*"[0-9]')

    def test_cli_version_matches_pyproject(self):
        # The CLI reads its version from the single source of truth.
        self.assertEqual(hub.VERSION, _pyproject_version())

    def test_skill_version_in_lockstep_with_cli(self):
        self.assertEqual(hub.SKILL_VERSION, hub.VERSION)

    def test_skill_md_has_version_header(self):
        with open(SKILL_MD_PATH, "r", encoding="utf-8") as f:
            head = f.read(2048)
        match = re.search(r"<!--\s*SKILL VERSION:\s*([0-9A-Za-z.\-+]+)\s*-->", head)
        self.assertIsNotNone(match, "SKILL.md must carry a SKILL VERSION header")
        self.assertEqual(match.group(1), _pyproject_version())

    def test_version_output_reports_both_versions(self):
        proc = subprocess.run(
            [sys.executable, HUB_PATH, "--version"],
            capture_output=True,
            text=True,
            timeout=60,
        )
        self.assertEqual(proc.returncode, 0)
        output = proc.stdout.strip()
        self.assertEqual(
            output, "hub %s (skill %s)" % (_pyproject_version(), _pyproject_version())
        )


class UserAgentTests(unittest.TestCase):
    def test_user_agent_carries_real_version(self):
        recorder = _Recorder()
        client = hub.HubClient("https://hub.example", transport=recorder)
        client.call("GET", "/v1/health", auth=False)
        self.assertTrue(recorder.calls)
        self.assertEqual(
            recorder.calls[0]["User-Agent"],
            "family-hub-agent/" + _pyproject_version(),
        )

    def test_legacy_hardcoded_user_agent_removed(self):
        # The legacy `family-hub-agent/1.0` string is a WS-B sentinel for
        # unversioned clients; the CLI must never send it anymore.
        with open(HUB_PATH, "r", encoding="utf-8") as f:
            source = f.read()
        self.assertNotIn('"family-hub-agent/1.0"', source)
        self.assertNotIn("'family-hub-agent/1.0'", source)


class LockfileTests(unittest.TestCase):
    def test_lockfile_exists_and_is_hashed(self):
        self.assertTrue(os.path.exists(LOCKFILE_PATH), "requirements.lock missing")
        with open(LOCKFILE_PATH, "r", encoding="utf-8") as f:
            content = f.read()
        self.assertIn("--hash=sha256:", content)

    def test_lockfile_freshness(self):
        # CI installs from the lockfile; it must agree with the pinned
        # requirements.txt. Regenerate with:
        #   pip-compile --generate-hashes agent-skill/requirements.txt \
        #     -o agent-skill/requirements.lock
        required = _pins(REQUIREMENTS_PATH)
        locked = _pins(LOCKFILE_PATH)
        self.assertTrue(required, "requirements.txt has no pins")
        for name, version in required.items():
            self.assertIn(name, locked, "lockfile missing pin for %s" % name)
            self.assertEqual(
                locked[name],
                version,
                "lockfile pins %s==%s but requirements.txt says %s"
                % (name, locked[name], version),
            )


if __name__ == "__main__":
    unittest.main()
