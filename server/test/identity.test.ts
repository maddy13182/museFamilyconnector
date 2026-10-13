// Phase D (audit F02): identity principals.
//
// Cross-circle negative tests: a member in circle A whose email COLLIDES
// with circle B's owner email must NOT see B's metadata, must NOT pass the
// hub-owner check, and must NOT mint credentials for B's members.
// Plus migration 0005 backfill correctness: distinct emails -> distinct
// principals; the same email across circles -> one principal (the
// migration's documented trust assumption, preserving legitimate linking
// that existed before principals did).
import { test } from 'node:test';
import assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeApp, TestApp } from './app.js';
import { sqliteClient } from './sqlite.js';

async function bootstrap(app: TestApp, name: string, ownerName: string, email: string) {
  const fam = await app.call('POST', '/v1/families', {
    body: { name, owner_name: ownerName, owner_email: email },
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
  assert.equal(inv.status, 201);
  const acc = await app.call(
    'POST',
    `/v1/invites/${encodeURIComponent(inv.body.invite_code)}/accept`,
    { body: { display_name: displayName, agent_label: `${displayName.toLowerCase()}-agent` } },
  );
  assert.equal(acc.status, 201);
  return { token: acc.body.token as string, memberId: acc.body.member.id as string };
}

interface Setup {
  app: TestApp;
  ownerToken: string; // Mahesh, owner of Fam A
  kidToken: string; // Harshika, kid of Fam A
  strangerToken: string; // Stranger, owner of Fam B
  famA: string;
  famB: string;
}

async function lockedSetup(): Promise<Setup> {
  const app = makeApp();
  const a = await bootstrap(app, 'Fam A', 'Mahesh', 'mahesh@a.dev');
  const b = await bootstrap(app, 'Fam B', 'Stranger', 's@b.dev');
  const kid = await inviteAccept(app, a.famId, a.token, 'harshika@a.dev', 'kid', 'Harshika');
  app.env.SETUP_LOCKED = '1';
  return {
    app,
    ownerToken: a.token,
    kidToken: kid.token,
    strangerToken: b.token,
    famA: a.famId,
    famB: b.famId,
  };
}

test('colliding email in circle A grants no hub-owner power over circle B', async () => {
  const { app, ownerToken, strangerToken, famA, famB } = await lockedSetup();
  // The attack (pre-F02): the owner of A invites B's owner email into A as a
  // kid and an accomplice accepts. The email-string join in isHubOwner then
  // treated the accomplice as a hub owner: circle B's metadata leaked via
  // GET /v1/families and circles could be created while setup was locked.
  const attacker = await inviteAccept(app, famA, ownerToken, 's@b.dev', 'kid', 'Impostor');

  // 1. The new row gets a FRESH principal even though the email collides.
  const rows = await app.db.queryAll(
    `SELECT id, family_id, principal_id FROM members WHERE email = 's@b.dev' ORDER BY family_id`,
  );
  assert.equal(rows.length, 2);
  assert.ok(rows[0]['principal_id']);
  assert.ok(rows[1]['principal_id']);
  assert.notEqual(
    rows[0]['principal_id'],
    rows[1]['principal_id'],
    'colliding email must not share a principal',
  );

  // 2. Circle listing: sees only A, never B's metadata.
  const list = await app.call('GET', '/v1/families', { token: attacker.token });
  assert.equal(list.status, 200);
  assert.deepEqual(
    list.body.families.map((f: any) => f.id),
    [famA],
  );

  // 3. Hub-owner circle creation while locked: denied.
  const create = await app.call('POST', '/v1/families', {
    token: attacker.token,
    body: { name: 'Evil Circle' },
  });
  assert.equal(create.status, 403);
  assert.equal(create.body.error.code, 'forbidden');

  // 4. Minting a provisioning code for B's owner member: the member is not
  // in the attacker's circle — 404 with no existence leak.
  const bMembers = await app.call('GET', '/v1/members', { token: strangerToken });
  assert.equal(bMembers.status, 200);
  const bOwner = bMembers.body.members.find((m: any) => m.role === 'owner');
  assert.ok(bOwner);
  const mint = await app.call('POST', '/v1/provisioning-codes', {
    token: attacker.token,
    body: { member_id: bOwner.id, agent_label: 'evil-agent' },
  });
  assert.equal(mint.status, 404);

  // Sanity: the real owners are unaffected — B's owner still lists B and can
  // still create circles while locked.
  const bList = await app.call('GET', '/v1/families', { token: strangerToken });
  assert.equal(bList.status, 200);
  assert.deepEqual(
    bList.body.families.map((f: any) => f.id),
    [famB],
  );
  const okCreate = await app.call('POST', '/v1/families', {
    token: strangerToken,
    body: { name: 'Legit Circle' },
  });
  assert.equal(okCreate.status, 201);
});

test('verified owner keeps cross-circle visibility via locked creation', async () => {
  const { app, ownerToken, kidToken, famA, famB } = await lockedSetup();
  const created = await app.call('POST', '/v1/families', {
    token: ownerToken,
    body: { name: 'Gym Circle' },
  });
  assert.equal(created.status, 201);

  // The new member row inherits the caller's verified principal, so the
  // caller's token lists the new circle alongside the old one.
  const linked = await app.db.queryAll(
    `SELECT family_id, principal_id FROM members WHERE email = 'mahesh@a.dev'`,
  );
  assert.equal(linked.length, 2);
  assert.equal(linked[0]['principal_id'], linked[1]['principal_id']);

  const list = await app.call('GET', '/v1/families', { token: ownerToken });
  assert.equal(list.status, 200);
  const ids = list.body.families.map((f: any) => f.id);
  assert.ok(ids.includes(famA), 'still sees Fam A');
  assert.ok(ids.includes(created.body.id), 'sees the new circle');
  assert.ok(!ids.includes(famB), 'does not see Stranger family B');
  const gym = list.body.families.find((f: any) => f.id === created.body.id);
  assert.equal(gym.my_role, 'owner');

  // A non-owner in A sees only A and cannot create circles while locked.
  const kidList = await app.call('GET', '/v1/families', { token: kidToken });
  assert.deepEqual(
    kidList.body.families.map((f: any) => f.id),
    [famA],
  );
  const kidCreate = await app.call('POST', '/v1/families', {
    token: kidToken,
    body: { name: 'Nope' },
  });
  assert.equal(kidCreate.status, 403);
});

// --- Migration 0005 backfill correctness ---

function migrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/test -> dist/migrations (copied by the test script).
  return join(here, '..', 'migrations');
}

/** Apply migrations in filename order, stopping after maxFile (inclusive). */
function applyUpTo(db: DatabaseSync, maxFile: string): void {
  const dir = migrationsDir();
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const f of files) {
    if (f > maxFile) break;
    db.exec(readFileSync(join(dir, f), 'utf8'));
  }
}

