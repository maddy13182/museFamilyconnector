// Invite onboarding pages (v0.11.0): per-invite single-use pages at
// /i/<page-token>. The inviter shares the onboarding URL; the invitee
// proves the invited email and receives a fresh single-use invite code.
import { test } from 'node:test';
import assert from 'node:assert';
import { makeApp } from './app.js';
import { redactPath } from '../src/index.js';
import manifest from '../client-manifest.json' with { type: 'json' };

type App = ReturnType<typeof makeApp>;

const URL_RE = /^https:\/\/hub\.test\/i\/fhip_[A-Za-z0-9]{43}$/;
const CODE_RE = /^fhi_[A-Za-z0-9]{22}$/;

function ip(n: number) {
  return { headers: { 'CF-Connecting-IP': `10.8.7.${n}` } };
}

async function bootstrapOwner(app: App, name: string, email: string) {
  const fam = await app.call('POST', '/v1/families', {
    body: { name, owner_name: 'Owner', owner_email: email },
  });
  assert.equal(fam.status, 201);
  const red = await app.call(
    'POST',
    `/v1/provisioning-codes/${encodeURIComponent(fam.body.provisioning_code)}/redeem`,
    { body: {} },
  );
  assert.equal(red.status, 201);
  return { famId: fam.body.family.id as string, token: red.body.token as string };
}

async function createInvite(app: App, token: string, famId: string, email: string, role = 'parent') {
  const r = await app.call('POST', `/v1/families/${famId}/invites`, {
    token,
    body: { email, role },
  });
  assert.equal(r.status, 201);
  return r.body as { invite_code: string; expires_at: string; onboarding_url: string };
}

function pageTokenOf(onboardingUrl: string): string {
  return (onboardingUrl as string).split('/i/')[1];
}

// 1. Create invite (owner) -> onboarding_url present and well-formed; the
// invite_code field is unchanged.
test('create invite returns a one-time onboarding_url', async () => {
  const app = makeApp();
  const { famId, token } = await bootstrapOwner(app, 'Page Fam 1', 'owner1@t.dev');
  const inv = await createInvite(app, token, famId, 'invitee1@t.dev');
  assert.match(inv.onboarding_url, URL_RE);
  assert.match(inv.invite_code, CODE_RE);
  assert.ok(inv.expires_at);
});

// 2. Idempotency-hit path also mints a fresh page token (fresh URL).
test('idempotent invite retry returns a fresh onboarding_url', async () => {
  const app = makeApp();
  const { famId, token } = await bootstrapOwner(app, 'Page Fam 2', 'owner2@t.dev');
  const key = 'invite-page-idem-1';
  const first = await app.call('POST', `/v1/families/${famId}/invites`, {
    token,
    body: { email: 'invitee2@t.dev', role: 'parent' },
    headers: { 'idempotency-key': key },
  });
  assert.equal(first.status, 201);
  const second = await app.call('POST', `/v1/families/${famId}/invites`, {
    token,
    body: { email: 'invitee2@t.dev', role: 'parent' },
    headers: { 'idempotency-key': key },
  });
  assert.equal(second.status, 200);
  assert.equal(second.body.deduped, true);
  assert.match(second.body.onboarding_url, URL_RE);
  assert.notEqual(
    second.body.onboarding_url,
    first.body.onboarding_url,
    'idempotency hit must mint a fresh page token',
  );
  assert.notEqual(second.body.invite_code, first.body.invite_code);
});

