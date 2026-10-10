// Unit tests: strict input validation (SPEC §7).
import { test } from 'node:test';
import assert from 'node:assert';
import { HttpError } from '../src/types.js';
import {
  reqString,
  optString,
  reqEmail,
  reqEnum,
  reqIdArray,
  parseLimit,
  parseSeqCursor,
  reqIsoDate,
  reqJsonData,
} from '../src/validate.js';

function bad(fn: () => unknown, code = 'bad_request'): void {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof HttpError, 'expected HttpError');
    assert.equal((e as HttpError).status, 400);
    assert.equal((e as HttpError).code, code);
    return;
  }
  assert.fail('expected validation to throw');
}

test('reqString bounds', () => {
  assert.equal(reqString('hi', 'n', 1, 10), 'hi');
  bad(() => reqString('', 'n', 1, 10));
  bad(() => reqString('toolongstring', 'n', 1, 5));
  bad(() => reqString(42 as unknown as string, 'n', 1, 10));
});

test('optString', () => {
  assert.equal(optString(undefined, 'n', 5), null);
  assert.equal(optString(null, 'n', 5), null);
  assert.equal(optString('ok', 'n', 5), 'ok');
  bad(() => optString('toolong', 'n', 5));
});

test('reqEmail', () => {
  assert.equal(reqEmail('A@Example.COM'), 'a@example.com');
  bad(() => reqEmail('not-an-email'));
  bad(() => reqEmail('a@b'));
  bad(() => reqEmail(''));
});

test('reqEnum', () => {
  assert.equal(reqEnum('open', 's', ['open', 'done'] as const), 'open');
  bad(() => reqEnum('bogus', 's', ['open', 'done'] as const));
});

test('reqIdArray dedupes and bounds', () => {
  assert.deepEqual(reqIdArray(['a', 'b', 'a'], 'ids', 5), ['a', 'b']);
  bad(() => reqIdArray([], 'ids', 5));
  bad(() => reqIdArray(['a', 1], 'ids', 5));
  bad(() => reqIdArray(['a', 'b', 'c'], 'ids', 2));
});

test('parseLimit', () => {
  assert.equal(parseLimit(null, 100, 500), 100);
  assert.equal(parseLimit('50', 100, 500), 50);
  bad(() => parseLimit('0', 100, 500));
  bad(() => parseLimit('501', 100, 500));
  bad(() => parseLimit('abc', 100, 500));
});

test('parseSeqCursor', () => {
  assert.equal(parseSeqCursor(null), 0);
  assert.equal(parseSeqCursor('12'), 12);
  bad(() => parseSeqCursor('-1'));
  bad(() => parseSeqCursor('1.5'));
});

test('reqIsoDate', () => {
  assert.ok(reqIsoDate('2027-03-04', 'd').startsWith('2027-03-04'));
  bad(() => reqIsoDate('not a date', 'd'));
});

test('reqJsonData', () => {
  assert.equal(reqJsonData(null, 'd', 100), null);
  assert.equal(reqJsonData({ a: 1 }, 'd', 100), '{"a":1}');
  const big: Record<string, string> = { x: 'y'.repeat(200) };
  bad(() => reqJsonData(big, 'd', 100));
});
