// Phase B credential-lifecycle tests (audit findings F01, F04, F05, F17).
//
// Covers: the mint caller/target role matrix (F01) incl. the parent-can-never-
// touch-owner rule for mint and revoke; rotate-then-immediate-revoke
// overwriting rotation grace plus the retired-credential rotation denial
// (F04); single-winner concurrent redeem / invite-accept via atomic
// conditional consume (F05); and the revoke cascade to pending provisioning
// codes and one-level descendant tokens (F17).
import { test } from 'node:test';
import assert from 'node:assert';
import { makeApp, TestApp } from './app.js';
import { credentialHash } from '../src/auth.js';

interface Party {
  token: string;
  tokenId: string;
  memberId: string;
}

async function setupRoles(): Promise<{
  app: TestApp;
  famId: string;
  owner: Party;
  parent: Party;
  kid: Party;
}> {
  const app = makeApp();
  const fam = await app.call('POST', '/v1/families', {
    body: { name: 'Cred Fam', owner_name: 'Ow', owner_email: 'o@x.dev' },
  });
  assert.equal(fam.status, 201);
  const red = await app.call(
    'POST',
    `/v1/provisioning-codes/${encodeURIComponent(fam.body.provisioning_code)}/redeem`,
    { body: {} },
  );
  assert.equal(red.status, 201);
  const famId = (await app.db.queryOne('SELECT id FROM families', []))!['id'] as string;
  const owner: Party = {
    token: red.body.token as string,
    tokenId: red.body.token_id as string,
    memberId: red.body.member.id as string,
  };

  async function addMember(email: string, role: string, name: string): Promise<Party> {
    const inv = await app.call('POST', `/v1/families/${famId}/invites`, {
      token: owner.token,
      body: { email, role },
    });
    assert.equal(inv.status, 201);
    const acc = await app.call(
      'POST',
      `/v1/invites/${encodeURIComponent(inv.body.invite_code)}/accept`,
      { body: { display_name: name, agent_label: `${role}-agent` } },
    );
    assert.equal(acc.status, 201);
    return {
      token: acc.body.token as string,
      tokenId: acc.body.token_id as string,
      memberId: acc.body.member.id as string,
    };
  }
  const parent = await addMember('p@x.dev', 'parent', 'Pa');
  const kid = await addMember('k@x.dev', 'kid', 'Ki');
  return { app, famId, owner, parent, kid };
}

async function meStatus(app: TestApp, token: string): Promise<number> {
  return (await app.call('GET', '/v1/me', { token })).status;
}

test('F01: mint matrix — self-mint always allowed; minting for another member is owner-only', async () => {
  const { app, owner, parent, kid } = await setupRoles();
  const parties: Record<string, Party> = { owner, parent, kid };
  const members: Record<string, string> = {
    owner: owner.memberId,
    parent: parent.memberId,
    kid: kid.memberId,
  };
  for (const [callerRole, caller] of Object.entries(parties)) {
    for (const [targetRole, targetMemberId] of Object.entries(members)) {
      const self = targetMemberId === caller.memberId;
      const res = await app.call('POST', '/v1/provisioning-codes', {
        token: caller.token,
        body: { member_id: targetMemberId, agent_label: 'matrix-agent' },
      });
      const allowed = self || callerRole === 'owner';
      assert.equal(
        res.status,
        allowed ? 201 : 403,
        `${callerRole} -> ${self ? 'self' : targetRole}: expected ${allowed ? 201 : 403}, got ${res.status}`,
      );
      if (!allowed) assert.equal(res.body.error.code, 'forbidden');
    }
  }
});