// 3. Kids still cannot invite (existing authorization intact).
test('non-owner/parent creating invite -> 403', async () => {
  const app = makeApp();
  const { famId, token } = await bootstrapOwner(app, 'Page Fam 3', 'owner3@t.dev');
  const kidInv = await createInvite(app, token, famId, 'kid3@t.dev', 'kid');
  const acc = await app.call(
    'POST',
    `/v1/invites/${encodeURIComponent(kidInv.invite_code)}/accept`,
    { body: { display_name: 'Kid', agent_label: 'kid-agent' } },
  );
  assert.equal(acc.status, 201);
  const kidToken = acc.body.token as string;
  const denied = await app.call('POST', `/v1/families/${famId}/invites`, {
    token: kidToken,
    body: { email: 'someone@t.dev', role: 'kid' },
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'forbidden');
});

// 4. GET JSON (Accept header and .json suffix) -> 200 with the agent shape;
// no code; the page token appears ONLY in the absolute verify path (echoed
// back to its holder, who supplied it — a relative './verify' would resolve
// to /i/verify and drop the token segment). Masked hint present.
test('GET page as JSON returns the agent page shape without secrets', async () => {
  const app = makeApp();
  const { famId, token } = await bootstrapOwner(app, 'Page Fam 4', 'owner4@t.dev');
  const inv = await createInvite(app, token, famId, 'invitee4@t.dev', 'parent');
  const pageToken = pageTokenOf(inv.onboarding_url);

  for (const [label, path, extraHeaders] of [
    ['accept-header', `/i/${pageToken}`, { accept: 'application/json' }],
    ['dot-json', `/i/${pageToken}.json`, {}],
  ] as const) {
    const r = await app.call('GET', path, {
      headers: { ...ip(41).headers, ...extraHeaders },
    });
    assert.equal(r.status, 200, label);
    const b = r.body;
    assert.equal(b.page, 'invite', label);
    assert.equal(b.family_name, 'Page Fam 4', label);
    assert.equal(b.role, 'parent', label);
    assert.equal(b.email_hint, 'i***@t.dev', label);
    assert.ok(typeof b.expires_at === 'string', label);
    assert.equal(b.client.version, manifest.version, label);
    assert.equal(b.client.download_url, 'https://hub.test/v1/client/download/hub', label);
    // Install steps point at this server's download endpoints — no
    // GitHub release URLs remain in the user-facing flow.
    const stepsText = (b.install.steps as string[]).join('\n');
    assert.ok(stepsText.includes('https://hub.test/v1/client/download/hub'), label);
    assert.ok(stepsText.includes('https://hub.test/v1/client/download/hub.sigstore'), label);
    assert.ok(stepsText.includes('https://hub.test/v1/client/download/manifest.json'), label);
    assert.ok(!stepsText.includes('github.com/maddy13182/museFamilyconnector/releases'), label);
    assert.ok(typeof b.client.sha256 === 'string' && b.client.sha256.length > 0, label);
    assert.ok(Array.isArray(b.install.steps) && b.install.steps.length === 6, label);
    assert.ok(
      (b.install.steps as string[]).some((s) => s.includes('sigstore')),
      `${label}: install steps mention signature verification`,
    );
    assert.equal(b.verify.method, 'POST', label);
    assert.equal(b.verify.path, `/i/${pageToken}/verify`, label);
    const serialized = JSON.stringify(b);
    assert.ok(!serialized.includes(inv.invite_code), `${label}: must not leak the invite code`);
    const withoutPath = serialized.split(`/i/${pageToken}/verify`).join('');
    assert.ok(
      !withoutPath.includes(pageToken),
      `${label}: page token appears only in the verify path`,
    );
  }
});

// 5. GET HTML (no Accept header) -> 200 text/html with install steps and the
// masked hint, no code.
test('GET page as HTML renders install steps and the masked hint', async () => {
  const app = makeApp();
  const { famId, token } = await bootstrapOwner(app, 'Page Fam 5', 'owner5@t.dev');
  const inv = await createInvite(app, token, famId, 'invitee5@t.dev');
  const r = await app.call('GET', `/i/${pageTokenOf(inv.onboarding_url)}`, ip(51));
  assert.equal(r.status, 200);
  const html = r.body as string;
  assert.ok(html.includes('<!doctype html>'), 'is an HTML document');
  assert.ok(html.includes('i***@t.dev'), 'masked hint present');
  assert.ok(html.includes('sigstore'), 'install steps present');
  assert.ok(
    html.includes('https://hub.test/v1/client/download/hub'),
    'install steps use this server download endpoints',
  );
  assert.ok(
    !html.includes('github.com/maddy13182/museFamilyconnector/releases/download'),
    'no GitHub release download URLs in the user-facing flow',
  );
  const pt = pageTokenOf(inv.onboarding_url);
  assert.ok(
    html.includes(`fetch('/i/${pt}/verify'`),
    'verify form posts to the absolute verify path',
  );
  assert.ok(!html.includes(inv.invite_code), 'must not leak the invite code');
  const htmlWithoutFetch = html.split(`fetch('/i/${pt}/verify'`).join('');
  assert.ok(!htmlWithoutFetch.includes(pt), 'page token appears only in the form target');
});

// 6. Unknown token, used invite's page, expired invite's page -> identical
// 404 bodies.
test('unknown / used / expired pages all 404 identically', async () => {
  const app = makeApp();
  const { famId, token } = await bootstrapOwner(app, 'Page Fam 6', 'owner6@t.dev');

  const unknown = await app.call('GET', '/i/fhip_thisTokenWasNeverMinted00000000000000001', ip(61));
  assert.equal(unknown.status, 404);

  // Used: verify -> accept -> page is gone (self-destruct).
  const usedInv = await createInvite(app, token, famId, 'used6@t.dev');
  const usedToken = pageTokenOf(usedInv.onboarding_url);
  const verified = await app.call('POST', `/i/${usedToken}/verify`, {
    ...ip(62),
    body: { email: 'used6@t.dev' },
  });
  assert.equal(verified.status, 200);
  const acc = await app.call(
    'POST',
    `/v1/invites/${encodeURIComponent(verified.body.invite_code)}/accept`,
    { body: { display_name: 'Used', agent_label: 'used-agent' } },
  );
  assert.equal(acc.status, 201);
  const used = await app.call('GET', `/i/${usedToken}`, ip(63));
  assert.equal(used.status, 404);

  // Expired: backdate the invite; the page row is lazily deleted.
  const expInv = await createInvite(app, token, famId, 'exp6@t.dev');
  const expToken = pageTokenOf(expInv.onboarding_url);
  await app.db.queryAll(`UPDATE invites SET expires_at = ? WHERE email = ?`, [
    '2001-01-01T00:00:00.000Z',
    'exp6@t.dev',
  ]);
  const expired = await app.call('GET', `/i/${expToken}`, ip(64));
  assert.equal(expired.status, 404);
  const leftover = await app.db.queryOne(`SELECT 1 AS x FROM invite_pages LIMIT 1`, []);
  assert.equal(leftover, null, 'expired page row is lazily deleted');

  const bodies = [unknown, used, expired].map((r) => JSON.stringify(r.body));
  assert.equal(bodies[0], bodies[1], 'unknown vs used 404 bodies must be byte-identical');
  assert.equal(bodies[1], bodies[2], 'used vs expired 404 bodies must be byte-identical');
  assert.deepEqual(unknown.body, { error: { code: 'not_found', message: 'Not found' } });
});

// 7. POST verify: wrong email -> 403 generic; right email (mixed case +
// surrounding spaces) -> 200 with a fresh code + setup_command.
test('verify rejects wrong email, accepts normalized right email', async () => {
  const app = makeApp();
  const { famId, token } = await bootstrapOwner(app, 'Page Fam 7', 'owner7@t.dev');
  const inv = await createInvite(app, token, famId, 'invitee7@t.dev');
  const pageToken = pageTokenOf(inv.onboarding_url);

  const wrong = await app.call('POST', `/i/${pageToken}/verify`, {
    ...ip(71),
    body: { email: 'attacker@evil.dev' },
  });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.error.code, 'forbidden');
  assert.equal(wrong.body.error.message, 'This email does not match the invitation.');

  const right = await app.call('POST', `/i/${pageToken}/verify`, {
    ...ip(72),
    body: { email: '  Invitee7@T.Dev  ' },
  });
  assert.equal(right.status, 200);
  assert.match(right.body.invite_code, CODE_RE);
  assert.notEqual(right.body.invite_code, inv.invite_code, 'verify mints a fresh code');
  assert.equal(
    right.body.setup_command,
    `hub setup --server https://hub.test --invite ${right.body.invite_code}`,
  );
  assert.equal(right.body.expires_at, inv.expires_at, 'fresh code keeps the invite TTL');
});

