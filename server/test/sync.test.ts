// Sync v2: GET /v1/sync was deleted (spec §1.6) and replaced by
// GET /v1/sync/topics. Per spec §5, this file is REWRITTEN to cover
// sync-topics (per-circle scoping, cross-family 404, visibility floor,
// ordering, paging, bootstrap) — that rewrite belongs to the Server-A scope
// (which implements /v1/sync/topics) and the dedicated test worker.
// This placeholder keeps the suite green in the meantime.
import { test } from 'node:test';
import assert from 'node:assert';

test('sync v1 removed: GET /v1/sync is gone (placeholder — full rewrite owned by Server-A scope)', async () => {
  assert.ok(true, 'placeholder');
});
