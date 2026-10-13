// E2EE security-review fixes (secfix): server-side regression tests.
//
// F1 — key election via topics.current_key_id + owner/parent rotation privilege.
// F3 — envelope re-POST preserves the original created_at.
// F4 — PATCH /v1/topics/:id/subject (participant-only, E2EE-only).
// Info — handlePostEntry skips the PII scan for well-formed fh1 wire bodies.
import { test } from 'node:test';
import assert from 'node:assert';
import { makeApp, TestApp } from './app.js';
import { scanPii } from '../src/pii.js';

// No @types/node in this repo: random bytes via WebCrypto (DOM lib), base64
// via btoa (each input byte becomes one char — safe for short inputs).
function b64(n: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return btoa(String.fromCharCode(...bytes));
}
function hex(n: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

interface Party {
  token: string;
  memberId: string;
  agentLabel: string;
}

// Family whose owner's agent has a registered identity key.
async function setupKeyedFamily(app: TestApp, name: string): Promise<{ famId: string; owner: Party }> {
  const fam = await app.call('POST', '/v1/families', {
    body: { name, owner_name: 'Ow', owner_email: `o-${name}@x.dev` },
  });
  assert.equal(fam.status, 201);
  const famId = (await app.db.queryOne('SELECT id FROM families WHERE name = ?', [name]))!['id'] as string;
  const red = await app.call(
    'POST',
    `/v1/provisioning-codes/${encodeURIComponent(fam.body.provisioning_code)}/redeem`,
    { body: { agent_public_key: b64(32) } },
  );
  assert.equal(red.status, 201);
  return {
    famId,
    owner: {
      token: red.body.token as string,
      memberId: red.body.member.id as string,
      agentLabel: 'owner-agent',
    },
  };
}

// Extra member via the invite flow (no identity key unless added later).
async function addMember(
  app: TestApp,
  famId: string,
  inviterToken: string,
  email: string,
  role: string,
  displayName: string,
): Promise<{ token: string; memberId: string }> {
  const inv = await app.call('POST', `/v1/families/${famId}/invites`, {
    token: inviterToken,
    body: { email, role },
  });
  assert.equal(inv.status, 201);
  const acc = await app.call(
    'POST',
    `/v1/invites/${encodeURIComponent(inv.body.invite_code)}/accept`,
    { body: { display_name: displayName, agent_label: `${displayName.toLowerCase()}-agent` } },
  );
  assert.equal(acc.status, 201);
  return { token: acc.body.token as string, memberId: acc.body.member.id as string };
}

async function createE2eeTopic(
  app: TestApp,
  token: string,
  keyId: string,
): Promise<{ status: number; body: any }> {
  return app.call('POST', '/v1/topics', {
    token,
    body: {
      subject: b64(64),
      kind: 'group',
      participant_member_ids: [],
      e2ee: 1,
      initial_key_id: keyId,
    },
  });
}

async function inviteToTopic(app: TestApp, token: string, tid: string, memberIds: string[]): Promise<void> {
  const res = await app.call('POST', `/v1/topics/${tid}/invite`, {
    token,
    body: { member_ids: memberIds, history_from: 'full' },
  });
  assert.equal(res.status, 200);
}

function envelopeBody(over: Record<string, unknown>): Record<string, unknown> {
  return {
    member_id: over['member_id'],
    agent_label: over['agent_label'],
    key_id: over['key_id'],
    envelope: over['envelope'] ?? b64(96),
  };
}

async function currentKeyId(app: TestApp, tid: string): Promise<string | null> {
  const row = await app.db.queryOne(`SELECT current_key_id FROM topics WHERE id = ?`, [tid]);
  return row!['current_key_id'] as string | null;
}

// ---------------------------------------------------------------------------
// F1 — topics.current_key_id
// ---------------------------------------------------------------------------

test('F1: E2EE topic creation sets current_key_id from initial_key_id', async () => {
  const app = makeApp();
  const { owner } = await setupKeyedFamily(app, 'SecfixF1a');
  const keyId = hex(16);
  const res = await createE2eeTopic(app, owner.token, keyId);
  assert.equal(res.status, 201);
  const tid = res.body.topic.id as string;
  assert.equal(res.body.topic.current_key_id, keyId);
  assert.equal(await currentKeyId(app, tid), keyId);
});

test('F1: e2ee=1 without initial_key_id is 400; malformed initial_key_id is 400', async () => {
  const app = makeApp();
  const { owner } = await setupKeyedFamily(app, 'SecfixF1b');
  const missing = await app.call('POST', '/v1/topics', {
    token: owner.token,
    body: { subject: b64(64), kind: 'group', participant_member_ids: [], e2ee: 1 },
  });
  assert.equal(missing.status, 400);
  assert.match(String(missing.body.error.message), /initial_key_id/);

  const bad = await app.call('POST', '/v1/topics', {
    token: owner.token,
    body: { subject: b64(64), kind: 'group', participant_member_ids: [], e2ee: 1, initial_key_id: 'zzz' },
  });
  assert.equal(bad.status, 400);

  // Plaintext topics reject initial_key_id.
  const plain = await app.call('POST', '/v1/topics', {
    token: owner.token,
    body: { subject: 's', kind: 'group', participant_member_ids: [], initial_key_id: hex(16) },
  });
  assert.equal(plain.status, 400);

  const n = await app.db.queryOne(`SELECT COUNT(*) AS c FROM topics`, []);
  assert.equal(n!['c'], 0);
});

test('F1: kid participant introducing a new key_id is 403; current_key_id unchanged', async () => {
  const app = makeApp();
  const { famId, owner } = await setupKeyedFamily(app, 'SecfixF1c');
  const keyId = hex(16);
  const res = await createE2eeTopic(app, owner.token, keyId);
  assert.equal(res.status, 201);
  const tid = res.body.topic.id as string;
  const kid = await addMember(app, famId, owner.token, 'kid@s.dev', 'kid', 'Kiddo');
  await inviteToTopic(app, owner.token, tid, [kid.memberId]);

  // Attacker scenario: a participant (not owner/parent) tries to rotate to
  // an attacker key or downgrade to a removed member's key.
  const attackerKeyId = hex(16);
  const rot = await app.call('POST', `/v1/topics/${tid}/envelopes`, {
    token: kid.token,
    body: envelopeBody({
      member_id: owner.memberId,
      agent_label: owner.agentLabel,
      key_id: attackerKeyId,
    }),
  });
  assert.equal(rot.status, 403);
  assert.match(String(rot.body.error.message), /owner or parent/);
  assert.equal(await currentKeyId(app, tid), keyId);
  const n = await app.db.queryOne(
    `SELECT COUNT(*) AS c FROM topic_key_envelopes WHERE topic_id = ? AND key_id = ?`,
    [tid, attackerKeyId],
  );
  assert.equal(n!['c'], 0);
});

test('F1: owner introducing a new key_id stages it — current_key_id does NOT advance (N04)', async () => {
  const app = makeApp();
  const { owner } = await setupKeyedFamily(app, 'SecfixF1d');
  const keyId = hex(16);
  const res = await createE2eeTopic(app, owner.token, keyId);
  assert.equal(res.status, 201);
  const tid = res.body.topic.id as string;

  // Sync v2 (N04 fix): POSTing an envelope with a new key_id STORES it
  // (staged) but no longer flips topics.current_key_id — only
  // POST /v1/topics/:tid/keys/commit activates a key.
  const rotatedKeyId = hex(16);
  const rot = await app.call('POST', `/v1/topics/${tid}/envelopes`, {
    token: owner.token,
    body: envelopeBody({
      member_id: owner.memberId,
      agent_label: owner.agentLabel,
      key_id: rotatedKeyId,
    }),
  });
  assert.equal(rot.status, 201);
  assert.equal(await currentKeyId(app, tid), keyId, 'current_key_id must not flip on envelope POST');
  const n = await app.db.queryOne(
    `SELECT COUNT(*) AS c FROM topic_key_envelopes WHERE topic_id = ? AND key_id = ?`,
    [tid, rotatedKeyId],
  );
  assert.equal(n!['c'], 1, 'staged envelope must be stored');

  // GET /v1/topics/:id still advertises the old current key.
  const detail = await app.call('GET', `/v1/topics/${tid}`, { token: owner.token });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.topic.current_key_id, keyId);

  // The staged envelope is invisible via GET until keys/commit.
  const staged = await app.call('GET', `/v1/topics/${tid}/envelopes`, { token: owner.token });
  assert.equal(staged.status, 200);
  assert.equal(staged.body.envelopes.length, 0, 'staged envelopes must stay invisible pre-commit');
});

