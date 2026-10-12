#!/usr/bin/env python3
"""Tests for Phase 3 — E2EE encrypted messaging (`hub post`/`read`/`sync`).

Wire format under test: fh1.<key_id_hex>.<msg_id_hex>.<base64(nonce||ct)>
with XChaCha20-Poly1305 and AAD = b"fh-msg-v1\\x00" + topic_id + NUL +
key_id_hex + NUL + msg_id_hex.

Run from the repo root:
    python3 -m unittest discover -s agent-skill/tests -v
"""

import base64
import contextlib
import importlib.util
import io
import json
import os
import re
import shutil
import sys
import tempfile
import time
import unittest
import urllib.parse as urlparse
from importlib.machinery import SourceFileLoader

HERE = os.path.dirname(os.path.abspath(__file__))
HUB_PATH = os.path.join(HERE, "..", "hub")

spec = importlib.util.spec_from_file_location(
    "hubcli", HUB_PATH, loader=SourceFileLoader("hubcli", HUB_PATH)
)
hub = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hub)


# ---------------------------------------------------------------------------
# Stateful fake hub: topics, entries, history, sync, envelopes
# ---------------------------------------------------------------------------


class MsgFakeHub:
    """In-memory Hub server for the E2EE messaging tests.

    Serves topic records (with the e2ee flag), stores POSTed entries
    opaquely (assigning seq/gseq server-side, like the real server), and
    serves history + sync. Records every call for assertions.
    """

    def __init__(self):
        self.calls = []
        self.health_calls = []
        self.topics = {}
        self.entries = {}
        self.envelopes = {}  # tid -> [envelope dicts]
        self.gseq = 0

    def add_topic(self, tid, e2ee=0, subject="subject", current_key_id=None):
        self.topics[tid] = {"id": tid, "e2ee": e2ee, "subject": subject,
                            "current_key_id": current_key_id}
        self.entries.setdefault(tid, [])
        self.envelopes.setdefault(tid, [])

    def add_entry(self, tid, body, kind="message", data=None):
        self.gseq += 1
        entry = {
            "gseq": self.gseq,
            "topic_id": tid,
            "seq": len(self.entries[tid]) + 1,
            "ts": "2026-10-11T16:00:00Z",
            "actor_member_id": "m1",
            "agent_label": "a1",
            "kind": kind,
            "body": body,
            "data": data,
        }
        self.entries[tid].append(entry)
        return entry

    def add_envelope(self, tid, key_id, created_at="2026-10-11T16:00:00Z"):
        self.envelopes[tid].append(
            {"key_id": key_id, "created_at": created_at,
             "envelope": "opaque"})

    def __call__(self, method, url, headers, body_bytes):
        parts = urlparse.urlparse(url)
        path = parts.path
        method = method.upper()

        # The fake models a current (0.13.0) server: auto-answer the
        # per-invocation version check in main(). Recorded separately so
        # command-traffic assertions keep their meaning.
        if method == "GET" and path == "/v1/health":
            self.health_calls.append(
                {
                    "method": method,
                    "url": url,
                    "headers": dict(headers),
                    "body": body_bytes.decode("utf-8") if body_bytes else None,
                }
            )
            return 200, json.dumps(
                {"ok": True, "version": "0.13.0", "api_versions": ["v1"]}
            )

        self.calls.append(
            {
                "method": method,
                "url": url,
                "headers": dict(headers),
                "body": body_bytes.decode("utf-8") if body_bytes else None,
            }
        )

        if method == "GET" and path == "/v1/topics":
            return 200, json.dumps(
                {"topics": [dict(t) for t in self.topics.values()]})

        m = re.fullmatch(r"/v1/topics/([^/]+)", path)
        if m and method == "GET":
            topic = self.topics.get(m.group(1))
            if topic is None:
                return 404, json.dumps(
                    {"error": {"code": "not_found", "message": "no topic"}})
            return 200, json.dumps({"topic": dict(topic), "participants": []})

        m = re.fullmatch(r"/v1/topics/([^/]+)/entries", path)
        if m and method == "POST":
            tid = m.group(1)
            payload = json.loads(body_bytes.decode("utf-8"))
            entry = self.add_entry(
                tid, payload.get("body"), payload.get("kind", "message"),
                payload.get("data"))
            return 201, json.dumps({"entry": entry})

        m = re.fullmatch(r"/v1/topics/([^/]+)/history", path)
        if m and method == "GET":
            tid = m.group(1)
            return 200, json.dumps(
                {"entries": [dict(e) for e in self.entries.get(tid, [])]})

        m = re.fullmatch(r"/v1/topics/([^/]+)/envelopes", path)
        if m and method == "GET":
            return 200, json.dumps(
                {"envelopes": list(self.envelopes.get(m.group(1), []))})

        if method == "GET" and path == "/v1/sync":
            all_entries = []
            for entries in self.entries.values():
                all_entries.extend(dict(e) for e in entries)
            all_entries.sort(key=lambda e: e["gseq"])
            return 200, json.dumps(
                {"entries": all_entries, "next_after_gseq": self.gseq})

        return 404, json.dumps(
            {"error": {"code": "not_found", "message": "no route"}})

    def calls_to(self, method, path_suffix):
        return [
            c for c in self.calls
            if c["method"] == method and urlparse.urlparse(c["url"]).path.endswith(path_suffix)
        ]

    def topic_record_gets(self):
        """GET /v1/topics/<id> calls (the E2EE auto-detect fetch)."""
        return [
            c for c in self.calls
            if c["method"] == "GET"
            and re.fullmatch(r"/v1/topics/[^/]+",
                             urlparse.urlparse(c["url"]).path)
        ]


