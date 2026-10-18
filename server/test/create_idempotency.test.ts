import { b64 } from './syncv2_helpers.js';
// Idempotent creates: POST /v2/families, /v2/topics, /v2/families/:id/invites
// honor Idempotency-Key; circle names are unique (case-insensitive).
import { test } from 'node:test';
import assert from 'node:assert';
import { makeClientApp as makeApp } from './fixture-client.js';

async function bootstrapOwner(app: ReturnType<typeof makeApp>, name: string, email: string) {
  const fam = await app.call('POST', '/v2/families', {
    body: { name, owner_name: 'Owner', owner_email: email },
  });
  assert.equal(fam.status, 201);
  const red = await app.call(
    'POST',
    `/v2/provisioning-codes/${encodeURIComponent(fam.body.provisioning_code)}/redeem`,
    { body: { agent_public_key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE=' } },
  );
  assert.equal(red.status, 201);
  return { famId: fam.body.family.id as string, token: red.body.token as string };
}

test('duplicate circle name (case-insensitive) -> 409 circle_name_taken', async () => {
  const app = makeApp();
  await bootstrapOwner(app, 'Close Friends', 'a@t.dev');
  const dup = await app.call('POST', '/v2/families', {
    body: { name: 'close friends', owner_name: 'O2', owner_email: 'b@t.dev' },
  });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'circle_name_taken');
});

test('locked create retries return one circle without issuing another credential', async()=>{
 const app=makeApp();const {token}=await bootstrapOwner(app,'Fam A','a@t.dev');app.env.SETUP_LOCKED='1';
 const opts={token,body:{name:'Gym',kind:'general'},headers:{'idempotency-key':'same-create'}};
 const first=await app.call('POST','/v2/families',opts);const second=await app.call('POST','/v2/families',opts);
 assert.equal(first.status,201);assert.equal(second.status,200);assert.equal(first.body.id,second.body.id);
 assert.equal(second.body.deduped,true);assert.equal(second.body.provisioning_code,undefined);
 assert.equal((await app.db.queryOne('SELECT count(*) n FROM agent_tokens'))?.n,1);
 const members=await app.call('GET','/v2/members',{token,headers:{'X-Circle-ID':first.body.id}});assert.equal(members.status,200);
 const changed=await app.call('POST','/v2/families',{...opts,body:{name:'Different',kind:'general'}});
 assert.equal(changed.status,409);assert.equal(changed.body.error.code,'idempotency_conflict');
});


test('circle-create retry preserves the original server credential', async()=>{
 const app=makeApp();const {token}=await bootstrapOwner(app,'Fam A','a@t.dev');app.env.SETUP_LOCKED='1';
 const opts={token,body:{name:'Book'},headers:{'idempotency-key':'book-create'}};
 const first=await app.call('POST','/v2/families',opts);const retry=await app.call('POST','/v2/families',opts);
 assert.equal(first.status,201);assert.equal(retry.status,200);assert.equal(retry.body.id,first.body.id);
 assert.equal((await app.call('GET','/v2/me',{token,headers:{'X-Circle-ID':first.body.id}})).status,200);
 assert.equal((await app.db.queryOne('SELECT revoked_at FROM agent_tokens'))?.revoked_at,null);
});


test('a different credential cannot recover an already enrolled code', async () => {
  const app = makeApp();
  const fam = await app.call('POST', '/v2/families', {
    body: { name: 'F', owner_name: 'M', owner_email: 'm@t.dev' },
  });
  const code = fam.body.provisioning_code as string;
  const path = `/v2/provisioning-codes/${encodeURIComponent(code)}/redeem`;
  const red1 = await app.call('POST', path, { body: { agent_public_key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE=' } });
  assert.equal(red1.status, 201);
  const red2 = await app.call('POST', path, { body: { agent_public_key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE=' } });
  assert.equal(red2.status, 409);
  assert.equal(red2.body.error.code, 'enrollment_conflict');
  assert.equal(red2.body.token, undefined);
  assert.equal(red2.body.member, undefined);
});

test('topic create is idempotent with its client-generated operation ID', async () => {
  const app = makeApp();
  const { token } = await bootstrapOwner(app, 'Fam A', 'a@t.dev');
  const key = 'topic-key-1';
  const payload = {topic_id:'a'.repeat(32),subject:'fh1.'+'b'.repeat(32)+'.'+'c'.repeat(32)+'.'+b64(40),kind:'group',participant_member_ids:[]};
  const mk = () =>
    app.rawCall('POST', '/v2/topics', {
token,
      body: payload,
      headers: { 'idempotency-key': key },
    });
  const first = await mk();
  assert.equal(first.status, 201);
  const second = await mk();
  assert.equal(second.status, 200);
  assert.equal(second.body.deduped, true);
  assert.equal(second.body.topic.id, first.body.topic.id);
});

test('invite create is idempotent with a key (fresh code on dedup)', async () => {
  const app = makeApp();
  const { token, famId } = await bootstrapOwner(app, 'Fam A', 'a@t.dev');
  const key = 'invite-key-1';
  const mk = () =>
    app.call('POST', `/v2/families/${famId}/invites`, {
token,
      body: { email: 'n@t.dev', role: 'parent' },
      headers: { 'idempotency-key': key },
    });
  const first = await mk();
  assert.equal(first.status, 201);
  const second = await mk();
  assert.equal(second.status, 200);
  assert.equal(second.body.deduped, true);
  assert.ok(second.body.invite_code && second.body.invite_code !== first.body.invite_code);
});
