// Minimal human web UI (read/post), served by the worker at /.
// Single self-contained HTML page, no external assets. The human pastes their
// agent token once; it is kept in localStorage of their own browser only.

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

function cfg() {
  return {
    base: (localStorage.getItem('fh_base') || location.origin).replace(/\\/$/, ''),
    token: localStorage.getItem('fh_token') || ''
  };
}
async function api(path, opts = {}) {
  const { base, token } = cfg();
  const { unscoped, ...fetchOpts } = opts;
  const finalPath = unscoped ? path : circleScopedPath(path, activeCircleId);
  const res = await fetch(base + finalPath, {
    ...fetchOpts,
    headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + token, ...(opts.headers || {}) }
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
    const data = await api('/v1/families', { unscoped: true });
    families = Array.isArray(data.families) ? data.families : [];
  } catch (e) {
    if (/HTTP 404/.test(e.message)) {
      // Server predates multi-circle support: single-circle mode, stay quiet.
      box.style.display = 'none';
      errBox.textContent = '';
      activeCircleId = null;
      return;
    }
    errBox.textContent = 'Could not load circles: ' + e.message;
    return;
  }
  errBox.textContent = '';
  const active = circleResolveActive(families, activeCircleId);
  activeCircleId = active ? active.id : null;
  if (activeCircleId) localStorage.setItem('fh_circle_id', activeCircleId);
  else localStorage.removeItem('fh_circle_id');
  if (families.length === 0) {
    box.style.display = 'block';
    box.innerHTML = '<span class="meta">You are not a member of any circle yet.</span>';
    return;
  }
  if (!circleShouldShowSwitcher(families)) {
    box.style.display = 'none';
    box.innerHTML = '';
    return;
  }
  box.style.display = 'block';
  box.innerHTML = '';
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
}
async function switchCircle(id) {
  activeCircleId = id;
  localStorage.setItem('fh_circle_id', id);
  currentTopic = null;
  $('topicTitle').textContent = '';
  $('entries').innerHTML = '';
  try {
    await loadTopics();
  } catch (e) { alert('Could not load topics: ' + e.message); }
}
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

async function loadTopics() {
  const { topics } = await api('/v1/topics');
  $('topics').innerHTML = '';
  topics.forEach(t => {
    const b = document.createElement('button');
    b.textContent = t.subject + (t.parent_topic_id ? ' (linked)' : '');
    b.onclick = () => loadTopic(t.id, t.subject);
    $('topics').appendChild(b);
  });
}
async function loadTopic(id, subject) {
  currentTopic = id;
  $('topicTitle').textContent = subject;
  const { entries } = await api('/v1/topics/' + encodeURIComponent(id) + '/history?limit=100');
  $('entries').innerHTML = entries.map(e =>
    '<div class="entry"><span class="kind">' + esc(e.kind) + '</span> ' +
    '<span class="meta">#' + e.seq + ' · ' + esc(e.ts) + ' · ' + esc(e.agent_label) + '</span><br>' +
    esc(e.body) + '</div>'
  ).join('');
}
$('save').onclick = () => {
  localStorage.setItem('fh_base', $('base').value.trim() || location.origin);
  localStorage.setItem('fh_token', $('token').value.trim());
  $('app').style.display = 'block';
  loadCircles().then(() => loadTopics()).catch(e => alert('Connect failed: ' + e.message));
};
$('forget').onclick = () => { localStorage.removeItem('fh_token'); $('token').value = ''; $('app').style.display = 'none'; };
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
    const me = await api('/v1/members');
    const self = me.members[0];
    const { topic } = await api('/v1/topics', { method: 'POST',
      body: JSON.stringify({ subject, kind: 'group', participant_member_ids: [self.id] }) });
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
