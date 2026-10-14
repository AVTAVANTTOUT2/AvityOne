// AvityOne web client — vanilla JS, no build step.
const $ = (s) => document.querySelector(s);
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v != null && v !== false) el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : String(k));
  return el;
}
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

const S = { agents: [], projects: [], project: null, sessions: [], session: null, state: null, items: new Map(), mode: '' };
const feed = $('#feed');

async function api(path, body, method) {
  method ??= body ? 'POST' : 'GET';
  const r = await fetch('/api' + path, {
    method,
    headers: method === 'GET' ? {} : { 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/login') { showLogin(); throw new Error('non authentifié'); }
  if (!r.ok) throw new Error(data.error ?? r.statusText);
  return data;
}

let flashTimer;
function flash(msg) {
  const st = $('#status');
  st.textContent = '⚠️ ' + msg; st.style.color = 'var(--red)';
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { st.style.color = ''; renderState(); }, 5000);
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { flash(e.message); } };

const agentName = (id) => S.agents.find((a) => a.id === id)?.name ?? id ?? '—';
const badge = (id) => (id ? h('span', { class: `badge ${id}` }, agentName(id)) : null);
const rel = (ts) => {
  const s = (Date.now() - new Date(ts.replace(' ', 'T') + 'Z')) / 1000;
  return s < 60 ? 'à l\'instant' : s < 3600 ? `${Math.floor(s / 60)} min` : s < 86400 ? `${Math.floor(s / 3600)} h` : `${Math.floor(s / 86400)} j`;
};
function mdEl(text) {
  const d = h('div', { class: 'md' });
  if (window.marked && window.DOMPurify) d.innerHTML = DOMPurify.sanitize(marked.parse(text ?? ''));
  else { d.style.whiteSpace = 'pre-wrap'; d.textContent = text ?? ''; }
  return d;
}

// ---------- auth & boot ----------

function showLogin() { $('#app').hidden = true; $('#login').hidden = false; $('#token').focus(); }
$('#login').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await api('/login', { token: $('#token').value }); $('#login').hidden = true; boot(); }
  catch (err) { $('#loginErr').textContent = err.message; }
});

async function boot() {
  const st = await api('/state');
  S.agents = st.agents; S.projects = st.projects;
  $('#app').hidden = false;
  renderAgents(); renderProjects(); connectEvents();
  const [, pid, sid] = location.hash.match(/^#\/p\/(\d+)(?:\/s\/([\w-]+))?/) ?? [];
  const p = S.projects.find((x) => String(x.id) === (pid ?? store.get('avity.project'))) ?? S.projects[0];
  if (p) await openProject(p.id, sid);
}

function renderAgents() {
  $('#agents').replaceChildren(...S.agents.map((a) => h('div', { class: 'row', title: a.strengths }, h('span', { class: `dot ${a.installed ? 'ok' : ''}` }), a.name, a.installed ? null : h('span', { class: 'muted small' }, 'non installé'))));
  const installed = S.agents.filter((a) => a.installed);
  $('#agentSel').replaceChildren(h('option', { value: 'auto' }, 'Auto (routeur)'), ...installed.map((a) => h('option', { value: a.id }, a.name)));
  $('#execAgent').replaceChildren(...installed.map((a) => h('option', { value: a.id }, a.name)));
}

function renderProjects() {
  $('#projects').replaceChildren(...S.projects.map((p) => h('div', { class: `it ${p.id === S.project?.id ? 'on' : ''}`, title: p.path, onclick: () => openProject(p.id) }, '▸ ', p.name)));
}

async function openProject(id, sessionId) {
  S.project = S.projects.find((p) => p.id === Number(id));
  store.set('avity.project', String(id));
  renderProjects();
  await loadSessions();
  const sid = sessionId ?? S.sessions[0]?.id;
  if (sid) await openSession(sid); else { S.session = null; S.state = null; feed.replaceChildren(h('div', { class: 'empty' }, 'Aucune session. Crée-en une avec ＋.')); renderState(); }
  loadMemory();
  $('#side').classList.remove('open');
}

async function loadSessions() {
  if (!S.project) return;
  S.sessions = await api(`/projects/${S.project.id}/sessions`);
  $('#sessions').replaceChildren(...S.sessions.map((s) => h('div', { class: `it ${s.id === S.session?.id ? 'on' : ''}`, title: s.summary ?? '', onclick: () => openSession(s.id) },
    s.parent_id ? '↳ ' : '', s.title ?? 'Nouvelle session', h('span', { class: 'sub' }, s.agent ? agentName(s.agent).split(' ')[0] + ' · ' : '', rel(s.updated_at)))));
}

async function openSession(id) {
  const snap = await api(`/sessions/${id}`);
  S.session = snap.session; S.state = snap.state; S.items = new Map();
  location.hash = `#/p/${S.project.id}/s/${id}`;
  feed.replaceChildren();
  for (const it of snap.items) renderItem(it);
  if (!snap.items.length) feed.append(h('div', { class: 'empty', id: 'emptyHint' }, 'Nouvelle session. Le contexte du projet (mémoire, docs, git, sessions passées) sera injecté automatiquement.'));
  feed.scrollTop = feed.scrollHeight;
  renderState(); loadSessions(); refreshContext();
  $('#side').classList.remove('open');
  $('#input').focus();
}

// ---------- live events ----------

function connectEvents() {
  const es = new EventSource('/api/events');
  let broken = false;
  es.onerror = () => { broken = true; };
  es.onopen = () => { if (broken && S.session) openSession(S.session.id); broken = false; };
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    if (ev.type === 'sessions') { if (ev.projectId === S.project?.id) loadSessions(); return; }
    if (ev.sessionId !== S.session?.id) return;
    if (ev.type === 'item') queueItem(ev.item);
    else if (ev.type === 'state') { S.state = ev.state; renderState(); }
  };
}

