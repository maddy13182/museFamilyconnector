#!/usr/bin/env bash
#
# Family Hub end-to-end test — the "Kyler scenario".
#
# Drives the API through: family bootstrap -> invites -> parents_only topic ->
# kid gets 403 -> spawn linked child with briefing -> task delegation round-trip
# -> PII rejection -> idempotent retry dedupe -> sync v2 (changed-topic
# discovery, read receipts, ack) -> deleted-route confirmations (sync v1,
# redact, export, bare task GET/PATCH, auth/tokens) -> provision/revoke lifecycle.
#
# HOW TO RUN:
#   1. cd server && npm install && npm run build   # produces dist/
#   2. node docs/e2e-server.mjs &                  # local dev server below
#      - listens on $HUB (default http://127.0.0.1:8787)
#      - uses a FRESH in-memory database with SETUP_LOCKED=0 on every start
#   3. HUB=http://127.0.0.1:8787 bash docs/e2e.sh
#   (Or: wrangler dev --local against a dev D1, with SETUP_LOCKED=0.)
#
# NOTES:
#   - Creates throwaway data. NEVER run against the family's production instance.
#   - Uses the provisioning endpoints from docs/openapi.yaml
#     (POST /v1/provisioning-codes, POST /v1/provisioning-codes/{code}/redeem)
#     — without them the bootstrap provisioning code cannot be redeemed and
#     no owner token can exist.
#   - Tokens live in shell variables only and are never echoed. (They do appear
#     briefly in the local process list via curl -H; acceptable for a local
#     throwaway run, never do this over untrusted machines.)
#
# RELEASE GATE (spec §8) — MANUAL checklist, cannot run here:
#   The Muse side-chat e2e must pass in a real Muse instance before the
#   integration is called stable. Backend tests passing is NOT sufficient.
#   In a real Muse instance, with two test agents A and B (+ a third, C):
#     1. A creates a group topic with B and C.
#     2. B and C discover it via `hub sync`, create the correct side chats,
#        and display the messages.
#     3. B replies with an approval; A and C receive it exactly once.
#     4. Restart all three agents mid-flow: nothing is lost, nothing
#        double-delivers (unacked entries return; acks are idempotent).
#   Sign-off: ________________  Date: __________
#
set -euo pipefail

HUB="${HUB:-http://127.0.0.1:8787}"

command -v curl >/dev/null || { echo "need curl"; exit 2; }
command -v python3 >/dev/null || { echo "need python3"; exit 2; }

PASS=0
FAIL=0

# ------------------------------------------------------------------ helpers

API_CODE=0
API_BODY=""

# api METHOD PATH TOKEN DATA [extra curl args...]
api() {
  local method="$1" path="$2" token="$3" data="$4"
  shift 4
  local -a cmd=(curl -s -w '\n%{http_code}' --connect-timeout 5 --max-time 30 -X "$method")
  if [ -n "$token" ]; then cmd+=(-H "Authorization: Bearer $token"); fi
  cmd+=(-H "Content-Type: application/json")
  if [ -n "$data" ]; then cmd+=(-d "$data"); fi
  while [ $# -gt 0 ]; do cmd+=("$1"); shift; done
  cmd+=("$HUB$path")
  local out
  out="$("${cmd[@]}")"
  if [[ "$out" == *$'\n'* ]]; then
    API_CODE="${out##*$'\n'}"
    API_BODY="${out%$'\n'*}"
  else
    API_CODE="$out"
    API_BODY=""
  fi
}

# jget <dotted.path> — prints scalar or compact JSON from $API_BODY; "" if missing
jget() {
  python3 -c '
import json, sys
try:
    d = json.loads(sys.stdin.read())
except Exception:
    print("JSON_PARSE_ERROR")
    sys.exit(3)
v = d
try:
    for k in sys.argv[1].split("."):
        k = k.strip()
        if not k:
            continue
        if isinstance(v, list) and k.lstrip("-").isdigit():
            v = v[int(k)]
        else:
            v = v[k]
except (KeyError, IndexError, TypeError):
    print("")
    sys.exit(0)
print("" if v is None else (v if isinstance(v, str) else json.dumps(v)))
' "$1" <<<"$API_BODY"
}

# jlen <json-array> -> length
jlen() {
  python3 -c 'import json, sys; print(len(json.load(sys.stdin)))' <<<"$1"
}

# kinds_of: stdin JSON array -> space-joined entry kinds
kinds_of() {
  python3 -c 'import json, sys; print(" ".join(e["kind"] for e in json.load(sys.stdin)))'
}

urlencode() {
  python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$1"
}

# ids from the server must be inert before we interpolate them into JSON
need_id() {
  case "$1" in
    ""|*[!A-Za-z0-9_-]*)
      echo "ABORT: unexpected id format: [$1]" >&2; exit 2 ;;
  esac
}