// 8. Per-page attempt budget: 10+ rapid wrong emails -> 429 with backoff;
// after the cooldown the real email still succeeds (never a hard lock).
test('verify attempt budget backs off but never hard-locks', async () => {
  const app = makeApp();
  const { famId, token } = await bootstrapOwner(app, 'Page Fam 8', 'owner8@t.dev');
  const inv = await createInvite(app, token, famId, 'invitee8@t.dev');
  const pageToken = pageTokenOf(inv.onboarding_url);

  // 10 wrong guesses, each from a fresh IP so only the per-page budget bites.
  for (let i = 0; i < 10; i++) {
    const r = await app.call('POST', `/i/${pageToken}/verify`, {
      ...ip(80 + i),
      body: { email: `wrong${i}@evil.dev` },
    });
    assert.equal(r.status, 403, `wrong guess ${i + 1} should be 403`);
  }
  // 11th rapid guess -> 429 with Retry-After (per-page budget, not the IP bucket).
  const throttled = await app.call('POST', `/i/${pageToken}/verify`, {
    ...ip(90),
    body: { email: 'wrong10@evil.dev' },
  });
  assert.equal(throttled.status, 429);
  assert.equal(throttled.body.error.code, 'rate_limited');

  // The real email during backoff also waits (no oracle about correctness).
  const duringBackoff = await app.call('POST', `/i/${pageToken}/verify`, {
    ...ip(91),
    body: { email: 'invitee8@t.dev' },
  });
  assert.equal(duringBackoff.status, 429);

  // After the cooldown the real email succeeds: no hard lock. (Backdate
  // last_attempt_at past the 5-minute backoff AND the 1-hour decay.)
  const past = new Date(Date.now() - 61 * 60_000).toISOString();
  await app.db.queryAll(`UPDATE invite_pages SET last_attempt_at = ?`, [past]);
  const ok = await app.call('POST', `/i/${pageToken}/verify`, {
    ...ip(92),
    body: { email: 'invitee8@t.dev' },
  });
  assert.equal(ok.status, 200);
  assert.match(ok.body.invite_code, CODE_RE);
});

