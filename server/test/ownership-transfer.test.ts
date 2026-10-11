// Ownership transfer (offer -> accept): two-phase, never forced.
// Covers: happy path in both on_complete modes, 403s, 409 on double
// pending, 410 on expired, cancel, GET visibility, idempotency, and the
// atomic owner swap (a circle never has zero owners).
import { test } from 'node:test';
import assert from 'node:assert';
import { makeApp, TestApp } from './app.js';

interface Setup {
  app: TestApp;
  famId: string;
  ownerToken: string;
  ownerMemberId: string;
  parentToken: string;
  parentMemberId: string;
  kidToken: string;
  kidMemberId: string;
}

async function inviteAccept(
  app: TestApp,
  famId: string,
  inviterToken: string,
  email: string,
  role: string,
  displayName: string,
) {
  const inv = await app.call('POST', `/v1/families/${famId}/invites`, {
    token: inviterToken,
    body: { email, role },
  });
  assert.equal(inv.status, 201, `invite create failed: ${JSON.stringify(inv.body)}`);
  const acc = await app.call(
    'POST',
    `/v1/invites/${encodeURIComponent(inv.body.invite_code)}/accept`,
    { body: { display_name: displayName, agent_label: `${displayName.toLowerCase()}-agent` } },
  );
  assert.equal(acc.status, 201, `invite accept failed: ${JSON.stringify(acc.body)}`);
  return { token: acc.body.token as string, memberId: acc.body.member.id as string };
}

async function setup(): Promise<Setup> {
  const app = makeApp();
  const fam = await app.call('POST', '/v1/families', {
    body: { name: 'Transfer Fam', owner_name: 'Mahesh', owner_email: 'mahesh@t.dev' },
  });
  assert.equal(fam.status, 201);
  const famId = fam.body.family.id as string;
  const red = await app.call(
    'POST',
    `/v1/provisioning-codes/${encodeURIComponent(fam.body.provisioning_code)}/redeem`,
    { body: {} },
  );
  assert.equal(red.status, 201);
  const parent = await inviteAccept(app, famId, red.body.token, 'lakshmi@t.dev', 'parent', 'Lakshmi');
  const kid = await inviteAccept(app, famId, red.body.token, 'harshika@t.dev', 'kid', 'Harshika');
  return {
    app,
    famId,
    ownerToken: red.body.token as string,
    ownerMemberId: fam.body.member.id as string,
    parentToken: parent.token,
    parentMemberId: parent.memberId,
    kidToken: kid.token,
    kidMemberId: kid.memberId,
  };
}

function ownersOf(app: TestApp, famId: string) {
  return app.db.queryAll(
    `SELECT id FROM members WHERE family_id = ? AND role = 'owner'`,
    [famId],
  );
}