pass() { PASS=$((PASS + 1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }

assert_code() { # expected-code label
  if [ "$API_CODE" = "$1" ]; then pass "$2 (HTTP $1)";
  else fail "$2 — expected HTTP $1, got $API_CODE :: $(head -c 300 <<<"$API_BODY")"; fi
}
assert_eq() { # actual expected label
  if [ "$1" = "$2" ]; then pass "$3";
  else fail "$3 — expected [$2], got [$1]"; fi
}
assert_contains() { # haystack needle label
  case "$1" in
    *"$2"*) pass "$3" ;;
    *) fail "$3 — [$1] does not contain [$2]" ;;
  esac
}

echo "== Family Hub e2e — Kyler scenario — against $HUB =="

# ------------------------------------------------------------- 1. health
api GET /v1/health "" ""
assert_code 200 "health check"
assert_eq "$(jget ok)" "true" "health ok=true"

# ------------------------------------------------------------- 2. bootstrap
api POST /v1/families "" '{"name":"e2e family","owner_name":"e2e owner","owner_email":"e2e-owner@example.com"}'
if [ "$API_CODE" = "403" ]; then
  echo "ABORT: server has SETUP_LOCKED=1 — e2e needs a fresh dev instance (see header)."
  exit 2
fi
assert_code 201 "bootstrap family"
FID="$(jget family.id)"; need_id "$FID"
OWNER_MID="$(jget member.id)"; need_id "$OWNER_MID"
PROV="$(jget provisioning_code)"
assert_eq "$(jget member.role)" "owner" "bootstrap creates owner"

# ------------------------------------------------------------- 3. owner provision redeem
api POST "/v1/provisioning-codes/$(urlencode "$PROV")/redeem" "" '{}'
assert_code 201 "owner provision redeem"
OWNER_TOKEN="$(jget token)"
OWNER_TOKID="$(jget token_id)"; need_id "$OWNER_TOKID"

# ------------------------------------------------------------- 4. provisioning code is single-use
api POST "/v1/provisioning-codes/$(urlencode "$PROV")/redeem" "" '{}'
assert_code 409 "provisioning code single-use"
assert_eq "$(jget error.code)" "code_used" "409 code_used shape"

# ------------------------------------------------------------- 5. invite parent + kid
api POST "/v1/families/$(urlencode "$FID")/invites" "$OWNER_TOKEN" \
  '{"email":"e2e-parent@example.com","role":"parent"}'
assert_code 201 "invite parent"
PARENT_CODE="$(jget invite_code)"
api POST "/v1/families/$(urlencode "$FID")/invites" "$OWNER_TOKEN" \
  '{"email":"e2e-kid@example.com","role":"kid"}'
assert_code 201 "invite kid"
KID_CODE="$(jget invite_code)"

# ------------------------------------------------------------- 6. accept invites
api POST "/v1/invites/$(urlencode "$PARENT_CODE")/accept" "" \
  '{"display_name":"e2e parent","agent_label":"e2e-parent-agent"}'
assert_code 201 "parent accepts invite"
PARENT_TOKEN="$(jget token)"
PARENT_MID="$(jget member.id)"; need_id "$PARENT_MID"
assert_eq "$(jget member.role)" "parent" "parent role assigned"

api POST "/v1/invites/$(urlencode "$KID_CODE")/accept" "" \
  '{"display_name":"e2e kid","agent_label":"e2e-kid-agent"}'
assert_code 201 "kid accepts invite"
KID_TOKEN="$(jget token)"
KID_MID="$(jget member.id)"; need_id "$KID_MID"
assert_eq "$(jget member.role)" "kid" "kid role assigned"

# ------------------------------------------------------------- 7. invite codes are single-use
api POST "/v1/invites/$(urlencode "$KID_CODE")/accept" "" \
  '{"display_name":"intruder","agent_label":"x"}'
