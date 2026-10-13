#!/usr/bin/env python3
"""Tests for `hub new-topic --e2ee` (E2EE Phase 2).

Full flow with a stateful mocked transport: local topic-key generation,
subject encryption (XChaCha20-Poly1305, nonce prepended, base64; topic-bound
AAD via the PATCH two-step), one sealed envelope per participant agent
(crypto_box_seal over topic_id || 0x00 || key_id || topic_key),
0600 local key storage, and the own-envelope round-trip verification.
Also: missing keypair fails with `hub key-init` guidance (never
auto-generates), keyless participants warn but don't abort, and a failed
round-trip check aborts loudly without storing the key.

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
import re
import shutil
import stat
import sys
import tempfile
import unittest
import urllib.parse as urlparse
from importlib.machinery import SourceFileLoader

HERE = os.path.dirname(os.path.abspath(__file__))
HUB_PATH = os.path.join(HERE, "..", "hub")

spec = importlib.util.spec_from_file_location(
    "hubcli_e2ee_topics", HUB_PATH, loader=SourceFileLoader("hubcli_e2ee_topics", HUB_PATH)
)
hub = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hub)

from nacl.public import PrivateKey  # noqa: E402  (test dependency, like test_e2ee_keys.py)
from nacl import bindings  # noqa: E402

SUBJECT_AAD = b"fh-topic-subject-v1"
TOPIC_ID = "t-e2ee-1"


class E2eeFakeHub:
    """Stateful fake hub for the E2EE new-topic flow (sync-v2 semantics).

    - POST /v1/topics with e2ee=1 creates the topic at epoch 0
      (current_epoch=0, current_key_id=None): writes blocked until commit.
      There is no initial_key_id anymore.
    - POST .../envelopes is STAGED: stored, never flips current_key_id (the
      N04 defect is gone). Target must be a current participant with a
      registered key (400 otherwise).
    - GET .../envelopes returns the CALLER's envelopes for COMMITTED epochs
      only, each with the epoch's commitment. Staged envelopes are
      invisible until commit.
    - POST .../keys/commit implements the spec §1.4 checks: epoch
      sequence, key_id/commitment uniqueness, staged-vs-current set
      equality (burn on shrink with staged-row cleanup,
      incomplete_distribution for agents with no identity key unless
      force, owner/parent only). `fail_commit_with = (status, body)` forces
      a canned commit failure (commit-failure tests).
    """

    def __init__(self, keys_by_member, participants):
        self.calls = []
        self.health_calls = []
        self.keys_by_member = keys_by_member  # member_id -> [(agent_label, pub_b64)]
        self.participants = participants  # [member_id]
        self.envelopes = []  # staged + committed rows
        self.epochs = []  # committed epoch log: {epoch,key_id,commitment,...}
        self.current_epoch = 0
        self.current_key_id = None
        self.subject = "<ciphertext>"  # latest PATCHed subject
        self.caller = ("m1", "owner-agent")
        self.fail_commit_with = None

    def _record(self, method, url, headers, body_bytes):
        self.calls.append(
            {
                "method": method,
                "url": url,
                "headers": dict(headers),
                "body": body_bytes.decode("utf-8") if body_bytes else None,
            }
        )

    def _current_agents(self):
        """{(member_id, agent_label)} for current participants with keys."""
        out = set()
        for mid in self.participants:
            for label, _pub in self.keys_by_member.get(mid, []):
                out.add((mid, label))
        return out

    def _commit(self, body):
        expected = body.get("expected_epoch")
        if expected != self.current_epoch + 1:
            return 409, json.dumps({"error": {
                "code": "stale_epoch",
                "message": "expected epoch %d" % (self.current_epoch + 1)}})
        key_id = body.get("key_id")
        commitment = body.get("commitment")
        if not isinstance(commitment, str) or not re.fullmatch(
                r"[0-9a-f]{64}", commitment):
            return 400, json.dumps({"error": {
                "code": "bad_request",
                "message": "commitment must be 64 hex chars"}})
        for ep in self.epochs:
            if ep["key_id"] == key_id:
                return 409, json.dumps({"error": {
                    "code": "key_reuse", "message": "key_id already used"}})
            if ep["commitment"] == commitment:
                return 409, json.dumps({"error": {
                    "code": "key_material_reuse",
                    "message": "identical key material already committed"}})
        staged = {(e["member_id"], e["agent_label"]) for e in self.envelopes
                  if e["key_id"] == key_id}
        current = self._current_agents()
        removed = staged - current
        if removed:
            # Burn: the removed party may have seen the key — delete the
            # staged rows; the client must restart with fresh material.
            self.envelopes = [e for e in self.envelopes
                              if e["key_id"] != key_id]
            return 409, json.dumps({"error": {
                "code": "recipients_removed_key_burned",
                "message": "key burned",
                "removed": sorted("%s/%s" % r for r in removed)}})
        missing = current - staged
        if missing and not body.get("force"):
            return 409, json.dumps({"error": {
                "code": "incomplete_distribution",
                "message": "missing envelopes",
                "missing": sorted("%s/%s" % m for m in missing)}})
        no_key = {(mid, label) for (mid, label) in missing
                  if not self.keys_by_member.get(mid)}
        if missing - no_key:
            # force covers ONLY agents with no identity key at all.
            return 409, json.dumps({"error": {
                "code": "incomplete_distribution",
                "message": "missing envelopes for keyed agents",
                "missing": sorted("%s/%s" % m for m in missing)}})
        self.current_epoch += 1
        self.current_key_id = key_id
        self.epochs.append({
            "epoch": self.current_epoch, "key_id": key_id,
            "commitment": commitment,
            "recipients": sorted("%s/%s" % s for s in staged),
            "forced": 1 if (missing and body.get("force")) else 0,
            "forced_missing": sorted("%s/%s" % m for m in no_key),
        })
        for e in self.envelopes:
            if e["key_id"] == key_id:
                e["commitment"] = commitment
        return 200, json.dumps({"topic_id": TOPIC_ID,
                                "epoch": self.current_epoch,
                                "key_id": key_id})

    def __call__(self, method, url, headers, body_bytes):
        parts = urlparse.urlparse(url)
        path = parts.path
        query = urlparse.parse_qs(parts.query)
        method = method.upper()

        # The fake models a current (1.0.0) server: auto-answer the
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
                {"ok": True, "version": "1.0.0", "api_versions": ["v1"]}
            )

        self._record(method, url, headers, body_bytes)

        if method == "POST" and path == "/v1/topics":
            body = json.loads(body_bytes.decode("utf-8")) if body_bytes else {}
            # v2: E2EE topics are created at epoch 0 (writes blocked);
            # activation happens only via keys/commit. No initial_key_id.
            self.current_epoch = 0
            self.current_key_id = None
            self.epochs = []
            self.subject = body.get("subject", "<ciphertext>")
            return 201, json.dumps(
                {"topic": {"id": TOPIC_ID, "subject": self.subject, "e2ee": 1,
                           "current_epoch": 0, "current_key_id": None}}
            )
        if method == "GET" and path == "/v1/me":
            return 200, json.dumps(
                {"id": "m1", "family_id": "f1", "agent_label": "owner-agent", "role": "owner"}
            )
        if method == "GET" and path == "/v1/topics/%s" % TOPIC_ID:
            return 200, json.dumps(
                {
                    "topic": {"id": TOPIC_ID, "e2ee": 1,
                              "current_epoch": self.current_epoch,
                              "current_key_id": self.current_key_id},
                    "participants": [{"member_id": m, "history_from": "full"}
                                     for m in self.participants],
                }
            )
        # Subject re-encryption PATCH (topic-bound AAD): topic metadata, not
        # a content write — allowed at epoch 0.
        if method == "PATCH" and path == "/v1/topics/%s/subject" % TOPIC_ID:
            body = json.loads(body_bytes.decode("utf-8")) if body_bytes else {}
            subject = body.get("subject")
            if not isinstance(subject, str) or not (1 <= len(subject) <= 1024):
                return 400, json.dumps(
                    {"error": {"code": "bad_request", "message": "bad subject"}})
            self.subject = subject
            return 200, json.dumps(
                {"topic": {"id": TOPIC_ID, "subject": self.subject, "e2ee": 1,
                           "current_epoch": self.current_epoch,
                           "current_key_id": self.current_key_id}}
            )
        if method == "GET" and path == "/v1/agent-keys":
            mid = (query.get("member_id") or [""])[0]
            keys = [
                {"member_id": mid, "agent_label": label, "public_key": pub,
                 "created_at": "2026-10-11T00:00:00Z"}
                for label, pub in self.keys_by_member.get(mid, [])
            ]
            return 200, json.dumps({"keys": keys})
        if path == "/v1/topics/%s/envelopes" % TOPIC_ID:
            if method == "POST":
                env = json.loads(body_bytes.decode("utf-8"))
                tmid, tlabel = env.get("member_id"), env.get("agent_label")
                if tmid not in self.participants:
                    return 400, json.dumps({"error": {
                        "code": "bad_request",
                        "message": "target must be a current participant"}})
                if tlabel not in [l for l, _ in self.keys_by_member.get(tmid, [])]:
                    return 400, json.dumps({"error": {
                        "code": "bad_request",
                        "message": "target has no registered identity key"}})
                # v2: staged — stored, NEVER flips current_key_id.
                rec = dict(env, topic_id=TOPIC_ID,
                           created_at="2026-10-11T00:00:00Z",
                           identity_key_id="ik-%s-%s" % (tmid, tlabel),
                           commitment=None)  # lands at commit time
                self.envelopes.append(rec)
                return 201, json.dumps(rec)
            # GET: the caller's envelopes for COMMITTED epochs only, each
            # with the epoch's commitment. Staged envelopes are invisible.
            committed = {ep["key_id"]: ep["commitment"] for ep in self.epochs}
            mine = [
                dict(e, commitment=committed[e["key_id"]])
                for e in self.envelopes
                if e["member_id"] == self.caller[0]
                and e["agent_label"] == self.caller[1]
                and e["key_id"] in committed
            ]
            return 200, json.dumps({"envelopes": mine})
        if method == "POST" and path == "/v1/topics/%s/keys/commit" % TOPIC_ID:
            if self.fail_commit_with is not None:
                status, payload = self.fail_commit_with
                return status, json.dumps(payload)
            body = json.loads(body_bytes.decode("utf-8")) if body_bytes else {}
            return self._commit(body)
        return 404, json.dumps({"error": {"code": "not_found", "message": "no route"}})


@contextlib.contextmanager
def captured():
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        yield out, err


FAKE_TOKEN = "<redacted>"


class E2eeTopicTestBase(unittest.TestCase):
    def setUp(self):
        self._saved_env = dict(os.environ)
        self.tmp = tempfile.mkdtemp(prefix="hubtest-e2ee-")
        os.environ["FAMILY_HUB_CONFIG_HOME"] = self.tmp
        os.environ["FAMILY_HUB_TOKEN"] = FAKE_TOKEN
        os.environ.pop("FAMILY_HUB_VAULT_CMD", None)
        # Fresh version-check state: the fake models a current server.
        hub._reset_server_version_cache()
        # Identity keypairs: caller (m1/owner-agent) + two agents for m2.
        self.privs = {}
        self.pubs = {}
        for mid, label in [("m1", "owner-agent"), ("m2", "bee-agent"), ("m2", "bee2-agent")]:
            sk = PrivateKey.generate()
            self.privs[(mid, label)] = sk
            self.pubs[(mid, label)] = base64.b64encode(bytes(sk.public_key)).decode("ascii")
        keys_by_member = {
            "m1": [("owner-agent", self.pubs[("m1", "owner-agent")])],
            "m2": [
                ("bee-agent", self.pubs[("m2", "bee-agent")]),
                ("bee2-agent", self.pubs[("m2", "bee2-agent")]),
            ],
        }
        self.fake = E2eeFakeHub(keys_by_member, ["m1", "m2"])
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
                "member": {"id": "m1", "name": "Tester", "role": "owner"},
                "agent_label": "owner-agent",
                "auth_method": "env",
            },
        )

    def write_identity_key(self, profile="default"):
        """Store the caller's identity private key at 0600 (simulates key-init)."""
        hub._write_secret_file_0600(
            hub.agent_key_path(profile), bytes(self.privs[("m1", "owner-agent")]), "test key"
        )

    def run_cli(self, argv):
        with captured() as (out, err):
            rc = hub.main(argv, transport=self.fake)
        return rc, out.getvalue(), err.getvalue()

    def envelope_posts(self):
        return [
            c
            for c in self.fake.calls
            if c["method"] == "POST" and c["url"].endswith("/envelopes")
        ]


