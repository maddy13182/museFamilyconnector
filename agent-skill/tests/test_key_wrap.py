#!/usr/bin/env python3
"""Tests for passphrase-wrapped identity keys (`hub key-wrap`).

Magic-header detection, wrap/unwrap round-trip, wrong-passphrase
rejection, legacy-key deprecation warning, the FAMILY_HUB_KEY_PASSPHRASE
env-var path, backup creation, and the mocked-getpass path.

Run from the repo root:
    python3 -m unittest discover -s agent-skill/tests -v
"""

import contextlib
import importlib.util
import io
import os
import shutil
import stat
import sys
import tempfile
import unittest
from importlib.machinery import SourceFileLoader
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
HUB_PATH = os.path.join(HERE, "..", "hub")

spec = importlib.util.spec_from_file_location(
    "hubcli_keywrap", HUB_PATH, loader=SourceFileLoader("hubcli_keywrap", HUB_PATH)
)
hub = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hub)

try:
    import nacl  # noqa: F401

    HAVE_CRYPTO = True
except ImportError:
    HAVE_CRYPTO = False


@contextlib.contextmanager
def captured():
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        yield out, err


FAKE_TOKEN = "fh_test_token_0123456789abcdef"
PASSPHRASE = "correct horse battery staple"


class KeyWrapTestBase(unittest.TestCase):
    def setUp(self):
        if not HAVE_CRYPTO:
            self.skipTest("PyNaCl not installed")
        self._saved_env = dict(os.environ)
        self.tmp = tempfile.mkdtemp(prefix="hubtest-keywrap-")
        os.environ["FAMILY_HUB_CONFIG_HOME"] = self.tmp
        os.environ["FAMILY_HUB_TOKEN"] = FAKE_TOKEN
        os.environ.pop("FAMILY_HUB_VAULT_CMD", None)
        os.environ.pop(hub._KEYWRAP_ENV_VAR, None)

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._saved_env)
        shutil.rmtree(self.tmp, ignore_errors=True)
        hub.clear_secrets()

    def run_cli(self, argv):
        with captured() as (out, err):
            rc = hub.main(argv)
        return rc, out.getvalue(), err.getvalue()

    def key_path(self, profile="default"):
        return hub.agent_key_path(profile)

    def file_mode(self, path):
        return stat.S_IMODE(os.stat(path).st_mode)

    def seed_unwrapped_key(self, profile="default"):
        """Write a fresh raw 32-byte identity key (legacy form)."""
        priv = hub._generate_identity_keypair()
        hub._write_secret_file_0600(self.key_path(profile), priv,
                                    "identity private key")
        return priv