@contextlib.contextmanager
def captured():
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        yield out, err


FAKE_TOKEN = "fh_test_token_12345"


class E2eeMsgTestBase(unittest.TestCase):
    def setUp(self):
        self._saved_env = dict(os.environ)
        self.tmp = tempfile.mkdtemp(prefix="hubtest-e2ee-msg-")
        os.environ["FAMILY_HUB_CONFIG_HOME"] = self.tmp
        os.environ["FAMILY_HUB_TOKEN"] = FAKE_TOKEN
        os.environ.pop("FAMILY_HUB_VAULT_CMD", None)
        self.fake = MsgFakeHub()
        # Fresh version-check state: the fake models a current server.
        hub._reset_server_version_cache()
        self.seed_config()

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._saved_env)
        shutil.rmtree(self.tmp, ignore_errors=True)
        hub.clear_secrets()

    def seed_config(self, profile="default"):
        hub.save_config(
            profile,
            {
                "server_url": "https://hub.example",
                "member": {"id": "m1", "name": "Tester", "role": "parent"},
                "agent_label": "test-agent",
                "auth_method": "env",
            },
        )

    def run_cli(self, argv):
        with captured() as (out, err):
            rc = hub.main(argv, transport=self.fake)
        return rc, out.getvalue(), err.getvalue()

    def seed_keystore(self, tid, keys, profile="default"):
        """keys: {key_id_hex: key_bytes} -> writes the 0600 keystore file."""
        d = hub.topic_keys_dir(profile)
        os.makedirs(d, exist_ok=True)
        payload = {kid: base64.b64encode(k).decode("ascii")
                   for kid, k in keys.items()}
        hub._write_secret_file_0600(
            os.path.join(d, tid + ".json"),
            json.dumps(payload).encode("utf-8"), "test topic key")

    def new_key(self):
        return os.urandom(32), os.urandom(16).hex()

    def post_entry_calls(self):
        return self.fake.calls_to("POST", "/entries")

    @staticmethod
    def wire_parts(wire):
        parts = wire.split(".")
        assert len(parts) == 4, "expected 4 wire parts: %r" % wire[:40]
        tag, kid, mid, blob = parts
        assert tag == "fh1"
        assert re.fullmatch(r"[0-9a-f]{32}", kid), "key_id not 32 hex"
        assert re.fullmatch(r"[0-9a-f]{32}", mid), "msg_id not 32 hex"
        raw = base64.b64decode(blob, validate=True)
        assert len(raw) >= 24 + 16
        return kid, mid, raw