test('F1: re-POST of the CURRENT key_id by a kid is distribution, not rotation (201)', async () => {
  const app = makeApp();
  const { famId, owner } = await setupKeyedFamily(app, 'SecfixF1e');
  const keyId = hex(16);
  const res = await createE2eeTopic(app, owner.token, keyId);
  assert.equal(res.status, 201);
  const tid = res.body.topic.id as string;
  const kid = await addMember(app, famId, owner.token, 'kid2@s.dev', 'kid', 'KidTwo');
  await inviteToTopic(app, owner.token, tid, [kid.memberId]);

  // Same key_id as current_key_id: allowed for any participant.
  const dist = await app.call('POST', `/v1/topics/${tid}/envelopes`, {
    token: kid.token,
    body: envelopeBody({
      member_id: owner.memberId,
      agent_label: owner.agentLabel,
      key_id: keyId,
    }),
  });
  assert.equal(dist.status, 201);
  assert.equal(await currentKeyId(app, tid), keyId);
});

// ---------------------------------------------------------------------------
// F3 — re-POST preserves created_at
// ---------------------------------------------------------------------------

test('F3: re-POST of the same envelope preserves created_at and updates the blob', async () => {
  const app = makeApp();
  const { owner } = await setupKeyedFamily(app, 'SecfixF3');
  const keyId = hex(16);
  const res = await createE2eeTopic(app, owner.token, keyId);
  assert.equal(res.status, 201);
  const tid = res.body.topic.id as string;

  const env1 = b64(96);
  const first = await app.call('POST', `/v1/topics/${tid}/envelopes`, {
    token: owner.token,
    body: envelopeBody({
      member_id: owner.memberId,
      agent_label: owner.agentLabel,
      key_id: keyId,
      envelope: env1,
    }),
  });
  assert.equal(first.status, 201);

  // Pin created_at to a fixed old value so the test is deterministic
  // regardless of clock precision.
  const pinned = '2020-01-01T00:00:00.000Z';
  (app.raw as any)
    .prepare(`UPDATE topic_key_envelopes SET created_at = ? WHERE topic_id = ? AND key_id = ?`)
    .run(pinned, tid, keyId);

  const env2 = b64(96);
  assert.notEqual(env2, env1);
  const again = await app.call('POST', `/v1/topics/${tid}/envelopes`, {
    token: owner.token,
    body: envelopeBody({
      member_id: owner.memberId,
      agent_label: owner.agentLabel,
      key_id: keyId,
      envelope: env2,
    }),
  });
  assert.equal(again.status, 201);
  // The response reports the STORED created_at, not "now".
  assert.equal(again.body.created_at, pinned);

  const row = await app.db.queryOne(
    `SELECT envelope, created_at FROM topic_key_envelopes
      WHERE topic_id = ? AND member_id = ? AND agent_label = ? AND key_id = ?`,
    [tid, owner.memberId, owner.agentLabel, keyId],
  );
  assert.equal(row!['created_at'], pinned, 're-POST must not refresh created_at');
  assert.equal(row!['envelope'], env2, 're-POST must still replace the envelope blob');
});

