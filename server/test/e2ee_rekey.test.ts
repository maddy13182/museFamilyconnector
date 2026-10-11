// E2EE Phase 4 — membership changes + re-keying (server side).
//
// Covers: DELETE /v1/topics/:tid/participants/:mid access control (caller
// must be a participant; owner/parent role only — the same 403 rule as the
// topic invite endpoint), 400 on non-participant target and on removing the
// last participant, the `member_left` system entry, the removed member's
// subsequent 403, envelopes no longer postable for a removed member, and
// the new client-postable plaintext system kinds (key_rotated, key_request,
// pending_key_distribution) on POST /v1/topics/:tid/entries.
import { test } from 'node:test';
import assert from 'node:assert';
import { makeApp, TestApp } from './app.js';

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

async function makeTopic(app: TestApp, token: string, e2ee: number): Promise<string> {
  const topic = await app.call('POST', '/v1/topics', {
    token,
    body: {
      subject: e2ee ? b64(64) : 'plain subject',
      kind: 'group',
      participant_member_ids: [],
      e2ee,
      // secfix F1: E2EE creation carries the creator's key_id.
      ...(e2ee === 1 ? { initial_key_id: hex(16) } : {}),
    },
  });
  assert.equal(topic.status, 201);
  return topic.body.topic.id as string;
}

async function inviteToTopic(app: TestApp, token: string, tid: string, memberIds: string[]): Promise<void> {
  const res = await app.call('POST', `/v1/topics/${tid}/invite`, {
    token,
    body: { member_ids: memberIds, history_from: 'full' },
  });
  assert.equal(res.status, 200);
}

async function envelopeBody(over: Record<string, unknown>): Promise<Record<string, unknown>> {
  return { member_id: '', agent_label: '', key_id: hex(16), envelope: b64(80), ...over };
}

// ---------------------------------------------------------------------------
// DELETE /v1/topics/:tid/participants/:mid
// ---------------------------------------------------------------------------

test('remove participant: non-participant caller is 403; unknown topic is 404', async () => {
  const app = makeApp();
  const { famId, owner } = await setupKeyedFamily(app, 'RekeyFam1');
  const tid = await makeTopic(app, owner.token, 1);
  const outsider = await addMember(app, famId, owner.token, 'out@r.dev', 'parent', 'Outsider');

  const res = await app.call('DELETE', `/v1/topics/${tid}/participants/${owner.memberId}`, {
    token: outsider.token,
  });
  assert.equal(res.status, 403);

  const missing = await app.call('DELETE', `/v1/topics/nope-not-here/participants/${owner.memberId}`, {
    token: owner.token,
  });
  assert.equal(missing.status, 404);
});

