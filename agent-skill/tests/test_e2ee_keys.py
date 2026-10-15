#!/usr/bin/env python3
"""Tests for the `hub` CLI E2EE key commands (Phase 1).

key-init / key-backup / key-restore, keypair generation + 0600 storage,
setup sending the public key in the redeem call, and the PyNaCl-missing
failure mode. Transport is mocked with the FakeHub pattern from
test_hub.py; crypto runs for real (PyNaCl + mnemonic are test
dependencies, pinned in agent-skill/requirements.txt).

Run from the repo root:
    python3 -m unittest discover -s agent-skill/tests -v
"""

import base64
import contextlib
import importlib.util
import io
import json
import os
import shutil
import stat
import sys
import tempfile
import unittest
import urllib.parse as urlparse
from importlib.machinery import SourceFileLoader
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
HUB_PATH = os.path.join(HERE, "..", "hub")

spec = importlib.util.spec_from_file_location(
    "hubcli_e2ee", HUB_PATH, loader=SourceFileLoader("hubcli_e2ee", HUB_PATH)
)
hub = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hub)

try:
    from mnemonic import Mnemonic

    HAVE_CRYPTO = True
except ImportError:
    HAVE_CRYPTO = False

REDEEM_PATH = "/v2/provisioning-codes/fhp_E2EE01/redeem"


class FakeHub:
    """Canned responses keyed by (method, path). Records every call."""

    def __init__(self):
        self.routes = {}
        self.calls = []
        # Per-invocation version-check traffic is recorded separately so
        # command-traffic assertions keep their meaning.
        self.health_calls = []

    def add(self, method, path, status, body):
        self.routes[(method.upper(), path)] = (status, body)

    def __call__(self, method, url, headers, body_bytes):
        path = urlparse.urlparse(url).path
        if (
            method.upper() == "GET"
            and path == "/v2/health"
            and ("GET", "/v2/health") not in self.routes
        ):
            # The fake models a current (1.0.0) server: auto-answer the
            # per-invocation version check in main().
            self.health_calls.append(
                {
                    "method": method,
                    "url": url,
                    "headers": dict(headers),
                    "body": body_bytes.decode("utf-8") if body_bytes else None,
                }
            )
            return 200, json.dumps(
                {"ok": True, "version": "2.0.0", "api_versions": ["v2"]}
            )
        self.calls.append(
            {
                "method": method,
                "url": url,
                "headers": dict(headers),
                "body": body_bytes.decode("utf-8") if body_bytes else None,
            }
        )
        key = (method.upper(), path)
        if key in self.routes:
            status, body = self.routes[key]
        else:
            status, body = 404, {"error": {"code": "not_found", "message": "no route"}}
        return status, json.dumps(body)

    def bodies_for(self, method, path):
        return [
            json.loads(c["body"]) if c["body"] else None
            for c in self.calls
            if c["method"] == method.upper()
            and urlparse.urlparse(c["url"]).path == path
        ]


@contextlib.contextmanager
def captured():
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        yield out, err


FAKE_TOKEN = "fh_test_token_e2ee_001"


class E2EETestBase(unittest.TestCase):
    def setUp(self):
        if not HAVE_CRYPTO:
            self.skipTest("PyNaCl/mnemonic not installed")
        self._saved_env = dict(os.environ)
        self.tmp = tempfile.mkdtemp(prefix="hubtest-e2ee-")
        os.environ["FAMILY_HUB_CONFIG_HOME"] = self.tmp
        os.environ["FAMILY_HUB_TOKEN"] = FAKE_TOKEN
        os.environ.pop("FAMILY_HUB_VAULT_CMD", None)
        self.fake = FakeHub()
        # Fresh version-check state per test (the fake auto-answers
        # /v2/health as a current server; see FakeHub.__call__).
        hub._reset_server_version_cache()

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._saved_env)
        shutil.rmtree(self.tmp, ignore_errors=True)
        hub.clear_secrets()

    def run_cli(self, argv):
        with captured() as (out, err):
            rc = hub.main(argv, transport=self.fake)
        return rc, out.getvalue(), err.getvalue()

    def seed_config(self, profile="default", **over):
        cfg = {
            "server_url": "https://hub.example",
            "member": {"id": "m1", "name": "Tester", "role": "parent"},
            "agent_label": "test-agent",
            "auth_method": "env",
        }
        cfg.update(over)
        hub.save_config(profile, cfg)

    def key_path(self, profile="default"):
        return hub.agent_key_path(profile)

    def read_key(self, profile="default"):
        with open(self.key_path(profile), "rb") as fh:
            return fh.read()

    def file_mode(self, path):
        return stat.S_IMODE(os.stat(path).st_mode)


# ---------------------------------------------------------------------------
# Keypair generation + storage
# ---------------------------------------------------------------------------


