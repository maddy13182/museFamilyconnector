// Tests for the dashboard circle-switcher pure logic (src/circle-logic.ts).
// The embedded source is evaluated so the tests exercise exactly the code
// that ships inside the served HTML page.
import { test } from 'node:test';
import assert from 'node:assert';
import { CIRCLE_LOGIC_SRC } from '../src/circle-logic.js';
import { UI_HTML } from '../src/ui.js';

interface Circle {
  id: string;
  name: string;
  kind: string;
  my_role: string;
  created_at: string;
}

type TokenMap = Record<string, string>;

interface CircleLogic {
  circleShouldShowSwitcher: (families: Circle[]) => boolean;
  circleResolveActive: (families: Circle[], storedId: string | null) => Circle | null;
  circleTokenMapParse: (raw: string | null) => TokenMap;
  circleHasToken: (map: TokenMap | null, circleId: string | null) => boolean;
  circleTokenFor: (map: TokenMap | null, circleId: string | null, defaultToken: string) => string;
  circleTokenMapSet: (map: TokenMap | null, circleId: string, token: string) => TokenMap;
  circleLabel: (f: Circle) => string;
}

function loadLogic(): CircleLogic {
  const factory = new Function(
    CIRCLE_LOGIC_SRC +
      '\nreturn { circleShouldShowSwitcher, circleResolveActive, ' +
      'circleTokenMapParse, circleHasToken, circleTokenFor, circleTokenMapSet, circleLabel };'
  );
  return factory() as CircleLogic;
}

const fam = (id: string, name = id): Circle => ({
  id,
  name,
  kind: 'family',
  my_role: 'owner',
  created_at: '2026-01-01T00:00:00.000Z',
});

test('switcher visibility: hidden for 0 or 1 circles, shown for 2+', () => {
  const L = loadLogic();
  assert.equal(L.circleShouldShowSwitcher([]), false);
  assert.equal(L.circleShouldShowSwitcher([fam('a')]), false);
  assert.equal(L.circleShouldShowSwitcher([fam('a'), fam('b')]), true);
  assert.equal(L.circleShouldShowSwitcher([fam('a'), fam('b'), fam('c')]), true);
  assert.equal(L.circleShouldShowSwitcher(null as unknown as Circle[]), false);
});

test('active circle resolution: stored id honored, stale id falls back to first', () => {
  const L = loadLogic();
  const list = [fam('a', 'Alpha'), fam('b', 'Beta')];
  assert.equal(L.circleResolveActive([], 'a'), null);
  assert.equal(L.circleResolveActive(list, null)?.id, 'a');
  assert.equal(L.circleResolveActive(list, 'b')?.id, 'b');
  assert.equal(L.circleResolveActive(list, 'gone')?.id, 'a');
});

test('token map parse: valid JSON kept, garbage and non-strings dropped', () => {
  const L = loadLogic();
  assert.deepEqual(L.circleTokenMapParse('{"a":"fh_x","b":"fh_y"}'), { a: 'fh_x', b: 'fh_y' });
  assert.deepEqual(L.circleTokenMapParse(null), {});
  assert.deepEqual(L.circleTokenMapParse(''), {});
  assert.deepEqual(L.circleTokenMapParse('not json'), {});
  assert.deepEqual(L.circleTokenMapParse('[1,2]'), {});
  assert.deepEqual(L.circleTokenMapParse('"str"'), {});
  // non-string values are dropped, empty strings are dropped
  assert.deepEqual(L.circleTokenMapParse('{"a":42,"b":"","c":"fh_z"}'), { c: 'fh_z' });
});

test('hasToken: true only for a stored non-empty string', () => {
  const L = loadLogic();
  const map = { a: 'fh_x' };
  assert.equal(L.circleHasToken(map, 'a'), true);
  assert.equal(L.circleHasToken(map, 'b'), false);
  assert.equal(L.circleHasToken(map, null), false);
  assert.equal(L.circleHasToken(null, 'a'), false);
  assert.equal(L.circleHasToken({ a: '' }, 'a'), false);
});

test('tokenFor: circle token wins, default token is the fallback', () => {
  const L = loadLogic();
  const map = { a: 'fh_circle_a' };
  assert.equal(L.circleTokenFor(map, 'a', 'fh_default'), 'fh_circle_a');
  assert.equal(L.circleTokenFor(map, 'b', 'fh_default'), 'fh_default');
  assert.equal(L.circleTokenFor(map, null, 'fh_default'), 'fh_default');
  assert.equal(L.circleTokenFor({}, 'a', 'fh_default'), 'fh_default');
  assert.equal(L.circleTokenFor(null, 'a', 'fh_default'), 'fh_default');
  assert.equal(L.circleTokenFor({}, 'a', ''), '');
});

test('tokenMapSet: sets, overwrites, and removes without mutating input', () => {
  const L = loadLogic();
  const before = { a: 'fh_x' };
  const added = L.circleTokenMapSet(before, 'b', 'fh_y');
  assert.deepEqual(added, { a: 'fh_x', b: 'fh_y' });
  assert.deepEqual(before, { a: 'fh_x' }, 'input not mutated');
  const overwritten = L.circleTokenMapSet(added, 'a', 'fh_new');
  assert.deepEqual(overwritten, { a: 'fh_new', b: 'fh_y' });
  const removed = L.circleTokenMapSet(overwritten, 'a', '');
  assert.deepEqual(removed, { b: 'fh_y' });
  assert.deepEqual(L.circleTokenMapSet(null, 'a', 'fh_x'), { a: 'fh_x' });
});

test('circle labels include name, kind and role', () => {
  const L = loadLogic();
  assert.equal(L.circleLabel(fam('a', 'Alpha')), 'Alpha [family] · owner');
});

test('served page embeds the token logic and wiring, not query-param scoping', () => {
  assert.ok(UI_HTML.includes('circleTokenFor'), 'token selection embedded');
  assert.ok(UI_HTML.includes('circleHasToken'), 'token presence check embedded');
  assert.ok(UI_HTML.includes('circleTokenMapSet'), 'token map update embedded');
  assert.ok(UI_HTML.includes('fh_circle_tokens'), 'per-circle token map in localStorage');
  assert.ok(UI_HTML.includes('fh_circle_id'), 'selection persisted to localStorage');
  assert.ok(UI_HTML.includes('dashboard-token'), 'onboarding hint wired');
  assert.ok(UI_HTML.includes('id="circleBox"'), 'switcher container present');
  assert.ok(UI_HTML.includes("api('/v1/families'"), 'families endpoint wired');
  assert.ok(!UI_HTML.includes('circleScopedPath'), 'query-param scoping removed');
  assert.ok(!UI_HTML.includes('family_id='), 'no family_id query params emitted');
});
