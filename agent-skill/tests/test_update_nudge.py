#!/usr/bin/env python3
"""Update advertisement: `hub sync` nudges on stderr when the server's
`versions` stanza advertises newer CLI/skill releases (decoupled releases).

- newer CLI advertised -> CLI nudge on stderr
- newer skill advertised -> skill nudge on stderr
- current/older/missing/malformed -> silent
- the nudge never raises and never touches the sync result

Run from agent-skill/:  python3 -m pytest tests/test_update_nudge.py -q
"""

import contextlib
import importlib.util
import io
import unittest
from unittest import mock


import os
from importlib.machinery import SourceFileLoader

HERE = os.path.dirname(os.path.abspath(__file__))
HUB_PATH = os.path.join(HERE, "..", "hub")

spec = importlib.util.spec_from_file_location(
    "hubcli", HUB_PATH, loader=SourceFileLoader("hubcli", HUB_PATH)
)
hub = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hub)


def _nudge_stderr(versions, cli_version="1.1.0", skill_version="1.1.0"):
    err = io.StringIO()
    with mock.patch.object(hub, "VERSION", cli_version), mock.patch.object(
        hub, "SKILL_VERSION", skill_version
    ), contextlib.redirect_stderr(err):
        hub._maybe_nudge_updates(versions)
    return err.getvalue()


class TestUpdateNudge(unittest.TestCase):
    def test_newer_cli_nudges(self):
        err = _nudge_stderr({"cli": "1.2.0", "skill": "1.1.0", "server": "1.2.0"})
        assert "CLI 1.2.0" in err and "hub upgrade" in err, err
        assert "skill" not in err.lower().replace("skill docs", ""), err

    def test_newer_skill_nudges(self):
        err = _nudge_stderr({"cli": "1.1.0", "skill": "1.2.0", "server": "1.2.0"})
        assert "skill 1.2.0" in err and "hub upgrade" in err, err

    def test_both_nudge(self):
        err = _nudge_stderr({"cli": "2.0.0", "skill": "2.0.0", "server": "2.0.0"})
        assert "CLI 2.0.0" in err and "skill 2.0.0" in err, err

    def test_current_versions_silent(self):
        assert _nudge_stderr({"cli": "1.1.0", "skill": "1.1.0"}) == ""
        assert _nudge_stderr({"cli": "1.0.0", "skill": "1.0.0"}) == ""

    def test_missing_stanza_silent(self):
        assert _nudge_stderr(None) == ""
        assert _nudge_stderr({}) == ""
        assert _nudge_stderr("garbage") == ""

    def test_malformed_versions_silent(self):
        assert _nudge_stderr({"cli": "not-a-version", "skill": "1.1.0"}) == ""
        assert _nudge_stderr({"cli": "1.1.0", "skill": None}) == ""
        assert _nudge_stderr({"cli": 123, "skill": "1.1.0"}) == ""  # non-str ignored

    def test_safe_is_newer_never_raises(self):
        assert hub._safe_is_newer("1.2.0", "1.1.0") is True
        assert hub._safe_is_newer("1.1.0", "1.1.0") is False
        assert hub._safe_is_newer("garbage", "1.1.0") is False
        assert hub._safe_is_newer("1.1.0", "garbage") is False


if __name__ == "__main__":
    unittest.main()
