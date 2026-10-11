// Minimal human web UI (read/post), served by the worker at /.
// Single self-contained HTML page, no external assets. The human pastes their
// agent token once; it is kept in localStorage of their own browser only.
//
// Multi-circle: the server binds each bearer token to exactly one (member,
// circle), so the dashboard keeps a per-circle token map ('fh_circle_tokens',
// circle id -> token) alongside the default token ('fh_token'). Data calls
// for a circle use that circle's token; the default token is only a fallback
// and always backs the /v1/families listing (the server scopes it by caller).

import { CIRCLE_LOGIC_SRC } from './circle-logic.js';

export const UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Family Hub</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 760px; margin: 2rem auto; padding: 0 1rem; }
  #auth { background: #f6f6f6; padding: 1rem; border-radius: 8px; margin-bottom: 1rem; }
  input, textarea, button, select { font-size: 1rem; padding: 0.4rem; margin: 0.2rem 0; }
  textarea { width: 100%; min-height: 3rem; }
  .entry { border-bottom: 1px solid #eee; padding: 0.5rem 0; }
  .meta { color: #666; font-size: 0.8rem; }
  .kind { display: inline-block; background: #eef; border-radius: 4px; padding: 0 0.4rem; font-size: 0.75rem; }
  #topics button { display: block; width: 100%; text-align: left; margin: 0.2rem 0; }
  #tokenBox { margin-top: 0.5rem; padding: 0.5rem; background: #fff8f0; border-radius: 8px; }
</style>
</head>
<body>
<h1>Family Hub</h1>
<div id="auth">
  <label>API base: <input id="base" size="40" placeholder="https://your-hub.workers.dev"></label><br>
  <label>Token: <input id="token" type="password" size="40" placeholder="fh_..."></label>
  <button id="save">Connect</button>
  <button id="forget">Forget token</button>
  <div class="meta">Your token stays in this browser's localStorage only. Never share screenshots of it.</div>
</div>
<div id="app" style="display:none">
  <div id="circleBox" style="display:none; margin-bottom: 1rem;"></div>
  <div id="circleError" class="meta" style="color: #a00;"></div>
  <h2>Topics</h2>
  <div id="topics"></div>
  <h3>New topic</h3>
  <input id="newSubject" placeholder="Subject" size="40">
  <button id="createTopic">Create group topic with me</button>
  <h2 id="topicTitle"></h2>
  <div id="entries"></div>
  <h3>Post</h3>
  <textarea id="postBody" placeholder="Write a message…"></textarea><br>
  <button id="post">Post message</button>
</div>
<script>
${CIRCLE_LOGIC_SRC}
const $ = (id) => document.getElementById(id);
let currentTopic = null;
let activeCircleId = localStorage.getItem('fh_circle_id') || null;
let lastFamilies = [];

function cfg() {
  return {
    base: (localStorage.getItem('fh_base') || location.origin).replace(/\\/$/, ''),
    token: localStorage.getItem('fh_token') || ''
  };
}
function readTokenMap() {
  return circleTokenMapParse(localStorage.getItem('fh_circle_tokens'));
}
function tokenForCircle(circleId) {
  return circleTokenFor(readTokenMap(), circleId, cfg().token);
}
// The server binds each bearer token to exactly one (member, circle), so a
// data call for a circle must carry that circle's token. opts.circleId
// overrides the active circle; null selects the default token (used for the
// /v1/families listing, which the server scopes by caller email).
async function api(path, opts = {}) {
  const { base } = cfg();
  const { circleId, ...fetchOpts } = opts;
  const token = tokenForCircle(circleId === undefined ? activeCircleId : circleId);
  const res = await fetch(base + path, {
    ...fetchOpts,
    headers: { ...(opts.headers || {}), 'content-type': 'application/json', 'authorization': 'Bearer ' + token }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data.error && data.error.message) || ('HTTP ' + res.status));
  return data;
}

async function loadCircles() {
  const box = $('circleBox');
  const errBox = $('circleError');
  let families = [];
  try {
    const data = await api('/v1/families', { circleId: null });
    families = Array.isArray(data.families) ? data.families : [];
  } catch (e) {
    if (/HTTP 404/.test(e.message)) {
      // Server predates multi-circle support: single-circle mode, stay quiet.
      box.style.display = 'none';
      errBox.textContent = '';
      activeCircleId = null;
      lastFamilies = [];
      return;
    }
    errBox.textContent = 'Could not load circles: ' + e.message;
    return; // keep existing content
  }
  errBox.textContent = '';
  lastFamilies = families;
  const active = circleResolveActive(families, activeCircleId);
  activeCircleId = active ? active.id : null;
  if (activeCircleId) localStorage.setItem('fh_circle_id', activeCircleId);
  else localStorage.removeItem('fh_circle_id');
  renderCircleBox(families);
  renderTokenNotice();
}

function renderCircleBox(families) {
  const box = $('circleBox');
  box.innerHTML = '';
  if (families.length === 0) {
    box.style.display = 'block';
    box.innerHTML = '<span class="meta">You are not a member of any circle yet.</span>';
    return;
  }
  if (!circleShouldShowSwitcher(families)) {
    box.style.display = 'none';
    return;
  }
  box.style.display = 'block';
  const label = document.createElement('label');
  label.textContent = 'Circle: ';
  const sel = document.createElement('select');
  sel.id = 'circleSel';
  families.forEach(function (f) {
    const o = document.createElement('option');
    o.value = f.id;
    o.textContent = circleLabel(f);
    if (f.id === activeCircleId) o.selected = true;
    sel.appendChild(o);
  });
  sel.onchange = function () { switchCircle(sel.value); };
  label.appendChild(sel);
  box.appendChild(label);
  const tokenUI = document.createElement('div');
  tokenUI.id = 'tokenBox';
  box.appendChild(tokenUI);
}

// Inline token onboarding for the active circle. Stored tokens are never
// written back into the page: the paste box always starts empty.
function renderTokenNotice() {
  const tokenUI = $('tokenBox');
  if (!tokenUI) return;
  tokenUI.innerHTML = '';
  if (!activeCircleId || circleHasToken(readTokenMap(), activeCircleId)) return;
  const active = lastFamilies.filter(function (f) { return f.id === activeCircleId; })[0];
  const name = active ? active.name : activeCircleId;
  const warn = document.createElement('div');
  warn.className = 'meta';
  warn.style.color = '#a00';
  warn.textContent = 'No access token stored for this circle.';
  const input = document.createElement('input');
  input.type = 'password';
  input.size = 40;
  input.placeholder = 'fh_...';
  input.id = 'circleTokenInput';
  const save = document.createElement('button');
  save.textContent = 'Save token';
  save.onclick = saveCircleToken;
  const hint = document.createElement('div');
  hint.className = 'meta';
  hint.appendChild(document.createTextNode('Hint: run '));
  const code = document.createElement('code');
  code.textContent = 'hub dashboard-token --circle "' + name + '"';
  hint.appendChild(code);
  hint.appendChild(document.createTextNode(
    ' on your machine and paste the result. Circle tokens stay in this browser only and are never displayed back.'));
  tokenUI.appendChild(warn);
  tokenUI.appendChild(input);
  tokenUI.appendChild(document.createTextNode(' '));
  tokenUI.appendChild(save);
  tokenUI.appendChild(hint);
}

async function saveCircleToken() {
  const input = $('circleTokenInput');
  const t = input ? input.value.trim() : '';
  if (!t) { alert('Paste a token first.'); return; }
  if (t.slice(0, 3) !== 'fh_') { alert('That does not look like a hub token (expected fh_...).'); return; }
  const active = lastFamilies.filter(function (f) { return f.id === activeCircleId; })[0];
  const name = active ? active.name : activeCircleId;
  // Verify the token before storing it: fail fast on typos, expired, or
  // revoked tokens instead of 403ing every later call. GET /v1/me also
  // proves the token is bound to THIS circle, so a token pasted for the
  // wrong circle is rejected instead of mislabeling its data as ours.
  let me;
  try {
    const res = await fetch(cfg().base + '/v1/me', {
      headers: { 'authorization': 'Bearer ' + t }
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    me = await res.json();
  } catch (e) {
    alert('That token was rejected (' + e.message + '). Not saved.');
    return;
  }
  if (!me || me.family_id !== activeCircleId) {
    alert('That token belongs to a different circle and was not saved. Run the hinted command for "' + name + '" and paste that token.');
    return;
  }
  const map = circleTokenMapSet(readTokenMap(), activeCircleId, t);
  try {
    localStorage.setItem('fh_circle_tokens', JSON.stringify(map));
  } catch (e) { alert('Could not save token: ' + e.message); return; }
  input.value = '';
  renderTokenNotice();
  loadTopics();
}

// Data calls may proceed only when we hold the active circle's token.
// Single-circle setups fall back to the default token. The server binds
// each token to exactly one circle and ignores client-supplied scoping, so
// a stale fallback fails closed (401) or returns that token's own circle's
// data — it can never leak another circle's data. With several circles we
// never guess: the token notice stays up until a token is pasted.
function canLoadCircleData() {
  if (!activeCircleId) return true;
  if (circleHasToken(readTokenMap(), activeCircleId)) return true;
  return lastFamilies.length <= 1;
}

async function switchCircle(id) {
  activeCircleId = id;
  localStorage.setItem('fh_circle_id', id);
  currentTopic = null;
  $('topicTitle').textContent = '';
  $('entries').innerHTML = '';
  $('topics').innerHTML = '';
  renderTokenNotice();
  await loadTopics();
}
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

async function loadTopics() {
  if (!canLoadCircleData()) return; // token notice showing; never fetch with the wrong token
  try {
    const { topics } = await api('/v1/topics');
    $('circleError').textContent = '';
    $('topics').innerHTML = '';
    topics.forEach(t => {
      const b = document.createElement('button');
      b.textContent = t.subject + (t.parent_topic_id ? ' (linked)' : '');
      b.onclick = () => loadTopic(t.id, t.subject);
      $('topics').appendChild(b);
    });
  } catch (e) {
    $('circleError').textContent = 'Could not load topics: ' + e.message;
    // keep existing content
  }
}
async function loadTopic(id, subject) {
  currentTopic = id;
  $('topicTitle').textContent = subject;
  try {
    const { entries } = await api('/v1/topics/' + encodeURIComponent(id) + '/history?limit=100');
    $('entries').innerHTML = entries.map(e =>
      '<div class="entry"><span class="kind">' + esc(e.kind) + '</span> ' +
      '<span class="meta">#' + esc(e.seq) + ' · ' + esc(e.ts) + ' · ' + esc(e.agent_label) + '</span><br>' +
      esc(e.body) + '</div>'
    ).join('');
  } catch (e) {
    $('circleError').textContent = 'Could not load messages: ' + e.message;
  }
}
$('save').onclick = () => {
  localStorage.setItem('fh_base', $('base').value.trim() || location.origin);
  localStorage.setItem('fh_token', $('token').value.trim());
  $('app').style.display = 'block';
  loadCircles().then(() => loadTopics()).catch(e => alert('Connect failed: ' + e.message));
};
$('forget').onclick = () => {
  localStorage.removeItem('fh_token');
  localStorage.removeItem('fh_circle_tokens');
  localStorage.removeItem('fh_circle_id');
  $('token').value = '';
  $('app').style.display = 'none';
};
$('post').onclick = async () => {
  if (!currentTopic) return alert('Pick a topic first');
  try {
    await api('/v1/topics/' + encodeURIComponent(currentTopic) + '/entries',
      { method: 'POST', body: JSON.stringify({ body: $('postBody').value }) });
    $('postBody').value = '';
    loadTopic(currentTopic, $('topicTitle').textContent);
  } catch (e) { alert('Post failed: ' + e.message); }
};
$('createTopic').onclick = async () => {
  const subject = $('newSubject').value.trim();
  if (!subject) return alert('Subject required');
  try {
    // Identity comes from GET /v1/me — the member bound to THIS token. Never
    // /v1/members[0]: the server orders members by creation time, so [0] is
    // typically the owner, and a kid clicking this would otherwise create a
    // topic that discloses to the owner.
    const me = await api('/v1/me');
    const { topic } = await api('/v1/topics', { method: 'POST',
      body: JSON.stringify({ subject, kind: 'group', participant_member_ids: [me.id] }) });
    $('newSubject').value = '';
    await loadTopics();
    loadTopic(topic.id, topic.subject);
  } catch (e) { alert('Create failed: ' + e.message); }
};
if (localStorage.getItem('fh_token')) {
  $('base').value = localStorage.getItem('fh_base') || '';
  $('token').value = localStorage.getItem('fh_token');
  $('app').style.display = 'block';
  loadCircles().then(() => loadTopics()).catch(() => {});
}
</script>
</body>
</html>`;