class WrapFormatTests(KeyWrapTestBase):
    def test_wrap_unwrap_roundtrip(self):
        priv = hub._generate_identity_keypair()
        blob = hub._wrap_identity_key(priv, PASSPHRASE)
        self.assertTrue(blob.startswith(b"FHWRAP1\n"))
        # salt(16) || nonce(24) || ct(32 plaintext + 16 tag) = 96 bytes
        self.assertEqual(len(blob), 8 + 16 + 24 + 48)
        self.assertEqual(hub._unwrap_identity_key_with(blob, PASSPHRASE), priv)

    def test_wrap_is_randomized(self):
        priv = hub._generate_identity_keypair()
        self.assertNotEqual(hub._wrap_identity_key(priv, PASSPHRASE),
                            hub._wrap_identity_key(priv, PASSPHRASE))

    def test_wrong_passphrase_rejected_cleanly(self):
        priv = hub._generate_identity_keypair()
        blob = hub._wrap_identity_key(priv, PASSPHRASE)
        with self.assertRaises(hub.HubError) as cm:
            hub._unwrap_identity_key_with(blob, "wrong-passphrase-000")
        exc = cm.exception
        self.assertEqual(exc.code, "auth")
        self.assertIn("Incorrect passphrase", str(exc))
        # The passphrase itself must never appear in the error.
        self.assertNotIn("wrong-passphrase-000", str(exc))
        self.assertNotIn(PASSPHRASE, str(exc))

    def test_truncated_blob_rejected(self):
        with self.assertRaises(hub.HubError) as cm:
            hub._unwrap_identity_key_with(b"FHWRAP1\n" + b"short", PASSPHRASE)
        self.assertEqual(cm.exception.code, "config")

    def test_legacy_32_bytes_are_not_wrapped(self):
        priv = hub._generate_identity_keypair()
        self.assertFalse(priv.startswith(b"FHWRAP1\n"))

    def test_passphrase_sourcing_env_first(self):
        os.environ[hub._KEYWRAP_ENV_VAR] = PASSPHRASE
        with mock.patch.object(hub.getpass, "getpass") as gp:
            self.assertEqual(hub._key_wrap_passphrase(), PASSPHRASE)
            gp.assert_not_called()

    def test_passphrase_sourcing_falls_back_to_getpass(self):
        with mock.patch.object(hub.getpass, "getpass",
                               return_value=PASSPHRASE) as gp:
            self.assertEqual(hub._key_wrap_passphrase(), PASSPHRASE)
            gp.assert_called_once()

    def test_empty_env_var_falls_through_to_prompt(self):
        os.environ[hub._KEYWRAP_ENV_VAR] = ""
        with mock.patch.object(hub.getpass, "getpass",
                               return_value=PASSPHRASE):
            self.assertEqual(hub._key_wrap_passphrase(), PASSPHRASE)


class LoadIdentityKeyTests(KeyWrapTestBase):
    def test_legacy_key_loads_with_loud_warning(self):
        priv = self.seed_unwrapped_key()
        with captured() as (out, err):
            loaded = hub._load_identity_key(self.key_path())
        self.assertEqual(loaded, priv)  # no regression: still works
        self.assertIn("UNWRAPPED", err.getvalue())
        self.assertIn("hub key-wrap", err.getvalue())

    def test_wrapped_key_loads_silently_via_env(self):
        priv = self.seed_unwrapped_key()
        blob = hub._wrap_identity_key(priv, PASSPHRASE)
        hub._write_secret_file_0600(self.key_path(), blob, "wrapped key")
        os.environ[hub._KEYWRAP_ENV_VAR] = PASSPHRASE
        with captured() as (out, err):
            loaded = hub._load_identity_key(self.key_path())
        self.assertEqual(loaded, priv)
        self.assertNotIn("UNWRAPPED", err.getvalue())

    def test_wrapped_key_wrong_passphrase_is_clean(self):
        priv = self.seed_unwrapped_key()
        blob = hub._wrap_identity_key(priv, PASSPHRASE)
        hub._write_secret_file_0600(self.key_path(), blob, "wrapped key")
        os.environ[hub._KEYWRAP_ENV_VAR] = "nope-not-it-12345"
        with self.assertRaises(hub.HubError) as cm:
            hub._load_identity_key(self.key_path())
        self.assertIn("Incorrect passphrase", str(cm.exception))