# ---------------------------------------------------------------------------
# Wire format + AAD construction
# ---------------------------------------------------------------------------


class TestWireFormat(E2eeMsgTestBase):
    def test_aad_exact_construction(self):
        aad = hub._e2ee_msg_aad("topic-9", "a" * 32, "b" * 32)
        self.assertEqual(
            aad,
            b"fh-msg-v1\x00topic-9\x00" + b"a" * 32 + b"\x00" + b"b" * 32)

    def test_aad_rejects_nul_topic_id(self):
        with self.assertRaises(hub.HubError):
            hub._e2ee_msg_aad("a\x00b", "a" * 32, "b" * 32)

    def test_encrypt_wire_shape(self):
        key, kid = self.new_key()
        wire = hub._e2ee_encrypt_field(b"hi", "t1", kid, key)
        got_kid, _mid, _raw = self.wire_parts(wire)
        self.assertEqual(got_kid, kid)

    def test_nonce_and_msgid_unique_per_field(self):
        key, kid = self.new_key()
        w1 = hub._e2ee_encrypt_field(b"same", "t1", kid, key)
        w2 = hub._e2ee_encrypt_field(b"same", "t1", kid, key)
        self.assertNotEqual(w1, w2)


# ---------------------------------------------------------------------------
# Round trip: post -> read -> sync
# ---------------------------------------------------------------------------


class TestRoundTrip(E2eeMsgTestBase):
    def test_post_read_sync_round_trip(self):
        key, kid = self.new_key()
        self.fake.add_topic("et1", e2ee=1)
        self.seed_keystore("et1", {kid: key})

        rc, out, err = self.run_cli(
            ["post", "--topic", "et1", "--message", "hello secret",
             "--data", '{"a": 1, "b": [2, 3]}'])
        self.assertEqual(rc, 0, err)

        # What hit the wire: opaque fh1 blobs, no plaintext.
        posts = self.post_entry_calls()
        self.assertEqual(len(posts), 1)
        payload = json.loads(posts[0]["body"])
        self.assertNotIn("hello secret", posts[0]["body"])
        kid_on_wire, _mid, _raw = self.wire_parts(payload["body"])
        self.assertEqual(kid_on_wire, kid)
        self.assertIsInstance(payload["data"], str)
        self.wire_parts(payload["data"])

        # read decrypts body + data
        rc, out, err = self.run_cli(["read", "--topic", "et1"])
        self.assertEqual(rc, 0, err)
        entries = json.loads(out)
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["body"], "hello secret")
        self.assertEqual(entries[0]["data"], {"a": 1, "b": [2, 3]})

        # sync decrypts too
        rc, out, err = self.run_cli(["sync"])
        self.assertEqual(rc, 0, err)
        entries = json.loads(out)
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["body"], "hello secret")
        self.assertEqual(entries[0]["data"], {"a": 1, "b": [2, 3]})

    def test_post_without_data_leaves_data_null(self):
        key, kid = self.new_key()
        self.fake.add_topic("et1", e2ee=1)
        self.seed_keystore("et1", {kid: key})
        rc, out, err = self.run_cli(
            ["post", "--topic", "et1", "--message", "no data here"])
        self.assertEqual(rc, 0, err)
        payload = json.loads(self.post_entry_calls()[0]["body"])
        self.assertNotIn("data", payload)
        rc, out, err = self.run_cli(["read", "--topic", "et1"])
        entries = json.loads(out)
        self.assertEqual(entries[0]["body"], "no data here")
        self.assertIsNone(entries[0]["data"])


# ---------------------------------------------------------------------------
# AAD tamper rejection
# ---------------------------------------------------------------------------