class TestKeygen(E2EETestBase):
    def test_generate_stores_0600_and_reuses(self):
        priv, pub_b64, is_new = hub._ensure_identity_keypair("default")
        self.assertTrue(is_new)
        self.assertEqual(len(priv), 32)
        # 32-byte X25519 public key as standard base64.
        self.assertEqual(len(base64.b64decode(pub_b64)), 32)
        path = self.key_path()
        self.assertTrue(os.path.exists(path))
        self.assertEqual(self.file_mode(path), 0o600)
        self.assertEqual(self.read_key(), priv)
        # Second call reuses — never overwrites an existing identity.
        priv2, pub2, is_new2 = hub._ensure_identity_keypair("default")
        self.assertFalse(is_new2)
        self.assertEqual(priv2, priv)
        self.assertEqual(pub2, pub_b64)

    def test_recovery_phrase_roundtrip(self):
        priv, _pub, _new = hub._ensure_identity_keypair("default")
        phrase = hub._recovery_phrase(priv)
        self.assertEqual(len(phrase.split()), 24)
        self.assertEqual(hub._privkey_from_phrase(phrase), priv)

    def test_recovery_phrase_rejects_bad_checksum(self):
        priv, _pub, _new = hub._ensure_identity_keypair("default")
        words = hub._recovery_phrase(priv).split()
        # Swap the last word for a different valid word -> checksum fails.
        last = words[-1]
        alt = next(w for w in Mnemonic("english").wordlist if w != last)
        words[-1] = alt
        with self.assertRaises(hub.HubError):
            hub._privkey_from_phrase(" ".join(words))

    def test_load_missing_key_explains_recovery(self):
        with self.assertRaises(hub.HubError) as cm:
            hub._load_identity_key(self.key_path())
        self.assertIn("key-restore", str(cm.exception))


# ---------------------------------------------------------------------------
# setup: keypair generated, public key sent in the redeem call
# ---------------------------------------------------------------------------


class TestSetupKey(E2EETestBase):
    def _add_redeem(self):
        self.fake.add(
            "POST",
            REDEEM_PATH,
            201,
            {
                "token": "fh_NEW_tok999",
                "token_id": "tokN",
                "member": {
                    "id": "m9",
                    "family_id": "c9",
                    "name": "Owner",
                    "role": "owner",
                },
            },
        )
        self.fake.add("GET", "/v2/me", 200, {"id": "m9", "name": "Owner"})

    def test_setup_sends_public_key_in_redeem(self):
        self._add_redeem()
        rc, out, err = self.run_cli(
            ["setup", "--server", "https://hub.example",
             "--invite", "fhp_E2EE01", "--store", "file"]
        )
        self.assertEqual(rc, 0)
        bodies = self.fake.bodies_for("POST", REDEEM_PATH)
        self.assertEqual(len(bodies), 1)
        pub_b64 = bodies[0].get("agent_public_key")
        self.assertIsNotNone(pub_b64, "redeem body must carry agent_public_key")
        self.assertEqual(len(base64.b64decode(pub_b64)), 32)
        # The registered public key matches the stored private key.
        priv = self.read_key()
        self.assertEqual(hub._public_key_b64(priv), pub_b64)
        self.assertEqual(self.file_mode(self.key_path()), 0o600)
        # Recovery material is private, never emitted into the agent transcript.
        phrase_path = os.path.join(hub.profile_dir("default"), "recovery-phrase.txt")
        with open(phrase_path, encoding="utf-8") as stream:
            phrase = stream.read().strip()
        self.assertEqual(hub._privkey_from_phrase(phrase), priv)
        self.assertEqual(self.file_mode(phrase_path), 0o600)
        self.assertNotIn(phrase, out + err)
        # The raw key itself never appears in output.
        self.assertNotIn(priv.hex(), out + err)
        self.assertNotIn(base64.b64encode(priv).decode(), out + err)

    def test_setup_without_pynacl_fails_clearly(self):
        self._add_redeem()
        with mock.patch.dict(
            sys.modules, {"nacl": None, "nacl.public": None, "nacl.pwhash": None}
        ):
            rc, out, err = self.run_cli(
                ["setup", "--server", "https://hub.example",
                 "--invite", "fhp_E2EE01", "--store", "file"]
            )
        self.assertNotEqual(rc, 0)
        self.assertIn("PyNaCl", err)
        # The code must not have been burned: no redeem call was made.
        self.assertEqual(self.fake.bodies_for("POST", REDEEM_PATH), [])


# ---------------------------------------------------------------------------
# key-backup / key-restore round-trip
# ---------------------------------------------------------------------------