// 9. Full lifecycle: verify -> accept -> the page 404s (self-destruct),
// on both the HTML and verify shapes.
test('page self-destructs on invite accept', async () => {
  const app = makeApp();
  const { famId, token } = await bootstrapOwner(app, 'Page Fam 9', 'owner9@t.dev');
  const inv = await createInvite(app, token, famId, 'invitee9@t.dev');
  const pageToken = pageTokenOf(inv.onboarding_url);

  const before = await app.call('GET', `/i/${pageToken}`, ip(93));
  assert.equal(before.status, 200);
  const verified = await app.call('POST', `/i/${pageToken}/verify`, {
    ...ip(94),
    body: { email: 'invitee9@t.dev' },
  });
  assert.equal(verified.status, 200);
  const acc = await app.call(
    'POST',
    `/v1/invites/${encodeURIComponent(verified.body.invite_code)}/accept`,
    { body: { display_name: 'Nine', agent_label: 'nine-agent' } },
  );
  assert.equal(acc.status, 201);

  for (const [label, method, path, body] of [
    ['get', 'GET', `/i/${pageToken}`, undefined],
    ['get-json', 'GET', `/i/${pageToken}.json`, undefined],
    ['verify', 'POST', `/i/${pageToken}/verify`, { email: 'invitee9@t.dev' }],
  ] as const) {
    const r = await app.call(method, path, { ...ip(95), body });
    assert.equal(r.status, 404, `${label}: page must 404 after accept`);
    assert.deepEqual(r.body, { error: { code: 'not_found', message: 'Not found' } }, label);
  }
});

// 9b. HIGH-1 regression: two live codes for one email (the raw fallback +
// a verify-minted fresh code) must still yield exactly one member.
// Accepting one code consumes ALL sibling codes for that (family, email),
// so concurrent accepts of different codes cannot double-join.
test('accepting one code consumes sibling codes for the same email', async () => {
  const app = makeApp();
  const { famId, token } = await bootstrapOwner(app, 'Page Fam 9b', 'owner9b@t.dev');
  const inv = await createInvite(app, token, famId, 'invitee9b@t.dev');
  const pageToken = pageTokenOf(inv.onboarding_url);

  // Mint a second live code via email verify; the raw fallback stays live.
  const verified = await app.call('POST', `/i/${pageToken}/verify`, {
    ...ip(96),
    body: { email: 'invitee9b@t.dev' },
  });
  assert.equal(verified.status, 200);
  const freshCode = verified.body.invite_code as string;
  assert.match(freshCode, CODE_RE);
  assert.notEqual(freshCode, inv.invite_code);

  // Accept with the ORIGINAL code -> 201.
  const acc = await app.call(
    'POST',
    `/v1/invites/${encodeURIComponent(inv.invite_code)}/accept`,
    { body: { display_name: 'NineB', agent_label: 'nineb-agent' } },
  );
  assert.equal(acc.status, 201);

  // The sibling code is spent: exactly one member row, second accept 409s.
  const members = await app.db.queryAll(
    `SELECT id FROM members WHERE family_id = ? AND email = ?`,
    [famId, 'invitee9b@t.dev'],
  );
  assert.equal(members.length, 1);
  const second = await app.call(
    'POST',
    `/v1/invites/${encodeURIComponent(freshCode)}/accept`,
    { body: { display_name: 'NineB Two', agent_label: 'nineb-agent-2' } },
  );
  assert.equal(second.status, 409);
  const membersAfter = await app.db.queryAll(
    `SELECT id FROM members WHERE family_id = ? AND email = ?`,
    [famId, 'invitee9b@t.dev'],
  );
  assert.equal(membersAfter.length, 1);
});

