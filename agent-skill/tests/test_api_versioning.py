#!/usr/bin/env python3
"""Tests for the API versioning contract (spec §1, §4.2-§4.5, CLI rows).

Covers: the _MIN_SERVER_VERSION constant; the per-invocation server
check (exact too-old message, missing api_versions/version -> too old,
unreachable -> connection error, result cached per process); the 426
client_too_old and 410 expired mappings; and that --version/--help and
local-only commands are unaffected by the health check.

Run from the repo root:
    python3 -m unittest discover -s agent-skill/tests -v
"""

import contextlib
import importlib.util
import io
import json
import os
import shutil
import tempfile
import unittest
import urllib.parse as urlparse
from importlib.machinery import SourceFileLoader
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
HUB_PATH = os.path.join(HERE, "..", "hub")

spec = importlib.util.spec_from_file_location(
    "hubcli_versioning", HUB_PATH, loader=SourceFileLoader("hubcli_versioning", HUB_PATH)
)
hub = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hub)


UNREACHABLE = object()


class FakeHub:
    """Canned transport; /v1/health is served from the `health` kwarg."""

    def __init__(self, health=None):
        self.health = health
        self.routes = {}
        self.calls = []

    def add(self, method, path, status, body):
        self.routes[(method.upper(), path)] = (status, body)

    def __call__(self, method, url, headers, body_bytes):
        self.calls.append(
            {
                "method": method,
                "url": url,
                "headers": dict(headers),
                "body": body_bytes.decode("utf-8") if body_bytes else None,
            }
        )
        path = urlparse.urlparse(url).path
        if path == "/v1/health":
            if self.health is UNREACHABLE:
                # Mirror HubClient._urllib_transport's URLError handling.
                raise hub.HubError(
                    "connection",
                    "Cannot reach https://hub.example.test: <urlopen error>",
                )
            return 200, json.dumps(self.health)
        key = (method.upper(), path)
        if key in self.routes:
            status, body = self.routes[key]
        else:
            status, body = 404, {
                "error": {"code": "not_found", "message": "no route"}
            }
        return status, json.dumps(body)

    def health_calls(self):
        return [
            c for c in self.calls
            if urlparse.urlparse(c["url"]).path == "/v1/health"
        ]


@contextlib.contextmanager
def captured():
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        yield out, err


HEALTH_OK = {"ok": True, "version": "0.12.0", "api_versions": ["v1"]}
# The 0.11.0 shape: health exists but carries no api_versions.
HEALTH_OLD = {"ok": True, "version": "0.11.0"}


class VersionCheckBase(unittest.TestCase):
    def setUp(self):
        self._saved_env = dict(os.environ)
        self.tmp = tempfile.mkdtemp(prefix="hubtest-ver-")
        os.environ["FAMILY_HUB_CONFIG_HOME"] = self.tmp
        os.environ["FAMILY_HUB_TOKEN"] = "fh_testtoken"
        os.environ.pop("FAMILY_HUB_VAULT_CMD", None)
        hub._reset_server_version_cache()
        self.fake = None

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._saved_env)
        shutil.rmtree(self.tmp, ignore_errors=True)
        hub.clear_secrets()
        hub._reset_server_version_cache()

    def seed_config(self, **over):
        cfg = {"server_url": "https://hub.example.test"}
        cfg.update(over)
        hub.save_config("default", cfg)

    def run_cli(self, argv, health=HEALTH_OK):
        self.fake = FakeHub(health=health)
        with captured() as (out, err):
            rc = hub.main(argv, transport=self.fake)
        return rc, out.getvalue(), err.getvalue()

    def exact_too_old(self, srv_ver):
        return (
            "hub %s needs server 0.12.0+ (this server runs %s). "
            "Ask the server operator to upgrade." % (hub.VERSION, srv_ver)
        )


# ---------------------------------------------------------------------------
# The constant
# ---------------------------------------------------------------------------


class MinServerVersionTest(unittest.TestCase):
    def test_floor_is_0_12_0(self):
        self.assertEqual(hub._MIN_SERVER_VERSION, "0.12.0")

    def test_floor_is_valid_semver(self):
        hub._parse_version(hub._MIN_SERVER_VERSION)


# ---------------------------------------------------------------------------
# Per-invocation server check through main()
# ---------------------------------------------------------------------------


