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

interface CircleLogic {
  circleShouldShowSwitcher: (families: Circle[]) => boolean;
  circleResolveActive: (families: Circle[], storedId: string | null) => Circle | null;
  circleScopedPath: (path: string, familyId: string | null) => string;
  circleLabel: (f: Circle) => string;
}

function loadLogic(): CircleLogic {
  const factory = new Function(
    CIRCLE_LOGIC_SRC +
      '\nreturn { circleShouldShowSwitcher, circleResolveActive, circleScopedPath, circleLabel };'
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

test('scoped paths append family_id without breaking existing queries', () => {
  const L = loadLogic();
  assert.equal(L.circleScopedPath('/v1/topics', 'fid'), '/v1/topics?family_id=fid');
  assert.equal(
    L.circleScopedPath('/v1/topics/abc/history?limit=100', 'fid'),
    '/v1/topics/abc/history?limit=100&family_id=fid'
  );
  assert.equal(L.circleScopedPath('/v1/topics', null), '/v1/topics');
  assert.equal(L.circleScopedPath('/v1/topics', ''), '/v1/topics');
  assert.equal(L.circleScopedPath('/v1/f', 'a b'), '/v1/f?family_id=a%20b');
});

test('circle labels include name, kind and role', () => {
  const L = loadLogic();
  assert.equal(L.circleLabel(fam('a', 'Alpha')), 'Alpha [family] · owner');
});

test('served page embeds the switcher logic and wiring', () => {
  assert.ok(UI_HTML.includes('circleShouldShowSwitcher'), 'logic source embedded');
  assert.ok(UI_HTML.includes('circleResolveActive'), 'resolver embedded');
  assert.ok(UI_HTML.includes('id="circleBox"'), 'switcher container present');
  assert.ok(UI_HTML.includes("api('/v1/families'"), 'families endpoint wired');
  assert.ok(UI_HTML.includes('fh_circle_id'), 'selection persisted to localStorage');
});