// ---------------------------------------------------------------------------
// F4 — PATCH /v1/topics/:id/subject
// ---------------------------------------------------------------------------

test('F4: PATCH subject — non-participant 403; unknown topic 404', async () => {
  const app = makeApp();
  const { famId, owner } = await setupKeyedFamily(app, 'SecfixF4a');
  const res = await createE2eeTopic(app, owner.token, hex(16));
  assert.equal(res.status, 201);
  const tid = res.body.topic.id as string;
  const outsider = await addMember(app, famId, owner.token, 'out@s.dev', 'parent', 'Outsider');

  const forbidden = await app.call('PATCH', `/v1/topics/${tid}/subject`, {
    token: outsider.token,
    body: { subject: b64(64) },
  });
  assert.equal(forbidden.status, 403);

  const missing = await app.call('PATCH', `/v1/topics/nope-not-here/subject`, {
    token: owner.token,
    body: { subject: b64(64) },
  });
  assert.equal(missing.status, 404);
});

test('F4: PATCH subject — plaintext topics are 400', async () => {
  const app = makeApp();
  const { owner } = await setupKeyedFamily(app, 'SecfixF4b');
  const res = await app.call('POST', '/v1/topics', {
    token: owner.token,
    body: { subject: 'plain', kind: 'group', participant_member_ids: [] },
  });
  assert.equal(res.status, 201);
  const bad = await app.call('PATCH', `/v1/topics/${res.body.topic.id}/subject`, {
    token: owner.token,
    body: { subject: 'new subject' },
  });
  assert.equal(bad.status, 400);
});

