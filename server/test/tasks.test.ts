// Tests: task lifecycle rules (SPEC §5, §10) — incl. the subtask gate.
import { test } from 'node:test';
import assert from 'node:assert';
import { makeApp, TestApp } from './app.js';

async function setup(): Promise<{ app: TestApp; token: string; topicId: string; kidToken: string; kidId: string }> {
  const app = makeApp();
  const fam = await app.call('POST', '/v1/families', {
    body: { name: 'F', owner_name: 'Mahesh', owner_email: 'm@t.dev' },
  });
  const red = await app.call(
    'POST',
    `/v1/provisioning-codes/${encodeURIComponent(fam.body.provisioning_code)}/redeem`,
    { body: {} },
  );
  const token = red.body.token as string;
  const meId = red.body.member.id as string;
  const inv = await app.call('POST', `/v1/families/${fam.body.family.id}/invites`, {
    token,
    body: { email: 'k@t.dev', role: 'kid' },
  });
  const acc = await app.call(
    'POST',
    `/v1/invites/${encodeURIComponent(inv.body.invite_code)}/accept`,
    { body: { display_name: 'Kid', agent_label: 'kid-agent' } },
  );
  const kidToken = acc.body.token as string;
  const kidId = acc.body.member.id as string;
  const topic = await app.call('POST', '/v1/topics', {
    token,
    body: { subject: 'Trip', kind: 'group', participant_member_ids: [meId, kidId] },
  });
  assert.equal(topic.status, 201);
  return { app, token, topicId: topic.body.topic.id as string, kidToken, kidId };
}

test('done with open subtasks is rejected (409); works after subtasks close', async () => {
  const { app, token, topicId, kidId } = await setup();
  const parent = await app.call('POST', `/v1/topics/${topicId}/tasks`, {
    token,
    body: { title: 'Plan trip' },
  });
  assert.equal(parent.status, 201);
  const pid = parent.body.task.id as string;

  const sub = await app.call('POST', `/v1/topics/${topicId}/tasks`, {
    token,
    body: { title: 'Check dates', parent_task_id: pid, assignee_member_id: kidId },
  });
  assert.equal(sub.status, 201);
  const sid = sub.body.task.id as string;

  const early = await app.call('POST', `/v1/tasks/${pid}/done`, { token, body: {} });
  assert.equal(early.status, 409);
  assert.equal(early.body.error.code, 'subtasks_open');

  const doneSub = await app.call('POST', `/v1/tasks/${sid}/done`, {
    token,
    body: { result: { conflicts: [] } },
  });
  assert.equal(doneSub.status, 200);
  assert.equal(doneSub.body.task.status, 'done');
  assert.deepEqual(doneSub.body.task.result, { conflicts: [] });

  const doneParent = await app.call('POST', `/v1/tasks/${pid}/done`, { token, body: {} });
  assert.equal(doneParent.status, 200);
  assert.equal(doneParent.body.task.status, 'done');
});

test('assignee must participate in the topic; parent task must be in-topic', async () => {
  const { app, token, topicId } = await setup();
  const bad = await app.call('POST', `/v1/topics/${topicId}/tasks`, {
    token,
    body: { title: 'X', assignee_member_id: 'no-such-member' },
  });
  assert.equal(bad.status, 400);

  const other = await app.call('POST', '/v1/topics', {
    token,
    body: { subject: 'Other', kind: 'group', participant_member_ids: [] },
  });
  const otherTask = await app.call('POST', `/v1/topics/${other.body.topic.id}/tasks`, {
    token,
    body: { title: 'OT' },
  });
  const cross = await app.call('POST', `/v1/topics/${topicId}/tasks`, {
    token,
    body: { title: 'X', parent_task_id: otherTask.body.task.id },
  });
  assert.equal(cross.status, 400);
});

test('task trail reconstructs lifecycle entries', async () => {
  const { app, token, topicId, kidToken } = await setup();
  const t = await app.call('POST', `/v1/topics/${topicId}/tasks`, {
    token,
    body: { title: 'Trail test' },
  });
  const tid = t.body.task.id as string;
  await app.call('POST', `/v1/tasks/${tid}/notes`, { token: kidToken, body: { body: 'working on it' } });
  await app.call('POST', `/v1/tasks/${tid}/done`, { token, body: { result: { ok: true } } });
  // Bare GET /v1/tasks/:tid is deleted (spec §1.6); the trail is the
  // topic's task_created/task_* entries, readable via history.
  const hist = await app.call('GET', `/v1/topics/${topicId}/history`, { token });
  const kinds = (hist.body.entries as any[])
    .filter((e: any) => (e.data as any)?.task_id === tid)
    .map((e: any) => e.kind);
  assert.deepEqual(kinds, ['task_created', 'task_note', 'task_done']);
});
