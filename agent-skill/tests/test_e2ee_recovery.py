#!/usr/bin/env python3
"""Tests for E2EE Phase 5 — recovery ladder + archive-with-successor (CLI).

- `hub recover`: rung 1 restores the identity key from a key-backup file
  (conventional locations / --backup-file) or the 24-word recovery phrase;
  each rung is narrated and failures fall through to the next rung, never
  silently skipped. Rung 2 re-registers a fresh keypair and posts a visible
  key-request (exit 2 = "request posted, waiting for grant"); --wait polls
  until a member-agent grants. Rung 3 (no usable Bearer token) prints the
  exact out-of-band provisioning-code instructions.
- `hub topic-archive`: posts the plaintext `topic_archived` entry naming the
  successor, requires explicit confirmation (--yes bypasses), refuses
  non-owner/non-key-holders, and old history still decrypts for key-holders.
- SKILL.md carries the hard rule against silent topic replacement.

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
import sys
import tempfile
import unittest
import urllib.parse as urlparse
from importlib.machinery import SourceFileLoader
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
HUB_PATH = os.path.join(HERE, "..", "hub")
SKILL_PATH = os.path.join(HERE, "..", "SKILL.md")

spec = importlib.util.spec_from_file_location(
    "hubcli_e2ee_recovery", HUB_PATH, loader=SourceFileLoader("hubcli_e2ee_recovery", HUB_PATH)
)
hub = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hub)

from nacl.public import PrivateKey  # noqa: E402  (test dependency)

TOPIC_ID = "t-rec-1"
SUCCESSOR_ID = "t-rec-2"
ENTRY_KINDS = {
    "message", "key_rotated", "key_request", "pending_key_distribution",
    "topic_archived", "member_joined", "member_left",
}


class RecoveryFakeHub:
    """Stateful fake hub mirroring the server's access rules for recovery.

    - Participants gate topic-scoped calls (403 otherwise).
    - GET /v2/agent-keys?member_id=: registered keys per member.
    - POST /v2/agent-keys/rotate: registers the caller's new public key.
    - Envelopes POST: target must be a current participant with a registered
      key; GET returns only the caller's own envelopes.
    - entries POST: only known kinds; stored with seq/gseq.
    - grant_on_poll: when set, the Nth GET /v2/.../envelopes seals the topic
      key for the caller's current registered key (simulates a member-agent
      running `hub key-grant` after human approval).
    """

    def __init__(self, keys_by_member, members):
        self.calls = []
        self.health_calls = []
        self.keys_by_member = keys_by_member
        self.members = members
        self.topics = {}  # tid -> {"e2ee": 0|1, "participants": [member_id]}
        self.envelopes = []  # dicts: topic_id, member_id, agent_label, key_id, envelope
        self.entries = []
        self.caller = ("m1", "owner-agent")
        self.topic_keys = {}  # tid -> (key_id_hex, key_bytes)
        self.rotate_posts = []
        self.envelope_polls = 0
        self.grant_on_poll = None
        self.granted = False
        self._gseq = 0

    def _record(self, method, url, headers, body_bytes):
        self.calls.append(
            {
                "method": method,
                "url": url,
                "headers": dict(headers),
                "body": body_bytes.decode("utf-8") if body_bytes else None,
            }
        )

    def add_topic(self, tid, e2ee=1, participants=()):
        self.topics[tid] = {"e2ee": e2ee, "participants": list(participants)}

    def seal_for(self, tid, pub_b64):
        kid_hex, key = self.topic_keys[tid]
        return hub._e2ee_seal_envelope(tid, bytes.fromhex(kid_hex), key, pub_b64)

    def add_envelope(self, tid, member_id, agent_label, pub_b64):
        self.envelopes.append(
            {
                "topic_id": tid,
                "member_id": member_id,
                "agent_label": agent_label,
                "key_id": self.topic_keys[tid][0],
                "envelope": self.seal_for(tid, pub_b64),
                "commitment": hashlib.sha256(self.topic_keys[tid][1]).hexdigest(),
            }
        )

    def __call__(self, method, url, headers, body_bytes):
        parts = urlparse.urlparse(url)
        path = parts.path
        query = urlparse.parse_qs(parts.query)
        method = method.upper()

        # The fake models a current-release server: auto-answer the
        # per-invocation version check in main(). Recorded separately so
        # command-traffic assertions keep their meaning.
        if method == "GET" and path == "/v2/health":
            self.health_calls.append(
                {
                    "method": method,
                    "url": url,
                    "headers": dict(headers),
                    "body": body_bytes.decode("utf-8") if body_bytes else None,
                }
            )
            return 200, json.dumps(
                {"ok": True, "version": hub.VERSION, "api_versions": ["v2"]}
            )

        self._record(method, url, headers, body_bytes)
        body = json.loads(body_bytes.decode("utf-8")) if body_bytes else {}
        mid, label = self.caller

        if method == "GET" and path == "/v2/me":
            m = self.members[mid]
            return 200, json.dumps(
                {"id": mid, "name": m["name"], "role": m["role"],
                 "agent_label": label, "family_id": "f1"}
            )
        if method == "GET" and path == "/v2/agent-keys":
            qmid = (query.get("member_id") or [""])[0]
            keys = [
                {"member_id": qmid, "agent_label": lab, "public_key": pub,
                 "created_at": "2026-10-11T00:00:00Z"}
                for lab, pub in self.keys_by_member.get(qmid, [])
            ]
            return 200, json.dumps({"keys": keys})
        if method == "POST" and path == "/v2/agent-keys/rotate":
            pub = body.get("agent_public_key")
            if not pub:
                return 400, json.dumps(
                    {"error": {"code": "bad_request", "message": "no key"}})
            entries = self.keys_by_member.setdefault(mid, [])
            entries[:] = [(l, p) for l, p in entries if l != label]
            entries.append((label, pub))
            self.rotate_posts.append({"member_id": mid, "agent_label": label})
            return 200, json.dumps(
                {"member_id": mid, "agent_label": label, "public_key": pub,
                 "created_at": "2026-10-11T00:00:00Z"}
            )

        segs = path.strip("/").split("/")
        if len(segs) >= 3 and segs[0] == "v2" and segs[1] == "topics":
            tid = urlparse.unquote(segs[2])
            topic = self.topics.get(tid)
            if topic is None:
                return 404, json.dumps(
                    {"error": {"code": "not_found", "message": "no topic"}})
            if mid not in topic["participants"]:
                return 403, json.dumps(
                    {"error": {"code": "forbidden", "message": "not a participant"}})
            sub = segs[3] if len(segs) > 3 else None

            if method == "GET" and sub is None:
                return 200, json.dumps(
                    {"topic": {"id": tid, "e2ee": topic["e2ee"]},
                     "participants": [
                         {"member_id": p, "name": self.members[p]["name"]}
                         for p in topic["participants"]
                     ]})
            if method == "GET" and sub == "history":
                return 200, json.dumps(
                    {"entries": [e for e in self.entries if e["topic_id"] == tid]})
            if sub == "envelopes" and method == "POST":
                tmid, tlabel = body.get("member_id"), body.get("agent_label")
                if tmid not in topic["participants"]:
                    return 400, json.dumps(
                        {"error": {"code": "bad_request",
                                  "message": "target must be a current participant"}})
                if tlabel not in [l for l, _ in self.keys_by_member.get(tmid, [])]:
                    return 400, json.dumps(
                        {"error": {"code": "bad_request",
                                  "message": "target has no registered identity key"}})
                rec = {"topic_id": tid, "member_id": tmid, "agent_label": tlabel,
                       "key_id": body.get("key_id"), "envelope": body.get("envelope"),
                       "created_at": "2026-10-11T00:00:00Z"}
                self.envelopes.append(rec)
                return 201, json.dumps(rec)
            if sub == "envelopes" and method == "GET":
                self.envelope_polls += 1
                # Simulated member-agent grant after human approval.
                if (self.grant_on_poll is not None and not self.granted
                        and self.envelope_polls >= self.grant_on_poll
                        and tid in self.topic_keys):
                    current = dict(self.keys_by_member.get(mid, [])).get(label)
                    if current:
                        self.add_envelope(tid, mid, label, current)
                        self.granted = True
                mine = [e for e in self.envelopes
                        if e["topic_id"] == tid and e["member_id"] == mid
                        and e["agent_label"] == label]
                return 200, json.dumps({"envelopes": mine})
            if sub == "entries" and method == "POST":
                kind = body.get("kind", "message")
                if kind not in ENTRY_KINDS:
                    return 400, json.dumps(
                        {"error": {"code": "bad_request", "message": "bad kind"}})
                self._gseq += 1
                e = {"topic_id": tid,
                     "seq": sum(1 for x in self.entries if x["topic_id"] == tid) + 1,
                     "gseq": self._gseq, "ts": "2026-10-11T00:00:00Z",
                     "actor_member_id": mid, "agent_label": label,
                     "kind": kind, "body": body.get("body"), "data": body.get("data")}
                self.entries.append(e)
                return 201, json.dumps({"entry": e})
        return 404, json.dumps({"error": {"code": "not_found", "message": "no route"}})

    def entry_posts(self, kind=None):
        out = [c for c in self.calls
               if c["method"] == "POST" and c["url"].endswith("/entries")]
        if kind:
            out = [c for c in out if json.loads(c["body"])["kind"] == kind]
        return out


@contextlib.contextmanager
def captured():
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        yield out, err


FAKE_TOKEN = "fh-test-token"


class E2eeRecoveryTestBase(unittest.TestCase):
    def setUp(self):
        self._saved_env = dict(os.environ)
        self.tmp = tempfile.mkdtemp(prefix="hubtest-recovery-")
        os.environ["FAMILY_HUB_CONFIG_HOME"] = self.tmp
        os.environ["HOME"] = self.tmp
        os.environ["FAMILY_HUB_TOKEN"] = FAKE_TOKEN
        os.environ.pop("FAMILY_HUB_VAULT_CMD", None)
        # Fresh version-check state: the fake models a current server.
        hub._reset_server_version_cache()
        self.privs = {}
        self.pubs = {}
        for mid, label in [("m1", "owner-agent"), ("m2", "bee-agent")]:
            sk = PrivateKey.generate()
            self.privs[(mid, label)] = sk
            self.pubs[(mid, label)] = hub._public_key_b64(bytes(sk))
        self.fake = RecoveryFakeHub(
            keys_by_member={
                "m1": [("owner-agent", self.pubs[("m1", "owner-agent")])],
                "m2": [("bee-agent", self.pubs[("m2", "bee-agent")])],
            },
            members={
                "m1": {"name": "Owner", "role": "owner"},
                "m2": {"name": "Bee", "role": "parent"},
                "m3": {"name": "Kid", "role": "kid"},
            },
        )
        self.seed_config("default", "m1", "owner-agent")
        self.write_identity_key("default", ("m1", "owner-agent"))
        # E2EE topic with a known key; m1 holds an envelope for its key.
        self.key_id_hex = "ab" * 16
        self.topic_key = b"K" * 32
        self.fake.topic_keys[TOPIC_ID] = (self.key_id_hex, self.topic_key)
        self.fake.add_topic(TOPIC_ID, e2ee=1, participants=["m1", "m2"])
        self.fake.add_topic(SUCCESSOR_ID, e2ee=1, participants=["m1", "m2"])
        self.fake.add_envelope(
            TOPIC_ID, "m1", "owner-agent", self.pubs[("m1", "owner-agent")])
        hub._merge_topic_key("default", TOPIC_ID, self.key_id_hex, self.topic_key)

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._saved_env)
        shutil.rmtree(self.tmp, ignore_errors=True)
        hub.clear_secrets()

    def seed_config(self, profile, member_id, agent_label):
        role = self.fake.members[member_id]["role"]
        hub.save_config(
            profile,
            {
                "server_url": "https://hub.example",
                "member": {"id": member_id, "name": member_id, "role": role},
                "family_id": "f1",
                "agent_label": agent_label,
                "auth_method": "env",
            },
        )

    def write_identity_key(self, profile, who):
        hub._write_secret_file_0600(
            hub.agent_key_path(profile), bytes(self.privs[who]), "test key"
        )

    def run_cli(self, argv):
        with captured() as (out, err):
            rc = hub.main(argv, transport=self.fake)
        return rc, out.getvalue(), err.getvalue()

    def drop_identity_key(self, profile="default"):
        os.unlink(hub.agent_key_path(profile))

    def drop_keystore(self, profile="default", topic_id=TOPIC_ID):
        path = os.path.join(hub.topic_keys_dir(profile), topic_id + ".json")
        if os.path.exists(path):
            os.unlink(path)


class TestRecoverNoop(E2eeRecoveryTestBase):
    def test_recover_noop_when_keys_present(self):
        rc, out, err = self.run_cli(["recover", "--topic", TOPIC_ID])
        self.assertEqual(rc, 0, "stderr: %s" % err)
        self.assertIn("no recovery needed", out)
        # The ladder never climbed: no rung ran.
        self.assertNotIn("[rung 1/3]", err)
        self.assertNotIn("[rung 2/3]", err)


class TestRecoverRung1(E2eeRecoveryTestBase):
    def write_backup(self, path):
        blob = hub._encrypt_key_backup(
            bytes(self.privs[("m1", "owner-agent")]), "correct horse")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(blob, fh)

    def test_rung1_backup_file_restores(self):
        self.drop_identity_key()
        self.drop_keystore()
        backup_path = os.path.join(self.tmp, "my-backup.json")
        self.write_backup(backup_path)
        with mock.patch.object(
            hub.getpass, "getpass", return_value="correct horse"
        ):
            rc, out, err = self.run_cli(
                ["recover", "--topic", TOPIC_ID, "--backup-file", backup_path])
        self.assertEqual(rc, 0, "stderr: %s" % err)
        self.assertIn("[rung 1/3]", err)
        # Identity key restored byte-identical...
        restored = hub._load_identity_key(hub.agent_key_path("default"))
        self.assertEqual(restored, bytes(self.privs[("m1", "owner-agent")]))
        # ...and the topic key was fetched from the existing envelope.
        keys = hub._load_topic_keys("default", TOPIC_ID)
        self.assertEqual(keys.get(self.key_id_hex), self.topic_key)
        self.assertIn("recovered at rung 1", out)

    def test_rung1_wrong_password_fails_loudly_then_falls_through(self):
        self.drop_identity_key()
        self.drop_keystore()
        backup_path = os.path.join(self.tmp, "my-backup.json")
        self.write_backup(backup_path)
        # Wrong password, then decline the phrase, so rung 2 runs instead.
        with mock.patch.object(hub.getpass, "getpass", return_value="wrong password"), \
             mock.patch.object(hub, "_prompt", side_effect=["", "n"]):
            rc, out, err = self.run_cli(
                ["recover", "--topic", TOPIC_ID, "--backup-file", backup_path])
        self.assertEqual(rc, 2, "stderr: %s" % err)  # rung 2 posted the request
        self.assertIn("did not decrypt", err)
        self.assertIn("[rung 2/3]", err)

    def test_rung1_phrase_restore(self):
        self.drop_identity_key()
        self.drop_keystore()
        phrase = hub._recovery_phrase(bytes(self.privs[("m1", "owner-agent")]))
        with mock.patch.object(hub, "_prompt", side_effect=["", "y"]), \
             mock.patch.object(hub.getpass, "getpass", return_value=phrase):
            rc, out, err = self.run_cli(["recover", "--topic", TOPIC_ID])
        self.assertEqual(rc, 0, "stderr: %s" % err)
        restored = hub._load_identity_key(hub.agent_key_path("default"))
        self.assertEqual(restored, bytes(self.privs[("m1", "owner-agent")]))
        keys = hub._load_topic_keys("default", TOPIC_ID)
        self.assertEqual(keys.get(self.key_id_hex), self.topic_key)

    def test_rung1_skipped_when_identity_key_present(self):
        # Identity key present but keystore empty and no envelope waiting:
        # rung 1 is skipped aloud, rung 2 posts the key-request.
        self.drop_keystore()
        self.fake.envelopes = []
        with mock.patch.object(hub, "_prompt", return_value=""):
            rc, out, err = self.run_cli(["recover", "--topic", TOPIC_ID])
        self.assertEqual(rc, 2, "stderr: %s" % err)
        self.assertIn("[rung 1/3] skipped", err)
        self.assertIn("[rung 2/3]", err)


# ---------------------------------------------------------------------------
# secfix F5 — Argon2 parameters from the backup file are bounds-checked
# ---------------------------------------------------------------------------


class TestKeyBackupKdfBounds(unittest.TestCase):
    """A tampered backup file must not be able to force a huge KDF allocation.

    _decrypt_key_backup clamps opslimit/memlimit to [libsodium minimum, 64 /
    1 GiB] and raises a loud HubError on violation; a KDF allocation failure
    surfaces as HubError, never a crash. Valid backups still restore.
    """

    def setUp(self):
        self.priv = bytes(PrivateKey.generate())
        self.password = "correct horse"
        self.blob = hub._encrypt_key_backup(self.priv, self.password)

    def test_valid_backup_restores(self):
        self.assertEqual(
            hub._decrypt_key_backup(dict(self.blob), self.password), self.priv)

    def test_huge_memlimit_rejected(self):
        bad = dict(self.blob, memlimit=1 << 40)
        with self.assertRaises(hub.HubError) as cm:
            hub._decrypt_key_backup(bad, self.password)
        self.assertIn("memlimit", str(cm.exception))

    def test_huge_opslimit_rejected(self):
        bad = dict(self.blob, opslimit=10 ** 6)
        with self.assertRaises(hub.HubError) as cm:
            hub._decrypt_key_backup(bad, self.password)
        self.assertIn("opslimit", str(cm.exception))

    def test_below_minimum_rejected(self):
        for field in ("opslimit", "memlimit"):
            bad = dict(self.blob, **{field: 0})
            with self.assertRaises(hub.HubError, msg=field):
                hub._decrypt_key_backup(bad, self.password)

    def test_wrong_password_still_loud(self):
        # Bounds checks run before the KDF; a wrong password still fails
        # loudly (not silently) after them.
        with self.assertRaises(hub.HubError):
            hub._decrypt_key_backup(dict(self.blob), "wrong password")


class TestRecoverRung2(E2eeRecoveryTestBase):
    def test_rung2_reregisters_and_posts_request_exit_2(self):
        self.drop_identity_key()
        self.drop_keystore()
        with mock.patch.object(hub, "_prompt", side_effect=["", "n"]):
            rc, out, err = self.run_cli(["recover", "--topic", TOPIC_ID])
        self.assertEqual(rc, 2, "stderr: %s" % err)
        # Fresh keypair was generated and registered via the rotate endpoint.
        self.assertEqual(len(self.fake.rotate_posts), 1)
        new_pub = self.fake.keys_by_member["m1"][0][1]
        self.assertNotEqual(new_pub, self.pubs[("m1", "owner-agent")])
        # A visible key-request was posted; nothing was auto-granted.
        reqs = self.fake.entry_posts("key_request")
        self.assertEqual(len(reqs), 1)
        self.assertEqual(json.loads(reqs[0]["body"])["data"], {"member_id":"m1", "agent_label":"owner-agent"})
        self.assertIn("waiting", err)
        self.assertIn("[rung 1/3] FAILED", err)
        self.assertIn("[rung 2/3]", err)
        # Keystore is still empty — the grant hasn't landed.
        self.assertEqual(hub._load_topic_keys("default", TOPIC_ID), {})

    def test_rung2_wait_grant_flow(self):
        self.drop_identity_key()
        self.drop_keystore()
        self.fake.grant_on_poll = 3
        with mock.patch.object(hub, "_prompt", side_effect=["", "n"]):
            rc, out, err = self.run_cli(
                ["recover", "--topic", TOPIC_ID, "--wait",
                 "--wait-interval", "0.01", "--wait-timeout", "5"])
        self.assertEqual(rc, 0, "stderr: %s" % err)
        self.assertTrue(self.fake.granted, "the simulated grant never landed")
        keys = hub._load_topic_keys("default", TOPIC_ID)
        self.assertEqual(keys.get(self.key_id_hex), self.topic_key)
        self.assertIn("grant received", err)

    def test_rung2_wait_timeout_parks_at_exit_2(self):
        self.drop_identity_key()
        self.drop_keystore()
        with mock.patch.object(hub, "_prompt", side_effect=["", "n"]):
            rc, out, err = self.run_cli(
                ["recover", "--topic", TOPIC_ID, "--wait",
                 "--wait-interval", "0.01", "--wait-timeout", "0.05"])
        self.assertEqual(rc, 2, "stderr: %s" % err)
        self.assertIn("timed out waiting for the grant", err)


class TestRecoverRung3(E2eeRecoveryTestBase):
    def test_rung3_missing_token_prints_instructions(self):
        os.environ.pop("FAMILY_HUB_TOKEN", None)
        self.drop_identity_key()
        self.drop_keystore()
        with mock.patch.object(hub, "_prompt", return_value=""):
            rc, out, err = self.run_cli(["recover", "--topic", TOPIC_ID])
        self.assertEqual(rc, 3, "stdout: %s\nstderr: %s" % (out, err))
        self.assertIn("[rung 3/3]", err)
        self.assertIn("provisioning code", err)
        self.assertIn("hub agent-invite", err)
        self.assertIn("--recover-email YOUR-EMAIL", err)
        self.assertIn("does not restore historical topic keys", err)
        self.assertIn("[rung 2/3] SKIPPED", err)

    def test_rung3_identity_only_without_topic(self):
        os.environ.pop("FAMILY_HUB_TOKEN", None)
        self.drop_identity_key()
        with mock.patch.object(hub, "_prompt", return_value=""):
            rc, out, err = self.run_cli(["recover"])
        self.assertEqual(rc, 3, "stderr: %s" % err)
        self.assertIn("[rung 3/3]", err)
        self.assertIn("hub recover --topic <id>", err)


class TestTopicArchive(E2eeRecoveryTestBase):
    def test_archive_posts_entry_with_successor(self):
        rc, out, err = self.run_cli(
            ["topic-archive", "--topic", TOPIC_ID, "--successor", SUCCESSOR_ID, "--yes"])
        self.assertEqual(rc, 0, "stderr: %s" % err)
        posts = self.fake.entry_posts("topic_archived")
        self.assertEqual(len(posts), 1)
        payload = json.loads(posts[0]["body"])
        self.assertNotIn("body", payload)
        data = payload["data"]
        self.assertEqual(data["successor_topic_id"], SUCCESSOR_ID)
        self.assertNotIn("reason", data)
        self.assertEqual(data["archived_by"], "m1")
        result = json.loads(out)
        self.assertEqual(result["topic_id"], TOPIC_ID)

    def test_archive_requires_confirmation(self):
        with mock.patch.object(hub, "_prompt", return_value="no"):
            rc, out, err = self.run_cli(
                ["topic-archive", "--topic", TOPIC_ID,
                 "--successor", SUCCESSOR_ID,])
        self.assertEqual(rc, 1, "stderr: %s" % err)
        self.assertEqual(self.fake.entry_posts("topic_archived"), [])
        self.assertIn("archive cancelled", err)

    def test_archive_yes_bypasses_prompt(self):
        prompter = mock.patch.object(
            hub, "_prompt", side_effect=AssertionError("prompt must not run"))
        with prompter:
            rc, out, err = self.run_cli(
                ["topic-archive", "--topic", TOPIC_ID,
                 "--yes"])
        self.assertEqual(rc, 0, "stderr: %s" % err)
        self.assertEqual(len(self.fake.entry_posts("topic_archived")), 1)

    def test_archive_refuses_kid_without_key(self):
        self.seed_config("kidprof", "m3", "kid-agent")
        self.fake.caller = ("m3", "kid-agent")
        # m3 is not a participant of the topic at all here -> 403 surfaces
        # first; make m3 a participant without keys to reach the role check.
        self.fake.topics[TOPIC_ID]["participants"].append("m3")
        with mock.patch.object(hub, "_prompt", return_value="yes"):
            with captured() as (out, err):
                rc = hub.main(
                    ["--profile", "kidprof", "topic-archive", "--topic", TOPIC_ID,],
                    transport=self.fake,
                )
        self.assertEqual(rc, 1, "stderr: %s" % err.getvalue())
        self.assertIn("Only an owner or parent",
                      err.getvalue())
        self.assertEqual(self.fake.entry_posts("topic_archived"), [])

    def test_archive_allows_remaining_key_holder(self):
        # A parent (not owner) holding the topic key may archive.
        self.seed_config("beeprof", "m2", "bee-agent")
        self.write_identity_key("beeprof", ("m2", "bee-agent"))
        hub._merge_topic_key("beeprof", TOPIC_ID, self.key_id_hex, self.topic_key)
        self.fake.caller = ("m2", "bee-agent")
        with captured() as (out, err):
            rc = hub.main(
                ["--profile", "beeprof", "topic-archive", "--topic", TOPIC_ID, "--yes"],
                transport=self.fake,
            )
        self.assertEqual(rc, 0, "stderr: %s" % err.getvalue())
        self.assertEqual(len(self.fake.entry_posts("topic_archived")), 1)

    def test_archive_unknown_successor_refused(self):
        rc, out, err = self.run_cli(
            ["topic-archive", "--topic", TOPIC_ID, "--successor", "nope", "--yes"])
        self.assertEqual(rc, 1, "stderr: %s" % err)
        self.assertEqual(self.fake.entry_posts("topic_archived"), [])

    def test_old_history_still_decrypts_after_archive(self):
        wire = hub._e2ee_encrypt_field(
            b"old secret", TOPIC_ID, self.key_id_hex, self.topic_key)
        self.fake.entries.append(
            {"topic_id": TOPIC_ID, "seq": 1, "gseq": 1, "ts": "2026-10-11T00:00:00Z",
             "actor_member_id": "m1", "agent_label": "owner-agent",
             "kind": "message", "body": wire, "data": None})
        rc, out, err = self.run_cli(
            ["topic-archive", "--topic", TOPIC_ID, "--successor", SUCCESSOR_ID, "--yes"])
        self.assertEqual(rc, 0, "stderr: %s" % err)
        rc, out, err = self.run_cli(["read", "--topic", TOPIC_ID])
        self.assertEqual(rc, 0, "stderr: %s" % err)
        entries = json.loads(out)["entries"]
        bodies = [e["body"] for e in entries]
        self.assertIn("old secret", bodies)
        kinds = [e["kind"] for e in entries]
        self.assertIn("topic_archived", kinds)


class TestSkillHardRule(unittest.TestCase):
    def test_skillmd_recovery_hard_rule_present(self):
        with open(SKILL_PATH, "r", encoding="utf-8") as fh:
            text = fh.read()
        flat = " ".join(text.split())
        self.assertIn(
            "never create a replacement topic for key-loss reasons without "
            "completing `hub recover` first",
            flat,
        )
        self.assertIn("hub recover --topic <id> [--wait]", text)
        self.assertIn("hub topic-archive --topic <id> --successor", text)
        # The agent-facing half of the rule: ask, don't silently follow.
        self.assertIn("do not silently", flat)


if __name__ == "__main__":
    unittest.main()