class TestBackupRestore(E2EETestBase):
    def test_backup_restore_roundtrip(self):
        hub._ensure_identity_keypair("default")
        original = self.read_key()
        backup = os.path.join(self.tmp, "agent-key.backup")
        with mock.patch.object(
            hub.getpass, "getpass", side_effect=["s3cret-pass", "s3cret-pass"]
        ):
            rc, out, err = self.run_cli(["key-backup", "--out", backup])
        self.assertEqual(rc, 0)
        self.assertEqual(self.file_mode(backup), 0o600)
        with open(backup, encoding="utf-8") as fh:
            blob = json.load(fh)
        self.assertEqual(blob["kdf"], "argon2id")
        # The plaintext key is nowhere in the backup file.
        with open(backup, "rb") as fh:
            raw = fh.read()
        self.assertNotIn(original, raw)
        self.assertNotIn(original.hex().encode(), raw)

        # Lose the key, restore from the backup.
        os.unlink(self.key_path())
        with mock.patch.object(hub.getpass, "getpass", return_value="s3cret-pass"):
            rc, out, err = self.run_cli(
                ["key-restore", "--backup-file", backup, "--force"]
            )
        self.assertEqual(rc, 0)
        self.assertEqual(self.read_key(), original)
        self.assertEqual(self.file_mode(self.key_path()), 0o600)

    def test_restore_wrong_password_fails(self):
        hub._ensure_identity_keypair("default")
        backup = os.path.join(self.tmp, "agent-key.backup")
        with mock.patch.object(
            hub.getpass, "getpass", side_effect=["s3cret-pass", "s3cret-pass"]
        ):
            self.run_cli(["key-backup", "--out", backup])
        os.unlink(self.key_path())
        with mock.patch.object(hub.getpass, "getpass", return_value="wrong-pass"):
            rc, out, err = self.run_cli(
                ["key-restore", "--backup-file", backup, "--force"]
            )
        self.assertNotEqual(rc, 0)
        self.assertIn("Wrong password", err)
        self.assertFalse(os.path.exists(self.key_path()))

    def test_restore_from_phrase(self):
        priv, _pub, _new = hub._ensure_identity_keypair("default")
        phrase = hub._recovery_phrase(priv)
        os.unlink(self.key_path())
        with mock.patch.object(hub.getpass, "getpass", return_value=phrase):
            rc, out, err = self.run_cli(["key-restore", "--force"])
        self.assertEqual(rc, 0)
        self.assertEqual(self.read_key(), priv)

    def test_restore_refuses_to_clobber_without_force(self):
        hub._ensure_identity_keypair("default")
        # Key exists and no --force: refuses BEFORE prompting for anything.
        rc, out, err = self.run_cli(["key-restore"])
        self.assertNotEqual(rc, 0)
        self.assertIn("--force", err)


# ---------------------------------------------------------------------------
# key-init: registration via the rotate endpoint
# ---------------------------------------------------------------------------


class TestKeyInit(E2EETestBase):
    def _add_directory(self, keys):
        self.fake.add("GET", "/v2/me", 200,
                      {"id": "m1", "name": "Tester", "agent_label": "test-agent"})
        self.fake.add("GET", "/v2/agent-keys", 200, {"keys": keys})
        self.fake.add(
            "POST", "/v2/agent-keys/rotate", 200,
            {"member_id": "m1", "agent_label": "test-agent",
             "public_key": "PENDING", "created_at": "2026-10-11T00:00:00Z"},
        )

    def test_key_init_registers_and_is_idempotent(self):
        self.seed_config()
        self._add_directory(keys=[])
        rc, out, err = self.run_cli(["key-init"])
        self.assertEqual(rc, 0)
        rotates = self.fake.bodies_for("POST", "/v2/agent-keys/rotate")
        self.assertEqual(len(rotates), 1)
        sent = rotates[0]["agent_public_key"]
        self.assertEqual(sent, hub._public_key_b64(self.read_key()))
        self.assertIn("registered", out)

        # Second run: the directory now shows our key -> no rotate call.
        self.fake.calls.clear()
        self.fake.add(
            "GET", "/v2/agent-keys", 200,
            {"keys": [{"member_id": "m1", "agent_label": "test-agent",
                       "public_key": sent, "created_at": "2026-10-11T00:00:00Z"}]},
        )
        rc, out, err = self.run_cli(["key-init"])
        self.assertEqual(rc, 0)
        self.assertIn("already registered", out)
        self.assertEqual(self.fake.bodies_for("POST", "/v2/agent-keys/rotate"), [])

    def test_key_init_registers_preexisting_local_key(self):
        # Agent generated a key at setup (invite path) but never registered.
        self.seed_config()
        hub._ensure_identity_keypair("default")
        self._add_directory(keys=[])
        rc, out, err = self.run_cli(["key-init"])
        self.assertEqual(rc, 0)
        rotates = self.fake.bodies_for("POST", "/v2/agent-keys/rotate")
        self.assertEqual(len(rotates), 1)

    def test_key_material_never_in_debug_output(self):
        self.seed_config()
        self._add_directory(keys=[])
        rc, out, err = self.run_cli(["--debug", "key-init"])
        self.assertEqual(rc, 0)
        priv = self.read_key()
        blob = out + err
        self.assertNotIn(priv.hex(), blob)
        self.assertNotIn(base64.b64encode(priv).decode(), blob)


if __name__ == "__main__":
    unittest.main()