test('F4: PATCH subject — participant replaces the opaque subject', async () => {
  const app = makeApp();
  const { owner } = await setupKeyedFamily(app, 'SecfixF4c');
  const res = await createE2eeTopic(app, owner.token, hex(16));
  assert.equal(res.status, 201);
  const tid = res.body.topic.id as string;
  const before = res.body.topic.subject as string;

  const rebound = b64(120);
  assert.notEqual(rebound, before);
  const patched = await app.call('PATCH', `/v1/topics/${tid}/subject`, {
    token: owner.token,
    body: { subject: rebound },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.topic.subject, rebound);
  const row = await app.db.queryOne(`SELECT subject FROM topics WHERE id = ?`, [tid]);
  assert.equal(row!['subject'], rebound);
});

test('F4: PATCH subject — empty / oversize subjects are 400', async () => {
  const app = makeApp();
  const { owner } = await setupKeyedFamily(app, 'SecfixF4d');
  const res = await createE2eeTopic(app, owner.token, hex(16));
  assert.equal(res.status, 201);
  const tid = res.body.topic.id as string;

  const empty = await app.call('PATCH', `/v1/topics/${tid}/subject`, {
    token: owner.token,
    body: { subject: '' },
  });
  assert.equal(empty.status, 400);
  const huge = await app.call('PATCH', `/v1/topics/${tid}/subject`, {
    token: owner.token,
    body: { subject: 'x'.repeat(1025) },
  });
  assert.equal(huge.status, 400);
});

// ---------------------------------------------------------------------------
// Info — PII scan skips well-formed fh1 wire bodies
// ---------------------------------------------------------------------------

/** Build a structurally valid fh1 body whose base64 payload contains a
 *  Luhn-valid 16-digit run: scanPii WOULD 422 it, so a 201 proves the PII
 *  scan was skipped for E2EE ciphertext. Fully deterministic: the 12 head
 *  bytes encode exactly "4111111111111111" and the 28 zero tail bytes keep
 *  the run bounded by non-digits ('A's). */
function piiTrippingWireBody(): string {
  const digits = '4111111111111111'; // Luhn-valid test card number
  const vals = [...digits].map((c) => 52 + (c.charCodeAt(0) - 48)); // '0'->52 … '9'->61
  const head: number[] = [];
  for (let i = 0; i < vals.length; i += 4) {
    const n = (vals[i] << 18) | (vals[i + 1] << 12) | (vals[i + 2] << 6) | vals[i + 3];
    head.push((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
  }
  // 40 raw bytes total (24 nonce + 16 tag minimum).
  const raw = new Uint8Array([...head, ...new Uint8Array(28)]);
  const blob = btoa(String.fromCharCode(...raw));
  assert.ok(blob.startsWith(digits), 'crafted payload must start with the digit run');
  assert.ok(scanPii(blob) !== null, 'crafted payload must trip the PII scanner');
  return `fh1.${hex(16)}.${hex(16)}.${blob}`;
}

test('info: well-formed fh1 ciphertext body skips the server PII scan', async () => {
  const app = makeApp();
  const { owner } = await setupKeyedFamily(app, 'SecfixPii');
  const res = await createE2eeTopic(app, owner.token, hex(16));
  assert.equal(res.status, 201);
  const tid = res.body.topic.id as string;

  const wire = piiTrippingWireBody();
  assert.ok(scanPii(wire) !== null, 'test body must trip the PII scanner');
  const posted = await app.call('POST', `/v1/topics/${tid}/entries`, {
    token: owner.token,
    body: { kind: 'message', body: wire },
  });
  assert.equal(posted.status, 201);
  assert.equal(posted.body.entry.body, wire);
});

test('info: malformed fh1-looking body is still PII-scanned', async () => {
  const app = makeApp();
  const { owner } = await setupKeyedFamily(app, 'SecfixPii2');
  const res = await createE2eeTopic(app, owner.token, hex(16));
  assert.equal(res.status, 201);
  const tid = res.body.topic.id as string;

  // Starts with the tag but is not a well-formed wire string -> scanned.
  const bad = 'fh1.nothex.4111111111111111';
  assert.ok(scanPii(bad) !== null, 'test body must trip the PII scanner');
  const posted = await app.call('POST', `/v1/topics/${tid}/entries`, {
    token: owner.token,
    body: { kind: 'message', body: bad },
  });
  assert.equal(posted.status, 422);
  assert.equal(posted.body.error.code, 'pii_detected');
});
