#!/usr/bin/env python3
"""Tests for the `hub upgrade` skill-docs refresh phase (contract §3.6).

Covers: the manifest `skill`-block validation; the refresh when the
server skill is newer (download → sha256 verify → safe extract →
allowlist copy); the no-op when older/equal; hash mismatch and unsafe
tarballs raising HubError with nothing written; the graceful skip when
no SKILL.md is adjacent; the allowlist as the credential-safety boundary
(hub / hub.sigstore / manifest.json / config.json / token / agent.key
are never touched); the same-origin pin on the skill URL; and that the
phase runs after the binary flow even when the binary is already current.

Run from the repo root:
    python3 -m unittest discover -s agent-skill/tests -v
"""

import contextlib
import hashlib
import importlib.util
import io
import json
import os
import shutil
import stat
import tarfile
import tempfile
import types
import unittest
from importlib.machinery import SourceFileLoader
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
HUB_PATH = os.path.join(HERE, "..", "hub")

spec = importlib.util.spec_from_file_location(
    "hubcli_skillbundle",
    HUB_PATH,
    loader=SourceFileLoader("hubcli_skillbundle", HUB_PATH),
)
hub = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hub)

SERVER = "https://hub.example.test"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def make_tarball(entries, mode="w:gz"):
    """Build a tarball in memory.

    entries: list of (name, data, kind); kind in {"file", "dir",
    "symlink", "hardlink", "fifo"}. For links, `data` is the link target.
    No sanitization is applied on purpose — malicious members are built
    here so the extractor's fail-closed checks can be tested.
    """
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode=mode) as tf:
        for name, data, kind in entries:
            ti = tarfile.TarInfo(name)
            if kind == "dir":
                ti.type = tarfile.DIRTYPE
                tf.addfile(ti)
            elif kind == "symlink":
                ti.type = tarfile.SYMTYPE
                ti.linkname = data
                tf.addfile(ti)
            elif kind == "hardlink":
                ti.type = tarfile.LNKTYPE
                ti.linkname = data
                tf.addfile(ti)
            elif kind == "fifo":
                ti.type = tarfile.FIFOTYPE
                tf.addfile(ti)
            else:
                raw = data if isinstance(data, bytes) else data.encode("utf-8")
                ti.size = len(raw)
                ti.mode = 0o644
                tf.addfile(ti, io.BytesIO(raw))
    return buf.getvalue()


def good_bundle(new_skill_version="0.12.0"):
    """A well-formed skill bundle tarball, with poison members included."""
    return make_tarball(
        [
            (
                "SKILL.md",
                "<!-- SKILL VERSION: %s -->\n# skill\nnew docs\n" % new_skill_version,
                "file",
            ),
            ("INSTALL.md", "new install docs\n", "file"),
            ("requirements.txt", "new-requirements\n", "file"),
            ("references", None, "dir"),
            ("references/new.md", "new reference\n", "file"),
            # Poison: present in the bundle, must never be written.
            ("hub", b"evil-binary", "file"),
            ("hub.sigstore", b"evil-sig", "file"),
            ("manifest.json", b"evil-manifest", "file"),
            ("config.json", b"evil-config", "file"),
            ("token", b"evil-token", "file"),
            ("agent.key", b"evil-key", "file"),
        ]
    )


def make_manifest(skill_version, tarball_bytes, server=SERVER):
    """A valid /v1/client/latest payload with a skill block (contract §3.6)."""
    return {
        "version": "0.12.0",
        "min_cli_version": "0.10.0",
        "server_version": "1.0.0",
        "download_url": server + "/v1/client/download/hub",
        "sha256": "0" * 64,
        "released_at": "2026-10-12T00:00:00Z",
        "assets": {
            "hub": server + "/v1/client/download/hub",
            "sigstore": server + "/v1/client/download/hub.sigstore",
            "manifest": server + "/v1/client/download/manifest.json",
        },
        "skill": {
            "url": server + "/v1/client/download/skill.tar.gz",
            "sha256": hashlib.sha256(tarball_bytes).hexdigest(),
            "version": skill_version,
        },
    }


