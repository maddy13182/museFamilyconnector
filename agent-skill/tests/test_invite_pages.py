#!/usr/bin/env python3
"""Tests for the invite onboarding pages CLI behavior (v0.9.0).

Covers spec INVITE_PAGES_SPEC.md §6 CLI items:

1. `invite-member` with a mocked transport returning `onboarding_url` →
   JSON output contains it; the one-time human block is printed to stderr
   exactly once.
2. No invite-related command writes the page URL to config/disk.

Fixtures only — never real tokens, codes, or URLs. All page URLs below
are synthetic fixtures of the documented `fhip_…` shape.
"""

import json
import os
import unittest

# Reuse the canned-transport harness from the main CLI test module.
from test_hub import HubTestBase, FakeHub


PAGE_TOKEN = "fhip_" + "A" * 43
ONBOARDING_URL = "https://hub.test/i/" + PAGE_TOKEN
INVITE_CODE = "fhi_" + "B" * 43


class TestInviteOnboardingPages(HubTestBase):
    def _invite_member(self, **resp_over):
        self.seed_config(family_id="fam1")
        body = {
            "invite_code": INVITE_CODE,
            "expires_at": "2026-10-18T00:00:00Z",
            "onboarding_url": ONBOARDING_URL,
        }
        body.update(resp_over)
        self.fake.add("POST", "/v1/families/fam1/invites", 201, body)
        return self.run_cli(
            ["invite-member", "--email", "lakshmi@example.com", "--role", "parent"]
        )

    def test_onboarding_url_in_json_output(self):
        rc, out, _err = self._invite_member()
        self.assertEqual(rc, 0)
        payload = json.loads(out)
        self.assertEqual(payload.get("onboarding_url"), ONBOARDING_URL)
        # The invite code path is unchanged: code still flows through.
        self.assertEqual(payload.get("invite_code"), INVITE_CODE)

    def test_stderr_block_printed_once(self):
        rc, _out, err = self._invite_member()
        self.assertEqual(rc, 0)
        self.assertIn("Onboarding URL (one-time", err)
        self.assertIn("never post it publicly", err)
        # The URL appears exactly once on stderr — never repeated.
        self.assertEqual(err.count(ONBOARDING_URL), 1)

    def test_no_url_without_onboarding_field(self):
        # Older servers return no onboarding_url: nothing must be printed.
        rc, out, err = self._invite_member(onboarding_url=None)
        self.assertEqual(rc, 0)
        self.assertNotIn("Onboarding URL", err)
        self.assertNotIn("/i/", err)
        self.assertNotIn("/i/", out)

    def test_no_url_written_to_config_or_disk(self):
        self._invite_member()
        leaked = []
        for root, _dirs, files in os.walk(self.tmp):
            for name in files:
                path = os.path.join(root, name)
                with open(path, "rb") as fh:
                    if ONBOARDING_URL.encode() in fh.read():
                        leaked.append(path)
        self.assertEqual(leaked, [], "onboarding URL persisted to disk!")

    def test_invite_related_commands_never_print_page_urls(self):
        # Audit: no invite-related command prints or persists page URLs.
        # Only invite-member handles onboarding_url (stderr once, JSON
        # passthrough); everything below takes codes, never URLs.
        # topic-level invite
        self.seed_config(family_id="fam1")
        self.fake.add("POST", "/v1/topics/t1/invite", 200, {"ok": True})
        rc, out, err = self.run_cli(["invite", "--topic", "t1", "--member", "m1"])
        self.assertEqual(rc, 0)
        self.assertNotIn("/i/", out + err)
        # circle join: takes a code, never a page URL
        self.fake.add(
            "POST", "/v1/invites/%s/accept" % INVITE_CODE, 200,
            {"member": {"id": "m2", "name": "New", "role": "parent",
                        "family_id": "fam1"},
             "token": "fh_fixturetoken"},
        )
        self.fake.add(
            "GET", "/v1/me", 200,
            {"id": "m2", "name": "New", "role": "parent", "family_id": "fam1"},
        )
        rc, out, err = self.run_cli(["circle", "join", "--code", INVITE_CODE])
        self.assertEqual(rc, 0)
        self.assertNotIn("/i/", out + err)
        leaked = []
        for root, _dirs, files in os.walk(self.tmp):
            for name in files:
                path = os.path.join(root, name)
                with open(path, "rb") as fh:
                    if b"/i/" in fh.read():
                        leaked.append(path)
        self.assertEqual(leaked, [], "page URL persisted to disk!")

    def test_debug_dump_scrubs_onboarding_url(self):
        body = json.dumps({"onboarding_url": ONBOARDING_URL,
                           "invite_code": INVITE_CODE})
        from test_hub import hub
        scrubbed = hub._scrub_sensitive_text(body)
        self.assertIn("[redacted]", scrubbed)
        self.assertNotIn(ONBOARDING_URL, scrubbed)

    def test_debug_url_dump_scrubs_page_token(self):
        from test_hub import hub
        scrubbed = hub._scrub_url("https://hub.test/i/" + PAGE_TOKEN)
        self.assertNotIn(PAGE_TOKEN, scrubbed)


if __name__ == "__main__":
    unittest.main()