assert_code 409 "invite code single-use"
assert_eq "$(jget error.code)" "invite_used" "409 invite_used shape"

# ------------------------------------------------------------- 8. parents_only topic (the Kyler thread)
api POST /v1/topics "$OWNER_TOKEN" \
  '{"subject":"Kyler - schedule (parents only)","kind":"group","parents_only":true,"participant_member_ids":[]}'
assert_code 201 "create parents_only topic"
PTID="$(jget topic.id)"; need_id "$PTID"
api GET "/v1/topics/$(urlencode "$PTID")" "$OWNER_TOKEN" ""
assert_code 200 "read parent topic detail"
IDS="$(jget participants | python3 -c 'import json,sys; print(" ".join(p["member_id"] for p in json.load(sys.stdin)))')"
assert_eq "$(jlen "$(jget participants)")" "2" "parents_only topic has exactly 2 participants"
assert_contains "$IDS" "$OWNER_MID" "owner in parents topic"
assert_contains "$IDS" "$PARENT_MID" "parent in parents topic"
case "$IDS" in
  *"$KID_MID"*) fail "kid must NOT be in parents topic" ;;
  *) pass "kid not in parents topic" ;;
esac

# ------------------------------------------------------------- 9. parents discuss
api POST "/v1/topics/$(urlencode "$PTID")/entries" "$OWNER_TOKEN" \
  '{"body":"Kyler has a late practice Thursday; can you cover pickup?"}'
assert_code 201 "owner posts in parent topic"
assert_eq "$(jget entry.seq)" "1" "first entry seq=1"
api POST "/v1/topics/$(urlencode "$PTID")/entries" "$PARENT_TOKEN" \
  '{"body":"Yes, I can cover Thursday.","reply_to_seq":1}'
assert_code 201 "parent replies"
assert_eq "$(jget entry.seq)" "2" "reply seq=2"

# ------------------------------------------------------------- 10. kid is locked out (server-enforced)
api GET "/v1/topics/$(urlencode "$PTID")" "$KID_TOKEN" ""
assert_code 403 "kid cannot read parent topic metadata"
assert_eq "$(jget error.code)" "forbidden" "403 error shape"
api GET "/v1/topics/$(urlencode "$PTID")/history" "$KID_TOKEN" ""
assert_code 403 "kid cannot read parent topic history"

# ------------------------------------------------------------- 11. spawn linked child with briefing
BRIEF="We discussed Kyler Thursday pickup (mom covers). Sharing the plan with you now."
SPAWN_BODY="$(BRIEF="$BRIEF" IDS="$OWNER_MID,$PARENT_MID,$KID_MID" python3 -c '
import json, os
print(json.dumps({
  "subject": "Kyler - family chat",
  "participant_member_ids": os.environ["IDS"].split(","),
  "briefing": os.environ["BRIEF"],
}))')"
api POST "/v1/topics/$(urlencode "$PTID")/spawn" "$OWNER_TOKEN" "$SPAWN_BODY"
assert_code 201 "spawn linked child topic"
CTID="$(jget topic.id)"; need_id "$CTID"
assert_eq "$(jget parent_topic_id)" "$PTID" "child links to parent"
api GET "/v1/topics/$(urlencode "$CTID")/history" "$OWNER_TOKEN" ""
assert_eq "$(jget entries.0.kind)" "briefing" "first child entry is the briefing"
assert_eq "$(jget entries.0.seq)" "1" "briefing is seq 1"

# ------------------------------------------------------------- 12. kid sees child, not parent
api GET "/v1/topics/$(urlencode "$CTID")/history" "$KID_TOKEN" ""
assert_code 200 "kid reads child history"
assert_eq "$(jget entries.0.kind)" "briefing" "kid sees briefing first"
assert_contains "$(jget entries.0.body)" "Thursday pickup" "briefing content visible to kid"
api GET "/v1/topics/$(urlencode "$CTID")" "$KID_TOKEN" ""
assert_eq "$(jget topic.parent_topic_id)" "$PTID" "child metadata shows parent link"
api GET "/v1/topics/$(urlencode "$PTID")" "$KID_TOKEN" ""
assert_code 403 "kid still 403 on parent despite link"

# ------------------------------------------------------------- 13. history_from=from_join hides earlier history
T2_BODY="$(IDS="$OWNER_MID,$PARENT_MID" python3 -c '
import json, os
print(json.dumps({"subject": "logistics", "kind": "group",
                  "participant_member_ids": os.environ["IDS"].split(",")}))')"
