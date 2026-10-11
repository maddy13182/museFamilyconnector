#!/usr/bin/env python3
"""Tests for WS-E tamper-evidence: `hub verify-install` + startup self-check.

Each test builds an "installed" CLI by copying agent-skill/hub into a temp
dir (with manifest.json / hub.sigstore next to it) and loading the copy as
its own module, so __file__-based path resolution points at the temp dir.

Run from the repo root:
    python3 -m unittest discover -s agent-skill/tests -v
"""

import base64
import contextlib
import hashlib
import importlib.util
import io
import json
import os
import shutil
import tempfile
import unittest
from importlib.machinery import SourceFileLoader

HERE = os.path.dirname(os.path.abspath(__file__))
HUB_PATH = os.path.join(HERE, "..", "hub")

spec = importlib.util.spec_from_file_location(
    "hubcli", HUB_PATH, loader=SourceFileLoader("hubcli", HUB_PATH)
)
hub = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hub)


@contextlib.contextmanager
def captured():
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        yield out, err


def _load_copy(name, path):
    """Load a hub copy as an independent module (own __file__, own flags)."""
    spec = importlib.util.spec_from_file_location(
        name, path, loader=SourceFileLoader(name, path)
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _fake_bundle(digest_hex):
    """Minimal structurally-valid sigstore bundle attesting to digest_hex."""
    return {
        "mediaType": "application/vnd.dev.sigstore.bundle.v0.3+json",
        "verificationMaterial": {
            "certificate": {"rawBytes": "ZmFrZQ=="},
            "tlogEntries": [],
        },
        "messageSignature": {
            "messageDigest": {
                "algorithm": "SHA2_256",
                "digest": base64.b64encode(bytes.fromhex(digest_hex)).decode("ascii"),
            },
            "signature": "ZmFrZQ==",
        },
    }


class TamperEvidenceTestBase(unittest.TestCase):
    _counter = 0

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="hubtamper-")
        hub._integrity_warned = False

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)
        hub._integrity_warned = False

    def make_install(self, tamper=False, manifest="good", bundle="good"):
        """Create an installed CLI copy in self.tmp.

        manifest: "good" (hash matches the copy), "wrong-hash",
                  "missing", "corrupt", "no-signature".
        bundle: "good" (attests to the copy), "wrong-digest", "missing",
                "not-a-bundle".
        Returns (module, hub_copy_path).
        """
        TamperEvidenceTestBase._counter += 1
        name = "hubcopy%d" % TamperEvidenceTestBase._counter
        hub_copy = os.path.join(self.tmp, "hub-%d" % TamperEvidenceTestBase._counter)
        shutil.copyfile(HUB_PATH, hub_copy)
        with open(hub_copy, "rb") as handle:
            actual = hashlib.sha256(handle.read()).hexdigest()

        recorded = "0" * 64 if manifest == "wrong-hash" else actual
        if manifest not in ("missing", "corrupt"):
            doc = {
                "version": "0.6.0",
                "files": {"hub": recorded},
                "signature": "hub.sigstore",
            }
            if manifest == "no-signature":
                del doc["signature"]
            with open(os.path.join(self.tmp, "manifest.json"), "w") as handle:
                json.dump(doc, handle)
        elif manifest == "corrupt":
            with open(os.path.join(self.tmp, "manifest.json"), "w") as handle:
                handle.write("{not valid json")

        bundle_path = os.path.join(self.tmp, "hub.sigstore")
        if bundle == "good":
            with open(bundle_path, "w") as handle:
                json.dump(_fake_bundle(actual), handle)
        elif bundle == "wrong-digest":
            with open(bundle_path, "w") as handle:
                json.dump(_fake_bundle("ab" * 32), handle)
        elif bundle == "not-a-bundle":
            with open(bundle_path, "w") as handle:
                json.dump({"hello": "world"}, handle)
        # "missing": no bundle file written.

        # Post-install modification: the release was signed/installed, THEN
        # the file changed on disk. The manifest must record the pristine
        # hash, so tamper happens last.
        if tamper:
            with open(hub_copy, "ab") as handle:
                handle.write(b"# tampered by test\n")

        return _load_copy(name, hub_copy), hub_copy

    def run_verify(self, mod):
        with captured() as (out, err):
            rc = mod.main(["verify-install"], transport=None)
        return rc, out.getvalue(), err.getvalue()