const queued = new Map();
let frame = 0;
function queueItem(it) {
  queued.set(it.id, it);
  frame ||= requestAnimationFrame(() => {
    frame = 0;
    const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 120;
    for (const q of queued.values()) renderItem(q);
    queued.clear();
    if (atBottom) feed.scrollTop = feed.scrollHeight;
    renderState();
  });
}

// ---------- rendering ----------

function renderItem(it) {
  $('#emptyHint')?.remove();
  S.items.set(it.id, it);
  const el = buildItem(it);
  el.id = 'it' + it.id;
  const old = document.getElementById(el.id);
  if (old) {
    const open = [...old.querySelectorAll('details')].map((d) => d.open);
    el.querySelectorAll('details').forEach((d, i) => { if (open[i] != null) d.open = open[i]; });
    old.replaceWith(el);
  } else feed.append(el);
}

const KIND_ICON = { read: '📄', edit: '✏️', delete: '🗑️', move: '↪️', search: '🔎', execute: '▶️', think: '💭', fetch: '🌐', switch_mode: '⇄' };
const STATUS = { pending: 'en attente', in_progress: 'en cours', completed: '✓', failed: 'échec', running: 'en cours', done: '✓', error: 'erreur',
  waiting: 'validation requise', merged: 'mergé', conflict: 'conflit' };
const merge = guard(async (e) => {
  e.target.disabled = true;
  try { await api(`/sessions/${S.session.id}/merge`, {}); } finally { e.target.disabled = false; }
});