api POST /v1/topics "$OWNER_TOKEN" "$T2_BODY"
assert_code 201 "create logistics topic"
T2="$(jget topic.id)"; need_id "$T2"
api POST "/v1/topics/$(urlencode "$T2")/entries" "$OWNER_TOKEN" '{"body":"msg before kid joins"}'
assert_code 201 "message before kid joins"
INV_BODY="$(KID="$KID_MID" python3 -c '
import json, os
print(json.dumps({"member_ids": [os.environ["KID"]], "history_from": "from_join"}))')"
api POST "/v1/topics/$(urlencode "$T2")/invite" "$OWNER_TOKEN" "$INV_BODY"
assert_code 200 "invite kid with from_join"
api GET "/v1/topics/$(urlencode "$T2")/history" "$KID_TOKEN" ""
assert_eq "$(kinds_of <<<"$(jget entries)")" "member_joined" "from_join hides earlier message"
api POST "/v1/topics/$(urlencode "$T2")/entries" "$OWNER_TOKEN" '{"body":"msg after kid joins"}'
api GET "/v1/topics/$(urlencode "$T2")/history" "$KID_TOKEN" ""
assert_eq "$(kinds_of <<<"$(jget entries)")" "member_joined message" "kid sees only post-join history"

# kid cannot invite others (role rule)
api POST "/v1/topics/$(urlencode "$CTID")/invite" "$KID_TOKEN" \
  "$(python3 -c 'import json; print(json.dumps({"member_ids":["m_nonexistent"],"history_from":"full"}))')"
assert_code 403 "kid cannot invite to topics"

# ------------------------------------------------------------- 14. task delegation round-trip
TASK_BODY="$(KID="$KID_MID" python3 -c '
import json, os
print(json.dumps({"title": "Check Thursday availability",
                  "description": "Confirm no conflicts with Kyler pickup plan",
                  "assignee_member_id": os.environ["KID"]}))')"
api POST "/v1/topics/$(urlencode "$CTID")/tasks" "$OWNER_TOKEN" "$TASK_BODY"
assert_code 201 "owner creates task assigned to kid"
TASK="$(jget task.id)"; need_id "$TASK"
assert_eq "$(jget task.status)" "open" "task starts open"
api GET "/v1/topics/$(urlencode "$CTID")/tasks" "$KID_TOKEN" ""
assert_code 200 "kid lists topic tasks"
assert_contains "$(jget tasks)" "$TASK" "kid sees assigned task"
api POST "/v1/tasks/$(urlencode "$TASK")/notes" "$KID_TOKEN" '{"body":"Checked with mom; Thursday works."}'
assert_code 201 "kid posts progress note"
assert_eq "$(jget entry.kind)" "task_note" "note entry kind"
api POST "/v1/tasks/$(urlencode "$TASK")/done" "$KID_TOKEN" '{"result":{"conflicts":[]}}'
assert_code 200 "kid completes task"
assert_eq "$(jget task.status)" "done" "task done"
assert_eq "$(jget task.result.conflicts)" "[]" "result payload round-trips"
# GET /v1/tasks/:id is deleted (spec §1.6); the task_done event is verified
# via topic history instead.
api GET "/v1/topics/$(urlencode "$CTID")/history?after_seq=0&limit=500" "$OWNER_TOKEN" ""
assert_contains "$(kinds_of <<<"$(jget entries)")" "task_done" "owner sees task_done in history"

# ------------------------------------------------------------- 15. subtask rule (server-enforced)
api POST "/v1/topics/$(urlencode "$CTID")/tasks" "$OWNER_TOKEN" '{"title":"Plan trip"}'
PTASK="$(jget task.id)"; need_id "$PTASK"
api POST "/v1/topics/$(urlencode "$CTID")/tasks" "$OWNER_TOKEN" \
  "$(python3 -c 'import json; print(json.dumps({"title":"Check dates","parent_task_id":"'"$PTASK"'"}))')"
STASK="$(jget task.id)"; need_id "$STASK"
api POST "/v1/tasks/$(urlencode "$PTASK")/done" "$OWNER_TOKEN" '{}'
assert_code 409 "done with open subtask rejected"
assert_eq "$(jget error.code)" "subtasks_open" "409 subtasks_open shape"
api POST "/v1/tasks/$(urlencode "$STASK")/done" "$OWNER_TOKEN" '{}'
assert_code 200 "subtask completes"
api POST "/v1/tasks/$(urlencode "$PTASK")/done" "$OWNER_TOKEN" '{}'
assert_code 200 "parent completes after subtask"

