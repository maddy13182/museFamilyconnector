// Unit tests: PII scanner (SPEC §11).
import { test } from 'node:test';
import assert from 'node:assert';
import { scanPii, luhnValid } from '../src/pii.js';

test('luhnValid accepts known test card numbers', () => {
  assert.equal(luhnValid('4111111111111111'), true); // Visa test
  assert.equal(luhnValid('4012888888881881'), true); // Visa test
  assert.equal(luhnValid('378282246310005'), true); // Amex test (15 digits)
});

test('luhnValid rejects bad checksums', () => {
  assert.equal(luhnValid('4111111111111112'), false);
  assert.equal(luhnValid('1234567890123456'), false);
});

test('detects card numbers with spaces and dashes', () => {
  const h1 = scanPii('my card is 4111 1111 1111 1111 ok?');
  assert.ok(h1 && h1.kind === 'card');
  const h2 = scanPii('card: 4012-8888-8888-1881');
  assert.ok(h2 && h2.kind === 'card');
  const h3 = scanPii('4111111111111111');
  assert.ok(h3 && h3.kind === 'card');
});

test('ignores digit runs that fail Luhn or are too short', () => {
  assert.equal(scanPii('call me at 5551234567'), null);
  assert.equal(scanPii('order 12345 confirmed, total 987654'), null);
  assert.equal(scanPii('not a card: 4111 1111 1111 1112'), null);
});

test('detects SSN pattern', () => {
  const h = scanPii('her SSN is 900-12-3456 on file');
  assert.ok(h && h.kind === 'ssn');
});

test('does not flag SSN-like fragments', () => {
  assert.equal(scanPii('serial 12-345-6789 shipped'), null);
  assert.equal(scanPii('call 900-123-4567'), null); // phone shape, not SSN
});

test('clean text passes', () => {
  assert.equal(scanPii('Planning the trip for March 4-7, 2027. Everyone good?'), null);
  assert.equal(scanPii(''), null);
});

test('hit never exposes the matched value', () => {
  const h = scanPii('card 4111 1111 1111 1111')!;
  assert.ok(!JSON.stringify(h).includes('4111'));
});

test('configurable extra patterns', () => {
  const h = scanPii('DOB: 1990-01-01', {
    extraPatterns: [{ name: 'dob-tag', source: '\\bDOB\\b' }],
  });
  assert.ok(h && h.kind === 'custom' && h.description.includes('dob-tag'));
  assert.equal(scanPii('birthday 1990-01-01', { extraPatterns: [] }), null);
});
