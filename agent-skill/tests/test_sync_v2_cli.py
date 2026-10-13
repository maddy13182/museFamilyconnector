#!/usr/bin/env python3
"""Sync-v2 CLI journeys not covered elsewhere (spec §5).

Builds on the stateful RekeyFakeHub from test_e2ee_rekey (imported, not
duplicated):

- rekey delta->reseal: a member joins between seal and commit -> the server
  409s -> the CLI seals the delta and recommits the SAME key material.
- rekey superseded->re-seal: an identity-key rotation between seal and
  commit -> the server 409s superseded_identity_key -> the CLI re-fetches
  /v1/agent-keys, re-seals the SAME key, recommits.
- --force scoping: --force never bypasses a burn and is never sent for a
  superseded-key retry (force covers ONLY agents with no identity key).
- genesis completion: `hub topic-rekey` finishes a topic stuck at epoch 0
  (commit failed mid-ceremony), reusing the single local genesis key with
  expected_epoch=1.
- N07 commitment verification on open: an envelope whose opened key does
  NOT match the server-advertised epoch commitment is REFUSED (loud in
  key-fetch, warning-skipped in quiet sync refresh) and never stored.

Run from agent-skill/:  python3 -m pytest tests/test_sync_v2_cli.py -q
"""

import base64
import contextlib
import hashlib
import io
import json
import os
import unittest
import urllib.parse as urlparse
from unittest import mock

from nacl.public import PrivateKey  # noqa: E402  (test dependency)

from test_e2ee_rekey import (  # noqa: E402
    E2eeRekeyTestBase,
    RekeyFakeHub,
    TOPIC_ID,
    hub,
)

FAKE_TOKEN = "fh_test_token_0123456789abcdef"


def commit_bodies(fake, epoch=None):
    """Parsed JSON bodies of keys/commit POSTs (the genesis commit from
    new-topic has expected_epoch=1; rekey attempts are epoch 2+)."""
    out = [
        json.loads(c["body"])
        for c in fake.calls
        if c["method"] == "POST" and c["url"].endswith("/keys/commit")
    ]
    if epoch is not None:
        out = [b for b in out if b.get("expected_epoch") == epoch]
    return out


def commit_key_ids(fake, epoch=None):
    return [b["key_id"] for b in commit_bodies(fake, epoch)]


class TestRekeyDeltaReseal(E2eeRekeyTestBase):
    """Join interleaved with rotation: 409 -> seal the delta -> same key."""

    def test_join_delta_reseals_and_recommits_same_key(self):
        self.create_e2ee_topic(["m1", "m2"])
        state = {"rejected": False}

        def hook(tid, topic, body, mid):
            if not state["rejected"]:
                state["rejected"] = True
                # Cee joins AFTER the CLI sealed for m1+m2 (she has a
                # registered identity key, but no envelope for this key).
                topic["participants"].append("m3")
                return 409, json.dumps({"error": {
                    "code": "superseded_identity_key",
                    "message": "m3/cee-agent has no envelope for the active key",
                    "agents": ["m3/cee-agent"]}})
            return self.fake._commit(tid, topic, body, mid)

        self.fake.commit_hook = hook
        rc, out, err = self.run_cli(["topic-rekey", "--topic", TOPIC_ID])
        self.assertEqual(rc, 0, "stderr: %s" % err)

        kids = commit_key_ids(self.fake, epoch=2)
        self.assertEqual(len(kids), 2, "one retry after the 409")
        self.assertEqual(kids[0], kids[1], "the SAME key material is recommitted")
        # The delta was sealed: the committed epoch covers m3.
        epochs = self.fake.topics[TOPIC_ID]["epochs"]
        self.assertEqual(len(epochs), 2)
        self.assertIn("m3/cee-agent", epochs[1]["recipients"])
        result = json.loads(out)
        self.assertEqual(result["key_id"], kids[1])
        self.assertFalse(result["forced_commit"])


class TestRekeySupersededReseal(E2eeRekeyTestBase):
    """Superseded identity key: re-seal the SAME key material, recommit."""

    def test_superseded_reseals_same_key_without_force(self):
        self.create_e2ee_topic(["m1", "m2"])
        state = {"rejected": False}
        bodies = []

        def hook(tid, topic, body, mid):
            bodies.append(dict(body))
            if not state["rejected"]:
                state["rejected"] = True
                return 409, json.dumps({"error": {
                    "code": "superseded_identity_key",
                    "message": "bee-agent rotated their identity key",
                    "agents": ["m2/bee-agent"]}})
            return self.fake._commit(tid, topic, body, mid)

        self.fake.commit_hook = hook
        rc, out, err = self.run_cli(["topic-rekey", "--topic", TOPIC_ID])
        self.assertEqual(rc, 0, "stderr: %s" % err)
        self.assertIn("superseded_identity_key", err)
        self.assertIn("re-sealing", err)

        kids = [b["key_id"] for b in bodies]
        self.assertEqual(len(kids), 2)
        self.assertEqual(kids[0], kids[1], "same key material, re-sealed")
        # force was never sent: it cannot override superseded keys.
        self.assertFalse(any(b.get("force") for b in bodies),
                         "force must never be sent for a superseded-key retry")
        # Envelopes were re-posted (re-seal), not just recommitted.
        env_posts = [c for c in self.fake.calls
                     if c["method"] == "POST" and c["url"].endswith("/envelopes")
                     and json.loads(c["body"])["key_id"] == kids[0]]
        self.assertGreaterEqual(len(env_posts), 4,
                                "re-seal re-posts envelopes for the participants")


