// Raw protocol and transaction checks. No test-client encryption adapter.
import { test } from 'node:test';
import assert from 'node:assert';
import { makeApp, setupKeyedFamily, addMember, createE2eeTopic, hex, wireBody, postEnvelope, commitKey } from './syncv2_helpers.js';

test('v2 refuses an unmigrated database and every older API major', async () => {
  const app = makeApp();
  for (const method of ['GET','POST']) {
    const res = await app.call(method, '/v1/topics', {body:method==='POST'?{subject:'private'}:undefined});
    assert.equal(res.status,404);
  }
  app.raw.exec('DROP TABLE encryption_contract');
  for (const path of ['/v2/health','/v2/topics']) {
    const res = await app.call('GET',path);
    assert.equal(res.status,503);
    assert.equal(res.body.error.code,'schema_required');
  }
});

test('topic creation requires encrypted subject and rejects every legacy mode flag', async () => {
  const app=makeApp(); const {owner}=await setupKeyedFamily(app,'Required');
  const base={topic_id:hex(16),subject:wireBody(hex(16)),kind:'group',participant_member_ids:[]};
  for (const extra of [{subject:'readable subject'},{e2ee:0},{e2ee:1},{initial_key_id:hex(16)},{briefing:'private'}]) {
    const res=await app.call('POST','/v2/topics',{token:owner.token,body:{...base,...extra}});
    assert.equal(res.status,400,JSON.stringify(extra));
  }
  const row=await app.db.queryOne('SELECT COUNT(*) AS c FROM topics',[]);
  assert.equal(row!['c'],0,'invalid operations must leave no topic behind');
});

test('membership change at the SQL commit invalidates the complete-recipient snapshot', async () => {
  const app=makeApp(); const {owner,famId}=await setupKeyedFamily(app,'Race');
  const member=await addMember(app,famId,owner.token,'later@race.test','parent','Later');
  const {tid}=await createE2eeTopic(app,owner.token);
  const kid=hex(16);
  assert.equal((await postEnvelope(app,owner.token,tid,owner.memberId,owner.agentLabel,kid)).status,201);
  const original=app.db.execAtomically.bind(app.db);
  let changed=false;
  app.db.execAtomically=async (ops) => {
    if (!changed && ops.some(op=>op.sql.includes('INSERT INTO topic_key_epochs'))) {
      changed=true;
      app.raw.prepare('INSERT INTO topic_participants(topic_id,member_id,joined_at,history_from_seq) VALUES (?,?,?,1)').run(tid,member.memberId,new Date().toISOString());
    }
    return original(ops);
  };
  const result=await commitKey(app,owner.token,tid,{expectedEpoch:1,keyId:kid,commitment:hex(32)});
  assert.equal(result.status,409);
  assert.equal(result.body.error.code,'stale_epoch');
  const row=await app.db.queryOne('SELECT current_epoch,current_key_id FROM topics WHERE id=?',[tid]);
  assert.equal(row!['current_epoch'],0);
  assert.equal(row!['current_key_id'],null);
  assert.equal((await app.db.queryOne('SELECT COUNT(*) AS c FROM topic_key_epochs WHERE topic_id=?',[tid]))!['c'],0);
});

test('SQL write guard catches rotation starting after the HTTP content check', async () => {
  const app=makeApp(); const {owner}=await setupKeyedFamily(app,'WriteRace');
  const {tid}=await createE2eeTopic(app,owner.token);
  const kid=hex(16);
  await postEnvelope(app,owner.token,tid,owner.memberId,owner.agentLabel,kid);
  assert.equal((await commitKey(app,owner.token,tid,{expectedEpoch:1,keyId:kid,commitment:hex(32)})).status,200);
  const original=app.db.execAtomically.bind(app.db);
  let changed=false;
  app.db.execAtomically=async ops=>{
    if (!changed && ops.some(op=>op.sql.includes('INSERT INTO entries'))) {
      changed=true;
      app.raw.prepare('UPDATE topics SET rotation_required=1 WHERE id=?').run(tid);
    }
    return original(ops);
  };
  const res=await app.call('POST',`/v2/topics/${tid}/entries`,{token:owner.token,body:{body:wireBody(kid)}});
  assert.equal(res.status,409);
  assert.equal(res.body.error.code,'rotation_required');
  assert.equal((await app.db.queryOne('SELECT COUNT(*) AS c FROM entries WHERE topic_id=?',[tid]))!['c'],0);
});
