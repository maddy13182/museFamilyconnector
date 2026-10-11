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
import stat
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
        self.seqs = {}
        self.calls = []

    def add(self, method, path, status, body):
        self.routes[(method.upper(), path)] = (status, body)

    def add_seq(self, method, path, responses):
        """Serve canned (status, body) responses in call order for (method, path).

        Useful when the same route must behave differently on successive
        calls (e.g. circle A succeeds while circle B fails a sync poll).
        Falls back to `add()` routes once the sequence is exhausted.
        """
        self.seqs[(method.upper(), path)] = list(responses)

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
        if key in self.seqs and self.seqs[key]:
            status, body = self.seqs[key].pop(0)
        elif key in self.routes:
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

    def test_debug_redacts_redeem_token_and_code(self):
        # The redeem request URL carries the bearer code and the redeem
        # response carries the fresh token; --debug must expose neither.
        # (The token cannot be note_secret()-registered yet at dump time,
        # so the scrub has to be structural.)
        self.seed_config()
        secret_tok = "fh_DEBUGMINTED999"
        code = "fhp_DEBUGCODE999"
        self.fake.add("POST", "/v1/provisioning-codes/%s/redeem" % code,
                      201,
                      {"token": secret_tok, "token_id": "tokD",
                       "member": {"id": "mD", "family_id": "cD9",
                                  "name": "Tester", "role": "member"}})
        self.fake.add("GET", "/v1/families", 200, {"families": []})
        rc, out, err = self.run_cli(["--debug", "circle", "join",
                                     "--code", code])
        self.assertEqual(rc, 0)
        self.assertNotIn(secret_tok, out + err)
        self.assertNotIn(code, out + err)
        self.assertIn("[redacted]", err)  # scrub markers present

    def test_scrub_sensitive_text(self):
        body = json.dumps({"token": "fh_X", "member": {"id": "m1"},
                           "provisioning_code": "fhp_Y"})
        scrubbed = hub._scrub_sensitive_text(body)
        self.assertNotIn("fh_X", scrubbed)
        self.assertNotIn("fhp_Y", scrubbed)
        self.assertIn("[redacted]", scrubbed)
        nested = json.dumps({"a": [{"token": "fh_Z"}]})
        self.assertNotIn("fh_Z", hub._scrub_sensitive_text(nested))
        self.assertEqual(hub._scrub_sensitive_text("plain text"), "plain text")
        self.assertEqual(hub._scrub_sensitive_text(""), "")

    def test_scrub_url(self):
        url = "https://hub.example/v1/provisioning-codes/fhp_ABC123/redeem"
        scrubbed = hub._scrub_url(url)
        self.assertNotIn("fhp_ABC123", scrubbed)
        self.assertIn("fhp_[redacted]", scrubbed)
        self.assertEqual(hub._scrub_url("https://hub.example/v1/sync"),
                         "https://hub.example/v1/sync")

    def test_save_config_is_0600(self):
        self.seed_config(circle_tokens={"c1": "fh_XYZ"})
        mode = stat.S_IMODE(os.stat(hub.config_path("default")).st_mode)
        self.assertEqual(mode, 0o600)

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