class TestForceScoping(E2eeRekeyTestBase):
    """--force covers ONLY agents with no identity key — never burns,
    never superseded keys."""

    def test_force_does_not_bypass_burn(self):
        self.create_e2ee_topic(["m1", "m2"])
        state = {"removed": False}

        def hook(tid, topic, body, mid):
            if not state["removed"]:
                state["removed"] = True
                # Removal AFTER the seal: the real _commit burns.
                topic["participants"].remove("m2")
            return self.fake._commit(tid, topic, body, mid)

        self.fake.commit_hook = hook
        with mock.patch("builtins.input", return_value="yes"):
            rc, out, err = self.run_cli(
                ["topic-rekey", "--topic", TOPIC_ID, "--force"])
        self.assertEqual(rc, 0, "stderr: %s" % err)
        self.assertIn("BURNED", err)

        kids = commit_key_ids(self.fake, epoch=2)
        self.assertEqual(len(kids), 2)
        self.assertNotEqual(kids[0], kids[1],
                            "--force must not resurrect burned material")
        bodies = commit_bodies(self.fake, epoch=2)
        self.assertFalse(any(b.get("force") for b in bodies),
                         "force is never sent on the burn-restart path")
        self.assertFalse(json.loads(out)["forced_commit"])

    def test_force_not_sent_for_superseded_retry(self):
        self.create_e2ee_topic(["m1", "m2"])
        state = {"rejected": False}
        bodies = []

        def hook(tid, topic, body, mid):
            bodies.append(dict(body))
            if not state["rejected"]:
                state["rejected"] = True
                return 409, json.dumps({"error": {
                    "code": "superseded_identity_key",
                    "message": "stale identity key",
                    "agents": ["m2/bee-agent"]}})
            return self.fake._commit(tid, topic, body, mid)

        self.fake.commit_hook = hook
        with mock.patch("builtins.input", return_value="yes"):
            rc, out, err = self.run_cli(
                ["topic-rekey", "--topic", TOPIC_ID, "--force"])
        self.assertEqual(rc, 0, "stderr: %s" % err)
        # Same key recommitted; force never attached.
        self.assertEqual(bodies[0]["key_id"], bodies[1]["key_id"])
        self.assertFalse(any(b.get("force") for b in bodies))


class TestGenesisViaRekey(E2eeRekeyTestBase):
    """A topic stuck at epoch 0 (commit failed mid-ceremony) is completed
    by `hub topic-rekey`, reusing the single local genesis key."""

    def test_rekey_completes_stuck_genesis(self):
        state = {"failed": False}

        def hook(tid, topic, body, mid):
            if not state["failed"]:
                state["failed"] = True
                return 400, json.dumps({"error": {
                    "code": "bad_request", "message": "simulated commit failure"}})
            return self.fake._commit(tid, topic, body, mid)

        self.fake.commit_hook = hook
        rc, out, err = self.run_cli(
            ["new-topic", "--e2ee", "--subject", "Stuck", "--with", "m1"])
        self.assertNotEqual(rc, 0, "the genesis commit must fail")
        self.assertIn("topic-rekey", err)
        # The genesis key remains as the single local anchor.
        keys = self.keystore("default")
        self.assertEqual(len(keys), 1)
        genesis_kid, genesis_key = next(iter(keys.items()))

        # Now complete it via topic-rekey.
        self.fake.commit_hook = None
        rc, out, err = self.run_cli(["topic-rekey", "--topic", TOPIC_ID])
        self.assertEqual(rc, 0, "stderr: %s" % err)
        result = json.loads(out)
        self.assertTrue(result["genesis_completed"])
        self.assertEqual(result["epoch"], 1)
        self.assertEqual(result["key_id"], genesis_kid,
                         "the stuck genesis key is reused, not replaced")
        bodies = commit_bodies(self.fake)
        self.assertEqual(bodies[-1]["expected_epoch"], 1)
        self.assertEqual(self.fake.topics[TOPIC_ID]["current_epoch"], 1)

    def test_rekey_refuses_ambiguous_genesis_keystore(self):
        # Epoch 0 with zero (or 2+) local keys: refuse loudly, never guess.
        self.fake.topics[TOPIC_ID] = {
            "e2ee": 1, "participants": ["m1"], "current_epoch": 0,
            "current_key_id": None, "epochs": [], "history_from": {},
        }
        rc, out, err = self.run_cli(["topic-rekey", "--topic", TOPIC_ID])
        self.assertNotEqual(rc, 0)
        self.assertIn("epoch 0", err)


