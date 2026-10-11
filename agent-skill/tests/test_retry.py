#!/usr/bin/env python3
"""Tests for hub CLI retry/backoff, auto idempotency keys, and the
circle create/join recovery flows.

Run from the repo root:
    python3 -m unittest discover -s agent-skill/tests -v
"""

import http.client
import importlib.util
import json
import os
import sys
import tempfile
import unittest
import urllib.parse as urlparse
from importlib.machinery import SourceFileLoader
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
HUB_PATH = os.path.join(HERE, "..", "hub")

spec = importlib.util.spec_from_file_location(
    "hubcli_retry", HUB_PATH, loader=SourceFileLoader("hubcli_retry", HUB_PATH)
)
hub = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hub)


class ScriptedTransport:
    """Plays a script of responses/exceptions in order; records calls."""

    def __init__(self, script):
        self.script = list(script)
        self.calls = []

    def __call__(self, method, url, headers, body_bytes):
        self.calls.append(
            {
                "method": method,
                "url": url,
                "headers": dict(headers),
                "body": body_bytes.decode("utf-8") if body_bytes else None,
            }
        )
        if not self.script:
            raise AssertionError("transport called more times than scripted")
        item = self.script.pop(0)
        if isinstance(item, Exception):
            raise item
        status, body = item
        return status, json.dumps(body)


def make_client(transport, debug=False):
    return hub.HubClient("https://hub.test", token="tok", debug=debug, transport=transport)


class RetryTest(unittest.TestCase):
    def setUp(self):
        self._sleep = mock.patch.object(hub.time, "sleep")
        self._sleep.start()

    def tearDown(self):
        self._sleep.stop()

    def test_retries_dropped_connection_then_succeeds(self):
        t = ScriptedTransport(
            [
                http.client.RemoteDisconnected("Remote end closed connection without response"),
                http.client.RemoteDisconnected("dropped again"),
                (200, {"ok": True}),
            ]
        )
        client = make_client(t)
        self.assertEqual(client.call("GET", "/v1/health", auth=False), {"ok": True})
        self.assertEqual(len(t.calls), 3)

    def test_no_retry_on_400(self):
        t = ScriptedTransport([(400, {"error": {"code": "bad_request", "message": "nope"}})])
        client = make_client(t)
        with self.assertRaises(hub.HubError):
            client.call("GET", "/v1/topics")
        self.assertEqual(len(t.calls), 1)

    def test_retries_500_then_succeeds(self):
        t = ScriptedTransport(
            [
                (500, {"error": {"code": "internal", "message": "boom"}}),
                (200, {"ok": True}),
            ]
        )
        client = make_client(t)
        self.assertEqual(client.call("GET", "/v1/health", auth=False), {"ok": True})
        self.assertEqual(len(t.calls), 2)

    def test_exhausted_retries_raise_connection(self):
        t = ScriptedTransport(
            [http.client.RemoteDisconnected("x")] * 5
        )
        client = make_client(t)
        with self.assertRaises(hub.HubError) as cm:
            client.call("GET", "/v1/health", auth=False, retries=2)
        self.assertEqual(cm.exception.code, "connection")
        self.assertEqual(len(t.calls), 3)  # 1 initial + 2 retries

    def test_same_idempotency_key_across_retries(self):
        t = ScriptedTransport(
            [
                http.client.RemoteDisconnected("x"),
                (201, {"id": "f1"}),
            ]
        )
        client = make_client(t)
        client.call("POST", "/v1/families", json_body={"name": "N"}, auth=False)
        keys = {c["headers"].get("Idempotency-Key") for c in t.calls}
        self.assertEqual(len(keys), 1)
        key = keys.pop()
        self.assertTrue(key and len(key) == 32)

    def test_auto_key_on_creates_not_on_redeem(self):
        seen = {}

        def transport(method, url, headers, body_bytes):
            path = urlparse.urlparse(url).path
            seen[path] = headers.get("Idempotency-Key")
            return 200, json.dumps({"ok": True})

        client = make_client(transport)
        client.call("POST", "/v1/families", json_body={}, auth=False)
        client.call("POST", "/v1/topics", json_body={}, auth=False)
        client.call("POST", "/v1/provisioning-codes", json_body={}, auth=False)
        client.call("POST", "/v1/families/f1/invites", json_body={}, auth=False)
        client.call("POST", "/v1/provisioning-codes/fhp_x/redeem", json_body={}, auth=False)
        client.call("POST", "/v1/invites/fhi_x/accept", json_body={}, auth=False)
        self.assertTrue(seen["/v1/families"])
        self.assertTrue(seen["/v1/topics"])
        self.assertTrue(seen["/v1/provisioning-codes"])
        self.assertTrue(seen["/v1/families/f1/invites"])
        self.assertIsNone(seen["/v1/provisioning-codes/fhp_x/redeem"])
        self.assertIsNone(seen["/v1/invites/fhi_x/accept"])

    def test_server_code_preserved(self):
        t = ScriptedTransport(
            [(409, {"error": {"code": "code_used", "message": "used"}})]
        )
        client = make_client(t)
        with self.assertRaises(hub.HubError) as cm:
            client.call("POST", "/v1/x", json_body={}, auth=False)
        # Friendly code stays mapped; server code preserved verbatim.
        self.assertEqual(cm.exception.code, "conflict")
        self.assertEqual(cm.exception.server_code, "code_used")

    def test_redeem_retried_without_key(self):
        # Single-use codes are retry-safe: no key, but retries happen.
        t = ScriptedTransport(
            [
                http.client.RemoteDisconnected("x"),
                (201, {"token": "t", "member": {}}),
            ]
        )
        client = make_client(t)
        resp = client.call(
            "POST", "/v1/provisioning-codes/fhp_abc/redeem", json_body={}, auth=False
        )
        self.assertEqual(resp["token"], "t")
        self.assertEqual(len(t.calls), 2)
        self.assertIsNone(t.calls[0]["headers"].get("Idempotency-Key"))

    def test_task_create_not_retried_without_key(self):
        # Duplicating operations must not retry blindly.
        t = ScriptedTransport(
            [http.client.RemoteDisconnected("x")]
        )
        client = make_client(t)
        with self.assertRaises(hub.HubError) as cm:
            client.call("POST", "/v1/topics/t1/tasks", json_body={}, auth=False)
        self.assertEqual(cm.exception.code, "connection")
        self.assertEqual(len(t.calls), 1)


