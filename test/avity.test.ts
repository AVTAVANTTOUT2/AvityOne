// End-to-end checks against a scripted ACP agent: routing, context injection, permissions, plan mode, MCP memory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const home = mkdtempSync(join(tmpdir(), 'avity-test-'));
process.env.AVITY_HOME = home;
const fake = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url));
writeFileSync(join(home, 'config.json'), JSON.stringify({
  token: 'test',
  projectsDir: join(home, 'projects'),
  defaultAgent: 'fake',
  routes: [{ match: '\\bbug\\b', agent: 'fake2' }],
  // Never fall back on a real agent CLI installed on the machine.
  reviewer: { fake: 'fake2', fake2: 'fake' },
  summarizer: { agent: 'fake' },
  agents: { fake: { name: 'Fake', cmd: process.execPath, args: [fake], strengths: '' }, fake2: { name: 'Fake2', cmd: process.execPath, args: [fake], strengths: '' } },
}));

const { route } = await import('../src/router.ts');
const { ftsQuery, addMemory, searchMemory, searchHistory, run, one } = await import('../src/store.ts');
const { hub, planTasks } = await import('../src/hub.ts');
const { exportMarkdown, summarize, buildPack } = await import('../src/context.ts');
const { config } = await import('../src/config.ts');
const avail = ['fake', 'fake2'];

test('router: mention, /plan, rules, continuity', () => {
  assert.deepEqual(route('@fake2 fais ça', avail), { agent: 'fake2', mode: 'agent', prompt: 'fais ça', reason: 'mention @fake2' });
  assert.equal(route('/plan refonte auth', avail).mode, 'plan');
  assert.equal(route('corrige ce bug', avail).agent, 'fake2');
  assert.equal(route('corrige ce bug', avail, {}, 'fake').agent, 'fake'); // a running session keeps its agent
  assert.equal(route('salut', avail).reason, 'agent par défaut');
  assert.throws(() => route('x', avail, { agent: 'absent' }));
});

test('fts: accents folded, user text cannot inject FTS syntax', () => {
  assert.equal(ftsQuery('Décision: NOT "auth" OR config*'), '"decision" OR "auth" OR "config"');
  addMemory(999, 'decision', 'On utilise SQLite FTS5 pour la mémoire');
  assert.equal(searchMemory(999, 'mémoire sqlite')[0].kind, 'decision');
  assert.equal(addMemory(999, 'fact', 'On utilise SQLite FTS5 pour la mémoire'), false); // dedup
});

async function waitIdle(id: string) {
  for (let i = 0; i < 200; i++) {
    const snap = hub.snapshot(id);
    if (!snap.state.busy) return snap;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timeout');
}

test('hub: agent turn with context pack, auto-approved edit, diff and plan', async () => {
  const p = await hub.createProject({ name: 'demo' });
  const s = hub.createSession(p.id);
  hub.prompt(s.id, 'ajoute une feature');
  const snap = await waitIdle(s.id);
  const types = snap.items.map((i: any) => i.type);
  assert.deepEqual(types, ['user', 'info', 'assistant', 'tool', 'plan', 'end']);
  assert.equal(snap.items[2].text, 'mode=default ctx=true');
  assert.equal(snap.items[3].status, 'completed');
  assert.equal(snap.items[3].diffs[0].path, 'a.txt');

  // second turn: same live agent, no second context pack
  hub.prompt(s.id, 'continue');
  const snap2 = await waitIdle(s.id);
  assert.equal(snap2.items.filter((i: any) => i.type === 'info').length, 1);
  assert.equal(snap2.items.at(-4).text, 'mode=default ctx=false');
});

test('hub: plan mode asks before edits, and switching agent hands off context', async () => {
  const p = await hub.createProject({ name: 'demo2' });
  const s = hub.createSession(p.id);
  hub.prompt(s.id, 'refonte', { mode: 'plan' });
  let perm: any;
  for (let i = 0; i < 200 && !perm; i++) {
    perm = hub.snapshot(s.id).items.find((it: any) => it.type === 'permission');
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(perm, 'edit in plan mode must ask the user');
  hub.respondPermission(s.id, perm.id, 'no');
  const snap = await waitIdle(s.id);
  assert.equal(snap.items.find((i: any) => i.type === 'assistant').text, 'mode=plan ctx=true');
  assert.equal(snap.items.find((i: any) => i.type === 'tool').status, 'failed');
  assert.equal(snap.items.find((i: any) => i.type === 'permission').resolved, 'Reject');

  hub.prompt(s.id, '@fake2 exécute');
  const snap2 = await waitIdle(s.id);
  const info = snap2.items.filter((i: any) => i.type === 'info').at(-1);
  assert.match(info.text, /Fake2.*reprise/);
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
function gitRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'avity-repo-'));
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'README.md'), '# Dépôt de test\n');
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  return dir;
}
async function waitFor<T>(fn: () => T): Promise<T> {
  for (let i = 0; i < 400; i++) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error('timeout');
}