class TestNewTopicE2eeArgs(unittest.TestCase):
    def parse(self, argv):
        return hub.build_parser().parse_args(argv)

    def test_e2ee_flag_parses(self):
        a = self.parse(["new-topic", "--e2ee", "--subject", "s", "--with", "m1"])
        self.assertTrue(a.e2ee)

    def test_e2ee_defaults_off(self):
        a = self.parse(["new-topic", "--subject", "s", "--with", "m1"])
        self.assertFalse(a.e2ee)


class TestNewTopicE2eeFlow(E2eeTopicTestBase):
    def test_full_flow(self):
        self.write_identity_key()
        rc, out, err = self.run_cli(
            ["new-topic", "--e2ee", "--subject", "Surprise party for Mahesh", "--with", "m1,m2"]
        )
        self.assertEqual(rc, 0, "stderr: %s" % err)
        result = json.loads(out)
        self.assertEqual(result["topic"]["id"], TOPIC_ID)

        # 1. Topic POST carried e2ee=1 and an encrypted (non-plaintext) subject.
        creates = [
            c for c in self.fake.calls
            if c["method"] == "POST" and c["url"].endswith("/v1/topics")
        ]
        self.assertEqual(len(creates), 1)
        create_body = json.loads(creates[0]["body"])
        self.assertEqual(create_body["e2ee"], 1)
        self.assertNotIn("Surprise party", create_body["subject"])
        # v2: no initial_key_id — the server leaves the topic at epoch 0
        # (writes blocked) and activation happens only via keys/commit.
        self.assertNotIn("initial_key_id", create_body)
        key_id_hex = result["e2ee"]["key_id"]

        # 2. Local key file: 0600, mapping key_id -> base64 topic key.
        self.assertRegex(key_id_hex, r"^[0-9a-f]{32}$")
        key_path = os.path.join(hub.topic_keys_dir("default"), TOPIC_ID + ".json")
        self.assertEqual(
            stat.S_IMODE(os.stat(key_path).st_mode), 0o600, "topic key file must be 0600"
        )
        with open(key_path) as fh:
            stored = json.load(fh)
        topic_key = base64.b64decode(stored[key_id_hex])
        self.assertEqual(len(topic_key), 32)
        self.assertEqual(stored, {key_id_hex: base64.b64encode(topic_key).decode("ascii")})

        # 3. secfix F4: immediately after creation the CLI PATCHes the
        # subject re-encrypted with the topic-bound AAD (topic ids are
        # server-generated, so it cannot be bound at create time).
        patches = [
            c for c in self.fake.calls
            if c["method"] == "PATCH" and c["url"].endswith("/subject")
        ]
        self.assertEqual(len(patches), 1)
        patched_subject = json.loads(patches[0]["body"])["subject"]
        self.assertNotIn("Surprise party", patched_subject)
        raw = base64.b64decode(patched_subject)
        nonce, ct = raw[:24], raw[24:]
        pt = bindings.crypto_aead_xchacha20poly1305_ietf_decrypt(
            ct, SUBJECT_AAD + b"\x00" + TOPIC_ID.encode("utf-8"), nonce, topic_key
        )
        self.assertEqual(pt.decode("utf-8"), "Surprise party for Mahesh")
        # ...and it does NOT verify under a different topic's AAD.
        with self.assertRaises(Exception):
            bindings.crypto_aead_xchacha20poly1305_ietf_decrypt(
                ct, SUBJECT_AAD + b"\x00" + b"some-other-topic", nonce, topic_key
            )

        # 4. One envelope per participant agent (3): each opens to key_id || topic_key.
        posts = self.envelope_posts()
        self.assertEqual(len(posts), 3)
        targets = set()
        for c in posts:
            b = json.loads(c["body"])
            targets.add((b["member_id"], b["agent_label"]))
            self.assertEqual(b["key_id"], key_id_hex)
            sk = self.privs[(b["member_id"], b["agent_label"])]
            opened = bindings.crypto_box_seal_open(
                base64.b64decode(b["envelope"]), bytes(sk.public_key), bytes(sk)
            )
            # secfix F2: sealed plaintext binds the topic id.
            self.assertEqual(
                opened,
                TOPIC_ID.encode("utf-8") + b"\x00" + bytes.fromhex(key_id_hex) + topic_key,
            )
        self.assertEqual(
            targets, {("m1", "owner-agent"), ("m2", "bee-agent"), ("m2", "bee2-agent")}
        )
        self.assertEqual(result["e2ee"]["envelopes_posted"], 3)

        # 5. The staged commit ran: POST keys/commit with expected_epoch=1,
        #    the key_id, and a 64-hex SHA256 commitment. Staged envelopes are
        #    invisible via GET until commit, so there is no round-trip
        #    envelope fetch — the commit response is the confirmation.
        commits = [
            c for c in self.fake.calls
            if c["method"] == "POST" and c["url"].endswith("/keys/commit")
        ]
        self.assertEqual(len(commits), 1)
        commit_body = json.loads(commits[0]["body"])
        self.assertEqual(commit_body["expected_epoch"], 1)
        self.assertEqual(commit_body["key_id"], key_id_hex)
        self.assertRegex(commit_body["commitment"], r"^[0-9a-f]{64}$")
        self.assertEqual(
            commit_body["commitment"], hashlib.sha256(topic_key).hexdigest()
        )
        self.assertFalse(commit_body["force"])
        self.assertEqual(result["e2ee"]["epoch"], 1)
        gets = [
            c for c in self.fake.calls
            if c["method"] == "GET" and c["url"].endswith("/envelopes")
        ]
        self.assertEqual(
            gets, [],
            "no envelope round-trip: staged envelopes are invisible pre-commit",
        )

        # 6. No key material and no plaintext subject on stdout.
        self.assertNotIn(base64.b64encode(topic_key).decode("ascii"), out)
        self.assertNotIn(topic_key.hex(), out)
        self.assertNotIn("Surprise party", out)

    def test_keyless_participant_warns_but_does_not_abort(self):
        self.write_identity_key()
        # m3 participates but has no registered agent keys.
        self.fake.participants = ["m1", "m2", "m3"]
        rc, out, err = self.run_cli(
            ["new-topic", "--e2ee", "--subject", "Quiet planning", "--with", "m1,m2,m3"]
        )
        self.assertEqual(rc, 0, "stderr: %s" % err)
        self.assertIn("key-init", err)
        self.assertIn("m3", err)
        # Envelopes still went out to the keyed agents.
        self.assertEqual(len(self.envelope_posts()), 3)
        result = json.loads(out)
        self.assertEqual(result["e2ee"]["keyless_participants"], ["m3"])

    def test_plaintext_new_topic_sends_no_e2ee_field(self):
        # The --e2ee flag must not change the plaintext request shape at all.
        self.write_identity_key()
        rc, out, err = self.run_cli(
            ["new-topic", "--subject", "plain subject", "--with", "m1"]
        )
        self.assertEqual(rc, 0, "stderr: %s" % err)
        creates = [
            c for c in self.fake.calls
            if c["method"] == "POST" and c["url"].endswith("/v1/topics")
        ]
        self.assertEqual(len(creates), 1)
        body = json.loads(creates[0]["body"])
        self.assertNotIn("e2ee", body)
        self.assertEqual(body["subject"], "plain subject")

    def test_commit_failure_keeps_key_anchor_and_names_rekey(self):
        # If the commit fails, the topic sits at epoch 0 (writes blocked)
        # but the genesis key REMAINS stored locally as the crash-recovery
        # anchor: `hub topic-rekey --topic <id>` completes the ceremony.
        self.write_identity_key()
        self.fake.fail_commit_with = (
            400, {"error": {"code": "bad_request", "message": "boom"}})
        rc, out, err = self.run_cli(
            ["new-topic", "--e2ee", "--subject", "Surprise", "--with", "m1"]
        )
        self.assertNotEqual(rc, 0)
        self.assertIn("topic-rekey", err)
        key_path = os.path.join(hub.topic_keys_dir("default"), TOPIC_ID + ".json")
        self.assertTrue(
            os.path.exists(key_path),
            "genesis key must remain stored as the rekey anchor",
        )

    def test_subject_over_200_chars_rejected(self):
        self.write_identity_key()
        rc, _out, err = self.run_cli(
            ["new-topic", "--e2ee", "--subject", "x" * 201, "--with", "m1"]
        )
        self.assertEqual(rc, 1)
        self.assertIn("200", err)
        # Rejected before any network call.
        self.assertEqual(self.fake.calls, [])