class CircleCreateRecoveryTest(unittest.TestCase):
    def setUp(self):
        self._sleep = mock.patch.object(hub.time, "sleep")
        self._sleep.start()
        self._saved_env = dict(os.environ)
        self.tmp = tempfile.mkdtemp(prefix="hubtest-")
        os.environ["FAMILY_HUB_CONFIG_HOME"] = self.tmp
        os.environ["FAMILY_HUB_TOKEN"] = "tok"
        os.environ.pop("FAMILY_HUB_VAULT_CMD", None)

    def tearDown(self):
        self._sleep.stop()
        os.environ.clear()
        os.environ.update(self._saved_env)
        import shutil

        shutil.rmtree(self.tmp, ignore_errors=True)
        hub.clear_secrets()

    def _run(self, argv, transport):
        import contextlib
        import io

        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = hub.main(argv, transport=transport)
        return rc, out.getvalue(), err.getvalue()

    def test_create_redeem_lost_response_recovers_via_dedup(self):
        # create -> 201/code1; redeem code1 -> response dropped; redeem retry
        # -> 409 code_used (server did redeem); loop back: create with the
        # SAME key -> 200 dedup/code2; redeem code2 -> token.
        state = {"code1_redeems": 0}
        calls = []

        def router(method, url, headers, body_bytes):
            path = urlparse.urlparse(url).path
            calls.append({"method": method, "url": url, "headers": dict(headers)})
            if path == "/v1/families" and method == "POST":
                n = len([c for c in calls if c["url"].endswith("/v1/families")])
                if n == 1:
                    return 201, json.dumps({"id": "c1", "name": "Gym", "kind": "general",
                                            "provisioning_code": "fhp_code1"})
                return 200, json.dumps({"id": "c1", "name": "Gym", "kind": "general",
                                        "provisioning_code": "fhp_code2", "deduped": True})
            if "fhp_code1" in path:
                state["code1_redeems"] += 1
                if state["code1_redeems"] == 1:
                    raise http.client.RemoteDisconnected("dropped")
                return 409, json.dumps({
                    "error": {"code": "code_used", "message": "used"},
                    "member": {"id": "m1", "family_id": "c1", "name": "Owner"},
                    "token_already_issued": True,
                })
            if "fhp_code2" in path:
                return 201, json.dumps({"token": "tok2",
                                        "member": {"id": "m1", "family_id": "c1"}})
            return 404, json.dumps({})

        rc, out, err = self._run(
            ["--server", "https://hub.test", "circle", "create", "--name", "Gym",
             "--kind", "general"],
            router,
        )
        self.assertEqual(rc, 0, err)
        self.assertIn("now active", out)
        creates = [c for c in calls if c["url"].endswith("/v1/families")]
        self.assertEqual(len(creates), 2)
        self.assertEqual(
            creates[0]["headers"].get("Idempotency-Key"),
            creates[1]["headers"].get("Idempotency-Key"),
        )
        self.assertTrue(creates[0]["headers"].get("Idempotency-Key"))

    def test_create_duplicate_name_is_clear_error(self):
        def transport(method, url, headers, body_bytes):
            return 409, json.dumps(
                {"error": {"code": "circle_name_taken", "message": "exists"}}
            )

        rc, out, err = self._run(
            ["--server", "https://hub.test", "circle", "create", "--name", "Gym"],
            transport,
        )
        self.assertNotEqual(rc, 0)
        self.assertIn("already exists", out + err)


if __name__ == "__main__":
    unittest.main()
