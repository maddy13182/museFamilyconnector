#!/usr/bin/env python3
"""Tests for E2EE Phase 4 — membership changes + re-keying (CLI).

Full flows with a stateful mocked transport:

- topic-add-member: seals the CURRENT key (never old keys) for the new
  member's agents; refuses non-participants (never auto-invites); posts a
  visible pending_key_distribution notice when the member has no registered
  keys.
- topic-remove-member + topic-rekey: removed member's old key cannot decrypt
  post-rotation messages; remaining members can; old history still decrypts
  with retained keys; the rotation announcement is plaintext (kind
  key_rotated); hub post uses the new key afterwards.
- key-request / key-grant: request posts visibly with no auto-fulfillment;
  grant seals the current key only after explicit human approval (prompt, or
  --yes); declining grants nothing.
- key-fetch: merges new envelopes into the keystore without dropping old keys.
- hub sync opportunistically refreshes envelopes for E2EE topics.

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
    "hubcli_e2ee_rekey", HUB_PATH, loader=SourceFileLoader("hubcli_e2ee_rekey", HUB_PATH)
)
hub = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hub)

from nacl.public import PrivateKey  # noqa: E402  (test dependency)
from nacl import bindings  # noqa: E402

TOPIC_ID = "t-rekey-1"
ENTRY_KINDS = {
    "message", "key_rotated", "key_request", "pending_key_distribution",
    "member_joined", "member_left",
}


class RekeyFakeHub:
    """Stateful fake hub mirroring the server's Phase 4 access rules.

    - Participants gate every topic-scoped call (403 otherwise).
    - Envelopes POST: target must be a current participant with a registered
      key (400 otherwise); GET returns only the caller's own envelopes,
      ordered by created_at ASC like the server.
    - entries POST: only known kinds; stored with seq/gseq.
    - DELETE participants: caller must be owner/parent (403 otherwise);
      appends a member_left entry.
    """

    def __init__(self, keys_by_member, members):
        # keys_by_member: member_id -> [(agent_label, pub_b64)]
        # members: member_id -> {"name":..., "role":...}
        self.calls = []
        self.keys_by_member = keys_by_member
        self.members = members
        self.topics = {}  # tid -> {"e2ee": 0|1, "participants": [member_id]}
        self.envelopes = []  # dicts with topic_id, member_id, agent_label, key_id, envelope, created_at
        self.entries = []  # dicts with topic_id, seq, gseq, kind, body, data, actor_member_id
        self.caller = ("m1", "owner-agent")
        self._env_counter = 0
        self._gseq = 0

    # -- transport -----------------------------------------------------
    def _record(self, method, url, headers, body_bytes):
        self.calls.append(
            {
                "method": method,
                "url": url,
                "headers": dict(headers),
                "body": body_bytes.decode("utf-8") if body_bytes else None,
            }
        )

    def __call__(self, method, url, headers, body_bytes):
        self._record(method, url, headers, body_bytes)
        parts = urlparse.urlparse(url)
        path = parts.path
        query = urlparse.parse_qs(parts.query)
        method = method.upper()
        body = json.loads(body_bytes.decode("utf-8")) if body_bytes else {}
        mid, _label = self.caller

        if method == "GET" and path == "/v1/me":
            m = self.members[mid]
            return 200, json.dumps(
                {"id": mid, "name": m["name"], "role": m["role"],
                 "agent_label": self.caller[1], "family_id": "f1"}
            )
        if method == "GET" and path == "/v1/agent-keys":
            qmid = (query.get("member_id") or [""])[0]
            keys = [
                {"member_id": qmid, "agent_label": label, "public_key": pub,
                 "created_at": "2026-10-11T00:00:00Z"}
                for label, pub in self.keys_by_member.get(qmid, [])
            ]
            return 200, json.dumps({"keys": keys})

        m = urlparse.urlparse(path)
        segs = path.strip("/").split("/")

        # POST /v1/topics (create)
        if method == "POST" and path == "/v1/topics":
            pids = list(dict.fromkeys(body.get("participant_member_ids") or []))
            self.topics[TOPIC_ID] = {"e2ee": body.get("e2ee") or 0, "participants": pids}
            return 201, json.dumps({"topic": {"id": TOPIC_ID, "e2ee": body.get("e2ee") or 0}})

        # /v1/topics/<tid>/...
        if len(segs) >= 3 and segs[0] == "v1" and segs[1] == "topics":
            tid = urlparse.unquote(segs[2])
            topic = self.topics.get(tid)
            if topic is None:
                return 404, json.dumps({"error": {"code": "not_found", "message": "no topic"}})
            if mid not in topic["participants"]:
                return 403, json.dumps({"error": {"code": "forbidden", "message": "not a participant"}})
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
            if method == "POST" and sub == "invite":
                added = []
                for m2 in body.get("member_ids") or []:
                    if m2 not in topic["participants"]:
                        topic["participants"].append(m2)
                        added.append(m2)
                        self._append_entry(tid, "member_joined",
                                           "%s joined the topic" % self.members[m2]["name"],
                                           {"member_id": m2})
                return 200, json.dumps({"added": added})
            if method == "DELETE" and sub == "participants" and len(segs) > 4:
                target = urlparse.unquote(segs[4])
                if self.members[mid]["role"] not in ("owner", "parent"):
                    return 403, json.dumps({"error": {"code": "forbidden", "message": "owner/parent only"}})
                if target not in topic["participants"]:
                    return 400, json.dumps({"error": {"code": "bad_request", "message": "not a participant"}})
                if len(topic["participants"]) <= 1:
                    return 400, json.dumps({"error": {"code": "bad_request", "message": "last participant"}})
                topic["participants"].remove(target)
                self._append_entry(tid, "member_left",
                                   "%s was removed from the topic" % self.members[target]["name"],
                                   {"member_id": target})
                return 200, json.dumps({"removed": target})
            if sub == "envelopes" and method == "POST":
                tmid, tlabel = body.get("member_id"), body.get("agent_label")
                if tmid not in topic["participants"]:
                    return 400, json.dumps({"error": {"code": "bad_request",
                                                      "message": "target must be a current participant"}})
                if tlabel not in [l for l, _ in self.keys_by_member.get(tmid, [])]:
                    return 400, json.dumps({"error": {"code": "bad_request",
                                                      "message": "target has no registered identity key"}})
                self._env_counter += 1
                rec = {"topic_id": tid, "member_id": tmid, "agent_label": tlabel,
                       "key_id": body.get("key_id"), "envelope": body.get("envelope"),
                       "created_at": "2026-10-11T00:00:%02dZ" % self._env_counter}
                self.envelopes.append(rec)
                return 201, json.dumps(rec)
            if sub == "envelopes" and method == "GET":
                mine = [e for e in self.envelopes
                        if e["topic_id"] == tid and e["member_id"] == mid
                        and e["agent_label"] == self.caller[1]]
                mine.sort(key=lambda e: e["created_at"])
                return 200, json.dumps({"envelopes": mine})
            if sub == "entries" and method == "POST":
                kind = body.get("kind", "message")
                if kind not in ENTRY_KINDS:
                    return 400, json.dumps({"error": {"code": "bad_request", "message": "bad kind"}})
                e = self._append_entry(tid, kind, body.get("body"), body.get("data"))
                return 201, json.dumps({"entry": e})
        if method == "GET" and path == "/v1/sync":
            after = int((query.get("after_gseq") or ["0"])[0])
            ents = [e for e in self.entries if e["gseq"] > after]
            return 200, json.dumps({"entries": ents, "next_after_gseq": self._gseq})
        return 404, json.dumps({"error": {"code": "not_found", "message": "no route"}})

    def _append_entry(self, tid, kind, body, data):
        self._gseq += 1
        seq = sum(1 for e in self.entries if e["topic_id"] == tid) + 1
        e = {"topic_id": tid, "seq": seq, "gseq": self._gseq, "ts": "2026-10-11T00:00:00Z",
             "actor_member_id": self.caller[0], "agent_label": self.caller[1],
             "kind": kind, "body": body, "data": data}
        self.entries.append(e)
        return e

    def envelope_posts(self, topic_id=TOPIC_ID):
        return [c for c in self.calls
                if c["method"] == "POST" and c["url"].endswith("/envelopes")]

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


FAKE_TOKEN = "<redacted>"


class E2eeRekeyTestBase(unittest.TestCase):
    def setUp(self):
        self._saved_env = dict(os.environ)
        self.tmp = tempfile.mkdtemp(prefix="hubtest-rekey-")
        os.environ["FAMILY_HUB_CONFIG_HOME"] = self.tmp
        os.environ["FAMILY_HUB_TOKEN"] = FAKE_TOKEN
        os.environ.pop("FAMILY_HUB_VAULT_CMD", None)
        # Identity keypairs for four members' agents.
        self.privs = {}
        self.pubs = {}
        for mid, label in [("m1", "owner-agent"), ("m2", "bee-agent"),
                           ("m3", "cee-agent"), ("m5", "eee-agent")]:
            sk = PrivateKey.generate()
            self.privs[(mid, label)] = sk
            self.pubs[(mid, label)] = base64.b64encode(bytes(sk.public_key)).decode("ascii")
        # m4 has NO registered keys (pending-state tests).
        self.fake = RekeyFakeHub(
            keys_by_member={
                "m1": [("owner-agent", self.pubs[("m1", "owner-agent")])],
                "m2": [("bee-agent", self.pubs[("m2", "bee-agent")])],
                "m3": [("cee-agent", self.pubs[("m3", "cee-agent")])],
                "m5": [("eee-agent", self.pubs[("m5", "eee-agent")])],
            },
            members={
                "m1": {"name": "Owner", "role": "owner"},
                "m2": {"name": "Bee", "role": "parent"},
                "m3": {"name": "Cee", "role": "parent"},
                "m4": {"name": "Dee", "role": "parent"},
                "m5": {"name": "Eee", "role": "parent"},
            },
        )
        self.seed_config("default", "m1", "owner-agent", "owner")
        self.write_identity_key("default", ("m1", "owner-agent"))

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._saved_env)
        shutil.rmtree(self.tmp, ignore_errors=True)
        hub.clear_secrets()

    def seed_config(self, profile, member_id, agent_label, role):
        hub.save_config(
            profile,
            {
                "server_url": "https://hub.example",
                "member": {"id": member_id, "name": member_id, "role": role},
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

    def as_member(self, profile, member_id, agent_label, role="parent"):
        """Switch the fake's caller identity and seed that profile."""
        self.seed_config(profile, member_id, agent_label, role)
        self.write_identity_key(profile, (member_id, agent_label))
        self.fake.caller = (member_id, agent_label)

    def create_e2ee_topic(self, with_members):
        rc, out, err = self.run_cli(
            ["new-topic", "--e2ee", "--subject", "rekey test",
             "--with", ",".join(with_members)]
        )
        self.assertEqual(rc, 0, "stderr: %s" % err)
        result = json.loads(out)
        key_id = result["e2ee"]["key_id"]
        keys = hub._load_topic_keys("default", TOPIC_ID)
        return key_id, keys[key_id]

    def keystore(self, profile, topic_id=TOPIC_ID):
        return hub._load_topic_keys(profile, topic_id)