class TestNewTopicE2eeMissingKey(E2eeTopicTestBase):
    def test_missing_keypair_fails_with_key_init_guidance(self):
        # No agent.key on disk: fail loudly, never auto-generate, no network.
        rc, _out, err = self.run_cli(
            ["new-topic", "--e2ee", "--subject", "Secret", "--with", "m1"]
        )
        self.assertEqual(rc, 1)
        self.assertIn("hub key-init", err)
        self.assertEqual(self.fake.calls, [], "must fail before any server call")
        self.assertFalse(
            os.path.exists(hub.agent_key_path("default")),
            "the CLI must not auto-generate the keypair here",
        )

    def test_server_400_for_unregistered_creator_key_surfaces(self):
        self.write_identity_key()

        class RejectingHub(E2eeFakeHub):
            def __call__(self, method, url, headers, body_bytes):
                parts = urlparse.urlparse(url)
                if method == "POST" and parts.path == "/v1/topics":
                    self._record(method, url, headers, body_bytes)
                    return 400, json.dumps(
                        {
                            "error": {
                                "code": "bad_request",
                                "message": "E2EE topics require the creator's agent to "
                                "have a registered identity key. Run `hub key-init`.",
                            }
                        }
                    )
                return super().__call__(method, url, headers, body_bytes)

        self.fake = RejectingHub(self.fake.keys_by_member, ["m1"])
        rc, _out, err = self.run_cli(
            ["new-topic", "--e2ee", "--subject", "Secret", "--with", "m1"]
        )
        self.assertEqual(rc, 1)
        self.assertIn("key-init", err)


