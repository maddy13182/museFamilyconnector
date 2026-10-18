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
  circleLabel: (f: Circle) => string;
}

function loadLogic(): CircleLogic {
  const factory = new Function(
    CIRCLE_LOGIC_SRC +
      '\nreturn { circleShouldShowSwitcher, circleResolveActive, ' +
      'circleLabel };'
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

test('circle labels include name, kind and role', () => {
  const L = loadLogic();
  assert.equal(L.circleLabel(fam('a', 'Alpha')), 'Alpha [family] · owner');
});

test('dashboard uses one server credential and explicit circle authorization',()=>{
 assert.ok(UI_HTML.includes("'X-Circle-ID':selected"));
 assert.ok(UI_HTML.includes("const token = cfg().token"));
 assert.ok(!UI_HTML.includes('fh_circle_tokens'));
 assert.ok(UI_HTML.includes("api('/v2/families'"));
 assert.ok(UI_HTML.includes('canLoadCircleData'));
});

test('dashboard E2EE view is metadata-only with honest labeling', () => {
  // Never decrypt in the browser: subjects render as [encrypted], bodies
  // as hidden, and the label states the server cannot read the topic.
  assert.ok(UI_HTML.includes('[encrypted]'), 'E2EE topics labeled, not subject-rendered');
  assert.ok(
    UI_HTML.includes('Content encrypted — the server cannot read this topic.'),
    'honest cannot-read label present',
  );
  assert.ok(
    UI_HTML.includes('Key import into the dashboard is not supported'),
    'deferred key import stated',
  );
  assert.ok(UI_HTML.includes('renderArchivedBanner'), 'archive banner renderer embedded');
  assert.ok(
    UI_HTML.includes('Discussion continues at'),
    'archive banner names the successor',
  );
  assert.ok(!UI_HTML.includes('postBody'), 'plaintext posting removed');
  assert.ok(!UI_HTML.includes('createTopic'), 'plaintext creation removed');
});