class TestCloudflareAndInvite(HubTestBase):
    def test_user_agent_identifies_client(self):
        # Regression: Cloudflare Error 1010 blocks Python-urllib's default UA.
        self.seed_config()
        self.fake.add("GET", "/v1/topics", 200, {"topics": []})
        rc, _out, _err = self.run_cli(["topics"])
        self.assertEqual(rc, 0)
        ua = self.fake.calls[0]["headers"].get("User-Agent", "")
        self.assertTrue(ua.startswith("family-hub-agent/"),
                        "User-Agent must identify the client, got %r" % ua)
        self.assertNotIn("Python-urllib", ua)

    def test_cloudflare_1010_detected(self):
        payload = {
            "cloudflare_error": True,
            "error_code": 1010,
            "title": "Error 1010: Access denied",
            "detail": "blocked based on your browser's signature.",
        }
        exc = hub._friendly_from_http(403, payload)
        self.assertEqual(exc.code, "connection")
        self.assertIn("Cloudflare", str(exc))

    def test_invite_member_posts_code(self):
        self.seed_config(family_id="fam1")
        self.fake.add("POST", "/v1/families/fam1/invites", 201,
                      {"invite_code": "inv_abc", "expires_at": "t"})
        rc, out, _err = self.run_cli(
            ["invite-member", "--email", "lakshmi@example.com", "--role", "parent"])
        self.assertEqual(rc, 0)
        self.assertIn("/v1/families/fam1/invites", self.fake.last_url())
        body = json.loads(self.fake.calls[0]["body"])
        self.assertEqual(body, {"email": "lakshmi@example.com", "role": "parent"})
        self.assertIn("inv_abc", out)

    def test_invite_member_needs_family_id(self):
        self.seed_config()  # no active circle at all
        rc, _out, err = self.run_cli(
            ["invite-member", "--email", "x@example.com", "--role", "kid"])
        self.assertEqual(rc, 1)
        self.assertEqual(self.fake.calls, [])
        self.assertIn("No active circle", err)

    def test_invite_member_bad_email(self):
        self.seed_config(family_id="fam1")
        rc, _out, err = self.run_cli(
            ["invite-member", "--email", "not-an-email", "--role", "kid"])
        self.assertEqual(rc, 1)
        self.assertEqual(self.fake.calls, [])


# ---------------------------------------------------------------------------
# Circles (v0.2.0): list / create / use / --circle override
# ---------------------------------------------------------------------------

CIRCLES = [
    {"id": "c111", "name": "Family", "kind": "family",
     "my_role": "owner", "created_at": "t"},
    {"id": "c222", "name": "Friends", "kind": "general",
     "my_role": "member", "created_at": "t"},
]