# ---------------------------------------------------------------------------
# verify-install
# ---------------------------------------------------------------------------


class TestVerifyInstall(TamperEvidenceTestBase):
    def test_pass(self):
        mod, _ = self.make_install()
        rc, out, err = self.run_verify(mod)
        self.assertEqual(rc, 0)
        self.assertIn("RESULT: PASS", out)
        self.assertIn("[ OK ] sha256 matches manifest", out)
        self.assertIn("[ OK ] bundle attests to exactly these bytes", out)
        self.assertIn("installed CLI matches the signed release", out)
        if shutil.which("sigstore") is None:
            self.assertIn("[SKIP] sigstore trust chain", out)

    def test_hash_mismatch(self):
        mod, _ = self.make_install(tamper=True)
        rc, out, _ = self.run_verify(mod)
        self.assertEqual(rc, 1)
        self.assertIn("[FAIL] sha256", out)
        self.assertIn("RESULT: FAIL", out)
        self.assertIn("reinstall from the GitHub Release", out)

    def test_missing_manifest(self):
        mod, _ = self.make_install(manifest="missing")
        rc, out, _ = self.run_verify(mod)
        self.assertEqual(rc, 1)
        self.assertIn("[FAIL] manifest.json", out)
        self.assertIn("RESULT: FAIL", out)

    def test_corrupt_manifest(self):
        mod, _ = self.make_install(manifest="corrupt")
        rc, out, _ = self.run_verify(mod)
        self.assertEqual(rc, 1)
        self.assertIn("[FAIL] manifest.json", out)
        self.assertIn("RESULT: FAIL", out)

    def test_wrong_hash_manifest(self):
        mod, _ = self.make_install(manifest="wrong-hash")
        rc, out, _ = self.run_verify(mod)
        self.assertEqual(rc, 1)
        self.assertIn("[FAIL] sha256", out)
        self.assertIn("RESULT: FAIL", out)

    def test_missing_bundle(self):
        mod, _ = self.make_install(bundle="missing")
        rc, out, _ = self.run_verify(mod)
        self.assertEqual(rc, 1)
        self.assertIn("[FAIL] signature", out)
        self.assertIn("RESULT: FAIL", out)

    def test_bundle_wrong_digest(self):
        mod, _ = self.make_install(bundle="wrong-digest")
        rc, out, _ = self.run_verify(mod)
        self.assertEqual(rc, 1)
        self.assertIn("[FAIL] sigstore bundle", out)
        self.assertIn("does not attest to this artifact", out)
        self.assertIn("RESULT: FAIL", out)

    def test_bundle_not_a_bundle(self):
        mod, _ = self.make_install(bundle="not-a-bundle")
        rc, out, _ = self.run_verify(mod)
        self.assertEqual(rc, 1)
        self.assertIn("[FAIL] sigstore bundle", out)
        self.assertIn("RESULT: FAIL", out)

    def test_manifest_without_signature_ref(self):
        mod, _ = self.make_install(manifest="no-signature")
        rc, out, _ = self.run_verify(mod)
        self.assertEqual(rc, 1)
        self.assertIn("[FAIL] signature", out)
        self.assertIn("RESULT: FAIL", out)


# ---------------------------------------------------------------------------
# Startup self-integrity check
# ---------------------------------------------------------------------------


