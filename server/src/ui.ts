// Minimal human web UI (read/post), served by the worker at /.
// Single self-contained HTML page, no external assets. The human pastes their
// agent token once; it is kept in localStorage of their own browser only.
//
// One user agent credential covers its active server memberships.

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
  <p>All conversations are encrypted. Create topics and send messages through your Muse.</p>
  <h2 id="topicTitle"></h2>
  <div id="entries"></div>
</div>
<script>
${CIRCLE_LOGIC_SRC}
const $ = (id) => document.getElementById(id);
let activeCircleId = localStorage.getItem('fh_circle_id') || null;
let lastFamilies = [];

function cfg() {
  return {
    base: (localStorage.getItem('fh_base') || location.origin).replace(/\\/$/, ''),
    token: localStorage.getItem('fh_token') || ''
  };
}
async function api(path, opts = {}) {
  const { base } = cfg();
  const { circleId, ...fetchOpts } = opts;
  const token = cfg().token;
  const selected = circleId === undefined ? activeCircleId : circleId;
  const res = await fetch(base + path, {
    ...fetchOpts,
    headers: { ...(opts.headers || {}), 'content-type': 'application/json', 'authorization': 'Bearer ' + token, ...(selected ? {'X-Circle-ID':selected} : {}) }
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
    const data = await api('/v2/families', { circleId: null });
    families = Array.isArray(data.families) ? data.families : [];
  } catch (e) {
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
}

function canLoadCircleData() {
  return !!activeCircleId && lastFamilies.some(function (f) {return f.id === activeCircleId;});
}

async function switchCircle(id) {
  activeCircleId = id;
  localStorage.setItem('fh_circle_id', id);
  $('topicTitle').textContent = '';
  $('entries').innerHTML = '';
  $('topics').innerHTML = '';
  await loadTopics();
}
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

async function loadTopics() {
  if (!canLoadCircleData()) return;
  try {
    const { topics } = await api('/v2/topics');
    $('circleError').textContent = '';
    $('topics').innerHTML = '';
    topics.forEach(t => {
      const b = document.createElement('button');
      const badge = document.createElement('span');
      badge.className = 'lockBadge';
      badge.textContent = '🔒 [encrypted]';
      b.appendChild(badge);
      b.onclick = () => loadTopic(t.id);
      $('topics').appendChild(b);
    });
  } catch (e) {
    $('circleError').textContent = 'Could not load topics: ' + e.message;
    // keep existing content
  }
}
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
  return head + '<span class="meta">(system event)</span></div>';
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
      api('/v2/topics/' + encodeURIComponent(id)),
      api('/v2/topics/' + encodeURIComponent(id) + '/history?limit=100')
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
async function loadTopic(id) {
  $('topicTitle').textContent = '🔒 encrypted topic';
  await loadE2eeTopic(id);
}
$('save').onclick = () => {
  localStorage.setItem('fh_base', $('base').value.trim() || location.origin);
  localStorage.setItem('fh_token', $('token').value.trim());
  $('app').style.display = 'block';
  loadCircles().then(() => loadTopics()).catch(e => alert('Connect failed: ' + e.message));
};
$('forget').onclick = () => {
  localStorage.removeItem('fh_token');
  localStorage.removeItem('fh_circle_id');
  $('token').value = '';
  $('app').style.display = 'none';
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