function buildItem(it) {
  switch (it.type) {
    case 'user':
      return h('div', { class: 'msg user' },
        h('div', { class: 'meta' }, 'Toi →', badge(it.agent), it.mode === 'plan' ? h('span', { class: 'badge plan' }, 'plan') : null, h('span', {}, it.reason)),
        h('div', { class: 'bubble' }, it.text));
    case 'assistant':
      return h('div', { class: 'msg' }, h('div', { class: 'meta' }, badge(it.agent)), mdEl(it.text));
    case 'thought':
      return h('details', { class: 'thought' }, h('summary', {}, '💭 Réflexion'), h('div', { style: 'white-space:pre-wrap' }, it.text));
    case 'tool': {
      const body = [];
      if (it.command) body.push(h('pre', {}, '$ ' + it.command));
      if (it.paths?.length) body.push(h('div', { class: 'muted small' }, it.paths.join('   ')));
      for (const d of it.diffs ?? []) body.push(diffEl(d));
      if (it.output) body.push(h('pre', {}, it.output));
      return h('div', { class: 'tool' }, h('details', {},
        h('summary', {}, KIND_ICON[it.kind] ?? '🔧', h('span', { class: 't' }, it.title), h('span', { class: `st ${it.status}` }, STATUS[it.status] ?? it.status)),
        body.length ? h('div', { class: 'body' }, body) : null));
    }
    case 'plan':
      return h('div', { class: 'card plan' }, h('h4', {}, '📋 Plan'),
        h('ul', {}, it.entries.map((e) => h('li', { class: e.status }, e.status === 'completed' ? '● ' : e.status === 'in_progress' ? '◐ ' : '○ ', e.content))));
    case 'permission':
      return h('div', { class: 'card perm' },
        h('h4', {}, it.kind === 'switch_mode' ? '✅ Plan prêt — valider pour exécuter ?' : '⚠️ Autorisation demandée', h('span', { class: 'muted' }, it.title)),
        it.text ? mdEl(it.text) : null,
        it.resolved ? h('div', { class: 'muted small' }, '→ ' + it.resolved)
          : h('div', { class: 'row' }, it.options.map((o) => h('button', {
            class: o.kind.startsWith('allow') ? 'primary' : '',
            onclick: guard(() => api(`/sessions/${S.session.id}/permission`, { permId: it.id, optionId: o.id })),
          }, o.name))));
    case 'review':
      return h('div', { class: 'card review' },
        h('h4', {}, '🔍 Revue croisée', badge(it.agent), h('span', { class: `st ${it.status}` }, STATUS[it.status] ?? it.status)),
        mdEl(it.text || '…'),
        it.status === 'done' ? h('div', { class: 'row' }, h('button', { onclick: () => {
          $('#input').value = `Applique les corrections pertinentes de cette revue (ignore les faux positifs, justifie) :\n\n${it.text}`;
          $('#input').focus();
        } }, 'Appliquer les corrections')) : null);
    case 'parallel':
      return h('div', { class: 'card par' }, h('h4', {}, `⚡ Exécution parallèle — ${it.children.length} sous-session(s), une par worktree`),
        h('div', { class: 'kids' }, it.children.map((c) => h('div', { class: 'kid', title: 'Ouvrir la sous-session', onclick: () => openSession(c.id) },
          badge(c.agent), h('span', { class: 't' }, c.task), h('span', { class: `st ${c.status}` }, STATUS[c.status] ?? c.status),
          c.conflicts?.length ? h('div', { class: 'conf' }, '⚠️ conflit sur ' + c.conflicts.join(', ')) : null))),
        it.children.some((c) => c.status !== 'merged')
          ? h('div', { class: 'row' }, h('button', { class: 'primary', title: 'Merge les branches dans la branche courante du projet, puis revue croisée', onclick: merge }, 'Merger'))
          : null);
    case 'info': return h('div', { class: 'info' }, it.text);
    case 'error': return h('div', { class: 'error' }, '⚠️ ' + it.text);
    case 'end': return h('div', { class: 'end' }, it.stopReason === 'end_turn' ? '' : `fin du tour : ${it.stopReason}`);
    default: return h('div', { class: 'info' }, JSON.stringify(it));
  }
}

/** Line diff via LCS, unchanged runs collapsed to 3 lines of context. */
function diffEl(d) {
  const A = d.old ? d.old.split('\n') : [], B = (d.new ?? '').split('\n');
  let ops;
  if (A.length * B.length > 250_000) ops = [...A.map((l) => ['-', l]), ...B.map((l) => ['+', l])];
  else {
    const n = A.length, m = B.length, T = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) T[i][j] = A[i] === B[j] ? T[i + 1][j + 1] + 1 : Math.max(T[i + 1][j], T[i][j + 1]);
    ops = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) { ops.push([' ', A[i]]); i++; j++; } else if (T[i + 1][j] >= T[i][j + 1]) ops.push(['-', A[i++]]); else ops.push(['+', B[j++]]);
    }
    while (i < n) ops.push(['-', A[i++]]);
    while (j < m) ops.push(['+', B[j++]]);
  }
  const near = ops.map((_, k) => ops.slice(Math.max(0, k - 3), k + 4).some((o) => o[0] !== ' '));
  const lines = [];
  ops.forEach((o, k) => {
    if (near[k]) lines.push(h('div', { class: `l ${o[0] === '+' ? 'add' : o[0] === '-' ? 'del' : ''}` }, `${o[0]} ${o[1]}`));
    else if (near[k - 1]) lines.push(h('div', { class: 'l muted' }, '  …'));
  });
  const add = ops.filter((o) => o[0] === '+').length, del = ops.filter((o) => o[0] === '-').length;
  return h('div', { class: 'diff' }, h('div', { class: 'path' }, `${d.path}  `, h('span', { style: 'color:var(--green)' }, `+${add}`), ' ', h('span', { style: 'color:var(--red)' }, `-${del}`)), lines);
}

