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
  .e2eeBanner { background: #fff4e0; border: 2px solid #e6a817; border-radius: 8px; padding: 0.8rem; margin: 0.8rem 0; font-size: 0.95rem; }
  .archivedBanner { background: #eef3ff; border: 1px solid #9db4e8; border-radius: 8px; padding: 0.6rem; margin: 0.6rem 0; }
  .sysEvent { color: #555; font-size: 0.9rem; }
  .lockBadge { display: inline-block; background: #fff4e0; border: 1px solid #e6a817; border-radius: 4px; padding: 0 0.4rem; font-size: 0.75rem; }
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
  <div class="meta">Topics created here are plaintext. Encrypted (E2EE) topics are created with the agent CLI (<code>hub new-topic --e2ee</code>).</div>
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
      const e2ee = t.e2ee === 1;
      // E2EE subjects are ciphertext opaque to the server — never render the
      // blob. Metadata-only label instead.
      if (e2ee) {
        b.innerHTML = '';
        const badge = document.createElement('span');
        badge.className = 'lockBadge';
        badge.textContent = '🔒 encrypted';
        b.appendChild(badge);
        b.appendChild(document.createTextNode(' [encrypted]'));
      } else {
        b.textContent = t.subject + (t.parent_topic_id ? ' (linked)' : '');
      }
      b.onclick = () => loadTopic(t.id, t.subject, e2ee);
      $('topics').appendChild(b);
    });
  } catch (e) {
    $('circleError').textContent = 'Could not load topics: ' + e.message;
    // keep existing content
  }
}
let currentTopicE2ee = false;
// Shared renderer: a retired topic's pointer entry is a "retired →
// continues at <id>" banner, never a normal message — in E2EE and plaintext
// views alike.
function renderArchivedBanner(e) {
  const data = (e.data && typeof e.data === 'object') ? e.data : {};
  const succ = data.successor_topic_id || null;
  return '<div class="archivedBanner">🗄 <strong>This topic was retired.</strong>' +
    (succ ? ' Discussion continues at <code>' + esc(succ) + '</code>.' : ' No successor topic was named.') +
    (e.body ? '<br><span class="meta">' + esc(e.body) + '</span>' : '') +
    '</div>';
}
// E2EE system kinds are plaintext by design (the CLI posts them via its
// loud plaintext system-entry path) so agents without the topic key can
// still read them. Everything else with an fh1.* wire body is ciphertext.
function isSystemKind(kind) {
  return kind === 'key_rotated' || kind === 'key_request' || kind === 'pending_key_distribution';
}
function renderE2eeEntry(e) {
  const head = '<div class="entry"><span class="kind">' + esc(e.kind) + '</span> ' +
    '<span class="meta">#' + esc(e.seq) + ' · ' + esc(e.ts) + ' · ' + esc(e.agent_label) + '</span><br>';
  if (e.kind === 'topic_archived') return renderArchivedBanner(e);
  if (isSystemKind(e.kind)) {
    return head + '<span class="sysEvent">' + esc(e.body) + '</span></div>';
  }
  if (typeof e.body === 'string' && e.body.indexOf('fh1.') === 0) {
    return head + '<span class="meta">(encrypted content — the dashboard holds no keys, so the body is not shown)</span></div>';
  }
  // Plaintext by accident or design on an E2EE topic: it IS readable, so
  // render it honestly rather than hiding it.
  return head + esc(e.body) + '</div>';
}
// The dashboard has no E2EE keys by design: subjects and message bodies
// stay opaque. This view is metadata only — participants, counts, plaintext
// system events — with an honest, prominent label. Key import into the
// dashboard is deferred (not supported), so reading or posting in an
// encrypted topic means using the agent CLI.
async function loadE2eeTopic(id) {
  const box = $('entries');
  try {
    const [detail, hist] = await Promise.all([
      api('/v1/topics/' + encodeURIComponent(id)),
      api('/v1/topics/' + encodeURIComponent(id) + '/history?limit=100')
    ]);
    const participants = (detail.participants || [])
      .map(p => esc(p.name) + ' (' + esc(p.role) + ')').join(', ') || '—';
    const entries = hist.entries || [];
    const rotations = entries.filter(e => e.kind === 'key_rotated').length;
    const count = (hist.max_seq != null) ? hist.max_seq : entries.length;
    let html = '<div class="e2eeBanner">🔒 <strong>Content encrypted — the server cannot read this topic.</strong><br>' +
      'Subjects and message bodies are encrypted with keys the server never sees, and this dashboard holds no keys, ' +
      'so nothing below is decryptable. What you see is <strong>metadata only</strong>: participants, message counts, ' +
      'and plaintext system events (key rotations, archive notices).<br>' +
      'Key import into the dashboard is not supported. Read or post in this topic with the agent CLI: ' +
      '<code>hub read --topic ' + esc(id) + '</code></div>';
    html += '<div class="meta">Participants: ' + participants + ' · Messages: ' + count +
      ' · Key rotations: ' + rotations + '</div>';
    box.innerHTML = html + entries.map(renderE2eeEntry).join('');
  } catch (e) {
    $('circleError').textContent = 'Could not load topic metadata: ' + e.message;
  }
}
async function loadPlainTopic(id) {
  try {
    const { entries } = await api('/v1/topics/' + encodeURIComponent(id) + '/history?limit=100');
    $('entries').innerHTML = entries.map(e =>
      e.kind === 'topic_archived' ? renderArchivedBanner(e) :
      '<div class="entry"><span class="kind">' + esc(e.kind) + '</span> ' +
      '<span class="meta">#' + esc(e.seq) + ' · ' + esc(e.ts) + ' · ' + esc(e.agent_label) + '</span><br>' +
      esc(e.body) + '</div>'
    ).join('');
  } catch (e) {
    $('circleError').textContent = 'Could not load messages: ' + e.message;
  }
}
async function loadTopic(id, subject, isE2ee) {
  currentTopic = id;
  currentTopicE2ee = !!isE2ee;
  if (currentTopicE2ee) {
    $('topicTitle').innerHTML = '';
    const badge = document.createElement('span');
    badge.className = 'lockBadge';
    badge.textContent = '🔒 encrypted topic';
    $('topicTitle').appendChild(badge);
    await loadE2eeTopic(id);
  } else {
    $('topicTitle').textContent = subject;
    await loadPlainTopic(id);
  }
  updatePostUi();
}
// Posting needs the plaintext-encrypting CLI: the dashboard holds no keys,
// so its Post box is disabled on encrypted topics rather than posting
// something unreadable (or failing server-side).
function updatePostUi() {
  $('post').disabled = currentTopicE2ee;
  $('postBody').disabled = currentTopicE2ee;
  let note = $('postNote');
  if (!note) {
    note = document.createElement('div');
    note.id = 'postNote';
    note.className = 'meta';
    $('post').insertAdjacentElement('afterend', note);
  }
  note.textContent = currentTopicE2ee
    ? 'Posting to an encrypted topic is not available in the dashboard (it holds no keys). Use the agent CLI: hub post --topic <id> --message "…".'
    : '';
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