function fixtureDbThrough0004(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  applyUpTo(db, '0004_credential_lineage.sql');
  // Fixture: two circles. 'mahesh@a.dev' has a member row in BOTH (the
  // pre-migration legitimate-linking case); the other emails are distinct.
  db.exec(`
    INSERT INTO families(id, name, created_at) VALUES
      ('fam-a','Fam A','2026-01-01T00:00:00.000Z'),
      ('fam-b','Fam B','2026-01-01T00:00:00.000Z');
    INSERT INTO members(id, family_id, name, email, role, created_at) VALUES
      ('m-a-owner','fam-a','Mahesh','mahesh@a.dev','owner','2026-01-01T00:00:00.000Z'),
      ('m-a-kid','fam-a','Harshika','harshika@a.dev','kid','2026-01-01T00:00:00.000Z'),
      ('m-b-owner','fam-b','Stranger','s@b.dev','owner','2026-01-01T00:00:00.000Z'),
      ('m-b-parent','fam-b','Mahesh (B)','mahesh@a.dev','parent','2026-01-01T00:00:00.000Z');
  `);
  return db;
}

test('migration 0005 applies cleanly on an empty database', async () => {
  const db = new DatabaseSync(':memory:');
  applyUpTo(db, '0004_credential_lineage.sql');
  db.exec(readFileSync(join(migrationsDir(), '0005_identity_principals.sql'), 'utf8'));
  const c = sqliteClient(db);
  const cols = await c.queryAll(`PRAGMA table_info(members)`);
  assert.ok(cols.some((r) => r['name'] === 'principal_id'), 'principal_id column exists');
  const count = await c.queryOne(`SELECT COUNT(*) AS n FROM principals`);
  assert.equal(count!['n'], 0);
});

test('migration 0005 backfill: one principal per distinct email', async () => {
  const db = fixtureDbThrough0004();
  db.exec(readFileSync(join(migrationsDir(), '0005_identity_principals.sql'), 'utf8'));
  const c = sqliteClient(db);

  const n = await c.queryOne(`SELECT COUNT(*) AS n FROM principals`);
  assert.equal(n!['n'], 3, 'one principal per distinct email');

  const nulls = await c.queryOne(`SELECT COUNT(*) AS n FROM members WHERE principal_id IS NULL`);
  assert.equal(nulls!['n'], 0, 'every member row backfilled');

  // Same email across circles -> ONE principal (preserves the legitimate
  // linking those rows were created under).
  const same = await c.queryAll(
    `SELECT principal_id FROM members WHERE email = 'mahesh@a.dev' ORDER BY family_id`,
  );
  assert.equal(same.length, 2);
  assert.equal(
    same[0]['principal_id'],
    same[1]['principal_id'],
    'same email across circles shares one principal',
  );

  // Distinct emails -> distinct principals.
  const distinct = await c.queryAll(`SELECT DISTINCT principal_id AS p FROM members`);
  assert.equal(distinct.length, 3);

  // Principal ids are opaque: they carry no recoverable relation to the email.
  const pid = same[0]['principal_id'] as string;
  assert.ok(pid.startsWith('pr_'));
  assert.ok(!pid.includes('mahesh'), 'principal id must not embed the email');
});

test('GET /v1/me exposes is_hub_owner for agent discovery', async () => {
  const { app, ownerToken, kidToken, strangerToken } = await lockedSetup();

  const ownerMe = await app.call('GET', '/v1/me', { token: ownerToken });
  assert.equal(ownerMe.status, 200);
  assert.equal(ownerMe.body.is_hub_owner, true);
  assert.equal(ownerMe.body.role, 'owner');

  const kidMe = await app.call('GET', '/v1/me', { token: kidToken });
  assert.equal(kidMe.status, 200);
  assert.equal(kidMe.body.is_hub_owner, false);
  assert.equal(kidMe.body.role, 'kid');

  // Owner of a different circle is still a hub owner (any-circle rule).
  const strangerMe = await app.call('GET', '/v1/me', { token: strangerToken });
  assert.equal(strangerMe.status, 200);
  assert.equal(strangerMe.body.is_hub_owner, true);
});