class TestMergeTopicKey(E2eeRekeyTestBase):
    def test_merge_keeps_old_keys_and_stays_0600(self):
        kid1 = "aa" * 16
        hub._merge_topic_key("default", TOPIC_ID, kid1, b"1" * 32)
        kid2 = "bb" * 16
        path = hub._merge_topic_key("default", TOPIC_ID, kid2, b"2" * 32)
        keys = hub._load_topic_keys("default", TOPIC_ID)
        self.assertEqual(keys[kid1], b"1" * 32)
        self.assertEqual(keys[kid2], b"2" * 32)
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)

    def test_merge_refuses_corrupt_keystore(self):
        path = os.path.join(hub.topic_keys_dir("default"), TOPIC_ID + ".json")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w") as fh:
            fh.write("{not json")
        with self.assertRaises(hub.HubError):
            hub._merge_topic_key("default", TOPIC_ID, "cc" * 16, b"3" * 32)


class TestTopicAddMember(E2eeRekeyTestBase):
    def test_add_member_gets_current_key_only(self):
        old_id, old_key = self.create_e2ee_topic(["m1", "m2"])
        # Rotate once so "current" != the original key.
        rc, out, err = self.run_cli(["topic-rekey", "--topic", TOPIC_ID])
        self.assertEqual(rc, 0, "stderr: %s" % err)
        new_id = json.loads(out)["key_id"]
        self.assertNotEqual(new_id, old_id)

        # Server step, then the envelope step for m3.
        rc, out, err = self.run_cli(
            ["invite", "--topic", TOPIC_ID, "--member", "m3"])
        self.assertEqual(rc, 0, "stderr: %s" % err)
        rc, out, err = self.run_cli(
            ["topic-add-member", "--topic", TOPIC_ID, "--member", "m3"])
        self.assertEqual(rc, 0, "stderr: %s" % err)
        result = json.loads(out)
        self.assertEqual(result["key_id"], new_id)
        self.assertEqual(result["pending_key_distribution"], [])

        # m3's envelope opens to the CURRENT key only — never the old key.
        posts = [c for c in self.fake.envelope_posts()
                 if json.loads(c["body"])["member_id"] == "m3"]
        self.assertTrue(posts, "no envelope posted for m3")
        sealed = base64.b64decode(json.loads(posts[0]["body"])["envelope"])
        pub = bytes(self.privs[("m3", "cee-agent")].public_key)
        opened = bindings.crypto_box_seal_open(
            sealed, pub, bytes(self.privs[("m3", "cee-agent")]))
        self.assertEqual(opened, bytes.fromhex(new_id) + self.keystore("default")[new_id])
        self.assertNotEqual(opened[16:], old_key,
                            "new member must never receive old keys")

    def test_add_member_refuses_non_participant(self):
        self.create_e2ee_topic(["m1", "m2"])
        before = len(self.fake.envelope_posts())
        rc, out, err = self.run_cli(
            ["topic-add-member", "--topic", TOPIC_ID, "--member", "m3"])
        self.assertNotEqual(rc, 0)
        self.assertIn("hub invite", err)
        self.assertEqual(len(self.fake.envelope_posts()), before)

    def test_add_member_without_local_key_fails_loudly(self):
        self.create_e2ee_topic(["m1", "m2"])
        self.run_cli(["invite", "--topic", TOPIC_ID, "--member", "m3"])
        # Wipe our keystore: we cannot distribute a key we don't hold.
        shutil.rmtree(os.path.join(hub.topic_keys_dir("default")), ignore_errors=True)
        rc, out, err = self.run_cli(
            ["topic-add-member", "--topic", TOPIC_ID, "--member", "m3"])
        self.assertNotEqual(rc, 0)
        self.assertIn("key-request", err)

    def test_pending_state_for_keyless_member(self):
        self.create_e2ee_topic(["m1", "m2"])
        self.run_cli(["invite", "--topic", TOPIC_ID, "--member", "m4"])
        rc, out, err = self.run_cli(
            ["topic-add-member", "--topic", TOPIC_ID, "--member", "m4"])
        self.assertEqual(rc, 0, "stderr: %s" % err)
        result = json.loads(out)
        self.assertEqual(result["pending_key_distribution"], ["m4"])
        self.assertEqual(result["envelopes_posted"], 0)

        # A VISIBLE plaintext notice names the member — never silent.
        notices = self.fake.entry_posts("pending_key_distribution")
        self.assertEqual(len(notices), 1)
        entry_body = json.loads(notices[0]["body"])
        self.assertIn("m4", entry_body["body"])
        self.assertIn("Dee", entry_body["body"])
        self.assertNotIn("fh1.", entry_body["body"])  # plaintext, not ciphertext
        self.assertIn("pending", err)  # stderr warning too

        # topic-key-status shows pending...
        rc, out, err = self.run_cli(["topic-key-status", "--topic", TOPIC_ID])
        self.assertEqual(rc, 0, "stderr: %s" % err)
        status = json.loads(out)
        m4 = [p for p in status["participants"] if p["member_id"] == "m4"][0]
        self.assertEqual(m4["key_state"], "pending")

        # ...then "ready" once m4 registers a key...
        sk = PrivateKey.generate()
        self.privs[("m4", "dee-agent")] = sk
        self.pubs[("m4", "dee-agent")] = base64.b64encode(bytes(sk.public_key)).decode("ascii")
        self.fake.keys_by_member["m4"] = [("dee-agent", self.pubs[("m4", "dee-agent")])]
        rc, out, err = self.run_cli(["topic-key-status", "--topic", TOPIC_ID])
        m4 = [p for p in json.loads(out)["participants"] if p["member_id"] == "m4"][0]
        self.assertEqual(m4["key_state"], "ready")

        # ...and distribution completes on re-run.
        rc, out, err = self.run_cli(
            ["topic-add-member", "--topic", TOPIC_ID, "--member", "m4"])
        self.assertEqual(rc, 0, "stderr: %s" % err)
        self.assertEqual(json.loads(out)["pending_key_distribution"], [])
        posts = [c for c in self.fake.envelope_posts()
                 if json.loads(c["body"])["member_id"] == "m4"]
        self.assertTrue(posts)


