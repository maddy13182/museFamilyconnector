#!/usr/bin/env python3
"""Tests for the `hub` CLI: arg parsing, token redaction, PII pre-scan.

Run from the repo root:
    python3 -m unittest discover -s agent-skill/tests -v
"""

import contextlib
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

HERE = os.path.dirname(os.path.abspath(__file__))
HUB_PATH = os.path.join(HERE, "..", "hub")

spec = importlib.util.spec_from_file_location(
    "hubcli", HUB_PATH, loader=SourceFileLoader("hubcli", HUB_PATH)
)
hub = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hub)


# ---------------------------------------------------------------------------
# Fake transport: canned Hub server
# ---------------------------------------------------------------------------


class FakeHub:
    """Canned responses keyed by (method, path). Records every call."""

    def __init__(self):
        self.routes = {}
        self.calls = []

    def add(self, method, path, status, body):
        self.routes[(method.upper(), path)] = (status, body)

    def __call__(self, method, url, headers, body_bytes):
        self.calls.append(
            {
                "method": method,
                "url": url,
                "headers": dict(headers),
                "body": body_bytes.decode("utf-8") if body_bytes else None,
            }
        )
        path = urlparse.urlparse(url).path
        key = (method.upper(), path)
        if key in self.routes:
            status, body = self.routes[key]
        else:
            status, body = 404, {"error": {"code": "not_found", "message": "no route"}}
        return status, json.dumps(body)

    def last_url(self):
        return self.calls[-1]["url"] if self.calls else ""


@contextlib.contextmanager
def captured():
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        yield out, err


FAKE_TOKEN = "fh_TESTTOKEN_abc123XYZ"


class HubTestBase(unittest.TestCase):
    def setUp(self):
        # Isolated environment: temp config home, fake token in env.
        self._saved_env = dict(os.environ)
        self.tmp = tempfile.mkdtemp(prefix="hubtest-")
        os.environ["FAMILY_HUB_CONFIG_HOME"] = self.tmp
        os.environ["FAMILY_HUB_TOKEN"] = FAKE_TOKEN
        os.environ.pop("FAMILY_HUB_VAULT_CMD", None)
        self.fake = FakeHub()

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._saved_env)
        shutil.rmtree(self.tmp, ignore_errors=True)
        hub.clear_secrets()

    def run_cli(self, argv):
        with captured() as (out, err):
            rc = hub.main(argv, transport=self.fake)
        return rc, out.getvalue(), err.getvalue()

    def assertTokenAbsent(self, *blobs):
        for blob in blobs:
            self.assertNotIn(
                FAKE_TOKEN, blob, "token leaked into CLI output!"
            )

    def seed_config(self, profile="default", **over):
        cfg = {
            "server_url": "https://hub.example",
            "member": {"id": "m1", "name": "Tester", "role": "parent"},
            "agent_label": "test-agent",
            "auth_method": "env",
        }
        cfg.update(over)
        hub.save_config(profile, cfg)


# ---------------------------------------------------------------------------
# PII pre-scan
# ---------------------------------------------------------------------------


class TestPII(HubTestBase):
    def test_card_spaced(self):
        self.assertEqual(hub.scan_pii("pay 4111 1111 1111 1111 now"),
                         ["possible card number"])

    def test_card_dashed(self):
        self.assertEqual(hub.scan_pii("card 4111-1111-1111-1111"),
                         ["possible card number"])

    def test_card_plain_amex(self):
        self.assertEqual(hub.scan_pii("378282246310005"),
                         ["possible card number"])

    def test_card_luhn_fail_is_clean(self):
        self.assertEqual(hub.scan_pii("4111111111111112"), [])

    def test_ssn(self):
        self.assertEqual(hub.scan_pii("ssn 123-45-6789 here"),
                         ["possible SSN"])

    def test_phone_number_is_clean(self):
        self.assertEqual(hub.scan_pii("call me at 555-0199"), [])

    def test_short_numbers_clean(self):
        self.assertEqual(hub.scan_pii("order 12345, qty 7"), [])

    def test_long_digit_run_clean(self):
        self.assertEqual(hub.scan_pii("ref 12345678901234567890"), [])

    def test_both_findings(self):
        findings = hub.scan_pii("card 4111 1111 1111 1111 ssn 123-45-6789")
        self.assertIn("possible card number", findings)
        self.assertIn("possible SSN", findings)


# ---------------------------------------------------------------------------
# Arg parsing
# ---------------------------------------------------------------------------