# ---------------------------------------------------------------------------
# secfix F2 — sealed envelopes bind topic_id (cross-topic transplant)
# ---------------------------------------------------------------------------


class TestEnvelopeTopicBinding(unittest.TestCase):
    """Unit tests for the topic_id binding inside sealed envelopes.

    Sealed plaintext: topic_id || 0x00 || key_id(16) || topic_key(32).
    """

    def setUp(self):
        self.sk = PrivateKey.generate()
        self.pub_b64 = base64.b64encode(bytes(self.sk.public_key)).decode("ascii")
        self.priv = bytes(self.sk)
        self.key_id = os.urandom(16)
        self.topic_key = os.urandom(32)

    def test_round_trip_opens_for_right_topic(self):
        env = hub._e2ee_seal_envelope("topic-A", self.key_id, self.topic_key, self.pub_b64)
        kid, key = hub._e2ee_open_envelope(env, self.priv, "topic-A")
        self.assertEqual(kid, self.key_id)
        self.assertEqual(key, self.topic_key)

    def test_transplant_to_other_topic_rejected(self):
        # Sealed for topic A; opening for topic B must fail loudly.
        env = hub._e2ee_seal_envelope("topic-A", self.key_id, self.topic_key, self.pub_b64)
        with self.assertRaises(hub.HubError) as cm:
            hub._e2ee_open_envelope(env, self.priv, "topic-B")
        self.assertIn("DIFFERENT topic", str(cm.exception))

    def test_sealed_plaintext_carries_topic_id(self):
        env = hub._e2ee_seal_envelope("topic-A", self.key_id, self.topic_key, self.pub_b64)
        opened = bindings.crypto_box_seal_open(
            base64.b64decode(env), bytes(self.sk.public_key), self.priv
        )
        self.assertEqual(
            opened, b"topic-A" + b"\x00" + self.key_id + self.topic_key
        )

    def test_legacy_plaintext_without_separator_rejected(self):
        # A pre-binding envelope (key_id || topic_key, no NUL) is malformed
        # under the new format and must never be stored.
        legacy = bindings.crypto_box_seal(
            self.key_id + self.topic_key, bytes(self.sk.public_key)
        )
        env = base64.b64encode(legacy).decode("ascii")
        with self.assertRaises(hub.HubError) as cm:
            hub._e2ee_open_envelope(env, self.priv, "topic-A")
        self.assertIn("malformed", str(cm.exception))

    def test_nul_topic_id_refused_at_seal(self):
        with self.assertRaises(hub.HubError):
            hub._e2ee_seal_envelope("topic\x00evil", self.key_id, self.topic_key, self.pub_b64)


if __name__ == "__main__":
    unittest.main()