class TestRemoveAndRekey(E2eeRekeyTestBase):
    def _setup_two_member_topic(self):
        key_id, key = self.create_e2ee_topic(["m1", "m2"])
        rc, out, err = self.run_cli(["post", "--topic", TOPIC_ID, "--message", "before removal"])
        self.assertEqual(rc, 0, "stderr: %s" % err)
        return key_id, key

    def test_remove_warns_rekey_and_rekey_rotates(self):
        old_id, old_key = self._setup_two_member_topic()
        rc, out, err = self.run_cli(
            ["topic-remove-member", "--topic", TOPIC_ID, "--member", "m2"])
        self.assertEqual(rc, 0, "stderr: %s" % err)
        self.assertIn("topic-rekey", err)  # loud: old key still live until rotation
        left = [e for e in self.fake.entries if e["kind"] == "member_left"]
        self.assertEqual(len(left), 1)
        self.assertIn("Bee", left[0]["body"])

        rc, out, err = self.run_cli(["topic-rekey", "--topic", TOPIC_ID])
        self.assertEqual(rc, 0, "stderr: %s" % err)
        result = json.loads(out)
        new_id = result["key_id"]
        self.assertNotEqual(new_id, old_id)
        self.assertEqual(result["previous_key_id"], old_id)

        # Old key retained locally for history.
        keys = self.keystore("default")
        self.assertEqual(keys[old_id], old_key)
        self.assertIn(new_id, keys)

        # Plaintext rotation announcement readable by everyone.
        rots = self.fake.entry_posts("key_rotated")
        self.assertEqual(len(rots), 1)
        rot_body = json.loads(rots[0]["body"])
        self.assertNotIn("fh1.", rot_body["body"])
        self.assertIn(new_id[-8:], rot_body["body"])
        self.assertEqual(rot_body["data"]["key_id"], new_id)

        # No new-key envelope was sealed for the removed member.
        new_posts = [c for c in self.fake.envelope_posts()
                     if json.loads(c["body"])["key_id"] == new_id]
        targets = {json.loads(c["body"])["member_id"] for c in new_posts}
        self.assertNotIn("m2", targets)
        self.assertIn("m1", targets)

    def test_post_uses_new_key_and_old_key_fails_on_new_content(self):
        old_id, old_key = self._setup_two_member_topic()
        self.run_cli(["topic-remove-member", "--topic", TOPIC_ID, "--member", "m2"])
        rc, out, err = self.run_cli(["topic-rekey", "--topic", TOPIC_ID])
        new_id = json.loads(out)["key_id"]

        rc, out, err = self.run_cli(["post", "--topic", TOPIC_ID, "--message", "after rotation"])
        self.assertEqual(rc, 0, "stderr: %s" % err)
        wire = json.loads(out)["entry"]["entry"]["body"]
        parsed = hub._e2ee_parse_wire(wire)
        self.assertIsNotNone(parsed)
        self.assertEqual(parsed[0], new_id)  # encrypted under the NEW key

        # The removed member's old key cannot decrypt post-rotation content...
        key_id_hex, msg_id_hex, nonce, ct = parsed
        aad = hub._e2ee_msg_aad(TOPIC_ID, key_id_hex, msg_id_hex)
        with self.assertRaises(Exception):
            bindings.crypto_aead_xchacha20poly1305_ietf_decrypt(ct, aad, nonce, old_key)

        # ...but the retained old key still decrypts pre-rotation history.
        hist = [e for e in self.fake.entries
                if e["topic_id"] == TOPIC_ID and e["kind"] == "message"]
        self.assertEqual(len(hist), 2)
        for e in hist[:1]:
            p = hub._e2ee_parse_wire(e["body"])
            pt = bindings.crypto_aead_xchacha20poly1305_ietf_decrypt(
                p[3], hub._e2ee_msg_aad(TOPIC_ID, p[0], p[1]), p[2], old_key)
            self.assertEqual(pt.decode(), "before removal")

    def test_rekey_requires_e2ee_and_current_key(self):
        # Plaintext topic: rekey is meaningless.
        self.fake.topics[TOPIC_ID] = {"e2ee": 0, "participants": ["m1"]}
        rc, out, err = self.run_cli(["topic-rekey", "--topic", TOPIC_ID])
        self.assertNotEqual(rc, 0)
        self.assertIn("not end-to-end encrypted", err)

    def test_rekey_without_local_key_fails(self):
        self._setup_two_member_topic()
        shutil.rmtree(os.path.join(hub.topic_keys_dir("default")), ignore_errors=True)
        rc, out, err = self.run_cli(["topic-rekey", "--topic", TOPIC_ID])
        self.assertNotEqual(rc, 0)
        self.assertIn("key-request", err)