def write_skill_dir(tmp, skill_version="0.11.0"):
    """A fake installed skill dir: docs plus files the refresh must never touch."""
    with open(os.path.join(tmp, "SKILL.md"), "w", encoding="utf-8") as fh:
        fh.write(
            "<!-- SKILL VERSION: %s -->\n# skill\nold docs\n" % skill_version
        )
    with open(os.path.join(tmp, "INSTALL.md"), "w", encoding="utf-8") as fh:
        fh.write("old install docs\n")
    with open(os.path.join(tmp, "requirements.txt"), "w", encoding="utf-8") as fh:
        fh.write("old-requirements\n")
    os.makedirs(os.path.join(tmp, "references"))
    with open(os.path.join(tmp, "references", "old.md"), "w", encoding="utf-8") as fh:
        fh.write("old reference\n")
    # Decoys: the refresh must provably never touch these.
    decoys = {
        "hub": b"old-binary-bytes",
        "hub.sigstore": b"old-sigstore-bundle",
        "manifest.json": b'{"version": "0.11.0"}',
        "config.json": b'{"server_url": "https://hub.example.test"}',
        "token": b"NOT-A-REAL-TOKEN",
        "agent.key": b"NOT-A-REAL-KEY",
    }
    for name, data in decoys.items():
        with open(os.path.join(tmp, name), "wb") as fh:
            fh.write(data)
    return decoys


def snapshot(tmp):
    """{relative path -> bytes} for every file under tmp."""
    out = {}
    for root, _dirs, files in os.walk(tmp):
        for name in files:
            path = os.path.join(root, name)
            with open(path, "rb") as fh:
                out[os.path.relpath(path, tmp)] = fh.read()
    return out


class SkillFixture:
    """A fake installed skill dir with _script_dir pointed at it."""

    def __init__(self, test, skill_version="0.11.0", with_skill_md=True):
        self.test = test
        self.tmp = tempfile.mkdtemp(prefix="hub-skill-test-")
        test.addCleanup(shutil.rmtree, self.tmp, True)
        self.decoys = write_skill_dir(self.tmp, skill_version)
        if not with_skill_md:
            os.unlink(os.path.join(self.tmp, "SKILL.md"))
        self.requested = []
        patch = mock.patch.object(hub, "_script_dir", return_value=self.tmp)
        patch.start()
        test.addCleanup(patch.stop)

    def run_refresh(self, manifest, tarball, patch_download=True):
        """Run _refresh_skill_docs; returns (rc, stdout)."""
        def fake_download(url, what, server=None, timeout=90):
            self.requested.append((url, what, server))
            return tarball

        patches = []
        if patch_download:
            patches.append(
                mock.patch.object(hub, "_download_bytes", side_effect=fake_download)
            )
        for p in patches:
            p.start()
            self.test.addCleanup(p.stop)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = hub._refresh_skill_docs(
                types.SimpleNamespace(server=SERVER), manifest
            )
        return rc, buf.getvalue()

    def assert_untouched(self, before):
        self.test.assertEqual(snapshot(self.tmp), before)


# ---------------------------------------------------------------------------
# Manifest `skill`-block validation
# ---------------------------------------------------------------------------


class SkillBlockValidationTest(unittest.TestCase):
    def test_valid_block(self):
        m = make_manifest("0.12.0", b"fake-tarball")
        self.assertEqual(hub._validate_client_manifest(m)["skill"]["version"], "0.12.0")

    def test_missing_skill_block(self):
        m = make_manifest("0.12.0", b"fake-tarball")
        del m["skill"]
        with self.assertRaises(hub.HubError):
            hub._validate_client_manifest(m)

    def test_skill_not_an_object(self):
        m = make_manifest("0.12.0", b"fake-tarball")
        m["skill"] = "https://hub.example.test/skill.tar.gz"
        with self.assertRaises(hub.HubError):
            hub._validate_client_manifest(m)

    def test_missing_skill_fields(self):
        for field in ("url", "sha256", "version"):
            m = make_manifest("0.12.0", b"fake-tarball")
            del m["skill"][field]
            with self.assertRaises(hub.HubError):
                hub._validate_client_manifest(m)

    def test_bad_skill_url(self):
        for bad in (
            "http://hub.example.test/skill.tar.gz",  # not https
            "ftp://hub.example.test/skill.tar.gz",
            "/v1/client/download/skill.tar.gz",  # not absolute
            "not a url",
        ):
            m = make_manifest("0.12.0", b"fake-tarball")
            m["skill"]["url"] = bad
            with self.assertRaises(hub.HubError):
                hub._validate_client_manifest(m)

    def test_bad_skill_sha256(self):
        m = make_manifest("0.12.0", b"fake-tarball")
        m["skill"]["sha256"] = "xyz"
        with self.assertRaises(hub.HubError):
            hub._validate_client_manifest(m)

    def test_bad_skill_version(self):
        m = make_manifest("0.12.0", b"fake-tarball")
        m["skill"]["version"] = "soon"
        with self.assertRaises(hub.HubError):
            hub._validate_client_manifest(m)