class TestAadTamper(E2eeMsgTestBase):
    def setUp(self):
        super().setUp()
        self.key, self.kid = self.new_key()
        self.fake.add_topic("et1", e2ee=1)
        self.seed_keystore("et1", {self.kid: self.key})
        rc, _, err = self.run_cli(
            ["post", "--topic", "et1", "--message", "tamper target"])
        self.assertEqual(rc, 0, err)
        self.entry = self.fake.entries["et1"][0]
        self.orig_body = self.entry["body"]

    def corrupt_b64_mid(self, wire):
        tag, kid, mid, blob = wire.split(".")
        i = len(blob) // 2
        ch = "A" if blob[i] != "A" else "B"
        return ".".join([tag, kid, mid, blob[:i] + ch + blob[i + 1:]])

    def test_flipped_ciphertext_byte_fails_loudly(self):
        self.entry["body"] = self.corrupt_b64_mid(self.orig_body)
        rc, out, err = self.run_cli(["read", "--topic", "et1"])
        self.assertEqual(rc, 1)
        self.assertIn("E2EE integrity failure", err)
        self.assertIn("seq=1", err)  # the entry is named
        self.assertNotIn("tamper target", out + err)

    def test_flipped_msg_id_fails_loudly(self):
        tag, kid, _mid, blob = self.orig_body.split(".")
        self.entry["body"] = ".".join([tag, kid, "f" * 32, blob])
        rc, out, err = self.run_cli(["read", "--topic", "et1"])
        self.assertEqual(rc, 1)
        self.assertIn("E2EE integrity failure", err)
        self.assertIn("seq=1", err)

    def test_cross_topic_replay_rejected(self):
        # Move the ciphertext into another E2EE topic: topic_id is in the AAD.
        key2, kid2 = self.new_key()
        self.fake.add_topic("et2", e2ee=1)
        self.seed_keystore("et2", {kid2: key2, self.kid: self.key})
        self.fake.add_entry("et2", self.orig_body)
        rc, out, err = self.run_cli(["read", "--topic", "et2"])
        self.assertEqual(rc, 1)
        self.assertIn("E2EE integrity failure", err)

    def test_malformed_wire_fails_loudly(self):
        self.entry["body"] = "fh1.not-hex-at-all"
        rc, out, err = self.run_cli(["read", "--topic", "et1"])
        self.assertEqual(rc, 1)
        self.assertIn("E2EE integrity failure", err)
        self.assertIn("seq=1", err)

    def test_plaintext_server_entry_passes_through(self):
        # The server legitimately writes plaintext entries into E2EE topics
        # (redaction announcements); they must survive read/sync untouched.
        self.fake.add_entry(
            "et1", "Entry #1 redacted by owner", kind="redaction",
            data={"redacted_gseq": 41})
        rc, out, err = self.run_cli(["read", "--topic", "et1"])
        self.assertEqual(rc, 0, err)
        entries = json.loads(out)
        by_kind = {e["kind"]: e for e in entries}
        self.assertEqual(by_kind["redaction"]["body"],
                         "Entry #1 redacted by owner")
        self.assertEqual(by_kind["redaction"]["data"], {"redacted_gseq": 41})


# ---------------------------------------------------------------------------
# Key rotation: key_id selects the right key
# ---------------------------------------------------------------------------


