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
from unittest import mock

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
        # Per-invocation version-check traffic is recorded separately so
        # command-traffic assertions (calls == [], calls[0], …) keep their
        # meaning. Explicitly registered /v2/health routes still work.
        self.health_calls = []

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
        path = urlparse.urlparse(url).path
        if method.upper()=="GET" and path=="/v2/families" and ("GET",path) not in self.routes and ("GET",path) not in self.seqs:
            cfg=hub.load_config("default")
            return 200,json.dumps({"families":[{"id":cfg.get("active_circle_id") or cfg.get("family_id") or "default","name":"Family"}]})
        if method.upper()=="POST" and path=="/v2/identity/challenges" and ("POST",path) not in self.routes:
            return 202,json.dumps({"challenge_id":"test-mail-challenge","expires_at":"2099-01-01T00:00:00Z"})

        if (
            method.upper() == "GET"
            and path == "/v2/health"
            and ("GET", "/v2/health") not in self.routes
            and ("GET", "/v2/health") not in self.seqs
        ):
            # The fake models a current-release server: auto-answer the
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
                {"ok": True, "version": hub.VERSION, "api_versions": ["v2"]}
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
        if key in self.seqs and self.seqs[key]:
            status, body = self.seqs[key].pop(0)
        elif key in self.routes:
            status, body = self.routes[key]
        else:
            status, body = 404, {"error": {"code": "not_found", "message": "no route"}}
        if method.upper() == "POST" and path.endswith(("/accept", "/redeem")) and 200 <= status < 300 and isinstance(body, dict) and body.get("token"):
            body = dict(body, token=json.loads(body_bytes)["agent_token"])
        if method.upper()=="GET" and path=="/v2/me" and status==200 and isinstance(body,dict):
            body=dict(body)
            body.setdefault("family_id",headers.get("X-Circle-ID"))
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
        # Fresh version-check state per test (the fake auto-answers
        # /v2/health as a current server; see FakeHub.__call__).
        hub._reset_server_version_cache()

    def seed_encrypted_topic(self, tid):
        kid, key = "ab" * 16, b"k" * 32
        hub._merge_topic_key("default", tid, kid, key)
        subject = hub._e2ee_encrypt_field(b"Test", tid, kid, key)
        return {"topic":{"id":tid,"e2ee":1,"current_epoch":1,"current_key_id":kid,"subject":subject}}

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self._saved_env)
        shutil.rmtree(self.tmp, ignore_errors=True)
        hub.clear_secrets()

    def run_cli(self, argv):
        with captured() as (out, err), mock.patch.object(hub,"_read_email_verification_code",return_value="test-mail-proof"):
            rc = hub.main(argv, transport=self.fake)
        return rc, out.getvalue(), err.getvalue()

    def assertTokenAbsent(self, *blobs):
        for blob in blobs:
            self.assertNotIn(
                FAKE_TOKEN, blob, "token leaked into CLI output!"
            )

    def enrolled_token(self):
        for call in reversed(self.fake.calls):
            body = json.loads(call["body"]) if call["body"] else {}
            if body.get("agent_token"):
                return body["agent_token"]
        self.fail("No enrollment credential was sent")

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
        a = self.parse(["task-done", "--topic", "t1", "--task", "tk", "--result", '{"a": 1}'])
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
        self.fake.add("GET", "/v2/sync/topics", 200,
                      {"topics": [{"topic_id": "t1", "subject": self.seed_encrypted_topic("t1")["topic"]["subject"]}]})
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
        self.fake.add("GET", "/v2/sync/topics", 200, {"topics": []})
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
        self.fake.add("POST", "/v2/provisioning-codes/%s/redeem" % code,
                      201,
                      {"token": secret_tok, "token_id": "tokD",
                       "member": {"id": "mD", "family_id": "cD9",
                                  "name": "Tester", "role": "member"}})
        self.fake.add("GET", "/v2/me", 200,
                      {"id": "mD", "name": "Tester", "role": "member"})
        self.fake.add("GET", "/v2/families", 200, {"families": []})
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
        url = "https://hub.example/v2/provisioning-codes/fhp_ABC123/redeem"
        scrubbed = hub._scrub_url(url)
        self.assertNotIn("fhp_ABC123", scrubbed)
        self.assertIn("fhp_[redacted]", scrubbed)
        self.assertEqual(hub._scrub_url("https://hub.example/v2/sync"),
                         "https://hub.example/v2/sync")

    def test_save_config_is_0600(self):
        self.seed_config()
        mode = stat.S_IMODE(os.stat(hub.config_path("default")).st_mode)
        self.assertEqual(mode, 0o600)

    def test_post_redacted(self):
        self.seed_config()
        self.fake.add("GET", "/v2/topics/t1", 200,
                      self.seed_encrypted_topic("t1"))
        self.fake.add("POST", "/v2/topics/t1/entries", 200,
                      {"gseq": 9, "seq": 4, "body": "hi"})
        rc, out, err = self.run_cli(
            ["post", "--topic", "t1", "--message", "hello family"])
        self.assertEqual(rc, 0)
        self.assertTokenAbsent(out, err)

    def test_401_error_redacted(self):
        self.seed_config()
        self.fake.add("GET", "/v2/sync/topics", 401,
                      {"error": {"code": "auth", "message": "bad token"}})
        rc, out, err = self.run_cli(["sync"])
        self.assertNotEqual(rc, 0)
        self.assertIn("sync failed for circle",err)
        self.assertTokenAbsent(out, err)
        self.assertIn("Authentication failed", err)

    def test_500_error_redacted(self):
        self.seed_config()
        self.fake.add("GET", "/v2/topics", 500,
                      {"error": {"code": "internal", "message": "boom"}})
        rc, out, err = self.run_cli(["topics"])
        self.assertEqual(rc, 1)
        self.assertTokenAbsent(out, err)

    def test_403_forbidden_message(self):
        self.seed_config()
        self.fake.add("GET", "/v2/topics/t9/history", 403,
                      {"error": {"code": "forbidden",
                                 "message": "not a participant"}})
        rc, out, err = self.run_cli(["read", "--topic", "t9"])
        self.assertEqual(rc, 1)
        self.assertTokenAbsent(out, err)
        self.assertIn("final", err)

    def test_422_pii_message(self):
        self.seed_config()
        self.fake.add("GET", "/v2/topics/t1", 200,
                      self.seed_encrypted_topic("t1"))
        self.fake.add("POST", "/v2/topics/t1/entries", 422,
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
            "POST", "/v2/invites/CODE123/accept", 200,
            {"member": {"id": "m2", "family_id": "c2", "name": "Lakshmi", "role": "parent",
                        "email": "l@example.com"},
             "token": new_token, "token_id": "tok_1"},
        )
        self.fake.add("GET", "/v2/me", 200,
                      {"id": "m2", "name": "Lakshmi", "role": "parent"})
        rc, out, err = self.run_cli([
            "setup", "--server", "https://hub.example",
            "--invite", "CODE123", "--name", "Lakshmi",
            "--label", "test-agent", "--store", "file",
        ])
        self.assertEqual(rc, 0)
        self.assertNotIn(new_token, out + err)
        self.assertTokenAbsent(out, err)
        # config on disk contains no token either
        with open(hub.config_path("default")) as fh:
            self.assertNotIn(new_token, fh.read())

    def test_setup_failure_redacted(self):
        self.fake.add("POST", "/v2/invites/BAD/accept", 401,
                      {"error": {"code": "auth", "message": "bad invite"}})
        rc, out, err = self.run_cli([
            "setup", "--server", "https://hub.example",
            "--invite", "BAD", "--name", "X", "--label", "y",
        ])
        self.assertNotEqual(rc, 0)
        self.assertTokenAbsent(out, err)

    def test_task_done_redacted(self):
        self.seed_config()
        self.fake.add("GET", "/v2/topics/t1", 200, self.seed_encrypted_topic("t1"))
        self.fake.add("GET", "/v2/topics/t1/tasks", 200, {"tasks":[{"id":"tk1"}]})
        self.fake.add("POST", "/v2/tasks/tk1/done", 200, {"ok": True})
        rc, out, err = self.run_cli(
            ["task-done", "--topic", "t1", "--task", "tk1", "--result", '{"conflicts": []}'])
        self.assertEqual(rc, 0)
        self.assertTokenAbsent(out, err)

    def test_spawn_failure_redacts_credentials(self):
        self.seed_config()
        hub._write_secret_file_0600(hub.agent_key_path("default"), os.urandom(32), "test identity")
        self.fake.add("GET", "/v2/topics/tp", 200, self.seed_encrypted_topic("tp"))
        self.fake.add("POST", "/v2/topics/tp/spawn", 403, {"error":{"code":"forbidden", "message":"not a participant"}})
        rc, out, err = self.run_cli(["spawn", "--topic", "tp", "--subject", "kid-safe", "--with", "m2", "--briefing", "approved summary"])
        self.assertEqual(rc, 1)
        self.assertIn("final", err)
        self.assertTokenAbsent(out, err)
        request = json.loads([c for c in self.fake.calls if c["method"] == "POST"][0]["body"])
        self.assertTrue(request["subject"].startswith("fh1."))
        self.assertNotIn("briefing", request)