test('happy path (default remove): offer -> accept swaps ownership atomically', async () => {
  const { app, famId, ownerToken, ownerMemberId, parentToken, parentMemberId, kidToken } = await setup();
  assert.equal((await ownersOf(app, famId)).length, 1, 'exactly one owner before');

  const offer = await app.call('POST', `/v1/families/${famId}/transfer`, {
    token: ownerToken,
    body: { to_member_id: parentMemberId },
  });
  assert.equal(offer.status, 201);
  const t = offer.body.transfer;
  assert.equal(t.status, 'pending');
  assert.equal(t.from_member_id, ownerMemberId);
  assert.equal(t.to_member_id, parentMemberId);
  assert.equal(t.on_complete, 'remove', 'default on_complete is remove');
  assert.ok(t.expires_at > t.created_at, '7-day expiry is in the future');

  // GET exposes the pending offer.
  const get = await app.call('GET', `/v1/families/${famId}/transfer`, { token: parentToken });
  assert.equal(get.status, 200);
  assert.equal(get.body.transfer.id, t.id);

  // The offering owner cannot accept their own offer; neither can another member.
  for (const tok of [ownerToken, kidToken]) {
    const denied = await app.call('POST', `/v1/families/${famId}/transfer/accept`, { token: tok });
    assert.equal(denied.status, 403, 'accept must be 403 for non-recipients');
  }

  // Recipient accepts: promote first, demote/remove old owner — one batch.
  const acc = await app.call('POST', `/v1/families/${famId}/transfer/accept`, {
    token: parentToken,
  });
  assert.equal(acc.status, 200);
  assert.equal(acc.body.transfer.status, 'completed');
  assert.equal(acc.body.new_owner.id, parentMemberId);
  assert.equal(acc.body.previous_owner.id, ownerMemberId);
  assert.equal(acc.body.previous_owner.role, 'removed');

  // Atomicity checks: exactly one owner (never zero, never two), previous
  // owner stripped of the role, their tokens revoked, recipient now owner.
  const owners = await ownersOf(app, famId);
  assert.equal(owners.length, 1);
  assert.equal(owners[0]['id'], parentMemberId);
  const retained = await app.db.queryOne(`SELECT role FROM members WHERE id = ?`, [ownerMemberId]);
  assert.ok(retained, 'member row is retained for audit history (FKs forbid a physical delete)');
  assert.equal(retained?.['role'], 'parent', 'previous owner no longer holds the owner role');
  const tokenRow = await app.db.queryOne(
    `SELECT revoked_at FROM agent_tokens WHERE member_id = ?`,
    [ownerMemberId],
  );
  assert.ok(tokenRow && tokenRow['revoked_at'], 'old owner tokens are revoked');

  // The old owner's session is over.
  const me = await app.call('GET', '/v1/me', { token: ownerToken });
  assert.equal(me.status, 401, 'removed owner token is rejected');

  // New owner can act as owner (offer another transfer, then cancel it).
  const kidRow = await app.db.queryOne(`SELECT id FROM members WHERE family_id = ? AND email = ?`, [
    famId,
    'harshika@t.dev',
  ]);
  const offer2 = await app.call('POST', `/v1/families/${famId}/transfer`, {
    token: parentToken,
    body: { to_member_id: kidRow?.['id'] as string, on_complete: 'demote' },
  });
  assert.equal(offer2.status, 201, 'new owner can initiate a transfer');
  const cancel = await app.call('POST', `/v1/families/${famId}/transfer/cancel`, {
    token: parentToken,
  });
  assert.equal(cancel.status, 200);
  assert.equal(cancel.body.transfer.status, 'cancelled');
  const afterCancel = await app.call('GET', `/v1/families/${famId}/transfer`, { token: parentToken });
  assert.equal(afterCancel.body.transfer, null, 'no pending transfer after cancel');
});

test('on_complete=demote: previous owner keeps a parent row', async () => {
  const { app, famId, ownerToken, ownerMemberId, parentToken, parentMemberId } = await setup();
  const offer = await app.call('POST', `/v1/families/${famId}/transfer`, {
    token: ownerToken,
    body: { to_member_id: parentMemberId, on_complete: 'demote' },
  });
  assert.equal(offer.status, 201);
  const acc = await app.call('POST', `/v1/families/${famId}/transfer/accept`, {
    token: parentToken,
  });
  assert.equal(acc.status, 200);
  assert.equal(acc.body.previous_owner.role, 'parent');

  const owners = await ownersOf(app, famId);
  assert.equal(owners.length, 1, 'never zero owners, never two');
  assert.equal(owners[0]['id'], parentMemberId);
  const demoted = await app.db.queryOne(`SELECT role FROM members WHERE id = ?`, [ownerMemberId]);
  assert.equal(demoted?.['role'], 'parent', 'demoted owner row survives as parent');
  // Demoted owner's token still works (they are still a member).
  const me = await app.call('GET', '/v1/me', { token: ownerToken });
  assert.equal(me.status, 200);
});