test('plan tasks: agent plan entries, else the numbered list of the last answer', () => {
  const s = hub.createSession(1);
  const add = (it: object) => run('INSERT INTO items (session_id, data) VALUES (?, ?)', s.id, JSON.stringify(it));
  add({ type: 'assistant', text: 'Plan :\n1. **Auth** : sessions\n   1. sous-étape\n2) Tests\n### 3. Docs\nFin.' });
  assert.deepEqual(planTasks(s.id).tasks, ['Auth : sessions', 'Tests', 'Docs']);
  add({ type: 'plan', entries: [{ content: 'A' }, { content: 'B' }] });
  assert.deepEqual(planTasks(s.id), { plan: '1. A\n2. B', tasks: ['A', 'B'] });
});

test('worktree: an isolated session gets its own worktree on its first agent turn, merge cleans it up', async () => {
  const repo = gitRepo();
  const p = await hub.createProject({ name: 'iso', path: repo });
  const s = hub.createSession(p.id, undefined, { isolated: true });
  hub.prompt(s.id, 'regarde puis exitplan', { mode: 'plan' });
  const planned = await waitIdle(s.id);
  assert.equal(planned.state.worktree, null, 'plan mode stays in the project');
  assert.match(planned.items.find((i: any) => i.type === 'permission').resolved, /session isolée/, 'leaving plan mode is deferred to « Exécuter le plan »');

  hub.prompt(s.id, 'go', { mode: 'agent' });
  const snap = await waitIdle(s.id);
  const wt = join(repo, '.avity', 'worktrees', s.id);
  assert.equal(snap.state.worktree, wt);
  assert.ok(existsSync(wt));
  assert.match(snap.items.find((i: any) => i.text?.startsWith('🌿')).text, new RegExp(`avity/${s.id}`));
  assert.equal(snap.items.filter((i: any) => i.type === 'assistant').at(-1).text, 'mode=default ctx=true', 'restarted inside the worktree with a fresh context pack');
  assert.equal(git(repo, 'status', '--porcelain'), '', 'worktrees stay out of the project status');

  assert.deepEqual(await hub.merge(s.id), { merged: 1, failed: 0 });
  assert.ok(!existsSync(wt));
  assert.equal(git(repo, 'branch', '--format=%(refname:short)', '--list', 'avity/*'), '');
  assert.equal(hub.snapshot(s.id).state.worktree, null);

  const plain = hub.createSession((await hub.createProject({ name: 'iso-nogit' })).id, undefined, { isolated: true });
  hub.prompt(plain.id, 'go');
  assert.equal((await waitIdle(plain.id)).state.worktree, null, 'non-git project: unchanged behaviour');
});