# ---------------------------------------------------------------------------
# Refresh flows
# ---------------------------------------------------------------------------


class RefreshFlowTest(unittest.TestCase):
    def test_newer_refreshes_docs_and_only_docs(self):
        fx = SkillFixture(self, skill_version="0.11.0")
        tarball = good_bundle("0.12.0")
        manifest = make_manifest("0.12.0", tarball)
        rc, out = fx.run_refresh(manifest, tarball)
        self.assertEqual(rc, 0)
        self.assertIn("New skill docs available: skill 0.11.0 → 0.12.0.", out)
        self.assertIn("Skill docs refreshed to 0.12.0:", out)

        def read(name):
            with open(os.path.join(fx.tmp, name), "rb") as fh:
                return fh.read()

        # Docs refreshed to the bundle's bytes.
        self.assertIn(b"new docs", read("SKILL.md"))
        self.assertIn(b"SKILL VERSION: 0.12.0", read("SKILL.md"))
        self.assertEqual(read("INSTALL.md"), b"new install docs\n")
        self.assertEqual(read("requirements.txt"), b"new-requirements\n")
        # references/ replaced wholesale: old file gone, new file present.
        self.assertFalse(os.path.exists(os.path.join(fx.tmp, "references", "old.md")))
        self.assertEqual(
            read(os.path.join("references", "new.md")), b"new reference\n"
        )
        # The poison members were never written: every decoy is untouched.
        for name, data in fx.decoys.items():
            self.assertEqual(read(name), data, name)
        # Exactly one download: the skill tarball, pinned to the server origin.
        self.assertEqual(
            fx.requested,
            [(SERVER + "/v1/client/download/skill.tar.gz", "skill bundle 0.12.0", SERVER)],
        )
        # Sensible modes: docs 0644.
        self.assertEqual(
            stat.S_IMODE(os.stat(os.path.join(fx.tmp, "SKILL.md")).st_mode), 0o644
        )

    def test_noop_when_equal(self):
        fx = SkillFixture(self, skill_version="0.11.0")
        tarball = good_bundle("0.11.0")
        manifest = make_manifest("0.11.0", tarball)
        before = snapshot(fx.tmp)
        rc, out = fx.run_refresh(manifest, tarball)
        self.assertEqual(rc, 0)
        self.assertIn("Skill docs are current", out)
        self.assertEqual(fx.requested, [])
        fx.assert_untouched(before)

    def test_noop_when_older(self):
        fx = SkillFixture(self, skill_version="0.11.0")
        tarball = good_bundle("0.10.0")
        manifest = make_manifest("0.10.0", tarball)
        before = snapshot(fx.tmp)
        rc, out = fx.run_refresh(manifest, tarball)
        self.assertEqual(rc, 0)
        self.assertIn("Skill docs are current", out)
        self.assertEqual(fx.requested, [])
        fx.assert_untouched(before)

    def test_hash_mismatch_raises_and_touches_nothing(self):
        fx = SkillFixture(self, skill_version="0.11.0")
        tarball = good_bundle("0.12.0")
        manifest = make_manifest("0.12.0", tarball)
        manifest["skill"]["sha256"] = "f" * 64  # lie about the hash
        before = snapshot(fx.tmp)
        with self.assertRaises(hub.HubError) as ctx:
            fx.run_refresh(manifest, tarball)
        self.assertIn("sha256 MISMATCH", str(ctx.exception))
        fx.assert_untouched(before)

    def test_dotdot_member_rejected(self):
        fx = SkillFixture(self, skill_version="0.11.0")
        tarball = make_tarball(
            [
                ("SKILL.md", "<!-- SKILL VERSION: 0.12.0 -->\n", "file"),
                ("../evil.md", "escape\n", "file"),
            ]
        )
        manifest = make_manifest("0.12.0", tarball)
        before = snapshot(fx.tmp)
        with self.assertRaises(hub.HubError) as ctx:
            fx.run_refresh(manifest, tarball)
        self.assertIn("unsafe path", str(ctx.exception))
        fx.assert_untouched(before)
        self.assertFalse(os.path.exists(os.path.join(fx.tmp, "evil.md")))

    def test_nested_dotdot_member_rejected(self):
        fx = SkillFixture(self, skill_version="0.11.0")
        tarball = make_tarball(
            [
                ("SKILL.md", "<!-- SKILL VERSION: 0.12.0 -->\n", "file"),
                ("references/../../evil.md", "escape\n", "file"),
            ]
        )
        manifest = make_manifest("0.12.0", tarball)
        before = snapshot(fx.tmp)
        with self.assertRaises(hub.HubError):
            fx.run_refresh(manifest, tarball)
        fx.assert_untouched(before)

    def test_absolute_member_rejected(self):
        fx = SkillFixture(self, skill_version="0.11.0")
        tarball = make_tarball(
            [
                ("SKILL.md", "<!-- SKILL VERSION: 0.12.0 -->\n", "file"),
                ("/tmp/evil.md", "escape\n", "file"),
            ]
        )
        manifest = make_manifest("0.12.0", tarball)
        before = snapshot(fx.tmp)
        with self.assertRaises(hub.HubError):
            fx.run_refresh(manifest, tarball)
        fx.assert_untouched(before)

    def test_drive_letter_member_rejected(self):
        # On Windows, os.path.join(staging, "C:/evil.md") resolves outside
        # the staging dir; the extractor must reject drive-letter members.
        fx = SkillFixture(self, skill_version="0.11.0")
        tarball = make_tarball(
            [
                ("SKILL.md", "<!-- SKILL VERSION: 0.12.0 -->\n", "file"),
                ("C:/evil.md", "escape\n", "file"),
            ]
        )
        manifest = make_manifest("0.12.0", tarball)
        before = snapshot(fx.tmp)
        with self.assertRaises(hub.HubError):
            fx.run_refresh(manifest, tarball)
        fx.assert_untouched(before)

    def test_copy_failure_raises_hub_error(self):
        # A disk/permission failure mid-copy is a loud HubError, not a
        # traceback, and leaves the installed docs untouched.
        fx = SkillFixture(self, skill_version="0.11.0")
        tarball = good_bundle("0.12.0")
        manifest = make_manifest("0.12.0", tarball)
        before = snapshot(fx.tmp)
        with mock.patch("shutil.copyfile", side_effect=OSError("disk full")):
            with self.assertRaises(hub.HubError) as ctx:
                fx.run_refresh(manifest, tarball)
        self.assertIn("Could not refresh SKILL.md", str(ctx.exception))
        fx.assert_untouched(before)

    def test_symlink_member_rejected(self):
        fx = SkillFixture(self, skill_version="0.11.0")
        tarball = make_tarball(
            [
                ("SKILL.md", "<!-- SKILL VERSION: 0.12.0 -->\n", "file"),
                ("references/sneaky.md", "SKILL.md", "symlink"),
            ]
        )
        manifest = make_manifest("0.12.0", tarball)
        before = snapshot(fx.tmp)
        with self.assertRaises(hub.HubError) as ctx:
            fx.run_refresh(manifest, tarball)
        self.assertIn("symlink", str(ctx.exception))
        fx.assert_untouched(before)

    def test_hardlink_member_rejected(self):
        fx = SkillFixture(self, skill_version="0.11.0")
        tarball = make_tarball(
            [
                ("SKILL.md", "<!-- SKILL VERSION: 0.12.0 -->\n", "file"),
                ("references/sneaky.md", "SKILL.md", "hardlink"),
            ]
        )
        manifest = make_manifest("0.12.0", tarball)
        before = snapshot(fx.tmp)
        with self.assertRaises(hub.HubError):
            fx.run_refresh(manifest, tarball)
        fx.assert_untouched(before)

    def test_nonregular_member_rejected(self):
        fx = SkillFixture(self, skill_version="0.11.0")
        tarball = make_tarball(
            [
                ("SKILL.md", "<!-- SKILL VERSION: 0.12.0 -->\n", "file"),
                ("weird-fifo", None, "fifo"),
            ]
        )
        manifest = make_manifest("0.12.0", tarball)
        before = snapshot(fx.tmp)
        with self.assertRaises(hub.HubError):
            fx.run_refresh(manifest, tarball)
        fx.assert_untouched(before)

    def test_not_a_tarball_rejected(self):
        fx = SkillFixture(self, skill_version="0.11.0")
        tarball = b"this is not a tar archive at all"
        manifest = make_manifest("0.12.0", tarball)
        before = snapshot(fx.tmp)
        with self.assertRaises(hub.HubError):
            fx.run_refresh(manifest, tarball)
        fx.assert_untouched(before)

    def test_no_skill_md_adjacent_skips_gracefully(self):
        fx = SkillFixture(self, skill_version="0.11.0", with_skill_md=False)
        tarball = good_bundle("0.12.0")
        manifest = make_manifest("0.12.0", tarball)
        before = snapshot(fx.tmp)
        rc, out = fx.run_refresh(manifest, tarball)
        self.assertEqual(rc, 0)
        self.assertIn("skipping the skill-docs refresh", out)
        self.assertEqual(fx.requested, [])  # not even a download was attempted
        fx.assert_untouched(before)

    def test_skill_url_origin_pinned(self):
        # A malicious server cannot bounce the tarball fetch off to an
        # attacker host: _download_bytes pins to the configured server.
        fx = SkillFixture(self, skill_version="0.11.0")
        tarball = good_bundle("0.12.0")
        manifest = make_manifest("0.12.0", tarball, server="https://evil.example")
        before = snapshot(fx.tmp)
        with self.assertRaises(hub.HubError) as ctx:
            fx.run_refresh(manifest, tarball, patch_download=False)
        self.assertIn("unexpected origin", str(ctx.exception))
        fx.assert_untouched(before)

    def test_allowlist_disjoint_from_never_write(self):
        self.assertTrue(
            set(hub._SKILL_DOC_FILES).isdisjoint(hub._SKILL_BUNDLE_NEVER_WRITE)
        )
        self.assertNotIn(hub._SKILL_DOC_DIR, hub._SKILL_BUNDLE_NEVER_WRITE)