# ---------------------------------------------------------------------------
# Command wiring (request shape + error mapping)
# ---------------------------------------------------------------------------


class TestCommands(HubTestBase):
    def test_topics_search_param(self):
        self.seed_config()
        self.fake.add("GET", "/v2/topics", 200, {"topics": []})
        rc, out, _ = self.run_cli(["topics", "--search", "trip"])
        self.assertEqual(rc, 0)
        self.assertNotIn("q=", self.fake.last_url())

    def test_post_idempotency_key_auto(self):
        self.seed_config()
        self.fake.add("GET", "/v2/topics/t1", 200,
                      self.seed_encrypted_topic("t1"))
        self.fake.add("POST", "/v2/topics/t1/entries", 200, {"gseq": 1})
        rc, out, _ = self.run_cli(["post", "--topic", "t1", "--message", "x"])
        self.assertEqual(rc, 0)
        post = [c for c in self.fake.calls if c["method"] == "POST"][0]
        self.assertIn("Idempotency-Key", post["headers"])
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
            ["task-done", "--topic", "t1", "--task", "t", "--result", "nope"])
        self.assertEqual(rc, 1)
        self.assertIn("valid JSON", err)

    def test_tasks_assigned_to_me_filter(self):
        self.seed_config()
        self.fake.add("GET", "/v2/topics/t1/tasks", 200, {"tasks": [
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

    def test_me_reflects_server_identity_not_local_config(self):
        # The local config caches the legacy bootstrap member, which goes
        # stale across circles. /v2/me is the truth: a kid's agent must never
        # report the owner's cached record as itself.
        self.seed_config(
            member={"id": "stale-owner", "name": "Owner", "role": "owner"})
        self.fake.add("GET", "/v2/me", 200, {
            "id": "m-kid", "family_id": "f1", "name": "Kid",
            "email": "kid@example.com", "role": "kid",
            "created_at": "2026-01-01T00:00:00Z", "agent_label": "kid-agent",
        })
        rc, out, _ = self.run_cli(["me"])
        self.assertEqual(rc, 0)
        me = json.loads(out)
        self.assertEqual(me["member"]["id"], "m-kid")
        self.assertEqual(me["member"]["role"], "kid")
        self.assertEqual(me["member"]["agent_label"], "kid-agent")
        self.assertTrue(self.fake.last_url().endswith("/v2/me"),
                        "hub me must query GET /v2/me")
        self.assertNotIn("stale-owner", out)
        self.assertTokenAbsent(out)

    def test_missing_server(self):
        os.environ.pop("FAMILY_HUB_TOKEN", None)
        rc, _out, err = self.run_cli(["--profile", "nosuch", "sync"])
        self.assertEqual(rc, 1)
        self.assertIn("hub setup", err)


class TestCloudflareAndInvite(HubTestBase):
    def test_user_agent_identifies_client(self):
        # Regression: Cloudflare Error 1010 blocks Python-urllib's default UA.
        self.seed_config()
        self.fake.add("GET", "/v2/topics", 200, {"topics": []})
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
        self.fake.add("POST", "/v2/families/fam1/invites", 201,
                      {"invite_code": "inv_abc", "expires_at": "t"})
        rc, out, _err = self.run_cli(
            ["invite-member", "--email", "lakshmi@example.com", "--role", "parent"])
        self.assertEqual(rc, 0)
        self.assertIn("/v2/families/fam1/invites", self.fake.last_url())
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
        self.fake.add("GET", "/v2/families", 200, {"families": CIRCLES})
        rc, out, _ = self.run_cli(["circles"])
        self.assertEqual(rc, 0)
        self.assertIn("* Friends", out)
        self.assertIn("(active)", out)
        self.assertIn("  Family", out)  # inactive: blank marker
        self.assertNotIn("c111 (active)", out)
        self.assertTokenAbsent(out)

    def test_circles_empty(self):
        self.seed_config()
        self.fake.add("GET", "/v2/families", 200, {"families": []})
        rc, out, _ = self.run_cli(["circles"])
        self.assertEqual(rc, 0)
        self.assertIn("no circles", out)

    def test_circle_create_posts_name_kind(self):
        self.seed_config()
        self.fake.add("POST", "/v2/families", 201,
                      {"id": "c333", "name": "Gym", "kind": "general",
                       "created_at": "t", "provisioning_code": "fhp_CREATE"})
        self.fake.add("POST", "/v2/provisioning-codes/fhp_CREATE/redeem", 201,
                      {"token": "fh_CREATED", "member": {"id": "m3", "family_id": "c333"}})
        self.fake.add("GET", "/v2/me", 200, {"id": "m3", "family_id": "c333"})
        self.fake.add("GET","/v2/families",200,{"families":[{"id":"c333","name":"Gym"}]})
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
        self.fake.add("GET", "/v2/families", 200, {"families": CIRCLES})
        rc, out, _ = self.run_cli(["circle", "use", "Friends"])
        self.assertEqual(rc, 0)
        self.assertIn("c222", out)
        cfg = hub.load_config("default")
        self.assertEqual(cfg["active_circle_id"], "c222")

    def test_circle_use_by_id_prefix(self):
        self.seed_config()
        self.fake.add("GET", "/v2/families", 200, {"families": CIRCLES})
        rc, _out, _ = self.run_cli(["circle", "use", "c22"])
        self.assertEqual(rc, 0)
        self.assertEqual(hub.load_config("default")["active_circle_id"],
                         "c222")

    def test_circle_use_ambiguous_prefix(self):
        self.seed_config()
        self.fake.add("GET", "/v2/families", 200, {"families": CIRCLES})
        rc, _out, err = self.run_cli(["circle", "use", "c"])
        self.assertEqual(rc, 1)
        self.assertIn("Ambiguous", err)
        self.assertNotIn("active_circle_id", hub.load_config("default"))

    def test_circle_use_no_match(self):
        self.seed_config()
        self.fake.add("GET", "/v2/families", 200, {"families": CIRCLES})
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
        self.fake.add("GET", "/v2/families", 200, {"families": dupes})
        rc, _out, err = self.run_cli(["circle", "use", "Dup"])
        self.assertEqual(rc, 1)
        self.assertIn("Multiple circles named", err)

    def test_resolve_prefers_selected_circle_over_registration_circle(self):
        # Active circle wins for resolution; its own token is used (the
        # server binds each token to one family, so the legacy token for
        # c111 could not act on c222).
        self.seed_config(active_circle_id="c222", family_id="c111")
        self.fake.add("POST", "/v2/families/c222/invites", 201,
                      {"invite_code": "inv_x"})
        rc, _out, _ = self.run_cli(
            ["invite-member", "--email", "a@example.com", "--role", "kid"])
        self.assertEqual(rc, 0)
        # no discovery call needed: the stored id is used directly
        self.assertEqual(self.call_paths(),
                         [("POST", "/v2/families/c222/invites")])
        auth = self.fake.calls[0]["headers"]["Authorization"]
        self.assertEqual(auth, "Bearer " + FAKE_TOKEN)

    def test_registration_circle_initial_selection(self):
        self.seed_config(family_id="c111")  # pre-circles profile
        self.fake.add("POST", "/v2/families/c111/invites", 201,
                      {"invite_code": "inv_y"})
        rc, _out, _ = self.run_cli(
            ["invite-member", "--email", "a@example.com", "--role", "kid"])
        self.assertEqual(rc, 0)
        self.assertEqual(self.call_paths(),
                         [("POST", "/v2/families/c111/invites")])

    def test_circle_override_flag(self):
        # --circle switches target AND token: c222's own token is used,
        # since the legacy c111 token is bound to its own family.
        self.seed_config(family_id="c111")
        self.fake.add("GET", "/v2/families", 200, {"families": CIRCLES})
        self.fake.add("POST", "/v2/families/c222/invites", 201,
                      {"invite_code": "inv_z"})
        rc, _out, _ = self.run_cli(
            ["invite-member", "--circle", "Friends",
             "--email", "a@example.com", "--role", "kid"])
        self.assertEqual(rc, 0)
        self.assertEqual(self.call_paths(),
                         [("GET", "/v2/families"),
                          ("POST", "/v2/families/c222/invites")])
        post = [c for c in self.fake.calls
                if urlparse.urlparse(c["url"]).path.endswith("/invites")][0]
        self.assertEqual(post["headers"]["Authorization"],
                         "Bearer " + FAKE_TOKEN)

    def test_override_no_match_makes_no_post(self):
        self.seed_config(family_id="c111")
        self.fake.add("GET", "/v2/families", 200, {"families": CIRCLES})
        rc, _out, err = self.run_cli(
            ["invite-member", "--circle", "Nope",
             "--email", "a@example.com", "--role", "kid"])
        self.assertEqual(rc, 1)
        self.assertIn("No circle matches", err)
        self.assertEqual(self.call_paths(), [("GET", "/v2/families")])


# ---------------------------------------------------------------------------
# Circle ownership transfer: transfer / transfer-accept / transfer-status /
# transfer-cancel
# ---------------------------------------------------------------------------


class TestCircleTransfer(HubTestBase):
    def parse(self, argv):
        return hub.build_parser().parse_args(argv)

    def call_paths(self):
        return [(c["method"], urlparse.urlparse(c["url"]).path)
                for c in self.fake.calls]

    def test_transfer_parses(self):
        a = self.parse(["circle", "transfer", "--to", "m2"])
        self.assertEqual(a.circle_action, "transfer")
        self.assertEqual(a.to_member, "m2")
        self.assertEqual(a.on_complete, "remove")  # default

    def test_transfer_on_complete_choices(self):
        a = self.parse(["circle", "transfer", "--to", "m2",
                        "--on-complete", "demote"])
        self.assertEqual(a.on_complete, "demote")
        a = self.parse(["circle", "transfer", "--to", "m2",
                        "--on-complete", "remove"])
        self.assertEqual(a.on_complete, "remove")
        with self.assertRaises(SystemExit):
            self.parse(["circle", "transfer", "--to", "m2",
                        "--on-complete", "suspend"])

    def test_transfer_requires_to(self):
        with self.assertRaises(SystemExit):
            self.parse(["circle", "transfer"])

    def test_transfer_accept_parses(self):
        a = self.parse(["circle", "transfer-accept"])
        self.assertEqual(a.circle_action, "transfer-accept")
        self.assertIsNone(a.transfer_id)
        b = self.parse(["circle", "transfer-accept",
                        "--transfer-id", "t123"])
        self.assertEqual(b.transfer_id, "t123")

    def test_transfer_status_and_cancel_parse(self):
        a = self.parse(["circle", "transfer-status"])
        self.assertEqual(a.circle_action, "transfer-status")
        a = self.parse(["circle", "transfer-cancel"])
        self.assertEqual(a.circle_action, "transfer-cancel")

    def test_transfer_posts_to_member_and_default_on_complete(self):
        self.seed_config(family_id="c111")
        self.fake.add("POST", "/v2/families/c111/transfer", 201,
                      {"id": "t1", "status": "pending",
                       "to_member_id": "m2", "on_complete": "remove"})
        rc, out, _ = self.run_cli(["circle", "transfer", "--to", "m2"])
        self.assertEqual(rc, 0)
        self.assertEqual(self.call_paths(),
                         [("POST", "/v2/families/c111/transfer")])
        body = json.loads(self.fake.calls[0]["body"])
        self.assertEqual(body,
                         {"to_member_id": "m2", "on_complete": "remove"})
        self.assertIn('"id": "t1"', out)
        self.assertIn("pending", out)
        self.assertTokenAbsent(out)

    def test_transfer_on_complete_demote(self):
        self.seed_config(family_id="c111")
        self.fake.add("POST", "/v2/families/c111/transfer", 201,
                      {"id": "t2", "status": "pending"})
        rc, _out, _ = self.run_cli(
            ["circle", "transfer", "--to", "m2", "--on-complete", "demote"])
        self.assertEqual(rc, 0)
        body = json.loads(self.fake.calls[0]["body"])
        self.assertEqual(body["on_complete"], "demote")

    def test_transfer_rejects_blank_to_member(self):
        self.seed_config(family_id="c111")
        rc, _out, err = self.run_cli(["circle", "transfer", "--to", "  "])
        self.assertEqual(rc, 1)
        self.assertEqual(self.fake.calls, [])
        self.assertIn("--to", err)

    def test_transfer_secret_fields_scrubbed(self):
        # A buggy server response that includes credential material must
        # never be echoed to stdout.
        self.seed_config(family_id="c111")
        self.fake.add("POST", "/v2/families/c111/transfer", 201,
                      {"id": "t3", "status": "pending",
                       "token": "fh_SUPER_SECRET_999"})
        rc, out, err = self.run_cli(["circle", "transfer", "--to", "m2"])
        self.assertEqual(rc, 0)
        self.assertNotIn("fh_SUPER_SECRET_999", out)
        self.assertNotIn("fh_SUPER_SECRET_999", err)
        self.assertIn("[redacted]", out)

    def test_transfer_accept_with_id(self):
        self.seed_config(family_id="c111")
        self.fake.add("POST", "/v2/families/c111/transfer/accept", 200,
                      {"id": "t1", "status": "accepted"})
        rc, out, _ = self.run_cli(
            ["circle", "transfer-accept", "--transfer-id", "t1"])
        self.assertEqual(rc, 0)
        self.assertEqual(self.call_paths(),
                         [("POST", "/v2/families/c111/transfer/accept")])
        body = json.loads(self.fake.calls[0]["body"])
        self.assertEqual(body, {"transfer_id": "t1"})
        self.assertIn("accepted", out)
        self.assertTokenAbsent(out)

    def test_transfer_accept_without_id(self):
        # The id is optional client-side: the server may resolve a single
        # pending transfer itself.
        self.seed_config(family_id="c111")
        self.fake.add("POST", "/v2/families/c111/transfer/accept", 200,
                      {"id": "t1", "status": "accepted"})
        rc, _out, _ = self.run_cli(["circle", "transfer-accept"])
        self.assertEqual(rc, 0)
        body = json.loads(self.fake.calls[0]["body"])
        self.assertEqual(body, {})

    def test_transfer_status_pending(self):
        self.seed_config(family_id="c111")
        self.fake.add("GET", "/v2/families/c111/transfer", 200,
                      {"transfer": {"id": "t1", "status": "pending",
                                    "to_member_id": "m2"}})
        rc, out, _ = self.run_cli(["circle", "transfer-status"])
        self.assertEqual(rc, 0)
        self.assertEqual(self.call_paths(),
                         [("GET", "/v2/families/c111/transfer")])
        self.assertIn('"id": "t1"', out)
        self.assertIn("pending", out)
        self.assertNotIn("none", out)
        self.assertTokenAbsent(out)

    def test_transfer_status_none(self):
        self.seed_config(family_id="c111")
        self.fake.add("GET", "/v2/families/c111/transfer", 200,
                      {"transfer": None})
        rc, out, _ = self.run_cli(["circle", "transfer-status"])
        self.assertEqual(rc, 0)
        self.assertEqual(out.strip(), "none")
        self.assertTokenAbsent(out)

    def test_transfer_cancel_posts(self):
        self.seed_config(family_id="c111")
        self.fake.add("POST", "/v2/families/c111/transfer/cancel", 200,
                      {"id": "t1", "status": "cancelled"})
        rc, out, _ = self.run_cli(["circle", "transfer-cancel"])
        self.assertEqual(rc, 0)
        self.assertEqual(self.call_paths(),
                         [("POST", "/v2/families/c111/transfer/cancel")])
        self.assertIn("cancelled", out)
        self.assertTokenAbsent(out)

    def test_transfer_uses_circle_override(self):
        self.seed_config(family_id="c111")
        self.fake.add("GET", "/v2/families", 200, {"families": CIRCLES})
        self.fake.add("POST", "/v2/families/c222/transfer", 201,
                      {"id": "t9", "status": "pending"})
        rc, _out, _ = self.run_cli(
            ["circle", "transfer", "--to", "m2", "--circle", "Friends"])
        self.assertEqual(rc, 0)
        self.assertEqual(self.call_paths(),
                         [("GET", "/v2/families"),
                          ("POST", "/v2/families/c222/transfer")])
        self.assertEqual(self.fake.calls[1]["headers"]["Authorization"],
                         "Bearer " + FAKE_TOKEN)


# ---------------------------------------------------------------------------
# Circle member removal: remove-member
# ---------------------------------------------------------------------------


class TestCircleRemoveMember(HubTestBase):
    def parse(self, argv):
        return hub.build_parser().parse_args(argv)

    def call_paths(self):
        return [(c["method"], urlparse.urlparse(c["url"]).path)
                for c in self.fake.calls]

    def test_remove_member_parses(self):
        a = self.parse(["circle", "remove-member", "--member", "m9"])
        self.assertEqual(a.circle_action, "remove-member")
        self.assertEqual(a.member_id, "m9")
        self.assertIsNone(a.circle)

    def test_remove_member_requires_member(self):
        with self.assertRaises(SystemExit):
            self.parse(["circle", "remove-member"])

    def test_remove_member_deletes_member_path(self):
        self.seed_config(family_id="c111")
        self.fake.add("DELETE", "/v2/families/c111/members/m9", 200,
                      {"removed": "m9"})
        rc, out, _ = self.run_cli(["circle", "remove-member",
                                   "--member", "m9"])
        self.assertEqual(rc, 0)
        self.assertEqual(self.call_paths(),
                         [("DELETE", "/v2/families/c111/members/m9")])
        self.assertIn('"removed": "m9"', out)
        self.assertTokenAbsent(out)

    def test_remove_member_rejects_blank_member(self):
        self.seed_config(family_id="c111")
        rc, _out, err = self.run_cli(["circle", "remove-member",
                                      "--member", "   "])
        self.assertEqual(rc, 1)
        self.assertEqual(self.fake.calls, [])
        self.assertIn("--member", err)

    def test_remove_member_respects_circle_override(self):
        self.seed_config(family_id="c111")
        self.fake.add("GET", "/v2/families", 200,
                      {"families": [{"id": "c222", "name": "Friends"}]})
        self.fake.add("DELETE", "/v2/families/c222/members/m9", 200,
                      {"removed": "m9"})
        rc, _out, _ = self.run_cli(
            ["circle", "remove-member", "--member", "m9",
             "--circle", "Friends"])
        self.assertEqual(rc, 0)
        self.assertEqual(self.call_paths(),
                         [("GET", "/v2/families"),
                          ("DELETE", "/v2/families/c222/members/m9")])
# Server ownership control plane: hub server owners/promote/demote
# ---------------------------------------------------------------------------


class TestServerOwners(HubTestBase):
    def parse(self, argv):
        return hub.build_parser().parse_args(argv)

    def call_paths(self):
        return [(c["method"], urlparse.urlparse(c["url"]).path)
                for c in self.fake.calls]

    def test_server_owners_parses(self):
        a = self.parse(["server", "owners"])
        self.assertEqual(a.server_action, "owners")

    def test_server_promote_parses(self):
        a = self.parse(["server", "promote", "--principal", "pr_abc"])
        self.assertEqual(a.server_action, "promote")
        self.assertEqual(a.principal_id, "pr_abc")
        self.assertIsNone(a.member_id)
        b = self.parse(["server", "promote", "--member", "m123"])
        self.assertEqual(b.member_id, "m123")
        self.assertIsNone(b.principal_id)

    def test_server_demote_parses(self):
        a = self.parse(["server", "demote", "--principal", "pr_abc"])
        self.assertEqual(a.server_action, "demote")
        self.assertEqual(a.principal_id, "pr_abc")
        with self.assertRaises(SystemExit):
            self.parse(["server", "demote"])

    def test_server_owners_get(self):
        self.seed_config(family_id="c111")
        self.fake.add("GET", "/v2/server/owners", 200,
                      {"owners": [{"principal_id": "pr_1",
                                   "name": "Mahesh",
                                   "email": "m@x.dev",
                                   "created_at": "2026-10-14T00:00:00Z"}]})
        rc, out, _ = self.run_cli(["server", "owners"])
        self.assertEqual(rc, 0)
        self.assertEqual(self.call_paths(), [("GET", "/v2/server/owners")])
        self.assertIn("pr_1", out)
        self.assertTokenAbsent(out)

    def test_server_promote_by_member_posts(self):
        self.seed_config(family_id="c111")
        self.fake.add("POST", "/v2/server/owners", 201,
                      {"owner": {"principal_id": "pr_2",
                                 "created_at": "2026-10-14T00:00:00Z"}})
        rc, out, _ = self.run_cli(["server", "promote", "--member", "m123"])
        self.assertEqual(rc, 0)
        self.assertEqual(self.call_paths(), [("POST", "/v2/server/owners")])
        self.assertEqual(json.loads(self.fake.calls[0]["body"]), {"member_id": "m123"})
        self.assertIn("pr_2", out)
        self.assertTokenAbsent(out)

    def test_server_promote_by_principal_posts(self):
        self.seed_config(family_id="c111")
        self.fake.add("POST", "/v2/server/owners", 201,
                      {"owner": {"principal_id": "pr_9",
                                 "created_at": "2026-10-14T00:00:00Z"}})
        rc, _out, _ = self.run_cli(["server", "promote",
                                    "--principal", "pr_9"])
        self.assertEqual(rc, 0)
        self.assertEqual(json.loads(self.fake.calls[0]["body"]), {"principal_id": "pr_9"})

    def test_server_promote_needs_an_id(self):
        self.seed_config(family_id="c111")
        rc, _out, err = self.run_cli(["server", "promote"])
        self.assertEqual(rc, 1)
        self.assertIn("--principal", err)

    def test_server_demote_deletes(self):
        self.seed_config(family_id="c111")
        self.fake.add("DELETE", "/v2/server/owners/pr_2", 200,
                      {"removed": "pr_2"})
        rc, out, _ = self.run_cli(["server", "demote",
                                   "--principal", "pr_2"])
        self.assertEqual(rc, 0)
        self.assertEqual(self.call_paths(),
                         [("DELETE", "/v2/server/owners/pr_2")])
        self.assertIn("pr_2", out)
        self.assertTokenAbsent(out)


# ---------------------------------------------------------------------------
# Sync v2: per-circle changed-topic discovery (no client cursors)
# ---------------------------------------------------------------------------


class TestSyncV2(HubTestBase):
    CIRCLES = [
        {"id": "c111", "name": "Family"},
        {"id": "c222", "name": "Friends"},
    ]

    def seed_multi(self):
        self.seed_config(
            active_circle_id="c111",

        )

    def test_sync_topics_labeled_per_circle(self):
        self.seed_multi()
        self.fake.add("GET", "/v2/families", 200, {"families": self.CIRCLES})
        self.fake.add_seq("GET", "/v2/sync/topics", [
            (200, {"topics": [{"topic_id": "t1", "subject": self.seed_encrypted_topic("t1")["topic"]["subject"],
                               "acked_seq": 1, "latest_seq": 3}]}),
            (200, {"topics": [{"topic_id": "t2", "subject": self.seed_encrypted_topic("t2")["topic"]["subject"],
                               "acked_seq": 0, "latest_seq": 1}]}),
        ])
        rc, out, err = self.run_cli(["sync"])
        self.assertEqual(rc, 0, err)
        topics = json.loads(out)
        self.assertEqual(len(topics), 2)
        by_circle = {t["circle_id"]: t for t in topics}
        self.assertEqual(by_circle["c111"]["circle_name"], "Family")
        self.assertEqual(by_circle["c222"]["circle_name"], "Friends")
        # each circle synced with its own token
        auths = {c["headers"].get("Authorization")
                 for c in self.fake.calls
                 if "/v2/sync/topics" in c["url"]}
        self.assertEqual(auths, {"Bearer " + FAKE_TOKEN})
        scopes={c["headers"].get("X-Circle-ID") for c in self.fake.calls if "/v2/sync/topics" in c["url"]}
        self.assertEqual(scopes,{"c111","c222"})
        self.assertTokenAbsent(out, err)

    def test_sync_discovers_memberships_from_server_without_cached_circle_tokens(self):
        self.seed_config()
        self.fake.add("GET","/v2/families",200,{"families":self.CIRCLES})
        self.fake.add("GET","/v2/sync/topics",200,{"topics":[]})
        rc,out,err=self.run_cli(["sync"])
        self.assertEqual(rc,0,err)
        requests=[c for c in self.fake.calls if "/v2/sync/topics" in c["url"]]
        self.assertEqual({r["headers"]["X-Circle-ID"] for r in requests},{"c111","c222"})
        self.assertEqual({r["headers"]["Authorization"] for r in requests},{"Bearer "+FAKE_TOKEN})

    def test_sync_partial_failure_reports_per_circle(self):
        self.seed_multi()
        self.fake.add("GET", "/v2/families", 200, {"families": self.CIRCLES})
        self.fake.add_seq("GET", "/v2/sync/topics", [
            (200, {"topics": [{"topic_id": "t1", "subject": self.seed_encrypted_topic("t1")["topic"]["subject"]}]}),
            (500, {"error": {"code": "internal", "message": "boom"}}),
        ])
        rc, out, err = self.run_cli(["sync"])
        self.assertNotEqual(rc, 0)
        topics = json.loads(out)
        self.assertEqual(len(topics), 1)  # healthy circle's topics survive
        self.assertEqual(topics[0]["circle_id"], "c111")
        self.assertIn("sync failed for circle", err)
        self.assertIn("Friends", err)


class TestReadReceipt(HubTestBase):
    def test_read_surfaces_receipt_and_defaults_after_to_acked(self):
        self.seed_config()
        self.fake.add("GET", "/v2/topics/t1/history", 200,
                      {"entries": [{"seq": 6, "body": "x"}],
                       "read_through_seq": 9, "read_receipt": "rcpt-1"})
        rc, out, err = self.run_cli(["read", "--topic", "t1"])
        self.assertEqual(rc, 0, err)
        result = json.loads(out)
        self.assertEqual(result["read_through_seq"], 9)
        self.assertEqual(result["read_receipt"], "rcpt-1")
        self.assertEqual(len(result["entries"]), 1)
        # --after omitted: no after_seq param — the server defaults to the
        # agent's acked position.
        self.assertNotIn("after_seq", self.fake.last_url())

    def test_read_after_and_context_are_passed_through(self):
        self.seed_config()
        self.fake.add("GET", "/v2/topics/t1/history", 200, {"entries": []})
        rc, out, err = self.run_cli(
            ["read", "--topic", "t1", "--after", "42", "--context", "5"])
        self.assertEqual(rc, 0, err)
        self.assertIn("after_seq=42", self.fake.last_url())
        self.assertIn("context=5", self.fake.last_url())


class TestAck(HubTestBase):
    def test_ack_posts_seq_and_receipt(self):
        self.seed_config()
        self.fake.add("POST", "/v2/topics/t1/ack", 200,
                      {"topic_id": "t1", "acked_seq": 9})
        rc, out, err = self.run_cli(
            ["ack", "--topic", "t1", "--seq", "9", "--receipt", "rcpt-1"])
        self.assertEqual(rc, 0, err)
        self.assertEqual(json.loads(out)["acked_seq"], 9)
        call = self.fake.calls[-1]
        self.assertEqual(
            json.loads(call["body"]), {"seq": 9, "read_receipt": "rcpt-1"})

    def test_ack_requires_both_seq_and_receipt(self):
        self.seed_config()
        for argv in (["ack", "--topic", "t1", "--seq", "9"],
                     ["ack", "--topic", "t1", "--receipt", "r"]):
            with self.assertRaises(SystemExit) as cm:
                with contextlib.redirect_stdout(io.StringIO()), \
                     contextlib.redirect_stderr(io.StringIO()):
                    hub.main(argv, transport=self.fake)
            self.assertEqual(cm.exception.code, 2)  # argparse: missing required
        # ...and nothing was sent.
        self.assertEqual(self.fake.calls, [])


class TestTokenRevoke(HubTestBase):
    def test_revoke_posts_with_confirmation(self):
        self.seed_config()
        self.fake.add("POST", "/v2/auth/revoke", 200,
                      {"ok": True, "token_id": "tok_1"})
        with mock.patch("builtins.input", return_value="yes"):
            rc, out, err = self.run_cli(
                ["token-revoke", "--token-id", "tok_1"])
        self.assertEqual(rc, 0, err)
        self.assertEqual(json.loads(out)["token_id"], "tok_1")
        call = self.fake.calls[-1]
        self.assertTrue(call["url"].endswith("/v2/auth/revoke"))
        self.assertEqual(json.loads(call["body"]), {"token_id": "tok_1"})
        self.assertIn("revoked", err)

    def test_revoke_cancelled_by_default(self):
        self.seed_config()
        with mock.patch("builtins.input", return_value="no"):
            rc, out, err = self.run_cli(["token-revoke", "--token-id", "tok_1"])
        self.assertEqual(rc, 1)
        self.assertIn("cancelled", err)
        posts = [c for c in self.fake.calls if c["method"] == "POST"]
        self.assertEqual(posts, [])


# ---------------------------------------------------------------------------
# One server credential with explicit circle selection, multi-circle sync,
# membership joining, and human-only dashboard credential export
# ---------------------------------------------------------------------------


class TestCircleContext(HubTestBase):

    def seed_multi(self, **over):
        cfg = {
            "active_circle_id": "c111",

            "circle_members": {
                "c111": {"id": "m1", "name": "Tester", "role": "owner"},
                "c222": {"id": "m9", "name": "Tester", "role": "member"},
            },
        }
        cfg.update(over)
        self.seed_config(**cfg)

    # -- circle create auto-redeem --------------------------------------

    def test_create_preserves_server_credential_and_activates_membership(self):
        self.seed_config()
        self.fake.add("POST","/v2/families",201,{"id":"c333","name":"Gym","kind":"general"})
        self.fake.add("GET","/v2/families",200,{"families":[{"id":"c333","name":"Gym","member_id":"m9","my_role":"owner"}]})
        rc,out,err=self.run_cli(["circle","create","--name","Gym","--kind","general"])
        self.assertEqual(rc,0,err)
        cfg=hub.load_config("default")
        self.assertEqual(cfg["active_circle_id"],"c333")
        self.assertEqual(cfg["circle_members"]["c333"]["id"],"m9")
        self.assertNotIn("circle_tokens",cfg)
        self.assertFalse(any("redeem" in c["url"] for c in self.fake.calls))
        self.assertTokenAbsent(out,err)

    def test_create_missing_membership_preserves_pending_operation(self):
        self.seed_config()
        self.fake.add("POST","/v2/families",201,{"id":"c333","name":"Gym"})
        self.fake.add("GET","/v2/families",200,{"families":[]})
        rc,out,err=self.run_cli(["circle","create","--name","Gym"])
        self.assertEqual(rc,1)
        self.assertIn("not returned as an active membership",err)
        self.assertTrue(os.path.exists(os.path.join(hub.profile_dir("default"),"pending-circle-create.json")))

    def test_join_with_provisioning_code(self):
        self.seed_config()
        self.fake.add("POST", "/v2/provisioning-codes/fhp_JOIN123/redeem",
                      201,
                      {"token": "fh_JOINED_tok111", "token_id": "tokJ",
                       "member": {"id": "m7", "family_id": "c777",
                                  "name": "Tester", "role": "member"}})
        self.fake.add("GET", "/v2/me", 200,
                      {"id": "m7", "name": "Tester", "role": "member"})
        self.fake.add("GET", "/v2/families", 200, {"families": [
            {"id": "c777", "name": "Book Club", "kind": "general",
             "my_role": "member"}]})
        rc, out, err = self.run_cli(["circle", "join", "--code", "fhp_JOIN123"])
        self.assertEqual(rc, 0)
        cfg = hub.load_config("default")
        self.assertEqual(self.enrolled_token(), FAKE_TOKEN)
        self.assertNotIn("circle_tokens",cfg)
        self.assertEqual(cfg["active_circle_id"], "c777")
        self.assertIn("Book Club", out)
        self.assertIn("now active", out)
        self.assertNotIn("fh_JOINED_tok111", out + err)

    def test_join_with_invite_code_sends_name_label(self):
        self.seed_config()
        self.fake.add("POST", "/v2/invites/fhi_INV123/accept", 201,
                      {"token": "fh_INVITED_tok222", "token_id": "tokI",
                       "member": {"id": "m8", "family_id": "c888",
                                  "name": "Tester", "role": "kid"}})
        self.fake.add("GET", "/v2/me", 200,
                      {"id": "m8", "name": "Tester", "role": "kid"})
        self.fake.add("GET", "/v2/families", 200, {"families": [
            {"id": "c888", "name": "Gym", "kind": "general",
             "my_role": "kid"}]})
        rc, out, err = self.run_cli(["circle", "join", "--code", "fhi_INV123"])
        self.assertEqual(rc, 0)
        accept = [c for c in self.fake.calls if "accept" in c["url"]][0]
        body = json.loads(accept["body"])
        self.assertEqual(body["display_name"], "Tester")
        self.assertEqual(body["agent_label"], "test-agent")
        self.assertEqual(len(hub.base64.b64decode(body["agent_public_key"])), 32)
        cfg = hub.load_config("default")
        self.assertEqual(self.enrolled_token(), FAKE_TOKEN)
        self.assertNotIn("circle_tokens",cfg)
        self.assertEqual(cfg["active_circle_id"], "c888")
        self.assertNotIn("fh_INVITED_tok222", out + err)

    def test_incomplete_join_preserves_pending_operation_without_guessing_circle(self):
        # A malformed response is retained privately; do not guess a circle
        # or discard a credential after the server may have committed.
        self.seed_config()
        self.fake.add("POST", "/v2/invites/fhi_NOFAMID/accept", 201,
                      {"token": "fh_NOFAM_tok333", "token_id": "tokN",
                       "member": {"id": "m9", "name": "Tester", "role": "kid"}})
        self.fake.add("GET", "/v2/me", 200,
                      {"id": "m9", "name": "Tester", "role": "kid"})
        self.fake.add("GET", "/v2/families", 200, {"families": [
            {"id": "c999", "name": "Fallback Gym", "kind": "general",
             "my_role": "kid"}]})
        rc, out, err = self.run_cli(["circle", "join", "--code", "fhi_NOFAMID"])
        self.assertNotEqual(rc, 0)
        self.assertIn("pending enrollment was preserved", err)
        self.assertTrue(os.path.exists(hub._pending_enrollment("default")))
        self.assertNotIn("fh_NOFAM_tok333", out + err)

    def test_join_requires_an_existing_server_credential(self):
        os.environ.pop("FAMILY_HUB_TOKEN", None)
        hub.save_config("default", {"server_url": "https://hub.example"})
        rc, _out, err = self.run_cli(["circle", "join", "--code", "fhi_X"])
        self.assertEqual(rc, 1)
        self.assertIn("No credential", err)
        self.assertEqual(self.fake.calls, [])

    # -- per-circle auth --------------------------------------------------

    def test_request_sends_active_circle_with_server_credential(self):
        self.seed_multi()  # active c111
        self.fake.add("GET", "/v2/topics", 200, {"topics": []})
        rc, _out, _ = self.run_cli(["topics"])
        self.assertEqual(rc, 0)
        auth = self.fake.calls[0]["headers"]["Authorization"]
        self.assertEqual(auth, "Bearer " + FAKE_TOKEN)
        self.assertTokenAbsent(self.fake.calls[0]["headers"].get("X-X", ""))

    def test_request_uses_registration_circle_context(self):
        self.seed_config(family_id="c111")
        self.fake.add("GET", "/v2/topics", 200, {"topics": []})
        rc, _out, _ = self.run_cli(["topics"])
        self.assertEqual(rc, 0)
        auth = self.fake.calls[0]["headers"]["Authorization"]
        self.assertEqual(auth, "Bearer " + FAKE_TOKEN)

    def test_circle_override_switches_membership_context(self):
        self.seed_multi()  # active c111
        self.fake.add("GET", "/v2/families", 200, {"families": CIRCLES})
        self.fake.add("POST", "/v2/families/c222/invites", 201,
                      {"invite_code": "inv_z"})
        rc, _out, _ = self.run_cli(
            ["invite-member", "--circle", "Friends",
             "--email", "a@example.com", "--role", "kid"])
        self.assertEqual(rc, 0)
        posts = [c for c in self.fake.calls
                 if urlparse.urlparse(c["url"]).path.endswith("/invites")]
        self.assertEqual(len(posts), 1)
        # The same credential is used with the selected circle context.
        self.assertEqual(posts[0]["headers"]["Authorization"],
                         "Bearer " + FAKE_TOKEN)

    def test_circle_override_uses_existing_credential_and_explicit_context(self):
        self.seed_config(active_circle_id="c111")
        self.fake.add("GET","/v2/families",200,{"families":CIRCLES})
        self.fake.add("POST","/v2/families/c222/invites",201,{"invite_code":"fhi_test"})
        rc,out,err=self.run_cli(["invite-member","--circle","Friends","--email","a@example.com","--role","kid"])
        self.assertEqual(rc,0,err)
        request=self.fake.calls[-1]
        self.assertEqual(request["headers"]["X-Circle-ID"],"c222")
        self.assertEqual(request["headers"]["Authorization"],"Bearer "+FAKE_TOKEN)

    def test_use_requires_only_the_server_credential(self):
        self.seed_config(active_circle_id="c111")
        self.fake.add("GET", "/v2/families", 200, {"families": CIRCLES})
        rc, out, err = self.run_cli(["circle", "use", "Friends"])  # c222
        self.assertEqual(rc, 0)
        self.assertEqual(hub.load_config("default")["active_circle_id"], "c222")
        self.assertEqual(err, "")

    def test_use_no_warning_when_token_present(self):
        self.seed_multi()
        self.fake.add("GET", "/v2/families", 200, {"families": CIRCLES})
        rc, _out, err = self.run_cli(["circle", "use", "Friends"])
        self.assertEqual(rc, 0)
        self.assertNotIn("no token stored", err)

    def test_use_registration_circle_with_server_credential(self):
        # Single-token profile: the bootstrap circle works via fallback.
        self.seed_config(family_id="c111")
        self.fake.add("GET", "/v2/families", 200, {"families": CIRCLES})
        rc, _out, err = self.run_cli(["circle", "use", "Family"])
        self.assertEqual(rc, 0)
        self.assertNotIn("no token stored", err)

    # -- dashboard-token --------------------------------------------------------

    def test_dashboard_token_prints_with_warning(self):
        self.seed_multi()
        self.fake.add("GET", "/v2/families", 200, {"families": CIRCLES})
        rc, out, _ = self.run_cli(["dashboard-token", "--circle", "Friends"])
        self.assertEqual(rc, 0)
        self.assertIn("WARNING", out)
        self.assertIn(FAKE_TOKEN, out)
        # warning precedes the token
        self.assertLess(out.index("WARNING"), out.index(FAKE_TOKEN))

    def test_dashboard_token_requires_a_server_credential(self):
        self.seed_config(active_circle_id="c111")
        os.environ.pop("FAMILY_HUB_TOKEN",None)
        rc,out,err=self.run_cli(["dashboard-token","--circle","Friends"])
        self.assertEqual(rc,1)
        self.assertIn("No credential",err)



# Enrollment persistence, identity verification, and server-origin boundaries.
class TestEnrollHardening(HubTestBase):
    def redeem_calls(self):
        return [c for c in self.fake.calls
                if "redeem" in urlparse.urlparse(c["url"]).path
                or "accept" in urlparse.urlparse(c["url"]).path]

    def me_calls(self):
        return [c for c in self.fake.calls
                if urlparse.urlparse(c["url"]).path == "/v2/me"]

    def block_sink_probe(self):
        # Root-proof "unwritable" sink: .sink-probe exists as a directory,
        # so the 0600 write probe's os.open(O_WRONLY) raises EISDIR for
        # every user — while the profile dir and its config stay intact.
        pdir = hub.profile_dir("default")
        os.makedirs(pdir, exist_ok=True)
        os.makedirs(os.path.join(pdir, ".sink-probe"), exist_ok=True)

    # -- F11: setup ----------------------------------------------------

    def test_setup_env_verifies_token_via_me_before_success(self):
        new_token = "fh_SETUPME_123"
        self.fake.add("POST", "/v2/invites/OK1/accept", 200,
                      {"member": {"id": "m2", "family_id": "c2", "name": "N", "role": "parent"},
                       "token": new_token, "token_id": "t1"})
        self.fake.add("GET", "/v2/me", 200, {"id": "m2", "name": "N"})
        rc, out, err = self.run_cli([
            "setup", "--server", "https://hub.example",
            "--invite", "OK1", "--name", "N", "--label", "l",
            "--store", "file",
        ])
        self.assertEqual(rc, 0)
        self.assertIn("setup complete", out)
        # the /me probe carried the NEW token, and only then did we succeed
        self.assertEqual(len(self.me_calls()), 1)
        self.assertEqual(self.me_calls()[0]["headers"]["Authorization"],
                         "Bearer " + self.enrolled_token())
        self.assertNotIn(new_token, out + err)

    def test_setup_rejection_preserves_pending_enrollment(self):
        new_token = "fh_SETUPME_456"
        self.fake.add("POST", "/v2/invites/OK2/accept", 200,
                      {"member": {"id": "m2", "family_id": "c2", "name": "N", "role": "parent"},
                       "token": new_token, "token_id": "t1"})
        self.fake.add("GET", "/v2/me", 401,
                      {"error": {"code": "auth", "message": "bad token"}})
        rc, out, err = self.run_cli([
            "setup", "--server", "https://hub.example",
            "--invite", "OK2", "--name", "N", "--label", "l",
        ])
        self.assertEqual(rc, 3)
        self.assertIn("pending enrollment", err)
        self.assertIn("diagnostics", err)
        self.assertNotIn("setup complete", out)
        self.assertNotIn(new_token, out + err)

    def test_setup_me_network_failure_keeps_stored_credential(self):
        # A 500 on /v2/me is not an auth rejection: the token WAS stored,
        # so the operator must not burn another code.
        new_token = "fh_SETUPME_789"
        self.fake.add("POST", "/v2/invites/OK5/accept", 200,
                      {"member": {"id": "m2", "family_id": "c2", "name": "N", "role": "parent"},
                       "token": new_token, "token_id": "t1"})
        self.fake.add("GET", "/v2/me", 500,
                      {"error": {"code": "internal", "message": "boom"}})
        rc, out, err = self.run_cli([
            "setup", "--server", "https://hub.example",
            "--invite", "OK5", "--name", "N", "--label", "l",
        ])
        self.assertEqual(rc, 1)
        self.assertIn("WAS stored", err)
        self.assertIn("enroll --resume", err)
        self.assertNotIn(new_token, out + err)

    def test_setup_file_sink_unwritable_fails_before_redeem(self):
        self.block_sink_probe()
        rc, out, err = self.run_cli([
            "setup", "--server", "https://hub.example",
            "--invite", "CODE9", "--name", "N", "--label", "l",
            "--store", "file",
        ])
        self.assertEqual(rc, 1)
        self.assertIn("sink", err)
        self.assertIn("NOT been used", err)
        self.assertEqual(self.redeem_calls(), [])

    def test_setup_file_store_writes_0600_token_file(self):
        new_token = "fh_SETUPFILE_1"
        self.fake.add("POST", "/v2/invites/OK4/accept", 200,
                      {"member": {"id": "m2", "family_id": "c2", "name": "N", "role": "parent"},
                       "token": new_token, "token_id": "t1"})
        self.fake.add("GET", "/v2/me", 200, {"id": "m2"})
        rc, out, err = self.run_cli([
            "setup", "--server", "https://hub.example",
            "--invite", "OK4", "--name", "N", "--label", "l",
            "--store", "file",
        ])
        self.assertEqual(rc, 0)
        tokfile = hub.default_token_path("default")
        with open(tokfile) as fh:
            self.assertEqual(fh.read().strip(), self.enrolled_token())
        mode = stat.S_IMODE(os.stat(tokfile).st_mode)
        self.assertEqual(mode, 0o600)

    def test_setup_rejects_read_only_vault_sink(self):
        with self.assertRaises(SystemExit) as exc:
            self.run_cli(["setup", "--server", "https://hub.example", "--invite", "CODE9", "--store", "vault-cmd"])
        self.assertEqual(exc.exception.code, 2)
        self.assertEqual(self.redeem_calls(), [], "unsupported sinks must not burn a code")

    def test_setup_rejects_ephemeral_env_sink(self):
        with self.assertRaises(SystemExit) as exc:
            self.run_cli(["setup", "--server", "https://hub.example", "--invite", "CODE9", "--store", "env"])
        self.assertEqual(exc.exception.code, 2)
        self.assertEqual(self.redeem_calls(), [], "unsupported sinks must not burn a code")

    def test_setup_file_does_not_change_injected_runtime_token(self):
        self.block_sink_probe()
        self.run_cli(["setup","--server","https://hub.example","--invite","CODE9"])
        self.assertEqual(os.environ["FAMILY_HUB_TOKEN"], FAKE_TOKEN)

    # -- F11: circle join ----------------------------------------------

    def test_join_verifies_token_via_me_before_success(self):
        new_token = "fh_JOINME_1"
        self.seed_config()
        self.fake.add("POST", "/v2/provisioning-codes/fhp_JM1/redeem", 201,
                      {"token": new_token, "token_id": "tJ",
                       "member": {"id": "m7", "family_id": "c701",
                                  "name": "Tester", "role": "member"}})
        self.fake.add("GET", "/v2/me", 200, {"id": "m7"})
        self.fake.add("GET", "/v2/families", 200, {"families": []})
        rc, out, err = self.run_cli(["circle", "join", "--code", "fhp_JM1"])
        self.assertEqual(rc, 0)
        self.assertIn("now active", out)
        self.assertEqual(len(self.me_calls()), 1)
        self.assertEqual(self.me_calls()[0]["headers"]["Authorization"],
                         "Bearer " + self.enrolled_token())
        self.assertNotIn(new_token, out + err)

    def test_join_rejection_preserves_pending_enrollment(self):
        new_token = "fh_JOINME_2"
        self.seed_config()
        self.fake.add("POST", "/v2/provisioning-codes/fhp_JM2/redeem", 201,
                      {"token": new_token, "token_id": "tJ",
                       "member": {"id": "m7", "family_id": "c702",
                                  "name": "Tester", "role": "member"}})
        self.fake.add("GET", "/v2/me", 403,
                      {"error": {"code": "forbidden", "message": "nope"}})
        rc, out, err = self.run_cli(["circle", "join", "--code", "fhp_JM2"])
        self.assertEqual(rc, 3)
        self.assertIn("pending enrollment", err)
        self.assertIn("diagnostics", err)
        self.assertNotIn(new_token, out + err)

    def test_join_unwritable_profile_dir_fails_before_redeem(self):
        self.seed_config()
        self.block_sink_probe()
        rc, out, err = self.run_cli(["circle", "join", "--code", "fhp_JM3"])
        self.assertEqual(rc, 1)
        self.assertIn("sink", err)
        self.assertIn("NOT been used", err)
        self.assertEqual(self.redeem_calls(), [])

    # -- F03: server origin pinning ------------------------------------

    def test_server_override_requires_flag(self):
        self.seed_config()  # pinned https://hub.example
        rc, out, err = self.run_cli(
            ["--server", "https://other.example", "topics"])
        self.assertEqual(rc, 1)
        self.assertIn("--allow-server-override", err)
        self.assertEqual(self.fake.calls, [])  # nothing hit the wire

    def test_server_override_with_flag_warns_loudly(self):
        self.seed_config()
        self.fake.add("GET", "/v2/topics", 200, {"topics": []})
        rc, out, err = self.run_cli(
            ["--server", "https://other.example",
             "--allow-server-override", "topics"])
        self.assertEqual(rc, 0)
        self.assertIn("DIFFERENT", err)
        self.assertIn("enrolled with", err)
        self.assertIn("https://other.example", self.fake.last_url())

    def test_env_var_override_requires_flag(self):
        self.seed_config()  # pinned https://hub.example
        with mock.patch.dict(os.environ, {"FAMILY_HUB_URL": "https://evil.example"}):
            rc, out, err = self.run_cli(["topics"])
        self.assertEqual(rc, 1)
        self.assertIn("--allow-server-override", err)
        self.assertIn("FAMILY_HUB_URL", err)
        self.assertEqual(self.fake.calls, [])  # nothing hit the wire

    def test_env_var_override_with_flag_warns(self):
        self.seed_config()
        self.fake.add("GET", "/v2/topics", 200, {"topics": []})
        with mock.patch.dict(os.environ, {"FAMILY_HUB_URL": "https://other.example"}):
            rc, out, err = self.run_cli(["--allow-server-override", "topics"])
        self.assertEqual(rc, 0)
        self.assertIn("DIFFERENT", err)
        self.assertIn("FAMILY_HUB_URL", err)

    def test_env_var_same_origin_passes_quietly(self):
        self.seed_config()
        self.fake.add("GET", "/v2/topics", 200, {"topics": []})
        with mock.patch.dict(os.environ, {"FAMILY_HUB_URL": "https://hub.example/"}):
            rc, out, err = self.run_cli(["topics"])
        self.assertEqual(rc, 0)
        self.assertNotIn("DIFFERENT", err)

    def test_server_override_same_origin_is_quiet(self):
        self.seed_config()
        self.fake.add("GET", "/v2/topics", 200, {"topics": []})
        rc, out, err = self.run_cli(
            ["--server", "https://hub.example/", "topics"])
        self.assertEqual(rc, 0)
        self.assertNotIn("DIFFERENT", err)

    def test_http_url_rejected_at_setup(self):
        rc, out, err = self.run_cli([
            "setup", "--server", "http://hub.example",
            "--invite", "C", "--name", "N", "--label", "l",
        ])
        self.assertEqual(rc, 1)
        self.assertIn("https", err)
        self.assertEqual(self.fake.calls, [])

    def test_http_url_rejected_from_config(self):
        self.seed_config(server_url="http://hub.example")
        rc, out, err = self.run_cli(["topics"])
        self.assertEqual(rc, 1)
        self.assertIn("https", err)
        self.assertEqual(self.fake.calls, [])

    def test_validate_server_url(self):
        hub._validate_server_url("https://hub.example")
        hub._validate_server_url("https://hub.example:8443/path")
        hub._validate_server_url("http://localhost:8787")
        hub._validate_server_url("http://127.0.0.1:8787")
        hub._validate_server_url("http://[::1]:8787")
        for bad in ("http://hub.example", "http://192.168.1.5/",
                    "ftp://hub.example/", "file:///etc/passwd",
                    "https://user:pw@hub.example/", "not a url", ""):
            with self.assertRaises(hub.HubError, msg=bad):
                hub._validate_server_url(bad)

    def test_transport_rejects_plain_http(self):
        client = hub.HubClient("http://hub.example")
        with self.assertRaises(hub.HubError):
            client._urllib_transport(
                "GET", "http://hub.example/v2/me", {}, None)
        # loopback http passes the policy check (fails later on connect)
        loopback = hub.HubClient("http://127.0.0.1:9")
        with self.assertRaises(hub.HubError) as ctx:
            loopback._urllib_transport(
                "GET", "http://127.0.0.1:9/v2/me", {}, None)
        self.assertEqual(ctx.exception.code, "connection")


if __name__ == "__main__":
    unittest.main()