# assignee must already be a topic participant
T3_BODY="$(IDS="$OWNER_MID,$PARENT_MID" python3 -c '
import json, os
print(json.dumps({"subject": "parents budget", "kind": "group",
                  "participant_member_ids": os.environ["IDS"].split(",")}))')"
api POST /v1/topics "$OWNER_TOKEN" "$T3_BODY"
T3="$(jget topic.id)"; need_id "$T3"
api POST "/v1/topics/$(urlencode "$T3")/tasks" "$OWNER_TOKEN" \
  "$(python3 -c 'import json; print(json.dumps({"title":"x","assignee_member_id":"'"$KID_MID"'"}))')"
assert_code 400 "assignee must be a topic participant"

# ------------------------------------------------------------- 16. PII rejected with 422, nothing stored
api GET "/v1/topics/$(urlencode "$CTID")/history?after_seq=0&limit=500" "$OWNER_TOKEN" ""
BEFORE_PII="$(jlen "$(jget entries)")"
api POST "/v1/topics/$(urlencode "$CTID")/entries" "$OWNER_TOKEN" \
  '{"body":"my card is 4111111111111111 do not share"}'
assert_code 422 "card number rejected"
assert_eq "$(jget error.code)" "pii_detected" "422 error shape"
api POST "/v1/topics/$(urlencode "$CTID")/entries" "$OWNER_TOKEN" \
  '{"body":"ssn 123-45-6789 here"}'
assert_code 422 "SSN rejected"
api GET "/v1/topics/$(urlencode "$CTID")/history?after_seq=0&limit=500" "$OWNER_TOKEN" ""
assert_eq "$(jlen "$(jget entries)")" "$BEFORE_PII" "rejected PII stored nothing"

# ------------------------------------------------------------- 17. idempotent retry dedupes
api GET "/v1/topics/$(urlencode "$CTID")/history?after_seq=0&limit=500" "$OWNER_TOKEN" ""
BEFORE_IDEM="$(jlen "$(jget entries)")"
IDEM="e2e-idem-$RANDOM-$RANDOM"
api POST "/v1/topics/$(urlencode "$CTID")/entries" "$OWNER_TOKEN" '{"body":"idempotent hello"}' \
  -H "Idempotency-Key: $IDEM"
assert_code 201 "first post with idempotency key"
E1="$(jget entry.gseq)"
api POST "/v1/topics/$(urlencode "$CTID")/entries" "$OWNER_TOKEN" '{"body":"idempotent hello"}' \
  -H "Idempotency-Key: $IDEM"
assert_code 200 "idempotent replay returns 200"
assert_eq "$(jget entry.gseq)" "$E1" "replay returns the same entry"
assert_eq "$(jget deduped)" "true" "deduped flag set"
api GET "/v1/topics/$(urlencode "$CTID")/history?after_seq=0&limit=500" "$OWNER_TOKEN" ""
assert_eq "$(jlen "$(jget entries)")" "$((BEFORE_IDEM + 1))" "retry stored no duplicate"

# ------------------------------------------------------------- 18. sync v1 removed; sync v2 journey (spec §1.3/§1.4)
# GET /v1/sync is deleted (spec §1.6).
api GET "/v1/sync?after_gseq=0&limit=500" "$KID_TOKEN" ""
assert_code 404 "GET /v1/sync removed"

# Changed-topic discovery, one call per circle token.
api GET "/v1/sync/topics" "$KID_TOKEN" ""
assert_code 200 "GET /v1/sync/topics"
SYNCTOPICS="$API_BODY"
assert_contains "$SYNCTOPICS" "$CTID" "sync lists the child topic as changed"
assert_contains "$SYNCTOPICS" "$T2" "sync lists the logistics topic as changed"
case "$SYNCTOPICS" in
  *"$PTID"*) fail "parents_only topic must not leak into the kid's sync" ;;
  *) pass "parents_only topic absent from kid sync" ;;
esac