function renderState() {
  const st = S.state ?? {}, s = S.session;
  $('#sessTitle').textContent = s ? (S.sessions.find((x) => x.id === s.id)?.title ?? s.title ?? 'Nouvelle session') : '—';
  $('#sessMeta').replaceChildren(...(s ? [
    st.agent ? badge(st.agent) : 'aucun agent encore',
    ' ', st.mode === 'plan' ? h('span', { class: 'badge plan' }, 'plan') : 'agent',
    st.modeId ? ` · mode ${st.modeId}` : '', st.connected ? ' · connecté' : '', st.worktree ? ' · 🌿 worktree' : '',
  ] : []));
  $('#status').textContent = st.busy ? `${agentName(st.agent)} travaille…` : '';
  $('#stopBtn').hidden = !st.busy;
  $('#sendBtn').disabled = !s || !!st.busy;
  $('#autoApprove').checked = st.autoApprove ?? true;
  $('#isolated').checked = !!st.isolated;
  $('#isolated').disabled = !s || !!st.worktree;
  $('#mergeBtn').hidden = !st.worktree;
  $('#mergeBtn').disabled = !!st.busy;
  $('#configs').replaceChildren(...(st.configOptions ?? []).filter((o) => o.type === 'select' && o.category !== 'mode').map((o) => {
    const flat = (opts) => opts.flatMap((x) => (x.options ? flat(x.options) : [x]));
    const sel = h('select', { title: o.name, onchange: guard((e) => api(`/sessions/${s.id}/config`, { configId: o.id, value: e.target.value })) },
      flat(o.options).map((x) => h('option', { value: x.value, selected: x.value === o.currentValue }, x.name)));
    return sel;
  }));
  const last = [...S.items.values()].at(-1);
  const planReady = s && !st.busy && st.mode === 'plan' && last?.type === 'end';
  $('#execBar').hidden = !planReady;
  if (planReady && st.agent && !$('#execAgent').dataset.touched) $('#execAgent').value = st.agent;
}

// ---------- actions ----------

const send = guard(async () => {
  const text = $('#input').value.trim();
  if (!text || !S.session) return;
  await api(`/sessions/${S.session.id}/prompt`, { text, agent: $('#agentSel').value, mode: S.mode || undefined });
  $('#input').value = '';
});
$('#sendBtn').onclick = send;
$('#input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  if (e.key === 'Escape' && S.state?.busy) $('#stopBtn').click();
});
$('#stopBtn').onclick = guard(() => api(`/sessions/${S.session.id}/cancel`, {}));
$('#modeSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  S.mode = b.dataset.mode;
  $('#modeSeg').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
});
$('#autoApprove').onchange = guard((e) => api(`/sessions/${S.session.id}/auto-approve`, { on: e.target.checked }));
$('#isolated').onchange = guard((e) => api(`/sessions/${S.session.id}/isolated`, { on: e.target.checked }));
$('#mergeBtn').onclick = merge;
$('#parBtn').onclick = guard(() => api(`/sessions/${S.session.id}/parallel`, {}));
$('#execAgent').onchange = (e) => { e.target.dataset.touched = '1'; };
$('#execBtn').onclick = guard(async () => { await api(`/sessions/${S.session.id}/execute`, { agent: $('#execAgent').value }); delete $('#execAgent').dataset.touched; });
$('#reviewBtn').onclick = guard(() => S.session && api(`/sessions/${S.session.id}/review`, {}));
$('#sumBtn').onclick = guard(async () => {
  if (!S.session) return;
  $('#status').textContent = '🧠 Résumé en cours…';
  const r = await api(`/sessions/${S.session.id}/summarize`, {});
  $('#status').textContent = r.skipped ? 'Rien à résumer.' : `🧠 Résumé : ${r.added ?? 0} connaissance(s) ajoutée(s).`;
  loadSessions(); loadMemory();
});
$('#newSession').onclick = guard(async () => {
  if (!S.project) return flash('crée d\'abord un projet');
  const s = await api(`/projects/${S.project.id}/sessions`, {});
  await loadSessions(); await openSession(s.id);
});