class KeyWrapCommandTests(KeyWrapTestBase):
    def test_key_wrap_cli_env_path_creates_backup(self):
        priv = self.seed_unwrapped_key()
        os.environ[hub._KEYWRAP_ENV_VAR] = PASSPHRASE
        rc, out, err = self.run_cli(["key-wrap"])
        self.assertEqual(rc, 0)
        bak = self.key_path() + ".bak-0600"
        self.assertTrue(os.path.exists(bak))
        self.assertEqual(self.file_mode(bak), 0o600)
        with open(bak, "rb") as fh:
            self.assertEqual(fh.read(), priv)  # backup holds the original
        with open(self.key_path(), "rb") as fh:
            wrapped = fh.read()
        self.assertEqual(self.file_mode(self.key_path()), 0o600)
        self.assertTrue(wrapped.startswith(b"FHWRAP1\n"))
        # Round-trip through the real load path with the same passphrase.
        self.assertEqual(hub._load_identity_key(self.key_path()), priv)
        self.assertIn("wrapped", out)
        self.assertIn(hub._KEYWRAP_ENV_VAR, out)  # ops note printed

    def test_key_wrap_cli_getpass_path(self):
        priv = self.seed_unwrapped_key()
        answers = iter([PASSPHRASE, PASSPHRASE])  # new + confirm
        with mock.patch.object(hub.getpass, "getpass",
                               side_effect=lambda *a: next(answers)):
            rc, out, err = self.run_cli(["key-wrap"])
        self.assertEqual(rc, 0)
        with open(self.key_path(), "rb") as fh:
            wrapped = fh.read()
        self.assertTrue(wrapped.startswith(b"FHWRAP1\n"))
        self.assertEqual(hub._unwrap_identity_key_with(wrapped, PASSPHRASE),
                         priv)

    def test_key_wrap_cli_mismatched_confirmation(self):
        self.seed_unwrapped_key()
        answers = iter([PASSPHRASE, "something-else-entirely"])
        with mock.patch.object(hub.getpass, "getpass",
                               side_effect=lambda *a: next(answers)):
            rc, out, err = self.run_cli(["key-wrap"])
        self.assertNotEqual(rc, 0)
        self.assertIn("do not match", err)
        # The key must be untouched.
        with open(self.key_path(), "rb") as fh:
            self.assertEqual(len(fh.read()), 32)

    def test_key_wrap_cli_short_passphrase_rejected(self):
        self.seed_unwrapped_key()
        os.environ[hub._KEYWRAP_ENV_VAR] = "short"
        rc, out, err = self.run_cli(["key-wrap"])
        self.assertNotEqual(rc, 0)
        self.assertIn("at least 8 characters", err)
        with open(self.key_path(), "rb") as fh:
            self.assertEqual(len(fh.read()), 32)

    def test_key_wrap_cli_idempotent(self):
        self.seed_unwrapped_key()
        os.environ[hub._KEYWRAP_ENV_VAR] = PASSPHRASE
        rc1, out1, _ = self.run_cli(["key-wrap"])
        self.assertEqual(rc1, 0)
        with open(self.key_path(), "rb") as fh:
            first = fh.read()
        rc2, out2, _ = self.run_cli(["key-wrap"])
        self.assertEqual(rc2, 0)
        self.assertIn("already passphrase-wrapped", out2)
        with open(self.key_path(), "rb") as fh:
            self.assertEqual(fh.read(), first)  # untouched

    def test_key_wrap_cli_refuses_to_clobber_backup(self):
        self.seed_unwrapped_key()
        bak = self.key_path() + ".bak-0600"
        hub._write_secret_file_0600(bak, b"existing-backup", "backup")
        os.environ[hub._KEYWRAP_ENV_VAR] = PASSPHRASE
        rc, out, err = self.run_cli(["key-wrap"])
        self.assertNotEqual(rc, 0)
        self.assertIn("Refusing to overwrite", err)
        # --force overwrites the stale backup and proceeds.
        rc, out, err = self.run_cli(["key-wrap", "--force"])
        self.assertEqual(rc, 0)
        with open(self.key_path(), "rb") as fh:
            self.assertTrue(fh.read().startswith(b"FHWRAP1\n"))

    def test_key_wrap_cli_no_key(self):
        rc, out, err = self.run_cli(["key-wrap"])
        self.assertNotEqual(rc, 0)
        self.assertIn("key-init", err)

    def test_key_wrap_never_echos_passphrase(self):
        self.seed_unwrapped_key()
        os.environ[hub._KEYWRAP_ENV_VAR] = PASSPHRASE
        rc, out, err = self.run_cli(["key-wrap"])
        self.assertEqual(rc, 0)
        self.assertNotIn(PASSPHRASE, out)
        self.assertNotIn(PASSPHRASE, err)

    def test_corrupt_legacy_key_still_rejected(self):
        hub._write_secret_file_0600(self.key_path(), b"too-short", "key")
        rc, out, err = self.run_cli(["key-wrap"])
        self.assertNotEqual(rc, 0)
        self.assertIn("corrupt", err)


if __name__ == "__main__":
    unittest.main()