# Field shape + paging.
api GET "/v1/sync/topics?limit=1" "$KID_TOKEN" ""
assert_code 200 "sync/topics page 1"
assert_eq "$(jget has_more)" "true" "has_more with limit=1"
assert_eq "$(jget topics.0.key_status)" "not_e2ee" "key_status for a plaintext topic"
assert_eq "$(jget topics.0.circle_id)" "$FID" "circle_id matches"
PAGE2="$(jget next_page_token)"
api GET "/v1/sync/topics?limit=1&page_token=$(urlencode "$PAGE2")" "$KID_TOKEN" ""
assert_code 200 "sync/topics page 2"
assert_eq "$(jget has_more)" "false" "no more pages"

# Read -> receipt -> ack: the topic goes quiet afterwards.
api GET "/v1/topics/$(urlencode "$CTID")/history" "$KID_TOKEN" ""
assert_code 200 "history for ack journey"
RCPT="$(jget read_receipt)"
THRU="$(jget read_through_seq)"
case "$RCPT" in
  fhrr1.*) pass "history issues a read receipt" ;;
  *) fail "history issues a read receipt — got [$RCPT]" ;;
esac
ACK_BODY="$(THRU="$THRU" RCPT="$RCPT" python3 -c '
import json, os
print(json.dumps({"seq": int(os.environ["THRU"]), "read_receipt": os.environ["RCPT"]}))')"
api POST "/v1/topics/$(urlencode "$CTID")/ack" "$KID_TOKEN" "$ACK_BODY"
assert_code 200 "ack with receipt"
assert_eq "$(jget acked_seq)" "$THRU" "ack advances to read_through_seq"
api GET "/v1/sync/topics" "$KID_TOKEN" ""
case "$(jget topics)" in
  *"$CTID"*) fail "acked topic must drop out of sync" ;;
  *) pass "acked topic drops out of sync" ;;
esac

# A forged receipt is rejected (403), and the legacy bootstrap_gseq param
# is accepted but ignored (full re-read semantics).
api POST "/v1/topics/$(urlencode "$T2")/ack" "$KID_TOKEN" '{"seq":99,"read_receipt":"fhrr1.1.99.ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"}'
assert_code 403 "forged receipt rejected"
assert_eq "$(jget error.code)" "invalid_read_receipt" "403 invalid_read_receipt shape"
api GET "/v1/sync/topics?bootstrap_gseq=424242" "$KID_TOKEN" ""
assert_code 200 "bootstrap_gseq accepted"

# ------------------------------------------------------------- 19. redact removed (spec §1.6)
# POST /v1/entries/:eid/redact is deleted (no client). The old behavior —
# owner-only scrub — is gone; assert the route 404s for everyone.
api POST "/v1/topics/$(urlencode "$CTID")/entries" "$OWNER_TOKEN" '{"body":"oops wrong number 555-0100"}'
assert_code 201 "post entry (would-be redact target)"
EGSEQ="$(jget entry.gseq)"
api POST "/v1/entries/$EGSEQ/redact" "$KID_TOKEN" '{}'
assert_code 404 "redact removed (kid)"
api POST "/v1/entries/$EGSEQ/redact" "$OWNER_TOKEN" '{}'
assert_code 404 "redact removed (owner)"

# ------------------------------------------------------------- 20. provision -> revoke lifecycle
api POST /v1/provisioning-codes "$KID_TOKEN" "$(python3 -c 'import json; print(json.dumps({"member_id":"'"$KID_MID"'","agent_label":"e2e-kid-agent-2"}))')"
assert_code 201 "kid mints provisioning code"
PC2="$(jget provisioning_code)"
api POST "/v1/provisioning-codes/$(urlencode "$PC2")/redeem" "" '{}'
assert_code 201 "second kid agent enrolled"
TOK2="$(jget token)"
TOK2ID="$(jget token_id)"; need_id "$TOK2ID"
api GET /v1/members "$TOK2" ""
assert_code 200 "new token works"
api POST /v1/auth/revoke "$TOK2" "$(python3 -c 'import json; print(json.dumps({"token_id":"'"$TOK2ID"'"}))')"
assert_code 200 "revoke token"
api GET /v1/members "$TOK2" ""
assert_code 401 "revoked token rejected"
# GET /v1/auth/tokens was a stale PROPOSED path; spec §1.6 deletes it.
api GET /v1/auth/tokens "$OWNER_TOKEN" ""
assert_code 404 "GET /v1/auth/tokens removed"

# ------------------------------------------------------------- summary
echo
echo "== e2e complete: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