test('remove participant: kid role cannot remove (same 403 rule as invite)', async () => {
  const app = makeApp();
  const { famId, owner } = await setupKeyedFamily(app, 'RekeyFam2');
  const tid = await makeTopic(app, owner.token, 1);
  const kid = await addMember(app, famId, owner.token, 'kid@r.dev', 'kid', 'Kiddo');
  const parent = await addMember(app, famId, owner.token, 'par@r.dev', 'parent', 'Par');
  await inviteToTopic(app, owner.token, tid, [kid.memberId, parent.memberId]);

  // Kid is a participant but lacks the owner/parent role: 403, unchanged rules.
  const res = await app.call('DELETE', `/v1/topics/${tid}/participants/${parent.memberId}`, {
    token: kid.token,
  });
  assert.equal(res.status, 403);

  // Parent role can remove.
  const ok = await app.call('DELETE', `/v1/topics/${tid}/participants/${kid.memberId}`, {
    token: parent.token,
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.removed, kid.memberId);
});

test('remove participant: 400 when the target is not a participant', async () => {
  const app = makeApp();
  const { famId, owner } = await setupKeyedFamily(app, 'RekeyFam3');
  const tid = await makeTopic(app, owner.token, 1);
  const outsider = await addMember(app, famId, owner.token, 'out2@r.dev', 'parent', 'Outsider2');

  const res = await app.call('DELETE', `/v1/topics/${tid}/participants/${outsider.memberId}`, {
    token: owner.token,
  });
  assert.equal(res.status, 400);
});

test('remove participant: cannot remove the last participant', async () => {
  const app = makeApp();
  const { owner } = await setupKeyedFamily(app, 'RekeyFam4');
  const tid = await makeTopic(app, owner.token, 1);

  const res = await app.call('DELETE', `/v1/topics/${tid}/participants/${owner.memberId}`, {
    token: owner.token,
  });
  assert.equal(res.status, 400);
});

test('remove participant: row removed, member_left entry appended, removed member gets 403 after', async () => {
  const app = makeApp();
  const { famId, owner } = await setupKeyedFamily(app, 'RekeyFam5');
  const tid = await makeTopic(app, owner.token, 0); // plaintext topic: removal is membership-only
  const bee = await addMember(app, famId, owner.token, 'bee@r.dev', 'parent', 'Bee');
  await inviteToTopic(app, owner.token, tid, [bee.memberId]);

  const res = await app.call('DELETE', `/v1/topics/${tid}/participants/${bee.memberId}`, {
    token: owner.token,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.removed, bee.memberId);

  // Participant row is gone.
  const detail = await app.call('GET', `/v1/topics/${tid}`, { token: owner.token });
  assert.equal(detail.status, 200);
  const ids = (detail.body.participants as any[]).map((p) => p.member_id);
  assert.ok(!ids.includes(bee.memberId), 'removed member still listed as participant');

  // A plaintext member_left system entry names the removed member.
  const hist = await app.call('GET', `/v1/topics/${tid}/history`, { token: owner.token });
  assert.equal(hist.status, 200);
  const left = (hist.body.entries as any[]).filter((e) => e.kind === 'member_left');
  assert.equal(left.length, 1);
  assert.ok((left[0].body as string).includes('Bee'), 'member_left body names the member');
  const leftData = left[0].data as { member_id?: string };
  assert.equal(leftData.member_id, bee.memberId);

  // The removed member can no longer read the topic.
  const gone = await app.call('GET', `/v1/topics/${tid}`, { token: bee.token });
  assert.equal(gone.status, 403);
});

test('remove participant: self-leave wording differs from removal', async () => {
  const app = makeApp();
  const { famId, owner } = await setupKeyedFamily(app, 'RekeyFam6');
  const tid = await makeTopic(app, owner.token, 0);
  const bee = await addMember(app, famId, owner.token, 'bee2@r.dev', 'parent', 'BeeTwo');
  await inviteToTopic(app, owner.token, tid, [bee.memberId]);

  const res = await app.call('DELETE', `/v1/topics/${tid}/participants/${bee.memberId}`, {
    token: bee.token,
  });
  assert.equal(res.status, 200);

  const hist = await app.call('GET', `/v1/topics/${tid}/history`, { token: owner.token });
  const left = (hist.body.entries as any[]).filter((e) => e.kind === 'member_left');
  assert.equal(left.length, 1);
  assert.ok((left[0].body as string).includes('left the topic'), 'self-leave wording');
});

test('envelope POST for a removed member is 400 (target must be a current participant)', async () => {
  const app = makeApp();
  const { famId, owner } = await setupKeyedFamily(app, 'RekeyFam7');
  const tid = await makeTopic(app, owner.token, 1);
  const bee = await addMember(app, famId, owner.token, 'bee3@r.dev', 'parent', 'BeeThree');
  await inviteToTopic(app, owner.token, tid, [bee.memberId]);

  const rem = await app.call('DELETE', `/v1/topics/${tid}/participants/${bee.memberId}`, {
    token: owner.token,
  });
  assert.equal(rem.status, 200);

  // Sealing a fresh envelope for the removed member is rejected: re-key
  // envelopes can only address current participants.
  const env = await app.call('POST', `/v1/topics/${tid}/envelopes`, {
      token: owner.token,
    body: await envelopeBody({ member_id: bee.memberId, agent_label: 'beethree-agent' }),
  });
  assert.equal(env.status, 400);
});

// ---------------------------------------------------------------------------
// POST /v1/topics/:tid/entries — Phase 4 plaintext system kinds
// ---------------------------------------------------------------------------

test('entries POST: key_rotated / key_request / pending_key_distribution are accepted as plaintext', async () => {
  const app = makeApp();
  const { owner } = await setupKeyedFamily(app, 'RekeyFam8');
  const tid = await makeTopic(app, owner.token, 1);

  for (const kind of ['key_rotated', 'key_request', 'pending_key_distribution']) {
    const res = await app.call('POST', `/v1/topics/${tid}/entries`, {
    token: owner.token,
      body: {
        kind,
        body: `[${kind}] plaintext system notice`,
        data: JSON.stringify({ key_id: hex(16) }),
      },
    });
    assert.equal(res.status, 201, `kind ${kind} rejected`);
    assert.equal(res.body.entry.kind, kind);
    // Stored as-is: plaintext, never transformed.
    assert.equal(res.body.entry.body, `[${kind}] plaintext system notice`);
  }

  // Unknown kinds are still rejected.
  const bad = await app.call('POST', `/v1/topics/${tid}/entries`, {
    token: owner.token,
    body: { kind: 'key_frobnicated', body: 'nope' },
  });
  assert.equal(bad.status, 400);
});

test('entries POST: system kinds require participation (403 otherwise)', async () => {
  const app = makeApp();
  const { famId, owner } = await setupKeyedFamily(app, 'RekeyFam9');
  const tid = await makeTopic(app, owner.token, 1);
  const outsider = await addMember(app, famId, owner.token, 'out3@r.dev', 'parent', 'Outsider3');

  const res = await app.call('POST', `/v1/topics/${tid}/entries`, {
    token: outsider.token,
    body: { kind: 'key_rotated', body: '[key_rotated] forged' },
  });
  assert.equal(res.status, 403);
});