test('non-owner cannot initiate; target rules enforced', async () => {
  const { app, famId, ownerToken, ownerMemberId, parentToken, kidToken, parentMemberId } = await setup();

  const asParent = await app.call('POST', `/v1/families/${famId}/transfer`, {
    token: parentToken,
    body: { to_member_id: parentMemberId },
  });
  assert.equal(asParent.status, 403, 'parent cannot initiate');

  const asKid = await app.call('POST', `/v1/families/${famId}/transfer`, {
    token: kidToken,
    body: { to_member_id: parentMemberId },
  });
  assert.equal(asKid.status, 403, 'kid cannot initiate');

  // Target not in this circle.
  const ghost = await app.call('POST', `/v1/families/${famId}/transfer`, {
    token: ownerToken,
    body: { to_member_id: 'm_nonexistent' },
  });
  assert.equal(ghost.status, 404);

  // Target already an owner (i.e. the caller themself).
  const self = await app.call('POST', `/v1/families/${famId}/transfer`, {
    token: ownerToken,
    body: { to_member_id: ownerMemberId },
  });
  assert.equal(self.status, 422);
  assert.equal(self.body.error.code, 'already_owner');

  // Bad on_complete value.
  const bad = await app.call('POST', `/v1/families/${famId}/transfer`, {
    token: ownerToken,
    body: { to_member_id: parentMemberId, on_complete: 'promote' },
  });
  assert.equal(bad.status, 400);

  // Cross-circle: fid that is not the caller's circle.
  const other = await app.call('POST', '/v1/families/fam_other/transfer', {
    token: ownerToken,
    body: { to_member_id: parentMemberId },
  });
  assert.equal(other.status, 404);
});

test('exactly one pending transfer per circle (409)', async () => {
  const { app, famId, ownerToken, parentMemberId, kidMemberId } = await setup();
  const first = await app.call('POST', `/v1/families/${famId}/transfer`, {
    token: ownerToken,
    body: { to_member_id: parentMemberId },
  });
  assert.equal(first.status, 201);
  const second = await app.call('POST', `/v1/families/${famId}/transfer`, {
    token: ownerToken,
    body: { to_member_id: kidMemberId },
  });
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, 'transfer_pending');
});

test('accept with no pending transfer is 404; cancel with none is 404', async () => {
  const { app, famId, ownerToken, parentToken } = await setup();
  const acc = await app.call('POST', `/v1/families/${famId}/transfer/accept`, {
    token: parentToken,
  });
  assert.equal(acc.status, 404);
  const can = await app.call('POST', `/v1/families/${famId}/transfer/cancel`, {
    token: ownerToken,
  });
  assert.equal(can.status, 404);
  const get = await app.call('GET', `/v1/families/${famId}/transfer`, { token: parentToken });
  assert.equal(get.status, 200);
  assert.equal(get.body.transfer, null);
});

test('expired transfer cannot be accepted (410) and is marked cancelled', async () => {
  const { app, famId, ownerToken, parentToken, parentMemberId } = await setup();
  const offer = await app.call('POST', `/v1/families/${famId}/transfer`, {
    token: ownerToken,
    body: { to_member_id: parentMemberId },
  });
  assert.equal(offer.status, 201);
  // Force expiry in the past (direct DB access; only a test shortcut).
  await app.db.execAtomically([
    {
      sql: `UPDATE ownership_transfers SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`,
      params: [offer.body.transfer.id as string],
    },
  ]);
  const acc = await app.call('POST', `/v1/families/${famId}/transfer/accept`, {
    token: parentToken,
  });
  assert.equal(acc.status, 410);
  assert.equal(acc.body.error.code, 'transfer_expired');
  const row = await app.db.queryOne(`SELECT status FROM ownership_transfers WHERE id = ?`, [
    offer.body.transfer.id as string,
  ]);
  assert.equal(row?.['status'], 'cancelled', 'expired transfer is marked cancelled');
  // Roles unchanged; still exactly one owner.
  const owners = await ownersOf(app, famId);
  assert.equal(owners.length, 1);
  // A fresh offer is allowed now that the expired one is out of the way.
  const again = await app.call('POST', `/v1/families/${famId}/transfer`, {
    token: ownerToken,
    body: { to_member_id: parentMemberId },
  });
  assert.equal(again.status, 201, 'expired offer does not block a new one');
});

