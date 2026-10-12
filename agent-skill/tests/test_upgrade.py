#!/usr/bin/env python3
"""Tests for `hub upgrade` / `hub rollback` (WS-C release management).

Covers: version comparison, client-manifest schema validation,
atomic swap + rollback, the upgrade no-op when already current, and the
hard refusal when sigstore is unavailable or the signature fails.

Run from the repo root:
    python3 -m unittest discover -s agent-skill/tests -v
"""

import contextlib
import hashlib
import importlib.util
import io
import json
import os
import re
import shutil
import sys
import tempfile
import types
import unittest
from importlib.machinery import SourceFileLoader
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
HUB_PATH = os.path.join(HERE, "..", "hub")

spec = importlib.util.spec_from_file_location(
    "hubcli_upgrade", HUB_PATH, loader=SourceFileLoader("hubcli_upgrade", HUB_PATH)
)
hub = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hub)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def make_manifest(version="0.10.1", sha256="0" * 64,
                  server="https://hub.example.test"):
    """The new /v1/client/latest shape (spec §3.5): assets served by the
    server itself, plus min_cli_version."""
    return {
        "version": version,
        "min_cli_version": "0.10.0",
        "server_version": "0.12.0",
        "download_url": server + "/v1/client/download/hub",
        "sha256": sha256,
        "released_at": "2026-10-11T22:00:00Z",
        "assets": {
            "hub": server + "/v1/client/download/hub",
            "sigstore": server + "/v1/client/download/hub.sigstore",
            "manifest": server + "/v1/client/download/manifest.json",
        },
    }


class FakeTransport:
    """Serve GET /v1/client/latest; nothing else is needed for upgrade."""

    def __init__(self, manifest):
        self.manifest = manifest

    def __call__(self, method, url, headers, body_bytes):
        if not url.endswith("/v1/client/latest"):
            raise AssertionError("unexpected URL: %s" % url)
        if "Authorization" in headers:
            raise AssertionError("latest must be unauthenticated")
        return 200, json.dumps(self.manifest)


def stamp_version(source_bytes, new_version):
    """Simulate a released artifact: the build-stamped _BUILD_VERSION.

    Mirrors the stamping step in .github/workflows/release.yml: a released
    single-file artifact carries its version in the _BUILD_VERSION anchor
    because it ships without pyproject.toml or pip metadata.
    """
    text = source_bytes.decode("utf-8")
    new_text, n = re.subn(
        r'^_BUILD_VERSION = None$', '_BUILD_VERSION = "%s"' % new_version, text, count=1,
        flags=re.MULTILINE,
    )
    if n != 1:
        raise AssertionError("expected exactly one _BUILD_VERSION anchor")
    return new_text.encode("utf-8")