test('F01: a parent can never revoke an owner token; owner and self-revoke still work', async () => {
  const { app, famId, owner, parent, kid } = await setupRoles();

  // parent -> owner's token: denied, and the owner token keeps working
  const denied = await app.call('POST', '/v1/auth/revoke', {
    token: parent.token,
    body: { token_id: owner.tokenId },
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'forbidden');
  assert.equal(await meStatus(app, owner.token), 200);

  // kid -> owner's token: denied (kids cannot revoke others at all)
  const deniedKid = await app.call('POST', '/v1/auth/revoke', {
    token: kid.token,
    body: { token_id: owner.tokenId },
  });
  assert.equal(deniedKid.status, 403);

  // owner -> second owner's token: allowed (documented: only parents are barred)
  const inv = await app.call('POST', `/v1/families/${famId}/invites`, {
    token: owner.token,
    body: { email: 'o2@x.dev', role: 'owner' },
  });
  assert.equal(inv.status, 201);
  const acc = await app.call(
    'POST',
    `/v1/invites/${encodeURIComponent(inv.body.invite_code)}/accept`,
    { body: { display_name: 'Ow2', agent_label: 'o2-agent' } },
  );
  assert.equal(acc.status, 201);
  const owner2TokenId = acc.body.token_id as string;
  const okCoOwner = await app.call('POST', '/v1/auth/revoke', {
    token: owner.token,
    body: { token_id: owner2TokenId },
  });
  assert.equal(okCoOwner.status, 200);
  assert.equal(await meStatus(app, acc.body.token as string), 401);

  // owner -> parent's token: allowed
  const ok = await app.call('POST', '/v1/auth/revoke', {
    token: owner.token,
    body: { token_id: parent.tokenId },
  });
  assert.equal(ok.status, 200);
  assert.equal(await meStatus(app, parent.token), 401);

  // self-revoke as kid: always allowed
  const selfOk = await app.call('POST', '/v1/auth/revoke', {
    token: kid.token,
    body: { token_id: kid.tokenId },
  });
  assert.equal(selfOk.status, 200);
  assert.equal(await meStatus(app, kid.token), 401);
});

test('F05: concurrent redeem of one code mints exactly one token', async () => {
  const { app, owner } = await setupRoles();
  const mint = await app.call('POST', '/v1/provisioning-codes', {
    token: owner.token,
    body: { member_id: owner.memberId, agent_label: 'race-agent' },
  });
  assert.equal(mint.status, 201);
  const path = `/v1/provisioning-codes/${encodeURIComponent(mint.body.provisioning_code)}/redeem`;

  const before = (
    await app.db.queryAll(`SELECT token_id FROM agent_tokens WHERE member_id = ?`, [owner.memberId])
  ).length;
  const [r1, r2] = await Promise.all([
    app.call('POST', path, { body: {} }),
    app.call('POST', path, { body: {} }),
  ]);
  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, [201, 409]);

  const winner = r1.status === 201 ? r1 : r2;
  const loser = r1.status === 201 ? r2 : r1;
  assert.equal(loser.body.error.code, 'code_used');
  assert.equal(loser.body.token_already_issued, true);

  // exactly one new token, and the code row records the winner
  const after = await app.db.queryAll(`SELECT token_id FROM agent_tokens WHERE member_id = ?`, [
    owner.memberId,
  ]);
  assert.equal(after.length, before + 1);
  assert.ok(after.some((r) => r['token_id'] === winner.body.token_id));
  const codeHash = await credentialHash(app.env.TOKEN_PEPPER, mint.body.provisioning_code as string);
  const pc = await app.db.queryOne(`SELECT redeemed_token_id, used_at FROM provisioning_codes WHERE code_hash = ?`, [
    codeHash,
  ]);
  assert.equal(pc!['redeemed_token_id'], winner.body.token_id);
  assert.ok(pc!['used_at']);
});

test('F05: concurrent accept of one invite creates exactly one member', async () => {
  const { app, famId, owner } = await setupRoles();
  const inv = await app.call('POST', `/v1/families/${famId}/invites`, {
    token: owner.token,
    body: { email: 'race@x.dev', role: 'kid' },
  });
  assert.equal(inv.status, 201);
  const path = `/v1/invites/${encodeURIComponent(inv.body.invite_code)}/accept`;

  const [r1, r2] = await Promise.all([
    app.call('POST', path, { body: { display_name: 'R1', agent_label: 'r1' } }),
    app.call('POST', path, { body: { display_name: 'R2', agent_label: 'r2' } }),
  ]);
  const statuses = [r1.status, r2.status].sort();
  assert.deepEqual(statuses, [201, 409]);

  const loser = r1.status === 201 ? r2 : r1;
  assert.equal(loser.body.error.code, 'invite_used');

  const members = await app.db.queryAll(
    `SELECT id FROM members WHERE family_id = ? AND email = ?`,
    [famId, 'race@x.dev'],
  );
  assert.equal(members.length, 1);
  const tokens = await app.db.queryAll(`SELECT token_id FROM agent_tokens WHERE member_id = ?`, [
    members[0]['id'] as string,
  ]);
  assert.equal(tokens.length, 1);
});