class TestStartupIntegrity(TamperEvidenceTestBase):
    def test_match_proceeds(self):
        mod, _ = self.make_install()
        with captured():
            self.assertTrue(mod._startup_integrity_check())

    def test_mismatch_refuses(self):
        mod, _ = self.make_install(manifest="wrong-hash")
        with captured() as (out, err):
            self.assertFalse(mod._startup_integrity_check())
        self.assertIn(
            "installed CLI does not match the signed release", err.getvalue()
        )

    def test_missing_manifest_warns_once_and_proceeds(self):
        mod, _ = self.make_install(manifest="missing")
        with captured() as (out, err):
            self.assertTrue(mod._startup_integrity_check())
            self.assertTrue(mod._startup_integrity_check())
        self.assertEqual(
            err.getvalue().count("startup self-check skipped"), 1
        )
        self.assertIn("warning", err.getvalue())

    def test_corrupt_manifest_warns_and_proceeds(self):
        mod, _ = self.make_install(manifest="corrupt")
        with captured() as (out, err):
            self.assertTrue(mod._startup_integrity_check())
        self.assertIn("startup self-check skipped", err.getvalue())

    def test_main_refuses_tampered_install(self):
        mod, _ = self.make_install(manifest="wrong-hash")
        with captured() as (out, err):
            rc = mod.main(["me"], transport=None)
        self.assertEqual(rc, mod.EXIT_TAMPERED)
        self.assertEqual(rc, 5)
        self.assertIn(
            "installed CLI does not match the signed release", err.getvalue()
        )

    def test_main_verify_install_exempt_from_refusal(self):
        # A tampered install must still be able to run verify-install so it
        # can report exactly which check failed.
        mod, _ = self.make_install(manifest="wrong-hash")
        with captured() as (out, err):
            rc = mod.main(["verify-install"], transport=None)
        self.assertEqual(rc, 1)
        self.assertIn("RESULT: FAIL", out.getvalue())

    def test_dev_checkout_warns_once(self):
        # The repo checkout itself has no manifest.json: warn once, run.
        hub._integrity_warned = False
        with captured() as (out, err):
            self.assertTrue(hub._startup_integrity_check())
            self.assertTrue(hub._startup_integrity_check())
        self.assertEqual(err.getvalue().count("startup self-check skipped"), 1)


# ---------------------------------------------------------------------------
# Bundle digest extraction unit tests
# ---------------------------------------------------------------------------


class TestBundleDigest(TamperEvidenceTestBase):
    def _write(self, obj, raw=None):
        path = os.path.join(self.tmp, "b.sigstore")
        with open(path, "w") as handle:
            handle.write(raw if raw is not None else json.dumps(obj))
        return path

    def test_extracts_digest(self):
        digest, err = hub._bundle_artifact_digest(self._write(_fake_bundle("cd" * 32)))
        self.assertEqual(digest, "cd" * 32)
        self.assertIsNone(err)

    def test_not_a_bundle(self):
        digest, err = hub._bundle_artifact_digest(self._write({"nope": True}))
        self.assertIsNone(digest)
        self.assertIn("verificationMaterial", err)

    def test_unreadable_file(self):
        digest, err = hub._bundle_artifact_digest(self._write({}, raw="{oops"))
        self.assertIsNone(digest)
        self.assertIsNotNone(err)

    def test_missing_digest(self):
        bundle = _fake_bundle("cd" * 32)
        del bundle["messageSignature"]["messageDigest"]
        digest, err = hub._bundle_artifact_digest(self._write(bundle))
        self.assertIsNone(digest)
        self.assertIn("no messageDigest", err)

    def test_wrong_algorithm(self):
        bundle = _fake_bundle("cd" * 32)
        bundle["messageSignature"]["messageDigest"]["algorithm"] = "SHA512_256"
        digest, err = hub._bundle_artifact_digest(self._write(bundle))
        self.assertIsNone(digest)
        self.assertIn("SHA2_256", err)


if __name__ == "__main__":
    unittest.main()