class TestArgs(HubTestBase):
    def parse(self, argv):
        return hub.build_parser().parse_args(argv)

    def test_post(self):
        a = self.parse(["post", "--topic", "t1", "--message", "hi"])
        self.assertEqual((a.command, a.topic, a.message), ("post", "t1", "hi"))

    def test_post_requires_message(self):
        with self.assertRaises(SystemExit):
            self.parse(["post", "--topic", "t1"])

    def test_sync(self):
        self.assertEqual(self.parse(["sync"]).command, "sync")

    def test_setup(self):
        a = self.parse(["setup", "--server", "https://x", "--store", "file"])
        self.assertEqual(a.store, "file")

    def test_spawn(self):
        a = self.parse(["spawn", "--topic", "t", "--subject", "s",
                        "--with", "a,b", "--with", "c", "--briefing", "b"])
        self.assertEqual(hub._id_list(a.with_), ["a", "b", "c"])

    def test_invite_history(self):
        a = self.parse(["invite", "--topic", "t", "--member", "m1",
                        "--history", "from-join"])
        self.assertEqual(a.history, "from-join")

    def test_task_done_result(self):
        a = self.parse(["task-done", "--task", "tk", "--result", '{"a": 1}'])
        self.assertEqual(a.result, '{"a": 1}')

    def test_tasks_filters(self):
        a = self.parse(["tasks", "--topic", "t", "--assigned-to", "me",
                        "--status", "open"])
        self.assertEqual((a.assigned_to, a.status), ("me", "open"))

    def test_no_token_flag_anywhere(self):
        parser = hub.build_parser()
        seen = []

        def walk(p):
            for action in p._actions:
                seen.extend(action.option_strings)
            if p._subparsers is None:
                return
            for sub in p._subparsers._group_actions:
                for child in sub.choices.values():
                    walk(child)

        walk(parser)
        self.assertNotIn("--token", seen,
                         "the CLI must never accept the token on the command line")

    def test_id_list(self):
        self.assertEqual(hub._id_list(["a,b", "c", ""]), ["a", "b", "c"])
        self.assertEqual(hub._id_list([]), [])


# ---------------------------------------------------------------------------
# Token loading precedence
# ---------------------------------------------------------------------------


class TestTokenLoading(HubTestBase):
    def test_env_wins_over_file(self):
        profile = "default"
        cfg = {"token_file": os.path.join(self.tmp, "tokfile")}
        with open(cfg["token_file"], "w") as fh:
            fh.write("fh_FROMFILE_000\n")
        os.chmod(cfg["token_file"], 0o600)
        token, source = hub.load_token(cfg, profile)
        self.assertEqual((token, source), (FAKE_TOKEN, "env"))

    def test_file_used_when_no_env(self):
        os.environ.pop("FAMILY_HUB_TOKEN")
        cfg = {"token_file": os.path.join(self.tmp, "tokfile")}
        with open(cfg["token_file"], "w") as fh:
            fh.write("fh_FROMFILE_111\n")
        os.chmod(cfg["token_file"], 0o600)
        token, source = hub.load_token(cfg, profile="default")
        self.assertEqual((token, source), ("fh_FROMFILE_111", "token-file"))

    def test_vault_cmd(self):
        os.environ.pop("FAMILY_HUB_TOKEN")
        os.environ["FAMILY_HUB_VAULT_CMD"] = "echo fh_FROMVAULT_222"
        token, source = hub.load_token({}, profile="default")
        self.assertEqual((token, source), ("fh_FROMVAULT_222", "vault-cmd"))

    def test_no_credential_raises(self):
        os.environ.pop("FAMILY_HUB_TOKEN")
        with self.assertRaises(hub.HubError):
            hub.load_token({}, profile="default")

    def test_world_readable_file_warns(self):
        os.environ.pop("FAMILY_HUB_TOKEN")
        cfg = {"token_file": os.path.join(self.tmp, "tokfile")}
        with open(cfg["token_file"], "w") as fh:
            fh.write("fh_FROMFILE_333\n")
        os.chmod(cfg["token_file"], 0o644)
        with captured() as (_out, err):
            hub.load_token(cfg, profile="default")
        self.assertIn("readable by others", err.getvalue())


# ---------------------------------------------------------------------------
# Redaction: the token must never appear in any output
# ---------------------------------------------------------------------------