class ServerCheckTest(VersionCheckBase):
    def test_too_old_server_fails_before_any_command(self):
        self.seed_config()
        rc, _out, err = self.run_cli(["topics"], health=HEALTH_OLD)
        self.assertEqual(rc, 1)
        self.assertIn(self.exact_too_old("0.11.0"), err)
        # The command itself never ran: only the health check hit the wire.
        self.assertEqual(len(self.fake.calls), 1)
        self.assertEqual(len(self.fake.health_calls()), 1)

    def test_too_old_version_with_api_versions_still_fails(self):
        health = {"ok": True, "version": "0.11.9", "api_versions": ["v1"]}
        self.seed_config()
        rc, _out, err = self.run_cli(["topics"], health=health)
        self.assertEqual(rc, 1)
        self.assertIn(self.exact_too_old("0.11.9"), err)

    def test_health_missing_api_versions_is_too_old(self):
        health = {"ok": True, "version": "0.12.0"}  # version ok, contract missing
        self.seed_config()
        rc, _out, err = self.run_cli(["topics"], health=health)
        self.assertEqual(rc, 1)
        self.assertIn(self.exact_too_old("0.12.0"), err)

    def test_health_missing_version_is_too_old(self):
        self.seed_config()
        rc, _out, err = self.run_cli(["topics"], health={"ok": True})
        self.assertEqual(rc, 1)
        self.assertIn(self.exact_too_old("unknown"), err)

    def test_api_versions_without_v1_is_too_old(self):
        health = {"ok": True, "version": "0.12.0", "api_versions": ["v2"]}
        self.seed_config()
        rc, _out, err = self.run_cli(["topics"], health=health)
        self.assertEqual(rc, 1)
        self.assertIn(self.exact_too_old("0.12.0"), err)

    def test_unreachable_server_is_connection_error_not_version_error(self):
        self.seed_config()
        rc, _out, err = self.run_cli(["topics"], health=UNREACHABLE)
        self.assertEqual(rc, 1)
        self.assertIn("Cannot reach", err)
        self.assertNotIn("needs server", err)

    def test_current_server_passes_and_command_runs(self):
        self.seed_config()
        self.fake = FakeHub(health=HEALTH_OK)
        self.fake.add("GET", "/v1/topics", 200, {"topics": []})
        with captured() as (out, err):
            rc = hub.main(["topics"], transport=self.fake)
        self.assertEqual(rc, 0, err)
        self.assertEqual(len(self.fake.health_calls()), 1)

    def test_health_check_is_unauthenticated(self):
        self.seed_config()
        self.run_cli(["topics"])
        for call in self.fake.health_calls():
            self.assertNotIn("Authorization", call["headers"])

    def test_check_cached_one_call_per_process(self):
        self.seed_config()
        self.fake = FakeHub(health=HEALTH_OK)
        self.fake.add("GET", "/v1/topics", 200, {"topics": []})
        with captured():
            hub.main(["topics"], transport=self.fake)
        with captured():
            hub.main(["topics"], transport=self.fake)
        # Two invocations, one health fetch: cached per process per server.
        self.assertEqual(len(self.fake.health_calls()), 1)

    def test_no_server_configured_is_config_error_not_version_error(self):
        # No config at all: the existing clear config error, not a version error.
        rc, _out, err = self.run_cli(["topics"])
        self.assertEqual(rc, 1)
        self.assertIn("No server configured", err)
        self.assertNotIn("needs server", err)


# ---------------------------------------------------------------------------
# Exemptions: --version / --help / local-only commands
# ---------------------------------------------------------------------------


class ExemptionsTest(VersionCheckBase):
    def test_version_flag_needs_no_server(self):
        # No config seeded at all: --version must still work.
        with captured() as (out, err):
            with self.assertRaises(SystemExit) as cm:
                hub.main(["--version"])
        self.assertEqual(cm.exception.code, 0)
        self.assertIn("hub " + hub.VERSION, out.getvalue())

    def test_help_needs_no_server(self):
        with captured() as (out, err):
            with self.assertRaises(SystemExit) as cm:
                hub.main(["--help"])
        self.assertEqual(cm.exception.code, 0)
        self.assertIn("Family Hub agent CLI", out.getvalue())

    def test_local_commands_skip_the_check(self):
        # rollback/verify-install never touch the server: with an ancient
        # server they must fail on their own terms, never on the version
        # check (and with no config at all, never on the config check).
        rc, _out, err = self.run_cli(["rollback"], health=HEALTH_OLD)
        self.assertEqual(rc, 1)
        self.assertIn("No previous binary", err)
        self.assertNotIn("needs server", err)
        self.assertEqual(self.fake.calls, [])

        rc, out, err = self.run_cli(["verify-install"], health=HEALTH_OLD)
        self.assertNotIn("needs server", err)
        self.assertEqual(self.fake.calls, [])


# ---------------------------------------------------------------------------
# 426 client_too_old and 410 expired
# ---------------------------------------------------------------------------