test('non-owner cannot cancel; recipient cannot cancel', async () => {
  const { app, famId, ownerToken, parentToken, parentMemberId } = await setup();
  const offer = await app.call('POST', `/v1/families/${famId}/transfer`, {
    token: ownerToken,
    body: { to_member_id: parentMemberId },
  });
  assert.equal(offer.status, 201);
  const byRecipient = await app.call('POST', `/v1/families/${famId}/transfer/cancel`, {
    token: parentToken,
  });
  assert.equal(byRecipient.status, 403);
  // The offer survives the unauthorized cancel.
  const get = await app.call('GET', `/v1/families/${famId}/transfer`, { token: ownerToken });
  assert.equal(get.body.transfer.status, 'pending');
  const byOwner = await app.call('POST', `/v1/families/${famId}/transfer/cancel`, {
    token: ownerToken,
  });
  assert.equal(byOwner.status, 200);
});

test('GET: any circle member may read; outsiders get 404', async () => {
  const { app, famId, ownerToken, kidToken, parentMemberId } = await setup();
  await app.call('POST', `/v1/families/${famId}/transfer`, {
    token: ownerToken,
    body: { to_member_id: parentMemberId },
  });
  // Kid (plain member) can read the pending offer.
  const asKid = await app.call('GET', `/v1/families/${famId}/transfer`, { token: kidToken });
  assert.equal(asKid.status, 200);
  assert.equal(asKid.body.transfer.status, 'pending');
  // Unauthenticated.
  const noAuth = await app.call('GET', `/v1/families/${famId}/transfer`);
  assert.equal(noAuth.status, 401);
  // Member of a different circle cannot see this circle's transfer.
  const other = makeApp();
  const famB = await other.call('POST', '/v1/families', {
    body: { name: 'Other Fam', owner_name: 'Stranger', owner_email: 's@o.dev' },
  });
  const red = await other.call(
    'POST',
    `/v1/provisioning-codes/${encodeURIComponent(famB.body.provisioning_code)}/redeem`,
    { body: {} },
  );
  const foreign = await other.call('GET', `/v1/families/${famId}/transfer`, {
    token: red.body.token as string,
  });
  assert.equal(foreign.status, 404);
});

test('idempotency-key dedupes the offer', async () => {
  const { app, famId, ownerToken, parentMemberId } = await setup();
  const hdr = { headers: { 'Idempotency-Key': 'transfer-key-1' } };
  const first = await app.call('POST', `/v1/families/${famId}/transfer`, {
    token: ownerToken,
    ...hdr,
    body: { to_member_id: parentMemberId },
  });
  assert.equal(first.status, 201);
  const retry = await app.call('POST', `/v1/families/${famId}/transfer`, {
    token: ownerToken,
    ...hdr,
    body: { to_member_id: parentMemberId },
  });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.deduped, true);
  assert.equal(retry.body.transfer.id, first.body.transfer.id, 'same transfer, not a duplicate');
  const pending = await app.db.queryAll(
    `SELECT id FROM ownership_transfers WHERE family_id = ? AND status = 'pending'`,
    [famId],
  );
  assert.equal(pending.length, 1, 'still exactly one pending transfer');
});

test('owner can still act after failed accept by wrong member (roles unchanged)', async () => {
  const { app, famId, ownerToken, kidToken, parentToken, parentMemberId } = await setup();
  await app.call('POST', `/v1/families/${famId}/transfer`, {
    token: ownerToken,
    body: { to_member_id: parentMemberId },
  });
  const wrong = await app.call('POST', `/v1/families/${famId}/transfer/accept`, {
    token: kidToken,
  });
  assert.equal(wrong.status, 403);
  const owners = await ownersOf(app, famId);
  assert.equal(owners.length, 1);
  const pending = await app.call('GET', `/v1/families/${famId}/transfer`, { token: parentToken });
  assert.equal(pending.body.transfer.status, 'pending', 'offer survives a rejected accept');
  const acc = await app.call('POST', `/v1/families/${famId}/transfer/accept`, {
    token: parentToken,
  });
  assert.equal(acc.status, 200);
});