class TestRedaction(HubTestBase):
    def test_sync_redacted(self):
        self.seed_config()
        self.fake.add("GET", "/v1/sync", 200,
                      {"entries": [{"gseq": 3, "seq": 1, "body": "hello"}]})
        rc, out, err = self.run_cli(["sync"])
        self.assertEqual(rc, 0)
        self.assertTokenAbsent(out, err)
        # auth header was actually sent
        self.assertEqual(
            self.fake.calls[0]["headers"].get("Authorization"),
            "Bearer " + FAKE_TOKEN,
        )

    def test_debug_redacts_authorization(self):
        self.seed_config()
        self.fake.add("GET", "/v1/sync", 200, {"entries": []})
        rc, out, err = self.run_cli(["--debug", "sync"])
        self.assertEqual(rc, 0)
        self.assertTokenAbsent(out, err)
        self.assertNotIn("Bearer " + FAKE_TOKEN, err)
        self.assertIn("[redacted]", err)  # the header value is scrubbed

    def test_post_redacted(self):
        self.seed_config()
        self.fake.add("POST", "/v1/topics/t1/entries", 200,
                      {"gseq": 9, "seq": 4, "body": "hi"})
        rc, out, err = self.run_cli(
            ["post", "--topic", "t1", "--message", "hello family"])
        self.assertEqual(rc, 0)
        self.assertTokenAbsent(out, err)

    def test_401_error_redacted(self):
        self.seed_config()
        self.fake.add("GET", "/v1/sync", 401,
                      {"error": {"code": "auth", "message": "bad token"}})
        rc, out, err = self.run_cli(["sync"])
        self.assertEqual(rc, 3)
        self.assertTokenAbsent(out, err)
        self.assertIn("Authentication failed", err)

    def test_500_error_redacted(self):
        self.seed_config()
        self.fake.add("GET", "/v1/topics", 500,
                      {"error": {"code": "internal", "message": "boom"}})
        rc, out, err = self.run_cli(["topics"])
        self.assertEqual(rc, 1)
        self.assertTokenAbsent(out, err)

    def test_403_forbidden_message(self):
        self.seed_config()
        self.fake.add("GET", "/v1/topics/t9/history", 403,
                      {"error": {"code": "forbidden",
                                 "message": "not a participant"}})
        rc, out, err = self.run_cli(["read", "--topic", "t9"])
        self.assertEqual(rc, 1)
        self.assertTokenAbsent(out, err)
        self.assertIn("final", err)

    def test_422_pii_message(self):
        self.seed_config()
        self.fake.add("POST", "/v1/topics/t1/entries", 422,
                      {"error": {"code": "pii",
                                 "message": "possible card number detected"}})
        rc, out, err = self.run_cli(
            ["post", "--topic", "t1", "--message", "looks innocent"])
        self.assertEqual(rc, 4)
        self.assertTokenAbsent(out, err)
        self.assertIn("Rephrase", err)

    def test_local_pii_refusal_sends_nothing(self):
        self.seed_config()
        rc, out, err = self.run_cli(
            ["post", "--topic", "t1",
             "--message", "my card is 4111 1111 1111 1111"])
        self.assertEqual(rc, 4)
        self.assertEqual(self.fake.calls, [])  # nothing hit the wire
        self.assertTokenAbsent(out, err)
        self.assertNotIn("4111", out + err)  # don't echo the sensitive value

    def test_setup_never_echoes_token(self):
        new_token = "fh_NEWLYISSUED_999"
        self.fake.add(
            "POST", "/v1/invites/CODE123/accept", 200,
            {"member": {"id": "m2", "name": "Lakshmi", "role": "parent",
                        "email": "l@example.com"},
             "token": new_token, "token_id": "tok_1"},
        )
        rc, out, err = self.run_cli([
            "setup", "--server", "https://hub.example",
            "--invite", "CODE123", "--name", "Lakshmi",
            "--label", "test-agent", "--store", "env",
        ])
        self.assertEqual(rc, 0)
        self.assertNotIn(new_token, out + err)
        self.assertTokenAbsent(out, err)
        # config on disk contains no token either
        with open(hub.config_path("default")) as fh:
            self.assertNotIn(new_token, fh.read())

    def test_setup_failure_redacted(self):
        self.fake.add("POST", "/v1/invites/BAD/accept", 401,
                      {"error": {"code": "auth", "message": "bad invite"}})
        rc, out, err = self.run_cli([
            "setup", "--server", "https://hub.example",
            "--invite", "BAD", "--name", "X", "--label", "y",
        ])
        self.assertNotEqual(rc, 0)
        self.assertTokenAbsent(out, err)

    def test_task_done_redacted(self):
        self.seed_config()
        self.fake.add("POST", "/v1/tasks/tk1/done", 200, {"ok": True})
        rc, out, err = self.run_cli(
            ["task-done", "--task", "tk1", "--result", '{"conflicts": []}'])
        self.assertEqual(rc, 0)
        self.assertTokenAbsent(out, err)

    def test_spawn_redacted(self):
        self.seed_config()
        self.fake.add("POST", "/v1/topics/tp/spawn", 200, {"id": "tc"})
        rc, out, err = self.run_cli([
            "spawn", "--topic", "tp", "--subject", "kid-safe",
            "--with", "m2", "--briefing", "approved summary"])
        self.assertEqual(rc, 0)
        self.assertTokenAbsent(out, err)