# ---------------------------------------------------------------------------
# Integration: the phase runs after the binary flow, even on binary no-op
# ---------------------------------------------------------------------------


class FakeTransport:
    """Serve GET /v1/client/latest; nothing else is needed."""

    def __init__(self, manifest):
        self.manifest = manifest

    def __call__(self, method, url, headers, body_bytes):
        if not url.endswith("/v1/client/latest"):
            raise AssertionError("unexpected URL: %s" % url)
        return 200, json.dumps(self.manifest)


class UpgradeIntegrationTest(unittest.TestCase):
    def test_refresh_runs_when_binary_already_current(self):
        tmp = tempfile.mkdtemp(prefix="hub-skill-upgrade-test-")
        self.addCleanup(shutil.rmtree, tmp, True)

        with open(HUB_PATH, "rb") as fh:
            old_bytes = fh.read()
        target = os.path.join(tmp, "hub")
        with open(target, "wb") as fh:
            fh.write(old_bytes)
        os.chmod(target, 0o755)  # nosec B103 -- test fixture: fake installed CLI in a temp dir

        # Installed skill is older than the server's; installed binary is current.
        write_skill_dir(tmp, "0.11.0")
        # Sibling pyproject.toml so _cli_version() (which reads via the
        # patched _script_dir) reports the current version -> binary no-op.
        with open(os.path.join(tmp, "pyproject.toml"), "w", encoding="utf-8") as fh:
            fh.write('[project]\nname = "family-hub-cli"\nversion = "%s"\n' % hub.VERSION)
        with open(target, "wb") as fh:  # restore: write_skill_dir's decoy clobbered it
            fh.write(old_bytes)

        config_home = os.path.join(tmp, "config")
        env = mock.patch.dict(
            os.environ,
            {"FAMILY_HUB_CONFIG_HOME": config_home, "FAMILY_HUB_PROFILE": "default"},
        )
        env.start()
        self.addCleanup(env.stop)
        profile_dir = os.path.join(config_home, "family-hub", "profiles", "default")
        os.makedirs(profile_dir, mode=0o700)
        with open(os.path.join(profile_dir, "config.json"), "w") as fh:
            json.dump({"server_url": SERVER}, fh)

        tarball = good_bundle("0.12.0")
        manifest = make_manifest("0.12.0", tarball)
        manifest["version"] = hub.VERSION  # binary already current -> no-op
        downloads = {manifest["skill"]["url"]: tarball}

        def fake_download(url, what, server=None, timeout=90):
            assert url in downloads, url
            return downloads[url]

        args = types.SimpleNamespace(
            profile="default", server=None, debug=False,
            allow_server_override=False,
        )
        with mock.patch.object(hub, "_script_path", return_value=target), \
             mock.patch.object(hub, "_script_dir", return_value=tmp), \
             mock.patch.object(hub, "_download_bytes", side_effect=fake_download):
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                rc = hub.cmd_upgrade(args, FakeTransport(manifest))
        out = buf.getvalue()
        self.assertEqual(rc, 0)
        self.assertIn("Already current", out)
        self.assertIn("Skill docs refreshed to 0.12.0:", out)
        # Binary untouched: no .prev, bytes identical.
        with open(target, "rb") as fh:
            self.assertEqual(fh.read(), old_bytes)
        self.assertFalse(os.path.exists(target + ".prev"))
        # Docs refreshed.
        with open(os.path.join(tmp, "SKILL.md"), "rb") as fh:
            self.assertIn(b"SKILL VERSION: 0.12.0", fh.read())


if __name__ == "__main__":
    unittest.main()
