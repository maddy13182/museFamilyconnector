// Pure, DOM-free logic for the dashboard circle switcher.
//
// These functions are embedded verbatim into the served dashboard HTML
// (see ui.ts) and run in the browser, so they must stay dependency-free
// plain JavaScript: no imports, no backticks, no ${} interpolation.
// Tests in test/circle-logic.test.ts evaluate this source directly, so the
// tests exercise exactly what ships in the page.
//
// Token model: the default token (localStorage 'fh_token') belongs to the
// first/enrolled circle. Per-circle tokens live in 'fh_circle_tokens', a
// JSON object mapping circle id -> token. The server binds each bearer
// token to exactly one (member, circle) and ignores any family_id query
// parameter, so data calls must use the token stored for the circle being
// viewed; the default token is only a fallback.

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
function circleTokenMapParse(raw) {
  var out = {};
  try {
    var m = raw ? JSON.parse(raw) : null;
    if (m && typeof m === 'object' && !Array.isArray(m)) {
      for (var k in m) {
        if (Object.prototype.hasOwnProperty.call(m, k) &&
            typeof m[k] === 'string' && m[k] !== '') {
          out[k] = m[k];
        }
      }
    }
  } catch (e) {}
  return out;
}
function circleHasToken(map, circleId) {
  return !!(map && circleId &&
    typeof map[circleId] === 'string' && map[circleId] !== '');
}
function circleTokenFor(map, circleId, defaultToken) {
  if (circleHasToken(map, circleId)) return map[circleId];
  return defaultToken || '';
}
function circleTokenMapSet(map, circleId, token) {
  var out = {};
  if (map && typeof map === 'object') {
    for (var k in map) {
      if (Object.prototype.hasOwnProperty.call(map, k)) out[k] = map[k];
    }
  }
  if (token) out[circleId] = token;
  else delete out[circleId];
  return out;
}
function circleLabel(f) {
  return String(f.name) + ' [' + String(f.kind) + '] \\u00b7 ' + String(f.my_role);
}
`;