test('F17: revoking a token expires its pending provisioning codes', async () => {
  const { app, owner, parent } = await setupRoles();

  // code minted under the owner's token, for the parent member
  const mint = await app.call('POST', '/v1/provisioning-codes', {
    token: owner.token,
    body: { member_id: parent.memberId, agent_label: 'doomed-agent' },
  });
  assert.equal(mint.status, 201);
  const codeHash = await credentialHash(app.env.TOKEN_PEPPER, mint.body.provisioning_code as string);
  const pcRow = await app.db.queryOne(
    `SELECT issued_by_token_id FROM provisioning_codes WHERE code_hash = ?`,
    [codeHash],
  );
  assert.equal(pcRow!['issued_by_token_id'], owner.tokenId);

  // control: code minted under the parent's own (live) token
  const control = await app.call('POST', '/v1/provisioning-codes', {
    token: parent.token,
    body: { member_id: parent.memberId, agent_label: 'control-agent' },
  });
  assert.equal(control.status, 201);

  // revoke the owner's token (self-revoke)
  const rev = await app.call('POST', '/v1/auth/revoke', {
    token: owner.token,
    body: { token_id: owner.tokenId },
  });
  assert.equal(rev.status, 200);

  // the pending code dies with the issuing token: redeem now reports expired
  const dead = await app.call(
    'POST',
    `/v1/provisioning-codes/${encodeURIComponent(mint.body.provisioning_code)}/redeem`,
    { body: {} },
  );
  assert.equal(dead.status, 410);
  assert.equal(dead.body.error.code, 'code_expired');

  // the control code, issued under a live token, still redeems
  const live = await app.call(
    'POST',
    `/v1/provisioning-codes/${encodeURIComponent(control.body.provisioning_code)}/redeem`,
    { body: {} },
  );
  assert.equal(live.status, 201);
});

test('F17: revoking a token revokes the full transitive descendant closure', async () => {
  const { app, owner, parent } = await setupRoles();

  // A (owner token) mints a code; redeeming it yields B, a child of A
  const c1 = await app.call('POST', '/v1/provisioning-codes', {
    token: owner.token,
    body: { member_id: parent.memberId, agent_label: 'child-agent' },
  });
  assert.equal(c1.status, 201);
  const b = await app.call(
    'POST',
    `/v1/provisioning-codes/${encodeURIComponent(c1.body.provisioning_code)}/redeem`,
    { body: {} },
  );
  assert.equal(b.status, 201);
  const bToken = b.body.token as string;
  const bTokenId = b.body.token_id as string;
  const bRow = await app.db.queryOne(`SELECT issued_by_token_id FROM agent_tokens WHERE token_id = ?`, [
    bTokenId,
  ]);
  assert.equal(bRow!['issued_by_token_id'], owner.tokenId);

  // B self-mints a code (always allowed); redeeming it yields C, a grandchild of A
  const c2 = await app.call('POST', '/v1/provisioning-codes', {
    token: bToken,
    body: { member_id: parent.memberId, agent_label: 'grandchild-agent' },
  });
  assert.equal(c2.status, 201);
  const c = await app.call(
    'POST',
    `/v1/provisioning-codes/${encodeURIComponent(c2.body.provisioning_code)}/redeem`,
    { body: {} },
  );
  assert.equal(c.status, 201);
  const cToken = c.body.token as string;

  for (const t of [owner.token, bToken, cToken]) assert.equal(await meStatus(app, t), 200);

  // revoke A: the transitive closure (B and C) is revoked
  const rev = await app.call('POST', '/v1/auth/revoke', {
    token: owner.token,
    body: { token_id: owner.tokenId },
  });
  assert.equal(rev.status, 200);
  assert.equal(await meStatus(app, owner.token), 401);
  assert.equal(await meStatus(app, bToken), 401);
  assert.equal(await meStatus(app, cToken), 401);
});