test('parallel: plan split into sub-sessions in worktrees, routed agents, merge with a conflict, then review', async () => {
  const repo = gitRepo();
  const p = await hub.createProject({ name: 'par', path: repo });
  const parent = hub.createSession(p.id);
  hub.prompt(parent.id, 'découpe :\n1. crée write:a.txt\n2. corrige le bug write:b.txt\n3. réécris write:a.txt');
  await waitIdle(parent.id);

  const item = await hub.parallel(parent.id);
  assert.deepEqual(item.children.map((c: any) => c.agent), ['fake', 'fake2', 'fake'], 'router picks each task\'s agent');
  const card = () => hub.snapshot(parent.id).items.find((i: any) => i.id === item.id);
  await waitFor(() => card().children.every((c: any) => c.status === 'done'));
  const kids = card().children;
  const wt = (k: any) => join(repo, '.avity', 'worktrees', k.id);
  assert.ok(existsSync(join(wt(kids[0]), 'a.txt')) && existsSync(join(wt(kids[1]), 'b.txt')));
  assert.ok(!existsSync(join(repo, 'b.txt')), 'sub-sessions work in their worktrees only');
  const first = readFileSync(join(wt(kids[0]), 'a.txt'), 'utf8');

  assert.deepEqual(await hub.merge(parent.id), { merged: 2, failed: 1 });
  assert.deepEqual(card().children.map((c: any) => c.status), ['merged', 'merged', 'conflict']);
  assert.deepEqual(card().children[2].conflicts, ['a.txt']);
  assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), first);
  assert.ok(existsSync(join(repo, 'b.txt')));
  assert.equal(git(repo, 'status', '--porcelain'), '', 'conflicting merge aborted cleanly');
  assert.ok(!existsSync(wt(kids[0])) && !existsSync(wt(kids[1])) && existsSync(wt(kids[2])), 'only merged worktrees are removed');
  assert.equal(git(repo, 'branch', '--format=%(refname:short)', '--list', 'avity/*'), `avity/${kids[2].id}`);

  const items = hub.snapshot(parent.id).items;
  assert.match(items.find((i: any) => i.type === 'error').text, /conflit sur a\.txt/);
  const review = await waitFor(() => hub.snapshot(parent.id).items.find((i: any) => i.type === 'review' && i.status === 'done'));
  assert.equal(review.agent, 'fake', 'cross-review by the other agent');
});