class TestN07CommitmentMismatch(E2eeRekeyTestBase):
    """N07: an envelope whose opened key mismatches the server-advertised
    epoch commitment is REFUSED and never stored."""

    def _plant_mismatched_envelope(self):
        self.create_e2ee_topic(["m1", "m2"])
        kid = os.urandom(16)
        key = os.urandom(32)
        pub = self.pubs[("m1", "owner-agent")]
        env = hub._e2ee_seal_envelope(TOPIC_ID, kid, key, pub)
        wrong_commitment = "00" * 32  # NOT sha256(key)
        assert wrong_commitment != hashlib.sha256(key).hexdigest()
        self.fake.envelopes.append({
            "topic_id": TOPIC_ID, "member_id": "m1",
            "agent_label": "owner-agent", "key_id": kid.hex(),
            "envelope": env, "identity_key_id": "ik-m1-owner-agent",
            "commitment": None,  # filled from the epoch row on GET
            "created_at": "2026-10-11T00:00:99Z",
        })
        self.fake.topics[TOPIC_ID]["epochs"].append({
            "epoch": 99, "key_id": kid.hex(),
            "commitment": wrong_commitment,
            "recipients": ["m1/owner-agent"], "forced": 0,
            "forced_missing": [],
        })
        return kid.hex()

    def test_key_fetch_refuses_mismatched_commitment_loudly(self):
        kid_hex = self._plant_mismatched_envelope()
        client = hub.HubClient("https://hub.example", token=FAKE_TOKEN,
                               transport=self.fake)
        with self.assertRaises(hub.HubError) as cm:
            hub._e2ee_refresh_own_keys(client, "default", TOPIC_ID,
                                       quiet=False)
        self.assertIn("REFUSING", str(cm.exception))
        self.assertIn("commitment", str(cm.exception))
        self.assertNotIn(kid_hex, self.keystore("default"),
                         "the mismatched key must never be stored")

    def test_quiet_refresh_warns_and_skips_mismatched_commitment(self):
        kid_hex = self._plant_mismatched_envelope()
        client = hub.HubClient("https://hub.example", token=FAKE_TOKEN,
                               transport=self.fake)
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            fresh = hub._e2ee_refresh_own_keys(client, "default", TOPIC_ID,
                                               quiet=True)
        self.assertEqual(fresh, [])
        self.assertIn("WARNING", err.getvalue())
        self.assertIn("commitment", err.getvalue())
        self.assertNotIn(kid_hex, self.keystore("default"),
                         "the mismatched key must never be stored")

    def test_matching_commitment_is_accepted(self):
        self.create_e2ee_topic(["m1", "m2"])
        kid = os.urandom(16)
        key = os.urandom(32)
        pub = self.pubs[("m1", "owner-agent")]
        env = hub._e2ee_seal_envelope(TOPIC_ID, kid, key, pub)
        good = hashlib.sha256(key).hexdigest()
        self.fake.envelopes.append({
            "topic_id": TOPIC_ID, "member_id": "m1",
            "agent_label": "owner-agent", "key_id": kid.hex(),
            "envelope": env, "identity_key_id": "ik-m1-owner-agent",
            "commitment": None,
            "created_at": "2026-10-11T00:00:99Z",
        })
        self.fake.topics[TOPIC_ID]["epochs"].append({
            "epoch": 99, "key_id": kid.hex(), "commitment": good,
            "recipients": ["m1/owner-agent"], "forced": 0,
            "forced_missing": [],
        })
        client = hub.HubClient("https://hub.example", token=FAKE_TOKEN,
                               transport=self.fake)
        fresh = hub._e2ee_refresh_own_keys(client, "default", TOPIC_ID,
                                           quiet=False)
        self.assertEqual(fresh, [kid.hex()])
        self.assertEqual(self.keystore("default")[kid.hex()], key)

    def test_commitment_check_unit_cases(self):
        key = b"k" * 32
        good = hashlib.sha256(key).hexdigest()
        self.assertTrue(hub._commitment_check(key, good))
        self.assertTrue(hub._commitment_check(key, good.upper()),
                        "commitment comparison is case-insensitive")
        self.assertFalse(hub._commitment_check(key, "00" * 32))
        self.assertFalse(hub._commitment_check(key, "not-hex"))
        self.assertFalse(hub._commitment_check(key, 42))
        self.assertIsNone(hub._commitment_check(key, None),
                          "grandfathered NULL commitment: unverifiable, not a mismatch")


if __name__ == "__main__":
    unittest.main()