class TestKeyRotation(E2eeMsgTestBase):
    def test_reader_selects_key_by_key_id(self):
        old_key, old_kid = self.new_key()
        new_key, new_kid = self.new_key()
        self.fake.add_topic("et1", e2ee=1)
        self.seed_keystore("et1", {old_kid: old_key, new_kid: new_key})
        # Entries encrypted under different rotations of the same topic.
        self.fake.add_entry(
            "et1", hub._e2ee_encrypt_field(b"old era", "et1", old_kid, old_key))
        self.fake.add_entry(
            "et1", hub._e2ee_encrypt_field(b"new era", "et1", new_kid, new_key))
        rc, out, err = self.run_cli(["read", "--topic", "et1"])
        self.assertEqual(rc, 0, err)
        bodies = [e["body"] for e in json.loads(out)]
        self.assertEqual(bodies, ["old era", "new era"])

    def test_post_selects_server_advertised_current_key(self):
        # secfix F1: with several keys in the keystore, the CURRENT key is
        # elected from the server-advertised topics.current_key_id — never
        # from envelope recency.
        old_key, old_kid = self.new_key()
        new_key, new_kid = self.new_key()
        self.fake.add_topic("et1", e2ee=1, current_key_id=new_kid)
        self.seed_keystore("et1", {old_kid: old_key, new_kid: new_key})
        self.fake.add_envelope("et1", old_kid, "2026-10-10T00:00:00Z")
        self.fake.add_envelope("et1", new_kid, "2026-10-11T00:00:00Z")
        rc, out, err = self.run_cli(
            ["post", "--topic", "et1", "--message", "after rotation"])
        self.assertEqual(rc, 0, err)
        payload = json.loads(self.post_entry_calls()[0]["body"])
        kid_on_wire, _mid, _raw = self.wire_parts(payload["body"])
        self.assertEqual(kid_on_wire, new_kid)

    def test_election_ignores_recency_forgery(self):
        # secfix F1 regression: an old-key envelope re-POSTed with a NEWER
        # created_at must NOT win the election — the victim still encrypts
        # under the server-advertised current key.
        old_key, old_kid = self.new_key()
        new_key, new_kid = self.new_key()
        self.fake.add_topic("et1", e2ee=1, current_key_id=new_kid)
        self.seed_keystore("et1", {old_kid: old_key, new_kid: new_key})
        self.fake.add_envelope("et1", new_kid, "2026-10-10T00:00:00Z")
        self.fake.add_envelope("et1", old_kid, "2026-10-12T00:00:00Z")  # forged recency
        rc, out, err = self.run_cli(
            ["post", "--topic", "et1", "--message", "after rotation"])
        self.assertEqual(rc, 0, err)
        payload = json.loads(self.post_entry_calls()[0]["body"])
        kid_on_wire, _mid, _raw = self.wire_parts(payload["body"])
        self.assertEqual(kid_on_wire, new_kid)

    def test_election_fails_loudly_when_current_key_missing_locally(self):
        # The server-advertised current key is not in the keystore (and the
        # keystore holds several keys, so election matters): fail loudly
        # with fetch guidance instead of silently using a stale key.
        old_key, old_kid = self.new_key()
        new_key, new_kid = self.new_key()
        other_key, other_kid = self.new_key()
        self.fake.add_topic("et1", e2ee=1, current_key_id=new_kid)
        self.seed_keystore("et1", {old_kid: old_key, other_kid: other_key})
        rc, out, err = self.run_cli(
            ["post", "--topic", "et1", "--message", "after rotation"])
        self.assertNotEqual(rc, 0)
        self.assertIn("key-fetch", err)
        self.assertEqual(self.post_entry_calls(), [],
                         "nothing may be posted when election fails")


# ---------------------------------------------------------------------------
# Missing key: graceful placeholder, no crash, no ciphertext leak
# ---------------------------------------------------------------------------


class TestMissingKey(E2eeMsgTestBase):
    def test_missing_key_placeholder(self):
        key, kid = self.new_key()
        other_key, other_kid = self.new_key()
        self.fake.add_topic("et1", e2ee=1)
        # Entry encrypted under kid; keystore holds only an unrelated key.
        self.fake.add_entry(
            "et1", hub._e2ee_encrypt_field(b"secret", "et1", kid, key),
            data=hub._e2ee_encrypt_field(b'{"x": 1}', "et1", kid, key))
        self.seed_keystore("et1", {other_kid: other_key})
        rc, out, err = self.run_cli(["read", "--topic", "et1"])
        self.assertEqual(rc, 0, err)
        entries = json.loads(out)
        self.assertEqual(len(entries), 1)
        self.assertIn("key-request", entries[0]["body"])
        self.assertIn("cannot decrypt", entries[0]["body"])
        self.assertIsNone(entries[0]["data"])
        # The ciphertext must not leak as if it were text.
        stored_blob = self.fake.entries["et1"][0]["body"].split(".")[3]
        self.assertNotIn(stored_blob, out)

    def test_missing_keystore_file_placeholder(self):
        key, kid = self.new_key()
        self.fake.add_topic("et1", e2ee=1)
        self.fake.add_entry(
            "et1", hub._e2ee_encrypt_field(b"secret", "et1", kid, key))
        # No keystore file at all.
        rc, out, err = self.run_cli(["read", "--topic", "et1"])
        self.assertEqual(rc, 0, err)
        entries = json.loads(out)
        self.assertIn("key-request", entries[0]["body"])


