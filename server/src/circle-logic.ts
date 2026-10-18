// Pure, DOM-free logic for the dashboard circle switcher.
//
// These functions are embedded verbatim into the served dashboard HTML
// (see ui.ts) and run in the browser, so they must stay dependency-free
// plain JavaScript: no imports, no backticks, no ${} interpolation.
// Tests in test/circle-logic.test.ts evaluate this source directly, so the
// tests exercise exactly what ships in the page.
//
// One server credential; the selected circle is sent in X-Circle-ID.

export const CIRCLE_LOGIC_SRC = `
'use strict';
function circleShouldShowSwitcher(families) {
  return Array.isArray(families) && families.length > 1;
}
function circleResolveActive(families, storedId) {
  if (!Array.isArray(families) || families.length === 0) return null;
  if (storedId) {
    for (var i = 0; i < families.length; i++) {
      if (families[i] && families[i].id === storedId) return families[i];
    }
  }
  return families[0];
}
function circleLabel(f) {
  return String(f.name) + ' [' + String(f.kind) + '] \\u00b7 ' + String(f.my_role);
}
`;