class TestCircles(HubTestBase):
    def call_paths(self):
        return [(c["method"], urlparse.urlparse(c["url"]).path)
                for c in self.fake.calls]

    def test_circles_lists_with_active_marked(self):
        self.seed_config(active_circle_id="c222")
        self.fake.add("GET", "/v1/families", 200, {"families": CIRCLES})
        rc, out, _ = self.run_cli(["circles"])
        self.assertEqual(rc, 0)
        self.assertIn("* Friends", out)
        self.assertIn("(active)", out)
        self.assertIn("  Family", out)  # inactive: blank marker
        self.assertNotIn("c111 (active)", out)
        self.assertTokenAbsent(out)

    def test_circles_empty(self):
        self.seed_config()
        self.fake.add("GET", "/v1/families", 200, {"families": []})
        rc, out, _ = self.run_cli(["circles"])
        self.assertEqual(rc, 0)
        self.assertIn("no circles", out)

    def test_circle_create_posts_name_kind(self):
        self.seed_config()
        self.fake.add("POST", "/v1/families", 201,
                      {"id": "c333", "name": "Gym", "kind": "general",
                       "created_at": "t"})
        rc, out, _ = self.run_cli(
            ["circle", "create", "--name", "Gym", "--kind", "general"])
        self.assertEqual(rc, 0)
        body = json.loads(self.fake.calls[0]["body"])
        self.assertEqual(body, {"name": "Gym", "kind": "general"})
        self.assertIn("c333", out)
        self.assertTokenAbsent(out)

    def test_circle_create_rejects_blank_name(self):
        self.seed_config()
        rc, _out, err = self.run_cli(
            ["circle", "create", "--name", "   "])
        self.assertEqual(rc, 1)
        self.assertEqual(self.fake.calls, [])
        self.assertIn("non-empty", err)

    def test_circle_use_by_name(self):
        self.seed_config(family_id="c111")
        self.fake.add("GET", "/v1/families", 200, {"families": CIRCLES})
        rc, out, _ = self.run_cli(["circle", "use", "Friends"])
        self.assertEqual(rc, 0)
        self.assertIn("c222", out)
        cfg = hub.load_config("default")
        self.assertEqual(cfg["active_circle_id"], "c222")

    def test_circle_use_by_id_prefix(self):
        self.seed_config()
        self.fake.add("GET", "/v1/families", 200, {"families": CIRCLES})
        rc, _out, _ = self.run_cli(["circle", "use", "c22"])
        self.assertEqual(rc, 0)
        self.assertEqual(hub.load_config("default")["active_circle_id"],
                         "c222")

    def test_circle_use_ambiguous_prefix(self):
        self.seed_config()
        self.fake.add("GET", "/v1/families", 200, {"families": CIRCLES})
        rc, _out, err = self.run_cli(["circle", "use", "c"])
        self.assertEqual(rc, 1)
        self.assertIn("Ambiguous", err)
        self.assertNotIn("active_circle_id", hub.load_config("default"))

    def test_circle_use_no_match(self):
        self.seed_config()
        self.fake.add("GET", "/v1/families", 200, {"families": CIRCLES})
        rc, _out, err = self.run_cli(["circle", "use", "Nope"])
        self.assertEqual(rc, 1)
        self.assertIn("No circle matches", err)
        self.assertIn("Family", err)  # candidates listed

    def test_circle_use_duplicate_names(self):
        self.seed_config()
        dupes = [
            {"id": "d1", "name": "Dup", "kind": "family", "my_role": "owner"},
            {"id": "d2", "name": "Dup", "kind": "family", "my_role": "owner"},
        ]
        self.fake.add("GET", "/v1/families", 200, {"families": dupes})
        rc, _out, err = self.run_cli(["circle", "use", "Dup"])
        self.assertEqual(rc, 1)
        self.assertIn("Multiple circles named", err)

    def test_resolve_prefers_active_over_legacy(self):
        # Active circle wins for resolution; its own token is used (the
        # server binds each token to one family, so the legacy token for
        # c111 could not act on c222).
        self.seed_config(active_circle_id="c222", family_id="c111",
                         circle_tokens={"c222": "fh_C222_tok"})
        self.fake.add("POST", "/v1/families/c222/invites", 201,
                      {"invite_code": "inv_x"})
        rc, _out, _ = self.run_cli(
            ["invite-member", "--email", "a@example.com", "--role", "kid"])
        self.assertEqual(rc, 0)
        # no discovery call needed: the stored id is used directly
        self.assertEqual(self.call_paths(),
                         [("POST", "/v1/families/c222/invites")])
        auth = self.fake.calls[0]["headers"]["Authorization"]
        self.assertEqual(auth, "Bearer fh_C222_tok")

    def test_legacy_family_id_fallback(self):
        self.seed_config(family_id="c111")  # pre-circles profile
        self.fake.add("POST", "/v1/families/c111/invites", 201,
                      {"invite_code": "inv_y"})
        rc, _out, _ = self.run_cli(
            ["invite-member", "--email", "a@example.com", "--role", "kid"])
        self.assertEqual(rc, 0)
        self.assertEqual(self.call_paths(),
                         [("POST", "/v1/families/c111/invites")])

    def test_circle_override_flag(self):
        # --circle switches target AND token: c222's own token is used,
        # since the legacy c111 token is bound to its own family.
        self.seed_config(family_id="c111",
                         circle_tokens={"c222": "fh_C222_tok"})
        self.fake.add("GET", "/v1/families", 200, {"families": CIRCLES})
        self.fake.add("POST", "/v1/families/c222/invites", 201,
                      {"invite_code": "inv_z"})
        rc, _out, _ = self.run_cli(
            ["invite-member", "--circle", "Friends",
             "--email", "a@example.com", "--role", "kid"])
        self.assertEqual(rc, 0)
        self.assertEqual(self.call_paths(),
                         [("GET", "/v1/families"),
                          ("POST", "/v1/families/c222/invites")])
        post = [c for c in self.fake.calls
                if urlparse.urlparse(c["url"]).path.endswith("/invites")][0]
        self.assertEqual(post["headers"]["Authorization"],
                         "Bearer fh_C222_tok")

    def test_override_no_match_makes_no_post(self):
        self.seed_config(family_id="c111")
        self.fake.add("GET", "/v1/families", 200, {"families": CIRCLES})
        rc, _out, err = self.run_cli(
            ["invite-member", "--circle", "Nope",
             "--email", "a@example.com", "--role", "kid"])
        self.assertEqual(rc, 1)
        self.assertIn("No circle matches", err)
        self.assertEqual(self.call_paths(), [("GET", "/v1/families")])