class VersionContractErrorsTest(unittest.TestCase):
    def test_426_surfaces_server_upgrade_message(self):
        message = (
            "Client 0.9.0 is below the server's minimum 0.10.0. "
            "Run `hub upgrade` to install the signed release."
        )
        exc = hub._friendly_from_http(
            426, {"error": {"code": "client_too_old", "message": message}}
        )
        self.assertEqual(exc.code, "client_too_old")
        self.assertIn(message, str(exc))
        # The friendly hint also points at the self-heal path.
        self.assertIn("hub upgrade", exc.friendly())

    def test_426_unknown_code_falls_back_to_error(self):
        exc = hub._friendly_from_http(
            426, {"error": {"code": "mystery", "message": "weird"}}
        )
        self.assertEqual(exc.code, "error")
        self.assertIn("http 426", str(exc))

    def test_410_maps_to_expired(self):
        exc = hub._friendly_from_http(
            410, {"error": {"code": "something_else", "message": "gone"}}
        )
        self.assertEqual(exc.code, "expired")
        self.assertEqual(exc.exit_code, 1)

    def test_410_trusted_server_codes_pass_through(self):
        for code in (
            "invite_expired",
            "code_expired",
            "transfer_expired",
            "transfer_recipient_gone",
        ):
            exc = hub._friendly_from_http(
                410, {"error": {"code": code, "message": "expired thing"}}
            )
            self.assertEqual(exc.code, code)
            # The verbatim server code is preserved for programmatic use.
            self.assertEqual(exc.server_code, code)


# ---------------------------------------------------------------------------
# Version-compare and API-major selection units
# ---------------------------------------------------------------------------


class VersionCompareUnitsTest(unittest.TestCase):
    def test_at_least(self):
        self.assertTrue(hub._version_at_least("0.12.0", "0.12.0"))
        self.assertTrue(hub._version_at_least("0.13.0", "0.12.0"))
        self.assertTrue(hub._version_at_least("1.0.0", "0.12.0"))
        self.assertFalse(hub._version_at_least("0.11.0", "0.12.0"))
        self.assertFalse(hub._version_at_least("0.11.99", "0.12.0"))

    def test_prerelease_of_floor_does_not_satisfy(self):
        self.assertFalse(hub._version_at_least("0.12.0-rc1", "0.12.0"))

    def test_garbage_never_satisfies(self):
        self.assertFalse(hub._version_at_least("soon", "0.12.0"))
        self.assertFalse(hub._version_at_least(None, "0.12.0"))
        self.assertFalse(hub._version_at_least(123, "0.12.0"))

    def test_select_api_major(self):
        self.assertEqual(hub._select_api_major(["v1"]), "v1")
        self.assertEqual(hub._select_api_major(["v2", "v1"]), "v1")
        self.assertIsNone(hub._select_api_major(["v2"]))
        self.assertIsNone(hub._select_api_major([]))
        self.assertIsNone(hub._select_api_major(None))
        self.assertIsNone(hub._select_api_major("v1"))

    def test_apply_api_major_defaults_to_v1(self):
        self.assertEqual(hub._apply_api_major("/v1/topics"), "/v1/topics")

    def test_apply_api_major_rewrites_when_selected(self):
        saved = hub._api_major
        try:
            hub._api_major = "v2"
            self.assertEqual(hub._apply_api_major("/v1/topics"), "/v2/topics")
            # Non-API paths are untouched.
            self.assertEqual(hub._apply_api_major("/health"), "/health")
        finally:
            hub._api_major = saved


# ---------------------------------------------------------------------------
# No bypass surface for the check
# ---------------------------------------------------------------------------


class NoBypassTest(unittest.TestCase):
    def test_no_skip_env_or_flag_in_source(self):
        with open(HUB_PATH, "r", encoding="utf-8") as fh:
            src = fh.read()
        for token in (
            "SKIP_VERSION",
            "SKIP_SERVER_CHECK",
            "NO_VERSION_CHECK",
            "DISABLE_VERSION",
            "--skip-version-check",
        ):
            self.assertNotIn(token, src)

    def test_too_old_server_cannot_be_overridden_by_env(self):
        # Even with every plausible knob set, a too-old server still fails.
        base = VersionCheckBase()
        base.setUp()
        try:
            base.seed_config()
            with mock.patch.dict(
                os.environ,
                {
                    "FAMILY_HUB_URL": "https://hub.example.test",
                    "HUB_SKIP_VERSION_CHECK": "1",
                },
            ):
                rc, _out, err = base.run_cli(["topics"], health=HEALTH_OLD)
            self.assertEqual(rc, 1)
            self.assertIn("needs server 0.12.0+", err)
        finally:
            base.tearDown()


if __name__ == "__main__":
    unittest.main()