class TestKeyRequestGrant(E2eeRekeyTestBase):
    def test_request_posts_visibly_with_no_auto_fulfillment(self):
        self.create_e2ee_topic(["m1", "m2"])
        # m5 is a participant without the key; they ask for it.
        self.run_cli(["invite", "--topic", TOPIC_ID, "--member", "m5"])
        self.as_member("eee", "m5", "eee-agent")
        rc, out, err = self.run_cli(["key-request", "--topic", TOPIC_ID])
        self.assertEqual(rc, 0, "stderr: %s" % err)

        reqs = self.fake.entry_posts("key_request")
        self.assertEqual(len(reqs), 1)
        body = json.loads(reqs[0]["body"])
        self.assertIn("[key request]", body["body"])
        self.assertIn("m5", body["body"])
        self.assertNotIn("fh1.", body["body"])  # plaintext, visible
        # Nothing was granted automatically.
        self.assertEqual(len(self.fake.envelope_posts()), 2)  # only creation's

    def test_grant_declined_by_default(self):
        self.create_e2ee_topic(["m1", "m2"])
        self.run_cli(["invite", "--topic", TOPIC_ID, "--member", "m5"])
        with mock.patch("builtins.input", return_value="no"):
            rc, out, err = self.run_cli(
                ["key-grant", "--topic", TOPIC_ID, "--member", "m5"])
        self.assertEqual(rc, 1)
        self.assertIn("cancelled", err)
        self.assertIn("HUMAN APPROVAL REQUIRED", err)
        self.assertEqual(len(self.fake.envelope_posts()), 2)  # only creation's

    def test_grant_with_yes_seals_current_key(self):
        key_id, key = self.create_e2ee_topic(["m1", "m2"])
        self.run_cli(["invite", "--topic", TOPIC_ID, "--member", "m5"])
        rc, out, err = self.run_cli(
            ["key-grant", "--topic", TOPIC_ID, "--member", "m5", "--yes"])
        self.assertEqual(rc, 0, "stderr: %s" % err)
        result = json.loads(out)
        self.assertEqual(result["key_id"], key_id)

        posts = [c for c in self.fake.envelope_posts()
                 if json.loads(c["body"])["member_id"] == "m5"]
        self.assertEqual(len(posts), 1)
        sealed = base64.b64decode(json.loads(posts[0]["body"])["envelope"])
        opened = bindings.crypto_box_seal_open(
            sealed, bytes(self.privs[("m5", "eee-agent")].public_key),
            bytes(self.privs[("m5", "eee-agent")]))
        self.assertEqual(opened, bytes.fromhex(key_id) + key)

    def test_grant_refuses_keyless_member(self):
        self.create_e2ee_topic(["m1", "m2"])
        self.run_cli(["invite", "--topic", TOPIC_ID, "--member", "m4"])
        rc, out, err = self.run_cli(
            ["key-grant", "--topic", TOPIC_ID, "--member", "m4", "--yes"])
        self.assertNotEqual(rc, 0)
        self.assertIn("key-init", err)
        self.assertEqual(len(self.fake.envelope_posts()), 2)  # only creation's

    def test_grant_refuses_non_participant(self):
        self.create_e2ee_topic(["m1", "m2"])
        rc, out, err = self.run_cli(
            ["key-grant", "--topic", TOPIC_ID, "--member", "m5", "--yes"])
        self.assertNotEqual(rc, 0)
        self.assertIn("not a participant", err)


