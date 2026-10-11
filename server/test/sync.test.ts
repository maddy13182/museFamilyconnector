// F09 regression: /v1/sync pagination drains a backlog without gaps.
// Old behavior returned next_after_gseq = MAX(gseq) over all visible
// entries, so a backlog deeper than `limit` silently skipped entries.
// New behavior is page-based: limit+1 rows fetched, has_more signals more
// backlog, and next_after_gseq is always the last RETURNED entry's gseq
// (or the input cursor when the page is empty).
import { test } from 'node:test';
import assert from 'node:assert';
import { makeApp, TestApp } from './app.js';

interface Page {
  gseqs: number[];
  next: number;
  max: number;
  more: boolean;
}

async function setup(): Promise<{ app: TestApp; token: string; post: (i: number) => Promise<void> }> {
  const app = makeApp();
  const fam = await app.call('POST', '/v1/families', {
    body: { name: 'Sync Fam', owner_name: 'Mahesh', owner_email: 'mahesh@sync.dev' },
  });
  assert.equal(fam.status, 201);
  const red = await app.call(
    'POST',
    `/v1/provisioning-codes/${encodeURIComponent(fam.body.provisioning_code)}/redeem`,
    { body: {} },
  );
  assert.equal(red.status, 201);
  const token = red.body.token as string;
  const memberId = red.body.member.id as string;
  const t = await app.call('POST', '/v1/topics', {
    token,
    body: { subject: 'paging', kind: 'group', participant_member_ids: [memberId] },
  });
  assert.equal(t.status, 201);
  const tid = t.body.topic.id as string;
  async function post(i: number): Promise<void> {
    const r = await app.call('POST', `/v1/topics/${tid}/entries`, {
      token,
      body: { body: `entry ${i}` },
    });
    assert.equal(r.status, 201);
  }
  return { app, token, post };
}

function pageOf(body: any): Page {
  return {
    gseqs: (body.entries as any[]).map((e) => e.gseq as number),
    next: body.next_after_gseq as number,
    max: body.max_gseq as number,
    more: body.has_more as boolean,
  };
}

test('backlog deeper than limit drains page by page without gaps', async () => {
  const { app, token, post } = await setup();
  for (let i = 1; i <= 5; i++) await post(i);

  let r = await app.call('GET', '/v1/sync?after_gseq=0&limit=2', { token });
  assert.equal(r.status, 200);
  let p = pageOf(r.body);
  assert.deepEqual(p.gseqs, [1, 2]);
  assert.equal(p.more, true);
  // Cursor follows the last RETURNED entry — never the head of the backlog.
  assert.equal(p.next, 2);
  assert.equal(p.max, 2);

  r = await app.call('GET', `/v1/sync?after_gseq=${p.next}&limit=2`, { token });
  assert.equal(r.status, 200);
  p = pageOf(r.body);
  assert.deepEqual(p.gseqs, [3, 4]);
  assert.equal(p.more, true);
  assert.equal(p.next, 4);
  assert.equal(p.max, 4);

  r = await app.call('GET', `/v1/sync?after_gseq=${p.next}&limit=2`, { token });
  assert.equal(r.status, 200);
  p = pageOf(r.body);
  assert.deepEqual(p.gseqs, [5]);
  assert.equal(p.more, false);
  assert.equal(p.next, 5);
  assert.equal(p.max, 5);

  // Caught up: empty page leaves the cursor unchanged.
  r = await app.call('GET', '/v1/sync?after_gseq=5&limit=2', { token });
  assert.equal(r.status, 200);
  p = pageOf(r.body);
  assert.deepEqual(p.gseqs, []);
  assert.equal(p.more, false);
  assert.equal(p.next, 5);
  assert.equal(p.max, 5);
});

test('entries arriving mid-pagination are neither lost nor duplicated', async () => {
  const { app, token, post } = await setup();
  for (let i = 1; i <= 5; i++) await post(i);

  const seen: number[] = [];
  let r = await app.call('GET', '/v1/sync?after_gseq=0&limit=2', { token });
  assert.equal(r.status, 200);
  let p = pageOf(r.body);
  assert.deepEqual(p.gseqs, [1, 2]);
  assert.equal(p.more, true);
  seen.push(...p.gseqs);

  // Two more entries land while the client is still paging.
  await post(6);
  await post(7);

  let cursor = p.next;
  while (true) {
    r = await app.call('GET', `/v1/sync?after_gseq=${cursor}&limit=2`, { token });
    assert.equal(r.status, 200);
    p = pageOf(r.body);
    assert.equal(p.next, p.gseqs.length > 0 ? p.gseqs[p.gseqs.length - 1] : cursor);
    seen.push(...p.gseqs);
    cursor = p.next;
    if (!p.more) break;
  }
  assert.deepEqual(seen, [1, 2, 3, 4, 5, 6, 7]);

  // And the next poll after the full drain is empty with a stable cursor.
  r = await app.call('GET', `/v1/sync?after_gseq=${cursor}&limit=2`, { token });
  p = pageOf(r.body);
  assert.deepEqual(p.gseqs, []);
  assert.equal(p.more, false);
  assert.equal(p.next, 7);
});

test('single page still returns the contract fields', async () => {
  const { app, token, post } = await setup();
  await post(1);
  const r = await app.call('GET', '/v1/sync?after_gseq=0&limit=100', { token });
  assert.equal(r.status, 200);
  const p = pageOf(r.body);
  assert.deepEqual(p.gseqs, [1]);
  assert.equal(p.more, false);
  assert.equal(p.next, 1);
  assert.equal(p.max, 1);
});