// 10. redactPath covers /i/ shapes (unit).
test('redactPath redacts invite page paths', () => {
  assert.equal(redactPath('/i/fhip_secret/verify'), '/i/[redacted]');
  assert.equal(redactPath('/i/fhip_secret'), '/i/[redacted]');
  assert.equal(redactPath('/i/fhip_secret.json'), '/i/[redacted]');
  // Existing behavior untouched.
  assert.equal(redactPath('/v1/invites/abc123/accept'), '/v1/invites/[redacted]');
  assert.equal(redactPath('/v1/health'), '/v1/health');
});

// 11. The invite_page IP bucket: 11 rapid GETs -> 429 on the 11th.
test('invite pages are rate-limited per IP (10 per 10 min)', async () => {
  const app = makeApp();
  const { famId, token } = await bootstrapOwner(app, 'Page Fam 11', 'owner11@t.dev');
  const inv = await createInvite(app, token, famId, 'invitee11@t.dev');
  const path = `/i/${pageTokenOf(inv.onboarding_url)}`;
  const headers = { 'CF-Connecting-IP': '10.8.11.11' };
  for (let i = 0; i < 10; i++) {
    const r = await app.call('GET', path, { headers });
    assert.equal(r.status, 200, `attempt ${i + 1} should process`);
  }
  const limited = await app.call('GET', path, { headers });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, 'rate_limited');
});

// 12. HTML escaping: a family name containing markup is escaped.
test('HTML page escapes the family name', async () => {
  const app = makeApp();
  const evil = 'Evil <script>alert(1)</script> Family';
  const { famId, token } = await bootstrapOwner(app, evil, 'owner12@t.dev');
  const inv = await createInvite(app, token, famId, 'invitee12@t.dev');
  const r = await app.call('GET', `/i/${pageTokenOf(inv.onboarding_url)}`, ip(121));
  assert.equal(r.status, 200);
  const html = r.body as string;
  assert.ok(!html.includes('<script>alert(1)</script>'), 'raw markup must not appear');
  assert.ok(
    html.includes('Evil &lt;script&gt;alert(1)&lt;/script&gt; Family'),
    'escaped family name must appear',
  );
});

// 13. Public by design: no Bearer needed; authenticated callers get the
// same responses (no auth-dependent branches).
test('invite pages work without auth and identically with auth', async () => {
  const app = makeApp();
  const { famId, token } = await bootstrapOwner(app, 'Page Fam 13', 'owner13@t.dev');
  const invA = await createInvite(app, token, famId, 'invitee13a@t.dev');
  const invB = await createInvite(app, token, famId, 'invitee13b@t.dev');

  const anon = await app.call('GET', `/i/${pageTokenOf(invA.onboarding_url)}`, ip(131));
  assert.equal(anon.status, 200);
  const authed = await app.call('GET', `/i/${pageTokenOf(invA.onboarding_url)}`, {
    ...ip(132),
    token,
  });
  assert.equal(authed.status, 200);
  assert.deepEqual(authed.body, anon.body, 'auth must not change the response');

  const verifyAnon = await app.call('POST', `/i/${pageTokenOf(invA.onboarding_url)}/verify`, {
    ...ip(133),
    body: { email: 'invitee13a@t.dev' },
  });
  assert.equal(verifyAnon.status, 200);
  const verifyAuthed = await app.call('POST', `/i/${pageTokenOf(invB.onboarding_url)}/verify`, {
    ...ip(134),
    token,
    body: { email: 'invitee13b@t.dev' },
  });
  assert.equal(verifyAuthed.status, 200);
});
