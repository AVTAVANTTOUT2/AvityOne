// End-to-end checks against a scripted ACP agent: routing, context injection, permissions, plan mode, MCP memory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
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
const { exportMarkdown, summarize } = await import('../src/context.ts');
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