// project dialog
$('#addProject').onclick = () => { $('#projErr').textContent = ''; $('#projForm').reset(); $('#projDialog').showModal(); };
$('#projForm').addEventListener('submit', async (e) => {
  if (e.submitter?.value !== 'ok') return;
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    $('#projErr').textContent = f.get('git') ? 'Clonage…' : '';
    const p = await api('/projects', { name: f.get('name'), path: f.get('path') || undefined, git: f.get('git') || undefined });
    $('#projDialog').close();
    S.projects = (await api('/state')).projects;
    await openProject(p.id);
  } catch (err) { $('#projErr').textContent = err.message; }
});

// side panels
$('#openSide').onclick = () => $('#side').classList.add('open');
$('#closeSide').onclick = () => $('#side').classList.remove('open');
$('#toggleRight').onclick = () => { $('#right').hidden = !$('#right').hidden; store.set('avity.right', $('#right').hidden ? '0' : '1'); if (!$('#right').hidden) { loadMemory(); refreshContext(); } };
if (store.get('avity.right') === '1' && innerWidth > 900) $('#right').hidden = false;
document.querySelector('#right .tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  document.querySelectorAll('#right .tabs button').forEach((x) => x.classList.toggle('on', x === b));
  $('#tab-memory').hidden = b.dataset.tab !== 'memory';
  $('#tab-context').hidden = b.dataset.tab !== 'context';
  if (b.dataset.tab === 'context') refreshContext();
});

const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

const loadMemory = guard(async () => {
  if (!S.project || $('#right').hidden) return;
  const q = $('#memQuery').value.trim();
  const r = await api(`/projects/${S.project.id}/memory${q ? '?q=' + encodeURIComponent(q) : ''}`);
  $('#memStats').textContent = `${r.memory.length} connaissance(s)${q ? ' trouvée(s)' : ''} · ${r.kbChunks} extraits de docs indexés`;
  $('#memList').replaceChildren(
    ...r.memory.map((m) => h('div', { class: 'mem' }, h('div', { class: 'k' }, m.kind), m.text,
      h('button', { class: 'icon x', title: 'Oublier', onclick: guard(async () => { await api(`/memory/${m.id}`, {}, 'DELETE'); loadMemory(); }) }, '✕'))),
    ...r.docs.map((d) => h('div', { class: 'mem doc' }, h('div', { class: 'k' }, '📄 ' + d.path), d.text.slice(0, 500))));
});
$('#memQuery').addEventListener('input', debounce(loadMemory, 250));
$('#memAdd').addEventListener('submit', guard(async (e) => {
  e.preventDefault();
  await api(`/projects/${S.project.id}/memory`, { kind: $('#memKind').value, text: $('#memText').value });
  $('#memText').value = ''; loadMemory();
}));
$('#reindexBtn').onclick = guard(async () => {
  const r = await api(`/projects/${S.project.id}/reindex`, {});
  $('#memStats').textContent = `${r.chunks} extraits indexés.`;
});

const refreshContext = guard(async () => {
  if (!S.session || $('#right').hidden || $('#tab-context').hidden) return;
  const r = await api(`/sessions/${S.session.id}/context?q=${encodeURIComponent($('#ctxQuery').value || $('#input').value)}`);
  $('#ctxPreview').textContent = `${r.stats}\n\n${r.text}`;
});
$('#ctxQuery').addEventListener('input', debounce(refreshContext, 300));

boot().catch(() => showLogin());