# ---------------------------------------------------------------------------
# Sync cursor behavior
# ---------------------------------------------------------------------------


class TestSyncCursor(HubTestBase):
    def test_cursor_advances(self):
        self.seed_config()
        self.fake.add("GET", "/v1/sync", 200, {"entries": [
            {"gseq": 5, "seq": 1, "body": "a"},
            {"gseq": 7, "seq": 2, "body": "b"},
        ]})
        rc, out, _ = self.run_cli(["sync"])
        self.assertEqual(rc, 0)
        entries = json.loads(out)
        self.assertEqual(len(entries), 2)
        with open(hub.cursor_path("default")) as fh:
            self.assertEqual(fh.read().strip(), "7")
        # second sync resumes after gseq=7
        rc, _out2, _ = self.run_cli(["sync"])
        self.assertIn("after_gseq=7", self.fake.last_url())

    def test_cursor_untouched_when_empty(self):
        self.seed_config()
        with open(hub.cursor_path("default"), "w") as fh:
            fh.write("42")
        self.fake.add("GET", "/v1/sync", 200, {"entries": []})
        rc, out, _ = self.run_cli(["sync"])
        self.assertEqual(rc, 0)
        self.assertEqual(json.loads(out), [])
        with open(hub.cursor_path("default")) as fh:
            self.assertEqual(fh.read().strip(), "42")


# ---------------------------------------------------------------------------
# Command wiring (request shape + error mapping)
# ---------------------------------------------------------------------------


class TestCommands(HubTestBase):
    def test_topics_search_param(self):
        self.seed_config()
        self.fake.add("GET", "/v1/topics", 200, {"topics": []})
        rc, out, _ = self.run_cli(["topics", "--search", "trip"])
        self.assertEqual(rc, 0)
        self.assertIn("q=trip", self.fake.last_url())

    def test_post_idempotency_key_auto(self):
        self.seed_config()
        self.fake.add("POST", "/v1/topics/t1/entries", 200, {"gseq": 1})
        rc, out, _ = self.run_cli(["post", "--topic", "t1", "--message", "x"])
        self.assertEqual(rc, 0)
        self.assertIn("Idempotency-Key",
                      self.fake.calls[0]["headers"])
        self.assertIn("idempotency_key", out)

    def test_post_bad_data_json(self):
        self.seed_config()
        rc, _out, err = self.run_cli(
            ["post", "--topic", "t1", "--message", "x", "--data", "{nope"])
        self.assertEqual(rc, 1)
        self.assertEqual(self.fake.calls, [])
        self.assertIn("valid JSON", err)

    def test_task_done_bad_result_json(self):
        self.seed_config()
        rc, _out, err = self.run_cli(
            ["task-done", "--task", "t", "--result", "nope"])
        self.assertEqual(rc, 1)
        self.assertIn("valid JSON", err)

    def test_tasks_assigned_to_me_filter(self):
        self.seed_config()
        self.fake.add("GET", "/v1/topics/t1/tasks", 200, {"tasks": [
            {"id": "a", "assignee_member_id": "m1", "status": "open"},
            {"id": "b", "assignee_member_id": "m2", "status": "open"},
        ]})
        rc, out, _ = self.run_cli(
            ["tasks", "--topic", "t1", "--assigned-to", "me"])
        self.assertEqual(rc, 0)
        tasks = json.loads(out)
        self.assertEqual([t["id"] for t in tasks], ["a"])

    def test_new_topic_direct_requires_two(self):
        self.seed_config()
        rc, _out, err = self.run_cli(
            ["new-topic", "--subject", "s", "--with", "m1", "--kind", "direct"])
        self.assertEqual(rc, 1)
        self.assertIn("exactly 2", err)

    def test_me_needs_no_token(self):
        os.environ.pop("FAMILY_HUB_TOKEN")
        self.seed_config()
        rc, out, _ = self.run_cli(["me"])
        self.assertEqual(rc, 0)
        me = json.loads(out)
        self.assertEqual(me["member"]["id"], "m1")
        self.assertNotIn("FAMILY_HUB_TOKEN", out)

    def test_missing_server(self):
        os.environ.pop("FAMILY_HUB_TOKEN", None)
        rc, _out, err = self.run_cli(["--profile", "nosuch", "sync"])
        self.assertEqual(rc, 1)
        self.assertIn("hub setup", err)


if __name__ == "__main__":
    unittest.main()