# ---------------------------------------------------------------------------
# Posting without a local key: clear failure, nothing posted
# ---------------------------------------------------------------------------


class TestPostWithoutKey(E2eeMsgTestBase):
    def test_post_to_e2ee_without_key_fails_cleanly(self):
        self.fake.add_topic("et1", e2ee=1)
        rc, out, err = self.run_cli(
            ["post", "--topic", "et1", "--message", "should never send"])
        self.assertEqual(rc, 1)
        self.assertIn("no topic key", err)
        self.assertIn("key-request", err)
        self.assertIn("Nothing was posted", err)
        self.assertEqual(self.post_entry_calls(), [])
        self.assertNotIn("should never send", out + err)


# ---------------------------------------------------------------------------
# PII: local pre-scan is the enforcement point for E2EE topics
# ---------------------------------------------------------------------------


class TestPiiPreScan(E2eeMsgTestBase):
    def setUp(self):
        super().setUp()
        key, kid = self.new_key()
        self.fake.add_topic("et1", e2ee=1)
        self.seed_keystore("et1", {kid: key})

    def test_card_in_body_blocked_before_encrypt(self):
        rc, out, err = self.run_cli(
            ["post", "--topic", "et1",
             "--message", "my card is 4111 1111 1111 1111"])
        self.assertEqual(rc, 4)
        self.assertEqual(self.post_entry_calls(), [])
        self.assertNotIn("4111", out + err)

    def test_card_in_data_blocked_before_encrypt(self):
        rc, out, err = self.run_cli(
            ["post", "--topic", "et1", "--message", "clean body",
             "--data", '{"note": "ssn 123-45-6789"}'])
        self.assertEqual(rc, 4)
        self.assertEqual(self.post_entry_calls(), [])


# ---------------------------------------------------------------------------
# Mixed plaintext + E2EE in one sync/read; O(1) topic-record fetch per topic
# ---------------------------------------------------------------------------


class TestMixedSync(E2eeMsgTestBase):
    def test_mixed_sync_and_o1_topic_detect(self):
        key, kid = self.new_key()
        self.fake.add_topic("pt1", e2ee=0, subject="plain")
        self.fake.add_topic("pt2", e2ee=0, subject="plain2")
        self.fake.add_topic("et1", e2ee=1)
        self.seed_keystore("et1", {kid: key})
        plain_entries = []
        for i in range(60):
            plain_entries.append(
                self.fake.add_entry("pt1", "plain-%d" % i)["body"])
            self.fake.add_entry("pt2", "plain2-%d" % i)
        secret_wire = hub._e2ee_encrypt_field(b"mixed secret", "et1", kid, key)
        self.fake.add_entry("et1", secret_wire)

        rc, out, err = self.run_cli(["sync"])
        self.assertEqual(rc, 0, err)
        entries = json.loads(out)
        self.assertEqual(len(entries), 121)
        by_topic = {}
        for e in entries:
            by_topic.setdefault(e["topic_id"], []).append(e)
        # Plaintext topics: byte-identical to what the server returned.
        self.assertEqual(
            [e["body"] for e in by_topic["pt1"]], plain_entries)
        # E2EE topic: decrypted.
        self.assertEqual(by_topic["et1"][0]["body"], "mixed secret")
        # O(1) per topic: exactly one topic-record GET per distinct topic,
        # not one per entry.
        self.assertEqual(len(self.fake.topic_record_gets()), 3)

    def test_read_plaintext_topic_untouched_single_fetch(self):
        self.fake.add_topic("pt1", e2ee=0, subject="plain")
        for i in range(10):
            self.fake.add_entry("pt1", "msg-%d" % i)
        rc, out, err = self.run_cli(["read", "--topic", "pt1"])
        self.assertEqual(rc, 0, err)
        entries = json.loads(out)
        self.assertEqual([e["body"] for e in entries],
                         ["msg-%d" % i for i in range(10)])
        self.assertEqual(len(self.fake.topic_record_gets()), 1)