# ---------------------------------------------------------------------------
# Per-circle tokens (v0.2.0): one token per circle, active-circle auth,
# legacy fallback, multi-circle sync, dashboard-token
# ---------------------------------------------------------------------------


class TestCircleTokens(HubTestBase):
    TOK_A = "fh_CIRCLE_A_token123456"
    TOK_B = "fh_CIRCLE_B_token789012"

    def seed_multi(self, **over):
        cfg = {
            "active_circle_id": "c111",
            "circle_tokens": {"c111": self.TOK_A, "c222": self.TOK_B},
            "circle_members": {
                "c111": {"id": "m1", "name": "Tester", "role": "owner"},
                "c222": {"id": "m9", "name": "Tester", "role": "member"},
            },
        }
        cfg.update(over)
        self.seed_config(**cfg)

    def sync_paths(self):
        return [
            (urlparse.urlparse(c["url"]).path, c["headers"].get("Authorization"))
            for c in self.fake.calls
            if urlparse.urlparse(c["url"]).path == "/v1/sync"
        ]

    # -- circle create auto-redeem --------------------------------------

    def test_create_auto_redeem_stores_token_and_activates(self):
        self.seed_config()
        self.fake.add("POST", "/v1/families", 201,
                      {"id": "c333", "name": "Gym", "kind": "general",
                       "created_at": "t",
                       "provisioning_code": "fhp_NEWCODE123",
                       "provisioning_expires_at": "t2"})
        self.fake.add("POST", "/v1/provisioning-codes/fhp_NEWCODE123/redeem",
                      201,
                      {"token": "fh_NEWCIRCLE_tok999", "token_id": "tok9",
                       "member": {"id": "m9", "family_id": "c333",
                                  "name": "Tester", "role": "owner",
                                  "email": "t@example.com"}})
        rc, out, err = self.run_cli(
            ["circle", "create", "--name", "Gym", "--kind", "general"])
        self.assertEqual(rc, 0)
        cfg = hub.load_config("default")
        self.assertEqual(cfg["circle_tokens"]["c333"], "fh_NEWCIRCLE_tok999")
        self.assertEqual(cfg["active_circle_id"], "c333")
        self.assertEqual(cfg["circle_members"]["c333"]["id"], "m9")
        self.assertIn("now active", out)
        self.assertIn("c333", out)
        # token never appears in output...
        self.assertNotIn("fh_NEWCIRCLE_tok999", out + err)
        self.assertTokenAbsent(out, err)
        # ...but IS persisted in the 0600 config
        with open(hub.config_path("default")) as fh:
            self.assertIn("fh_NEWCIRCLE_tok999", fh.read())
        mode = stat.S_IMODE(os.stat(hub.config_path("default")).st_mode)
        self.assertEqual(mode, 0o600)
        # redeem used no Authorization header (the code is the credential)
        redeem = [c for c in self.fake.calls if "redeem" in c["url"]][0]
        self.assertNotIn("Authorization", redeem["headers"])

    def test_create_redeem_mismatch_refuses_to_store(self):
        self.seed_config()
        self.fake.add("POST", "/v1/families", 201,
                      {"id": "c333", "name": "Gym", "kind": "general",
                       "created_at": "t",
                       "provisioning_code": "fhp_NEWCODE123",
                       "provisioning_expires_at": "t2"})
        self.fake.add("POST", "/v1/provisioning-codes/fhp_NEWCODE123/redeem",
                      201,
                      {"token": "fh_WRONG_tok", "token_id": "tok9",
                       "member": {"id": "m9", "family_id": "c999",
                                  "name": "Tester", "role": "owner"}})
        rc, _out, err = self.run_cli(["circle", "create", "--name", "Gym"])
        self.assertEqual(rc, 1)
        self.assertIn("different circle", err)
        cfg = hub.load_config("default")
        self.assertNotIn("circle_tokens", cfg)
        self.assertNotIn("fh_WRONG_tok", err)

    # -- circle join -----------------------------------------------------

    def test_join_with_provisioning_code(self):
        self.seed_config()
        self.fake.add("POST", "/v1/provisioning-codes/fhp_JOIN123/redeem",
                      201,
                      {"token": "fh_JOINED_tok111", "token_id": "tokJ",
                       "member": {"id": "m7", "family_id": "c777",
                                  "name": "Tester", "role": "member"}})
        self.fake.add("GET", "/v1/families", 200, {"families": [
            {"id": "c777", "name": "Book Club", "kind": "general",
             "my_role": "member"}]})
        rc, out, err = self.run_cli(["circle", "join", "--code", "fhp_JOIN123"])
        self.assertEqual(rc, 0)
        cfg = hub.load_config("default")
        self.assertEqual(cfg["circle_tokens"]["c777"], "fh_JOINED_tok111")
        self.assertEqual(cfg["active_circle_id"], "c777")
        self.assertIn("Book Club", out)
        self.assertIn("now active", out)
        self.assertNotIn("fh_JOINED_tok111", out + err)

    def test_join_with_invite_code_sends_name_label(self):
        self.seed_config()
        self.fake.add("POST", "/v1/invites/fhi_INV123/accept", 201,
                      {"token": "fh_INVITED_tok222", "token_id": "tokI",
                       "member": {"id": "m8", "family_id": "c888",
                                  "name": "Tester", "role": "kid"}})
        self.fake.add("GET", "/v1/families", 200, {"families": [
            {"id": "c888", "name": "Gym", "kind": "general",
             "my_role": "kid"}]})
        rc, out, err = self.run_cli(["circle", "join", "--code", "fhi_INV123"])
        self.assertEqual(rc, 0)
        accept = [c for c in self.fake.calls if "accept" in c["url"]][0]
        body = json.loads(accept["body"])
        self.assertEqual(body, {"display_name": "Tester",
                               "agent_label": "test-agent"})
        cfg = hub.load_config("default")
        self.assertEqual(cfg["circle_tokens"]["c888"], "fh_INVITED_tok222")
        self.assertEqual(cfg["active_circle_id"], "c888")
        self.assertNotIn("fh_INVITED_tok222", out + err)

    def test_join_invite_code_needs_name_label(self):
        os.environ.pop("FAMILY_HUB_TOKEN", None)
        hub.save_config("default", {"server_url": "https://hub.example"})
        rc, _out, err = self.run_cli(["circle", "join", "--code", "fhi_X"])
        self.assertEqual(rc, 1)
        self.assertIn("--name and --label", err)
        self.assertEqual(self.fake.calls, [])

    # -- per-circle auth --------------------------------------------------

    def test_request_uses_active_circle_token(self):
        self.seed_multi()  # active c111
        self.fake.add("GET", "/v1/topics", 200, {"topics": []})
        rc, _out, _ = self.run_cli(["topics"])
        self.assertEqual(rc, 0)
        auth = self.fake.calls[0]["headers"]["Authorization"]
        self.assertEqual(auth, "Bearer " + self.TOK_A)
        self.assertTokenAbsent(self.fake.calls[0]["headers"].get("X-X", ""))

    def test_request_falls_back_to_legacy_token(self):
        self.seed_config(family_id="c111")  # no circle_tokens at all
        self.fake.add("GET", "/v1/topics", 200, {"topics": []})
        rc, _out, _ = self.run_cli(["topics"])
        self.assertEqual(rc, 0)
        auth = self.fake.calls[0]["headers"]["Authorization"]
        self.assertEqual(auth, "Bearer " + FAKE_TOKEN)

    def test_circle_override_switches_token(self):
        self.seed_multi()  # active c111 (TOK_A)
        self.fake.add("GET", "/v1/families", 200, {"families": CIRCLES})
        self.fake.add("POST", "/v1/families/c222/invites", 201,
                      {"invite_code": "inv_z"})
        rc, _out, _ = self.run_cli(
            ["invite-member", "--circle", "Friends",
             "--email", "a@example.com", "--role", "kid"])
        self.assertEqual(rc, 0)
        posts = [c for c in self.fake.calls
                 if urlparse.urlparse(c["url"]).path.endswith("/invites")]
        self.assertEqual(len(posts), 1)
        # the POST went out with circle B's token, not the active circle's
        self.assertEqual(posts[0]["headers"]["Authorization"],
                         "Bearer " + self.TOK_B)

    def test_circle_override_tokenless_hints_join(self):
        self.seed_config(active_circle_id="c111",
                         circle_tokens={"c111": self.TOK_A})
        self.fake.add("GET", "/v1/families", 200, {"families": CIRCLES})
        rc, _out, err = self.run_cli(
            ["invite-member", "--circle", "Friends",
             "--email", "a@example.com", "--role", "kid"])
        self.assertEqual(rc, 1)
        self.assertIn("hub circle join --code", err)

    # -- sync --------------------------------------------------------------

    def test_sync_labels_entries_per_circle(self):
        self.seed_multi()
        self.fake.add("GET", "/v1/families", 200, {"families": CIRCLES})
        self.fake.add("GET", "/v1/sync", 200, {"entries": [
            {"gseq": 3, "seq": 1, "body": "hello"}]})
        rc, out, _ = self.run_cli(["sync"])
        self.assertEqual(rc, 0)
        entries = json.loads(out)
        self.assertEqual(len(entries), 2)  # one per circle
        by_circle = {e["circle_id"]: e for e in entries}
        self.assertEqual(by_circle["c111"]["circle_name"], "Family")
        self.assertEqual(by_circle["c222"]["circle_name"], "Friends")
        # each circle synced with its own token...
        auths = {p for _, p in self.sync_paths()}
        self.assertEqual(auths, {"Bearer " + self.TOK_A,
                                 "Bearer " + self.TOK_B})
        # ...and its own cursor
        for cid in ("c111", "c222"):
            with open(hub.cursor_path("default", cid)) as fh:
                self.assertEqual(fh.read().strip(), "3")
        self.assertFalse(os.path.exists(hub.cursor_path("default")))

    def test_sync_multi_circle_no_entries(self):
        self.seed_multi()
        self.fake.add("GET", "/v1/families", 200, {"families": CIRCLES})
        self.fake.add("GET", "/v1/sync", 200, {"entries": []})
        rc, out, err = self.run_cli(["sync"])
        self.assertEqual(rc, 0)
        self.assertEqual(json.loads(out), [])
        self.assertIn("no new entries", err)

    def test_sync_partial_failure_emits_without_advancing_cursors(self):
        # Circle A (c111) returns events; circle B (c222) 500s. A's events
        # must still be emitted, no cursor may advance (so a retry
        # re-delivers them), and the exit code must be non-zero with a
        # per-circle error naming the failed circle.
        self.seed_multi()
        self.fake.add("GET", "/v1/families", 200, {"families": CIRCLES})
        self.fake.add_seq("GET", "/v1/sync", [
            (200, {"entries": [{"gseq": 3, "seq": 1, "body": "hello"}],
                    "next_after_gseq": 3, "has_more": False}),
            (500, {"error": {"code": "internal", "message": "boom"}}),
        ])
        rc, out, err = self.run_cli(["sync"])
        self.assertNotEqual(rc, 0)
        entries = json.loads(out)
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["body"], "hello")
        self.assertEqual(entries[0]["circle_id"], "c111")
        self.assertEqual(entries[0]["circle_name"], "Family")
        self.assertIn("sync failed for circle", err)
        self.assertIn("Friends", err)
        # Neither circle's cursor advanced: the retry re-delivers A's events.
        for cid in ("c111", "c222"):
            self.assertFalse(
                os.path.exists(hub.cursor_path("default", cid)),
                "cursor file for %s must not exist after a failed sync" % cid,
            )
        self.assertTokenAbsent(out, err)

    def test_sync_retry_after_partial_failure_redelivers(self):
        # After the failure above, the same events come back on retry.
        self.seed_multi()
        self.fake.add("GET", "/v1/families", 200, {"families": CIRCLES})
        self.fake.add_seq("GET", "/v1/sync", [
            (200, {"entries": [{"gseq": 3, "seq": 1, "body": "hello"}],
                    "next_after_gseq": 3, "has_more": False}),
            (500, {"error": {"code": "internal", "message": "boom"}}),
        ])
        rc, out, _ = self.run_cli(["sync"])
        self.assertNotEqual(rc, 0)
        # Retry: both circles healthy now; A's event is re-delivered and
        # this time both cursors advance.
        self.fake.add("GET", "/v1/sync", 200,
                      {"entries": [{"gseq": 3, "seq": 1, "body": "hello"}],
                       "next_after_gseq": 3, "has_more": False})
        rc, out, _ = self.run_cli(["sync"])
        self.assertEqual(rc, 0)
        entries = json.loads(out)
        self.assertEqual(len(entries), 2)  # one per circle
        for cid in ("c111", "c222"):
            with open(hub.cursor_path("default", cid)) as fh:
                self.assertEqual(fh.read().strip(), "3")

    def test_sync_one_circle_empty_others_advance(self):
        # A healthy circle with no new entries does not block cursor
        # acknowledgement for a healthy circle that did return entries.
        self.seed_multi()
        self.fake.add("GET", "/v1/families", 200, {"families": CIRCLES})
        self.fake.add_seq("GET", "/v1/sync", [
            (200, {"entries": [], "next_after_gseq": 0, "has_more": False}),
            (200, {"entries": [{"gseq": 7, "seq": 1, "body": "yo"}],
                    "next_after_gseq": 7, "has_more": False}),
        ])
        rc, out, _ = self.run_cli(["sync"])
        self.assertEqual(rc, 0)
        entries = json.loads(out)
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["circle_id"], "c222")
        with open(hub.cursor_path("default", "c222")) as fh:
            self.assertEqual(fh.read().strip(), "7")
        self.assertFalse(os.path.exists(hub.cursor_path("default", "c111")))

    # -- circle use warnings ---------------------------------------------------

    def test_use_warns_when_tokenless(self):
        self.seed_config(active_circle_id="c111",
                         circle_tokens={"c111": self.TOK_A})
        self.fake.add("GET", "/v1/families", 200, {"families": CIRCLES})
        rc, out, err = self.run_cli(["circle", "use", "Friends"])  # c222
        self.assertEqual(rc, 0)
        self.assertEqual(hub.load_config("default")["active_circle_id"], "c222")
        self.assertIn("no token stored", err)
        self.assertIn("hub circle join --code", err)

    def test_use_no_warning_when_token_present(self):
        self.seed_multi()
        self.fake.add("GET", "/v1/families", 200, {"families": CIRCLES})
        rc, _out, err = self.run_cli(["circle", "use", "Friends"])
        self.assertEqual(rc, 0)
        self.assertNotIn("no token stored", err)

    def test_use_no_warning_for_legacy_bootstrap(self):
        # Single-token profile: the bootstrap circle works via fallback.
        self.seed_config(family_id="c111")
        self.fake.add("GET", "/v1/families", 200, {"families": CIRCLES})
        rc, _out, err = self.run_cli(["circle", "use", "Family"])
        self.assertEqual(rc, 0)
        self.assertNotIn("no token stored", err)

    # -- dashboard-token --------------------------------------------------------

    def test_dashboard_token_prints_with_warning(self):
        self.seed_multi()
        self.fake.add("GET", "/v1/families", 200, {"families": CIRCLES})
        rc, out, _ = self.run_cli(["dashboard-token", "--circle", "Friends"])
        self.assertEqual(rc, 0)
        self.assertIn("WARNING", out)
        self.assertIn(self.TOK_B, out)
        # warning precedes the token
        self.assertLess(out.index("WARNING"), out.index(self.TOK_B))

    def test_dashboard_token_no_token_stored(self):
        self.seed_config(active_circle_id="c111",
                         circle_tokens={"c111": self.TOK_A})
        self.fake.add("GET", "/v1/families", 200, {"families": CIRCLES})
        rc, _out, err = self.run_cli(["dashboard-token", "--circle", "Friends"])
        self.assertEqual(rc, 1)
        self.assertIn("No token stored", err)


if __name__ == "__main__":
    unittest.main()