class TestKeyFetchAndSyncRefresh(E2eeRekeyTestBase):
    def test_key_fetch_merges_without_dropping_old(self):
        old_id, old_key = self.create_e2ee_topic(["m1", "m2"])
        # m2's agent fetches the original key into its own profile.
        self.as_member("bee", "m2", "bee-agent")
        rc, out, err = self.run_cli(["--profile", "bee", "key-fetch", "--topic", TOPIC_ID])
        self.assertEqual(rc, 0, "stderr: %s" % err)
        self.assertIn(old_id, json.loads(out)["new_keys"])

        # m1 removes... (m2 stays) and m1 rotates; m2 picks it up via key-fetch.
        self.fake.caller = ("m1", "owner-agent")
        rc, out, err = self.run_cli(["topic-rekey", "--topic", TOPIC_ID])
        new_id = json.loads(out)["key_id"]
        self.fake.caller = ("m2", "bee-agent")
        rc, out, err = self.run_cli(["--profile", "bee", "key-fetch", "--topic", TOPIC_ID])
        self.assertEqual(rc, 0, "stderr: %s" % err)
        keys = self.keystore("bee")
        self.assertEqual(keys[old_id], old_key)  # old retained
        self.assertIn(new_id, keys)  # new merged

    def test_sync_refreshes_envelopes_for_e2ee_topics(self):
        self.create_e2ee_topic(["m1", "m2"])
        rc, out, err = self.run_cli(["post", "--topic", TOPIC_ID, "--message", "hello"])
        self.assertEqual(rc, 0, "stderr: %s" % err)
        self.as_member("bee", "m2", "bee-agent")
        # m2 syncs: picks up the original key via refresh BEFORE decrypting,
        # so the message decrypts on first sight.
        rc, out, err = self.run_cli(["--profile", "bee", "sync"])
        self.assertEqual(rc, 0, "stderr: %s" % err)
        self.assertEqual(len(self.keystore("bee")), 1)
        synced = json.loads(out)
        self.assertTrue(synced, "expected entries from sync")
        self.assertEqual(synced[0]["body"], "hello")

        # m1 rotates; m2's next sync fetches the new envelope automatically.
        self.fake.caller = ("m1", "owner-agent")
        rc, out, err = self.run_cli(["topic-rekey", "--topic", TOPIC_ID])
        new_id = json.loads(out)["key_id"]
        self.fake.caller = ("m2", "bee-agent")
        rc, out, err = self.run_cli(["--profile", "bee", "sync"])
        self.assertEqual(rc, 0, "stderr: %s" % err)
        self.assertIn("new key envelope", err)
        keys = self.keystore("bee")
        self.assertEqual(len(keys), 2)
        self.assertIn(new_id, keys)

        # ...and m2's next post uses the new key.
        rc, out, err = self.run_cli(
            ["--profile", "bee", "post", "--topic", TOPIC_ID, "--message", "bee here"])
        self.assertEqual(rc, 0, "stderr: %s" % err)
        wire = json.loads(out)["entry"]["entry"]["body"]
        self.assertEqual(hub._e2ee_parse_wire(wire)[0], new_id)


class TestSystemKindRouting(E2eeRekeyTestBase):
    def test_post_system_kind_stays_plaintext_on_e2ee_topic(self):
        self.create_e2ee_topic(["m1", "m2"])
        rc, out, err = self.run_cli(
            ["post", "--topic", TOPIC_ID, "--kind", "key_request",
             "--message", "[key request] manual"])
        self.assertEqual(rc, 0, "stderr: %s" % err)
        entry = json.loads(out)["entry"]["entry"]
        self.assertEqual(entry["kind"], "key_request")
        self.assertIn("[key request] manual", entry["body"])
        self.assertIn("PLAINTEXT", err)

    def test_post_message_still_encrypts(self):
        self.create_e2ee_topic(["m1", "m2"])
        rc, out, err = self.run_cli(
            ["post", "--topic", TOPIC_ID, "--message", "secret"])
        self.assertEqual(rc, 0, "stderr: %s" % err)
        body = json.loads(out)["entry"]["entry"]["body"]
        self.assertTrue(body.startswith("fh1."))


if __name__ == "__main__":
    unittest.main()