# ---------------------------------------------------------------------------
# hub topics: subject decryption
# ---------------------------------------------------------------------------


class TestTopicSubjects(E2eeMsgTestBase):
    def test_subjects_decrypted_and_plaintext_untouched(self):
        key, kid = self.new_key()
        enc_subject = hub._e2ee_encrypt_subject("secret plans", key, "et1")
        self.fake.add_topic("pt1", e2ee=0, subject="lunch plans")
        self.fake.add_topic("et1", e2ee=1, subject=enc_subject)
        self.seed_keystore("et1", {kid: key})
        rc, out, err = self.run_cli(["topics"])
        self.assertEqual(rc, 0, err)
        by_id = {t["id"]: t for t in json.loads(out)}
        self.assertEqual(by_id["pt1"]["subject"], "lunch plans")
        self.assertEqual(by_id["et1"]["subject"], "secret plans")

    def test_subject_missing_key_shows_placeholder(self):
        key, _kid = self.new_key()
        enc_subject = hub._e2ee_encrypt_subject("secret plans", key, "et1")
        self.fake.add_topic("et1", e2ee=1, subject=enc_subject)
        # No keystore: placeholder, not base64.
        rc, out, err = self.run_cli(["topics"])
        self.assertEqual(rc, 0, err)
        topics = json.loads(out)
        self.assertEqual(topics[0]["subject"], "[encrypted]")
        self.assertNotIn(enc_subject, out)


    def test_subject_encrypted_for_other_topic_shows_placeholder(self):
        # secfix F4: a subject blob swapped in from another topic fails the
        # topic-bound AAD check and shows "[encrypted]", never plaintext.
        key, kid = self.new_key()
        enc_for_other = hub._e2ee_encrypt_subject("secret plans", key, "other-topic")
        self.fake.add_topic("et1", e2ee=1, subject=enc_for_other)
        self.seed_keystore("et1", {kid: key})
        rc, out, err = self.run_cli(["topics"])
        self.assertEqual(rc, 0, err)
        topics = json.loads(out)
        self.assertEqual(topics[0]["subject"], "[encrypted]")
        self.assertNotIn("secret plans", out)

    def test_subject_aad_differs_per_topic(self):
        # The same subject encrypted for two topics yields different blobs
        # (different AAD), and each only verifies under its own topic.
        key, _kid = self.new_key()
        enc_a = hub._e2ee_encrypt_subject("same subject", key, "topic-A")
        enc_b = hub._e2ee_encrypt_subject("same subject", key, "topic-B")
        self.assertNotEqual(enc_a, enc_b)
        self.assertEqual(hub._e2ee_decrypt_subject(enc_a, key, "topic-A"), "same subject")
        self.assertEqual(hub._e2ee_decrypt_subject(enc_b, key, "topic-B"), "same subject")
        with self.assertRaises(hub.HubError):
            hub._e2ee_decrypt_subject(enc_a, key, "topic-B")


# ---------------------------------------------------------------------------
# Perf smoke: 200 plaintext entries must not measurably slow down
# ---------------------------------------------------------------------------


class TestPerfSmoke(E2eeMsgTestBase):
    def test_200_entry_plaintext_sync_is_fast_and_o1(self):
        for n in range(4):
            self.fake.add_topic("pt%d" % n, e2ee=0, subject="t%d" % n)
            for i in range(50):
                self.fake.add_entry("pt%d" % n, "entry %d/%d" % (n, i))
        start = time.monotonic()
        rc, out, err = self.run_cli(["sync", "--limit", "500"])
        elapsed = time.monotonic() - start
        self.assertEqual(rc, 0, err)
        entries = json.loads(out)
        self.assertEqual(len(entries), 200)
        # Structural guarantee: one topic-record fetch per topic, not per
        # entry — this is what keeps sync O(topics), not O(entries).
        self.assertEqual(len(self.fake.topic_record_gets()), 4)
        # Smoke bound (mocked transport; guards against accidental
        # per-entry crypto or repeated keystore walks).
        self.assertLess(elapsed, 10, "200-entry sync took %.2fs" % elapsed)


if __name__ == "__main__":
    unittest.main()