class UpgradeFixture:
    """An installed copy of the CLI in a temp dir + a configured profile."""

    def __init__(self, test):
        self.test = test
        self.tmp = tempfile.mkdtemp(prefix="hub-upgrade-test-")
        self.addCleanup(shutil.rmtree, self.tmp, True)

        with open(HUB_PATH, "rb") as fh:
            self.old_bytes = fh.read()
        self.target = os.path.join(self.tmp, "hub")
        with open(self.target, "wb") as fh:
            fh.write(self.old_bytes)
        os.chmod(self.target, 0o755)  # nosec B103 -- test fixture: fake installed CLI in a temp dir
        # Sibling pyproject.toml so _cli_version() resolves (contract C6).
        # Start at an older version so upgrades have somewhere to go.
        with open(os.path.join(self.tmp, "pyproject.toml"), "w", encoding="utf-8") as fh:
            fh.write('[project]\nname = "family-hub-cli"\nversion = "0.7.0"\n')

        # Profile config so _ctx() resolves the server without a token.
        self.config_home = os.path.join(self.tmp, "config")
        self._env = mock.patch.dict(
            os.environ,
            {
                "FAMILY_HUB_CONFIG_HOME": self.config_home,
                "FAMILY_HUB_PROFILE": "default",
            },
        )
        self._env.start()
        self.addCleanup(self._env.stop)
        profile_dir = os.path.join(self.config_home, "family-hub", "profiles", "default")
        os.makedirs(profile_dir, mode=0o700)
        with open(os.path.join(profile_dir, "config.json"), "w") as fh:
            json.dump({"server_url": "https://hub.example.test"}, fh)

    def addCleanup(self, *a, **k):
        self.test.addCleanup(*a, **k)

    def args(self):
        return types.SimpleNamespace(
            profile="default",
            server=None,
            debug=False,
            allow_server_override=False,
        )

    def run_upgrade(self, manifest, downloads):
        """Run cmd_upgrade with mocked download + sigstore verification."""
        def fake_download(url, what, timeout=90):
            self.test.assertIn(url, downloads)
            return downloads[url]

        patches = [
            mock.patch.object(hub, "_script_path", return_value=self.target),
            mock.patch.object(hub, "_download_bytes", side_effect=fake_download),
            mock.patch.object(hub, "_verify_sigstore", return_value=None),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = hub.cmd_upgrade(self.args(), FakeTransport(manifest))
        return rc, buf.getvalue()

    def run_rollback(self):
        patch = mock.patch.object(hub, "_script_path", return_value=self.target)
        patch.start()
        self.addCleanup(patch.stop)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = hub.cmd_rollback(self.args(), None)
        return rc, buf.getvalue()

    def read_target(self):
        with open(self.target, "rb") as fh:
            return fh.read()


# ---------------------------------------------------------------------------
# Version comparison
# ---------------------------------------------------------------------------


class VersionCompareTest(unittest.TestCase):
    def test_newer_minor(self):
        self.assertTrue(hub._is_newer("0.7.0", "0.6.0"))

    def test_newer_major(self):
        self.assertTrue(hub._is_newer("1.0.0", "0.99.9"))

    def test_equal_is_not_newer(self):
        self.assertFalse(hub._is_newer("0.7.0", "0.7.0"))

    def test_older_is_not_newer(self):
        self.assertFalse(hub._is_newer("0.6.9", "0.7.0"))

    def test_stable_beats_own_prerelease(self):
        self.assertTrue(hub._is_newer("0.7.0", "0.7.0-rc1"))
        self.assertFalse(hub._is_newer("0.7.0-rc1", "0.7.0"))

    def test_prerelease_ordering(self):
        self.assertTrue(hub._is_newer("0.7.0-rc2", "0.7.0-rc1"))

    def test_garbage_raises(self):
        with self.assertRaises(hub.HubError):
            hub._is_newer("banana", "0.7.0")

    def test_cli_version_falls_back_to_constant(self):
        # No pyproject.toml next to the script in this checkout.
        self.assertEqual(hub._cli_version(), hub.VERSION)

    def test_cli_version_prefers_pyproject(self):
        with tempfile.TemporaryDirectory() as d:
            script = os.path.join(d, "hub")
            with open(script, "w") as fh:
                fh.write("# fake\n")
            with open(os.path.join(d, "pyproject.toml"), "w") as fh:
                fh.write('[project]\nname = "x"\nversion = "9.9.9"\n')
            with mock.patch.object(hub, "_script_dir", return_value=d):
                self.assertEqual(hub._cli_version(), "9.9.9")


# ---------------------------------------------------------------------------
# Manifest schema validation
# ---------------------------------------------------------------------------


class ManifestSchemaTest(unittest.TestCase):
    def test_valid_manifest(self):
        m = make_manifest()
        self.assertEqual(hub._validate_client_manifest(m), m)

    def test_not_a_dict(self):
        with self.assertRaises(hub.HubError):
            hub._validate_client_manifest([1, 2])

    def test_missing_field(self):
        for field in ("version", "min_cli_version", "download_url",
                      "sha256", "assets"):
            m = make_manifest()
            del m[field]
            with self.assertRaises(hub.HubError):
                hub._validate_client_manifest(m)

    def test_bad_version(self):
        with self.assertRaises(hub.HubError):
            hub._validate_client_manifest(make_manifest(version="soon"))

    def test_bad_min_cli_version(self):
        m = make_manifest()
        m["min_cli_version"] = "soon"
        with self.assertRaises(hub.HubError):
            hub._validate_client_manifest(m)

    def test_bad_url(self):
        with self.assertRaises(hub.HubError):
            hub._validate_client_manifest(
                make_manifest().copy()
                | {"download_url": "http://evil.example/hub"}
            )

    def test_bad_asset_url(self):
        # Manifest validation checks well-formedness; the origin pin is
        # enforced at download time by _validate_download_url.
        m = make_manifest()
        m["assets"] = dict(m["assets"], hub="http://evil.example/hub")
        with self.assertRaises(hub.HubError):
            hub._validate_client_manifest(m)
        m2 = make_manifest()
        m2["assets"] = "not-an-object"
        with self.assertRaises(hub.HubError):
            hub._validate_client_manifest(m2)

    def test_missing_asset(self):
        m = make_manifest()
        del m["assets"]["sigstore"]
        with self.assertRaises(hub.HubError):
            hub._validate_client_manifest(m)

    def test_bad_sha256(self):
        with self.assertRaises(hub.HubError):
            hub._validate_client_manifest(make_manifest(sha256="xyz"))

    def test_download_url_origin_pinned(self):
        server = "https://hub.example.test"
        # Same origin passes (default and explicit https port agree).
        hub._validate_download_url(
            server + "/v1/client/download/hub", server)
        hub._validate_download_url(
            "https://hub.example.test:443/v1/client/download/hub", server)
        # Plain http is refused for non-loopback hosts…
        with self.assertRaises(hub.HubError):
            hub._validate_download_url(
                "http://github.com/x/y/releases/download/v/hub", server)
        with self.assertRaises(hub.HubError):
            hub._validate_download_url("http://hub.example.test/hub", server)
        # …as is any other host, even over https.
        with self.assertRaises(hub.HubError):
            hub._validate_download_url("https://evil.example/hub", server)
        with self.assertRaises(hub.HubError):
            hub._validate_download_url(
                "https://github.com/maddy13182/museFamilyconnector"
                "/releases/download/cli-v0.10.1/hub", server)
        # Non-HTTP schemes are refused outright.
        with self.assertRaises(hub.HubError):
            hub._validate_download_url("ftp://hub.example.test/hub", server)

    def test_download_url_loopback_http_allowed(self):
        # Dev-only exception, mirroring F03 for the server URL itself.
        hub._validate_download_url(
            "http://127.0.0.1:8080/v1/client/download/hub",
            "http://127.0.0.1:8080")
        with self.assertRaises(hub.HubError):
            hub._validate_download_url(
                "http://127.0.0.1:8080/v1/client/download/hub",
                "https://hub.example.test")


# ---------------------------------------------------------------------------
# Upgrade flows
# ---------------------------------------------------------------------------


class UpgradeTest(unittest.TestCase):
    def _downloads_for(self, new_version, new_bytes):
        digest = hashlib.sha256(new_bytes).hexdigest()
        manifest = make_manifest(version=new_version, sha256=digest)
        assets = manifest["assets"]
        downloads = {
            assets["hub"]: new_bytes,
            assets["sigstore"]: b"fake-sigstore-bundle",
            assets["manifest"]: json.dumps(
                {"version": new_version, "sha256": digest,
                 "files": {"hub": digest}, "signature": "hub.sigstore"}
            ).encode("utf-8"),
        }
        return manifest, downloads

    def test_noop_when_already_current(self):
        fx = UpgradeFixture(self)
        manifest = make_manifest(version=hub.VERSION, sha256="0" * 64)
        with mock.patch.object(hub, "_script_path", return_value=fx.target), \
             mock.patch.object(hub, "_download_bytes") as dl:
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                rc = hub.cmd_upgrade(fx.args(), FakeTransport(manifest))
        self.assertEqual(rc, 0)
        self.assertIn("Already current", buf.getvalue())
        dl.assert_not_called()
        # Nothing touched on disk.
        self.assertEqual(fx.read_target(), fx.old_bytes)
        self.assertFalse(os.path.exists(fx.target + ".prev"))

    def test_noop_when_server_older(self):
        fx = UpgradeFixture(self)
        manifest = make_manifest(version="0.5.0", sha256="0" * 64)
        with mock.patch.object(hub, "_script_path", return_value=fx.target), \
             mock.patch.object(hub, "_download_bytes") as dl:
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                rc = hub.cmd_upgrade(fx.args(), FakeTransport(manifest))
        self.assertEqual(rc, 0)
        dl.assert_not_called()

    def test_upgrade_downloads_from_server_assets(self):
        # The signed release comes from THIS server's download endpoints —
        # never GitHub. All three fetched URLs must be exactly the
        # manifest's assets.* entries.
        fx = UpgradeFixture(self)
        new_version = "0.10.1"
        new_bytes = stamp_version(fx.old_bytes, new_version)
        manifest, downloads = self._downloads_for(new_version, new_bytes)
        requested = []

        def fake_download(url, what, server=None, timeout=90):
            requested.append(url)
            return downloads[url]

        with mock.patch.object(hub, "_script_path", return_value=fx.target), \
             mock.patch.object(hub, "_download_bytes", side_effect=fake_download), \
             mock.patch.object(hub, "_verify_sigstore", return_value=None):
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                rc = hub.cmd_upgrade(fx.args(), FakeTransport(manifest))
        self.assertEqual(rc, 0)
        assets = manifest["assets"]
        self.assertEqual(
            requested, [assets["hub"], assets["sigstore"], assets["manifest"]])
        for url in requested:
            self.assertNotIn("github.com", url)
            self.assertTrue(
                url.startswith("https://hub.example.test/v1/client/download/"))

    def test_upgrade_surfaces_min_cli_version(self):
        fx = UpgradeFixture(self)
        manifest = make_manifest(version=hub.VERSION, sha256="0" * 64,
                                 server="https://hub.example.test")
        manifest["min_cli_version"] = "0.10.0"
        with mock.patch.object(hub, "_script_path", return_value=fx.target), \
             mock.patch.object(hub, "_download_bytes") as dl:
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                rc = hub.cmd_upgrade(fx.args(), FakeTransport(manifest))
        self.assertEqual(rc, 0)
        self.assertIn("This server requires CLI ≥ 0.10.0", buf.getvalue())
        dl.assert_not_called()

    def test_full_upgrade_flow(self):
        fx = UpgradeFixture(self)
        new_version = "0.10.1"
        new_bytes = stamp_version(fx.old_bytes, new_version)
        manifest, downloads = self._downloads_for(new_version, new_bytes)
        rc, out = fx.run_upgrade(manifest, downloads)
        self.assertEqual(rc, 0)
        self.assertIn("Upgraded hub %s → %s" % (hub._cli_version(), new_version), out)
        # Atomic cut-over: the installed file is byte-identical.
        self.assertEqual(fx.read_target(), new_bytes)
        # Previous binary kept for rollback.
        with open(fx.target + ".prev", "rb") as fh:
            self.assertEqual(fh.read(), fx.old_bytes)
        # Contract C5: integrity manifest + bundle live next to the CLI.
        with open(os.path.join(fx.tmp, "manifest.json")) as fh:
            im = json.load(fh)
        self.assertEqual(im["version"], new_version)
        self.assertEqual(im["files"]["hub"], hashlib.sha256(new_bytes).hexdigest())
        self.assertEqual(im["signature"], "hub.sigstore")
        self.assertIn("identity", im)
        self.assertTrue(os.path.exists(os.path.join(fx.tmp, "hub.sigstore")))

    def test_sha_mismatch_refuses(self):
        fx = UpgradeFixture(self)
        new_bytes = stamp_version(fx.old_bytes, "0.10.1")
        manifest = make_manifest(version="0.10.1", sha256="f" * 64)
        downloads = {manifest["assets"]["hub"]: new_bytes}
        with self.assertRaises(hub.HubError) as ctx:
            fx.run_upgrade(manifest, downloads)
        self.assertIn("sha256 MISMATCH", str(ctx.exception))
        self.assertEqual(fx.read_target(), fx.old_bytes)
        self.assertFalse(os.path.exists(fx.target + ".prev"))

    def test_release_manifest_disagreement_refuses(self):
        fx = UpgradeFixture(self)
        new_bytes = stamp_version(fx.old_bytes, "0.10.1")
        digest = hashlib.sha256(new_bytes).hexdigest()
        manifest = make_manifest(version="0.10.1", sha256=digest)
        assets = manifest["assets"]
        downloads = {
            assets["hub"]: new_bytes,
            assets["sigstore"]: b"fake",
            # release manifest claims a *different* hash
            assets["manifest"]: json.dumps(
                {"version": "0.7.0", "sha256": "e" * 64}
            ).encode("utf-8"),
        }
        with self.assertRaises(hub.HubError) as ctx:
            fx.run_upgrade(manifest, downloads)
        self.assertIn("disagrees", str(ctx.exception))
        self.assertEqual(fx.read_target(), fx.old_bytes)

    def test_bad_signature_refuses(self):
        fx = UpgradeFixture(self)
        new_bytes = stamp_version(fx.old_bytes, "0.10.1")
        manifest, downloads = self._downloads_for("0.10.1", new_bytes)
        with mock.patch.object(hub, "_script_path", return_value=fx.target), \
             mock.patch.object(hub, "_download_bytes",
                               side_effect=lambda url, what, timeout=90: downloads[url]), \
             mock.patch.object(hub, "_verify_sigstore",
                               side_effect=hub.HubError("config", "Signature verification FAILED")):
            with self.assertRaises(hub.HubError):
                hub.cmd_upgrade(fx.args(), FakeTransport(manifest))
        self.assertEqual(fx.read_target(), fx.old_bytes)
        self.assertFalse(os.path.exists(fx.target + ".prev"))

    def test_missing_sigstore_package_refuses(self):
        fx = UpgradeFixture(self)
        new_bytes = stamp_version(fx.old_bytes, "0.10.1")
        manifest, downloads = self._downloads_for("0.10.1", new_bytes)
        with mock.patch.object(hub, "_script_path", return_value=fx.target), \
             mock.patch.object(hub, "_download_bytes",
                               side_effect=lambda url, what, timeout=90: downloads[url]), \
             mock.patch.object(hub, "_have_sigstore", return_value=False):
            with self.assertRaises(hub.HubError) as ctx:
                hub.cmd_upgrade(fx.args(), FakeTransport(manifest))
        self.assertIn("pip install sigstore", str(ctx.exception))
        self.assertEqual(fx.read_target(), fx.old_bytes)

    def test_failed_self_test_restores_previous(self):
        fx = UpgradeFixture(self)
        new_bytes = stamp_version(fx.old_bytes, "0.10.1")
        manifest, downloads = self._downloads_for("0.10.1", new_bytes)
        real_self_test = hub._self_test

        def flaky_self_test(path, expect_version=None):
            # Candidate passes, installed copy fails (simulates a broken cut-over).
            if path == fx.target:
                raise hub.HubError("config", "boom")
            return real_self_test(path, expect_version=expect_version)

        with mock.patch.object(hub, "_script_path", return_value=fx.target), \
             mock.patch.object(hub, "_download_bytes",
                               side_effect=lambda url, what, timeout=90: downloads[url]), \
             mock.patch.object(hub, "_verify_sigstore", return_value=None), \
             mock.patch.object(hub, "_self_test", side_effect=flaky_self_test):
            with self.assertRaises(hub.HubError):
                hub.cmd_upgrade(fx.args(), FakeTransport(manifest))
        # Restored: the installed file is the old binary again.
        self.assertEqual(fx.read_target(), fx.old_bytes)


# ---------------------------------------------------------------------------
# Rollback
# ---------------------------------------------------------------------------


class RollbackTest(unittest.TestCase):
    def _with_prev(self, fx, prev_bytes=None):
        with open(fx.target + ".prev", "wb") as fh:
            fh.write(prev_bytes if prev_bytes is not None else fx.old_bytes)
        os.chmod(fx.target + ".prev", 0o755)  # nosec B103 -- test fixture in a temp dir

    def test_rollback_restores_previous(self):
        fx = UpgradeFixture(self)
        # Simulate a completed upgrade: current = 0.7.0, prev = 0.6.0.
        new_bytes = stamp_version(fx.old_bytes, "0.10.1")
        with open(fx.target, "wb") as fh:
            fh.write(new_bytes)
        self._with_prev(fx, fx.old_bytes)
        rc, out = fx.run_rollback()
        self.assertEqual(rc, 0)
        self.assertIn("Rolled back", out)
        self.assertEqual(fx.read_target(), fx.old_bytes)
        # The rolled-back-from binary becomes the new fallback (roll forward).
        with open(fx.target + ".prev", "rb") as fh:
            self.assertEqual(fh.read(), new_bytes)

    def test_rollback_without_prev_fails(self):
        fx = UpgradeFixture(self)
        with self.assertRaises(hub.HubError) as ctx:
            fx.run_rollback()
        self.assertIn("No previous binary", str(ctx.exception))
        self.assertEqual(fx.read_target(), fx.old_bytes)

    def test_rollback_self_test_failure_keeps_current(self):
        fx = UpgradeFixture(self)
        # A .prev that is not a working CLI (self-test fails).
        with open(fx.target + ".prev", "wb") as fh:
            fh.write(b"#!/bin/sh\nexit 1\n")
        with self.assertRaises(hub.HubError):
            fx.run_rollback()
        self.assertEqual(fx.read_target(), fx.old_bytes)


# ---------------------------------------------------------------------------
# Atomic swap unit checks
# ---------------------------------------------------------------------------


class AtomicInstallTest(unittest.TestCase):
    def test_atomic_install_preserves_mode(self):
        with tempfile.TemporaryDirectory() as d:
            target = os.path.join(d, "hub")
            with open(target, "wb") as fh:
                fh.write(b"old")
            os.chmod(target, 0o755)  # nosec B103 -- test fixture in a temp dir
            hub._atomic_install(b"new", target)
            with open(target, "rb") as fh:
                self.assertEqual(fh.read(), b"new")
            self.assertEqual(os.stat(target).st_mode & 0o777, 0o755)
            # No temp files leaked.
            self.assertEqual(os.listdir(d), ["hub"])


if __name__ == "__main__":
    unittest.main()