test('sessions: rename, pin, archive, draft, history search, export, delete', async () => {
  const p = await hub.createProject({ name: 'hist' });
  const a = hub.createSession(p.id), b = hub.createSession(p.id);
  hub.prompt(a.id, 'ajoute une fonctionnalité d\'export');
  await waitIdle(a.id);

  hub.updateSession(a.id, { title: '  Export   Markdown ', pinned: true });
  hub.prompt(b.id, 'autre chose');
  await waitIdle(b.id);
  const rows = hub.listSessions(p.id);
  assert.deepEqual(rows.map((r: any) => r.id), [a.id, b.id], 'pinned first even when older');
  assert.equal(rows[0].title, 'Export Markdown');
  await summarize(a.id); await summarize(b.id);
  assert.equal(hub.snapshot(a.id).session!.title, 'Export Markdown', 'summaries keep a chosen title');
  assert.equal(hub.snapshot(b.id).session!.title, 'Titre automatique');

  hub.setDraft(b.id, 'brouillon en cours');
  assert.equal(hub.snapshot(b.id).session!.draft, 'brouillon en cours');
  assert.equal(hub.snapshot(a.id).session!.draft, null, 'drafts are per session');

  const [hit] = searchHistory(p.id, 'FONCTIONNALITE');
  assert.equal(hit.session_id, a.id, 'accents and case folded');
  assert.match(hit.snippet, /\u0002fonctionnalité\u0003/);
  assert.equal(searchHistory(p.id, 'fonctionnalite expo')[0]?.session_id, a.id, 'all words, last one as a prefix');
  assert.equal(searchHistory(p.id, 'fonctionnalite absent').length, 0);
  assert.equal(searchHistory(p.id, 'ctx=true')[0]?.hits, 1, 'streamed answers are indexed once, with their final text');

  const md = exportMarkdown(a.id);
  assert.match(md.filename, /^export-markdown-\d{4}-\d{2}-\d{2}\.md$/);
  assert.match(md.markdown, /^# Export Markdown\n/);
  assert.match(md.markdown, /### Toi → Fake\n\najoute une fonctionnalité d'export/);
  assert.match(md.markdown, /### Fake\n\nmode=default ctx=true/);

  hub.updateSession(a.id, { archived: true, pinned: false });
  assert.deepEqual(hub.listSessions(p.id).map((r: any) => [r.id, r.archived]), [[b.id, 0], [a.id, 1]], 'archived last');

  const kid = hub.createSession(p.id, 'tâche', { parentId: a.id });
  run('INSERT INTO items (session_id, data) VALUES (?, ?)', kid.id, JSON.stringify({ type: 'user', text: 'sous-tâche fonctionnalité' }));
  const wt = hub.createSession(p.id);
  run('UPDATE sessions SET worktree = ? WHERE id = ?', '/tmp/x', wt.id);
  assert.throws(() => hub.deleteSession(wt.id), /worktree non mergé/);
  assert.deepEqual(hub.deleteSession(a.id), { deleted: 2 }, 'sub-sessions go with their parent');
  assert.throws(() => hub.snapshot(a.id), /session inconnue/);
  assert.equal(one('SELECT count(*) AS n FROM items WHERE session_id IN (?, ?)', a.id, kid.id)!.n, 0);
  assert.equal(searchHistory(p.id, 'fonctionnalite').length, 0, 'search index cleaned up');
});

test('fork: whole or at a message, live controls dropped, the copy resumes with the transcript', async () => {
  const p = await hub.createProject({ name: 'fork' });
  const s = hub.createSession(p.id);
  hub.prompt(s.id, 'premier sujet');
  await waitIdle(s.id);
  hub.prompt(s.id, 'second sujet');
  await waitIdle(s.id);
  hub.prompt(s.id, '@fake2 passe la main');
  await waitIdle(s.id);
  hub.updateSession(s.id, { title: 'Source' });
  const items = hub.snapshot(s.id).items;
  const second = items.filter((i: any) => i.type === 'user')[1];

  const dup = hub.fork(s.id);
  assert.equal(dup.title, 'Source (copie)');
  assert.equal(dup.forked_from, s.id);
  assert.equal(dup.acp_session_id, null);
  assert.equal(dup.turns, 3);
  assert.equal(dup.agent, 'fake2', 'the copy goes on with whoever answered last');
  assert.deepEqual(hub.snapshot(dup.id).items.map((i: any) => i.text ?? i.type), items.map((i: any) => i.text ?? i.type));

  const br = hub.fork(s.id, { before: second.id });
  assert.equal(br.title, 'Source (bifurcation)');
  assert.equal(br.turns, 1);
  assert.equal(br.agent, 'fake', 'a fork goes on with the agent of its own last turn');
  assert.deepEqual(hub.snapshot(br.id).items.filter((i: any) => i.type === 'user').map((i: any) => i.text), ['premier sujet']);
  hub.prompt(br.id, 'autre suite');
  const snap = await waitIdle(br.id);
  assert.match(snap.items.filter((i: any) => i.type === 'info').at(-1).text, /reprise/, 'fresh agent, copied transcript handed off');
  assert.equal(snap.items.filter((i: any) => i.type === 'assistant').at(-1).text, 'mode=default ctx=true');
  assert.equal(hub.snapshot(s.id).items.length, items.length, 'source untouched');

  const raw = hub.createSession(p.id);
  const add = (it: object) => run('INSERT INTO items (session_id, data) VALUES (?, ?)', raw.id, JSON.stringify(it));
  add({ type: 'permission', title: 'Edit', options: [{ id: 'yes', name: 'Allow', kind: 'allow_once' }] });
  add({ type: 'review', agent: 'fake', status: 'running', text: '' });
  add({ type: 'parallel', children: [{ id: 'x', task: 'tâche', agent: 'fake', status: 'running' }] });
  const copy = hub.snapshot(hub.fork(raw.id).id).items;
  assert.equal(copy[0].resolved, 'annulé');
  assert.equal(copy[1].status, 'error');
  assert.equal(copy[2].type, 'info');
  assert.match(copy[2].text, /tâche → fake/);
});

test('edit and regenerate: the conversation is cut at the message, the agent restarts with what remains', async () => {
  const p = await hub.createProject({ name: 'edit' });
  const s = hub.createSession(p.id);
  const resets: any[] = [];
  const spy = (ev: any) => { if (ev.type === 'reset' && ev.sessionId === s.id) resets.push(ev); };
  hub.listeners.add(spy);
  hub.prompt(s.id, 'premier message');
  await waitIdle(s.id);
  hub.prompt(s.id, 'message zygomatique');
  await waitIdle(s.id);
  const [first, second] = hub.snapshot(s.id).items.filter((i: any) => i.type === 'user');
  const texts = (snap: any) => snap.items.filter((i: any) => i.type === 'user').map((i: any) => i.text);

  assert.equal(hub.edit(s.id, second.id, 'message corrigé').sessionId, s.id);
  let snap = await waitIdle(s.id);
  assert.deepEqual(texts(snap), ['premier message', 'message corrigé']);
  assert.deepEqual([snap.items.at(-6).edited, snap.items.at(-6).reason], [true, 'même agent']);
  assert.deepEqual(resets.map((e) => e.fromId), [second.id]);
  assert.match(snap.items.filter((i: any) => i.type === 'info').at(-1).text, /reprise/, 'restarted with the first turn handed off');
  assert.equal(searchHistory(p.id, 'zygomatique').length, 0, 'search index follows the cut');
  assert.equal(snap.session!.turns, 2);

  const n = snap.items.length;
  hub.regenerate(s.id, 'fake2');
  snap = await waitIdle(s.id);
  assert.equal(snap.items.length, n, 'last turn replaced, not appended');
  const last = snap.items.filter((i: any) => i.type === 'user').at(-1);
  assert.deepEqual([last.text, last.agent, last.regenerated], ['message corrigé', 'fake2', true]);

  hub.edit(s.id, last.id, '@fake ramène le premier agent');
  snap = await waitIdle(s.id);
  assert.equal(snap.items.filter((i: any) => i.type === 'user').at(-1).agent, 'fake', 'a mention in the new text wins');

  hub.edit(s.id, first.id, 'tout recommencer');
  snap = await waitIdle(s.id);
  assert.deepEqual(texts(snap), ['tout recommencer']);
  assert.doesNotMatch(snap.items.find((i: any) => i.type === 'info').text, /reprise/, 'nothing left to hand off');
  assert.equal(snap.session!.turns, 1);

  const f = hub.edit(s.id, snap.items[0].id, 'variante', { fork: true });
  assert.notEqual(f.sessionId, s.id);
  assert.deepEqual(texts(await waitIdle(f.sessionId)), ['variante']);
  assert.deepEqual(texts(hub.snapshot(s.id)), ['tout recommencer'], 'the original stays as it was');

  hub.prompt(s.id, 'encore');
  assert.throws(() => hub.regenerate(s.id), /occupée/);
  await waitIdle(s.id);
  run('INSERT INTO items (session_id, data) VALUES (?, ?)', s.id, JSON.stringify({ type: 'parallel', children: [] }));
  assert.throws(() => hub.regenerate(s.id), /parallèle/);
  assert.throws(() => hub.edit(s.id, snap.items[1].id, 'x'), /introuvable/, 'only user messages can be edited');
  hub.listeners.delete(spy);
});

test('activity: waiting, done and error events, live state in session lists', async () => {
  const p = await hub.createProject({ name: 'act' });
  const s = hub.createSession(p.id);
  hub.updateSession(s.id, { title: 'Suivie' });
  const evs: any[] = [];
  const spy = (ev: any) => { if (ev.type === 'activity' && ev.sessionId === s.id) evs.push(ev); };
  hub.listeners.add(spy);
  const mine = () => hub.activityList().filter((a) => a.sessionId === s.id);

  hub.prompt(s.id, 'refonte', { mode: 'plan' }); // in plan mode the edit waits for the user
  const perm = await waitFor(() => hub.snapshot(s.id).items.find((i: any) => i.type === 'permission'));
  assert.equal(hub.snapshot(s.id).state.waiting, true);
  assert.deepEqual(hub.listSessions(p.id).map((r) => [r.busy, r.waiting]), [[true, true]]);
  assert.deepEqual(mine(), [{ sessionId: s.id, projectId: p.id, busy: true, waiting: true }]);
  hub.respondPermission(s.id, perm.id, 'yes');
  await waitIdle(s.id);
  assert.equal(hub.snapshot(s.id).state.waiting, false);
  assert.deepEqual(mine(), []);

  hub.prompt(s.id, 'crash');
  await waitIdle(s.id);
  assert.deepEqual(evs.map((e) => e.kind), ['waiting', 'done', 'error']);
  assert.equal(evs[0].text, 'Edit a.txt');
  assert.deepEqual([evs[1].text, evs[1].title, evs[1].projectId, evs[1].agent], ['mode=plan ctx=true', 'Suivie', p.id, 'fake']);
  assert.match(evs[2].text, /arrêté/);
  hub.listeners.delete(spy);
});

test('context: unreadable docs, brief and summaries are reported instead of failing or vanishing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'avity-docs-'));
  writeFileSync(join(dir, 'README.md'), '# Lisible\nLe projet zébu.');
  mkdirSync(join(dir, 'piège.md')); // named like a doc, can't be read as one
  const p = await hub.createProject({ name: 'docs', path: dir });
  assert.deepEqual([p.chunks, p.failed], [1, ['piège.md']], 'the readable docs are indexed, the project is created');

  assert.match(buildPack({ ...p, path: join(dir, 'absent') }, 'x', 'zébu').warnings.join(), /dossier de travail introuvable/);
  assert.deepEqual(buildPack(p, 'x', 'zébu').warnings, []);
  mkdirSync(join(dir, '.avity', 'brief.md'), { recursive: true });
  const s = hub.createSession(p.id);
  hub.prompt(s.id, 'zébu');
  const snap = await waitIdle(s.id);
  const warn = snap.items.find((i: any) => i.level === 'warn');
  assert.match(warn.text, /^⚠️ Contexte partiel : brief illisible/);
  assert.equal(snap.items.filter((i: any) => i.type === 'assistant').at(-1).text, 'mode=default ctx=true', 'the agent still gets the rest');

  const saved = config.summarizer;
  config.summarizer = { agent: 'absent', model: '' };
  const memoryWarnings = () => hub.snapshot(s.id).items.filter((i: any) => i.text?.startsWith('⚠️ Mémoire non mise à jour')).length;
  try {
    hub.summarizeBg(s.id);
    await waitFor(() => memoryWarnings());
    hub.summarizeBg(s.id);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(memoryWarnings(), 1, 'said once in a row');
  } finally { config.summarizer = saved; }
});

test('mcp: memory tools over stdio', async () => {
  const mcp = spawn(process.execPath, [fileURLToPath(new URL('../src/mcp.ts', import.meta.url)), '42'], { env: { ...process.env, AVITY_DB: join(home, 'avity.db') } });
  const lines = createInterface({ input: mcp.stdout })[Symbol.asyncIterator]();
  const rpc = async (id: number, method: string, params: object) => {
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return JSON.parse(String((await lines.next()).value)).result;
  };
  assert.equal((await rpc(1, 'initialize', { protocolVersion: '2025-06-18' })).serverInfo.name, 'avity');
  assert.equal((await rpc(2, 'tools/list', {})).tools.length, 3);
  assert.equal((await rpc(3, 'tools/call', { name: 'avity_memory_add', arguments: { kind: 'pitfall', text: 'Le port 7710 est réservé à AvityOne' } })).content[0].text, 'Mémorisé.');
  assert.match((await rpc(4, 'tools/call', { name: 'avity_memory_search', arguments: { query: 'port réservé' } })).content[0].text, /7710/);
  mcp.kill();
});

test.after(() => hub.shutdown());
