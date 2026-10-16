// End-to-end checks against a scripted ACP agent: routing, context injection, permissions, plan mode, MCP memory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync, unlinkSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { normalizeCursorQuota, readCursorQuota, type CursorReadings } from '../src/cursor-quota.ts';
import { cursorMonthly, cursorWeekly } from './cursor-quota-fixtures.ts';
import { sessionDirection } from '../web/src/shortcuts.ts';
import { normalizeCodexQuota, normalizeClaudeQuota, readCodexQuota, readClaudeQuota } from '../src/quota-source.ts';
import { createRequire } from 'node:module';
import { createAgentProbeRequests } from '../web/src/agentProbes.ts';

const home = mkdtempSync(join(tmpdir(), 'avity-test-'));

test('navigation: les raccourcis de session ne démontent pas un dialogue avec un brouillon', () => {
  const down = { key: 'ArrowDown', altKey: true, ctrlKey: false, metaKey: false, shiftKey: false };
  assert.equal(sessionDirection(down, true), 0);
  assert.equal(sessionDirection({ ...down, key: 'ArrowUp' }, true), 0);
  assert.equal(sessionDirection(down, false), 1);
  assert.equal(sessionDirection({ ...down, key: 'ArrowUp' }, false), -1);
  for (const extra of [{ altKey: false }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { key: 'Enter' }]) {
    assert.equal(sessionDirection({ ...down, ...extra }, false), 0);
  }
});
process.env.AVITY_HOME = home;
const fake = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url));
writeFileSync(join(home, 'config.json'), JSON.stringify({
  token: 'test',
  projectsDir: join(home, 'projects'),
  defaultAgent: 'fake',
  routes: [{ match: '\\bbug\\b', agent: 'fake2' }],
  routing: { fallback: false },
  // Never fall back on a real agent CLI installed on the machine.
  reviewer: { fake: 'fake2', fake2: 'fake' },
  summarizer: { agent: 'fake' },
  agents: { fake: { name: 'Fake', cmd: process.execPath, args: [fake], strengths: '' }, fake2: { name: 'Fake2', cmd: process.execPath, args: [fake], strengths: '' } },
}));

const { route } = await import('../src/router.ts');
const { ftsQuery, addMemory, searchMemory, searchKb, searchHistory, run, one } = await import('../src/store.ts');
const { hub, planTasks } = await import('../src/hub.ts');
const { exportMarkdown, summarize, buildPack, indexProject } = await import('../src/context.ts');
const { listKnowledge, updateKnowledge, knowledgeHistory, restoreKnowledge, removeKnowledge, consolidateKnowledge, exportKnowledge, knowledgeGraph, readSource, sourceFile, importDocument, extractDocument, setContextSelection } = await import('../src/knowledge.ts');
const { listProjects, updateProject, removeProject, projectDocuments, listFolders } = await import('../src/projects.ts');
const { config } = await import('../src/config.ts');
for (const id of Object.keys(config.agents)) if (!['fake', 'fake2'].includes(id)) delete config.agents[id];
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

test('permissions: human wait pauses inactivity, then approval restarts the agent deadline', async () => {
  const fixture = join(home, 'permission-agent.mjs');
  writeFileSync(fixture, `
    import { createInterface } from 'node:readline';
    const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
    let prompt;
    createInterface({ input: process.stdin }).on('line', (line) => {
      const m = JSON.parse(line);
      if (m.method === 'initialize') return send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });
      if (m.method === 'session/new') return send({ id: m.id, result: { sessionId: 'permission-fixture' } });
      if (m.method === 'session/prompt') {
        prompt = m;
        return send({ id: 'permission-1', method: 'session/request_permission', params: {
          sessionId: 'permission-fixture', toolCall: { toolCallId: 'edit-1', kind: 'edit', title: 'Modifier le fichier' },
          options: [{ optionId: 'yes', name: 'Autoriser', kind: 'allow_once' }]
        } });
      }
      if (m.id === 'permission-1' && m.result?.outcome?.optionId === 'yes' &&
          !prompt.params.prompt.some((b) => b.text?.includes('stall-after-approval'))) {
        setTimeout(() => {
          send({ method: 'session/update', params: { sessionId: 'permission-fixture', update: {
            sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Travail terminé après autorisation' }
          } } });
          send({ id: prompt.id, result: { stopReason: 'end_turn' } });
        }, 100);
      }
    });
  `);
  config.agents.permission = { name: 'Permission', cmd: process.execPath, args: [fixture], strengths: '' };
  const previous = config.stallTimeoutMs;
  config.stallTimeoutMs = 200;
  const p = await hub.createProject({ name: 'permission-wait' });
  const sessions: string[] = [];
  try {
    for (const shouldStall of [false, true]) {
      const s = hub.createSession(p.id); sessions.push(s.id);
      hub.setAutoApprove(s.id, false);
      hub.prompt(s.id, shouldStall ? 'stall-after-approval' : 'effectue la modification', { agent: 'permission' });
      const permission = await waitFor(() => hub.snapshot(s.id).items.find((item: any) => item.type === 'permission'));
      await new Promise((resolve) => setTimeout(resolve, 450));
      const waiting = hub.snapshot(s.id);
      assert.equal(waiting.state.waiting, true);
      assert.equal(hub.jobs(s.id)[0].status, 'running', 'human approval must not consume the agent inactivity deadline');
      hub.respondPermission(s.id, permission.id, 'yes');
      await waitIdle(s.id);
      const job = hub.jobs(s.id)[0];
      assert.equal(job.status, shouldStall ? 'error' : 'done', job.error ?? JSON.stringify(job.result));
      if (shouldStall) assert.match(job.error, /bloqué|délai ACP/);
      else assert.match(hub.snapshot(s.id).items.find((item: any) => item.type === 'assistant').text, /Travail terminé/);
    }
  } finally {
    for (const id of sessions) hub.cancel(id);
    config.stallTimeoutMs = previous; delete config.agents.permission;
  }
});

test('ACP: a request timeout disconnects the session and the next turn reconnects', async () => {
  const fixture = join(home, 'timeout-agent.mjs');
  writeFileSync(fixture, `
    import { createInterface } from 'node:readline';
    const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
    createInterface({ input: process.stdin }).on('line', (line) => {
      const m = JSON.parse(line);
      if (m.method === 'initialize') return send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });
      if (m.method === 'session/new') return send({ id: m.id, result: { sessionId: 'timeout-fixture' } });
      if (m.method === 'session/prompt') {
        send({ method: 'session/update', params: { sessionId: 'timeout-fixture', update: {
          sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Réponse' }
        } } });
        send({ id: m.id, result: { stopReason: 'end_turn' } });
      }
    });
  `);
  config.agents.timeout = { name: 'Timeout', cmd: process.execPath, args: [fixture], strengths: '' };
  const previous = config.agentTimeoutMs;
  const p = await hub.createProject({ name: 'timeout-reconnect' }), s = hub.createSession(p.id);
  try {
    hub.prompt(s.id, 'première réponse', { agent: 'timeout' }); await waitIdle(s.id);
    assert.equal(hub.jobs(s.id)[0].status, 'done');
    const pid = hub.get(s.id).a!.conn.proc.pid;
    config.agentTimeoutMs = 100;
    await assert.rejects(hub.setConfig(s.id, 'model', 'ignored'), /délai ACP/);
    assert.equal(hub.snapshot(s.id).state.connected, false, 'a timed-out ACP process must not stay connected');
    config.agentTimeoutMs = previous;
    hub.prompt(s.id, 'nouvelle réponse'); await waitIdle(s.id);
    assert.deepEqual(hub.jobs(s.id).map((job) => job.status), ['done', 'done']);
    assert.notEqual(hub.get(s.id).a!.conn.proc.pid, pid);
  } finally {
    hub.cancel(s.id); config.agentTimeoutMs = previous; delete config.agents.timeout;
  }
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

test('parallel: dependencies serialize overlapping files, pass results, synthesize and review before merging', async () => {
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
  assert.deepEqual(kids[2].dependencies, ['task-1'], 'overlapping files create a dependency');
  const last = readFileSync(join(wt(kids[2]), 'a.txt'), 'utf8');

  assert.deepEqual(await hub.merge(parent.id), { merged: 3, failed: 0 });
  assert.deepEqual(card().children.map((c: any) => c.status), ['merged', 'merged', 'merged']);
  assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), last);
  assert.ok(existsSync(join(repo, 'b.txt')));
  assert.equal(git(repo, 'status', '--porcelain'), '');
  assert.ok(kids.every((k: any) => !existsSync(wt(k))), 'merged worktrees are removed');
  assert.equal(git(repo, 'branch', '--format=%(refname:short)', '--list', 'avity/*'), '');
  for (const kid of kids) {
    const review = hub.snapshot(kid.id).items.find((i: any) => i.type === 'review' && i.status === 'done');
    assert.notEqual(review.agent, kid.agent, 'cross-review by another agent is required');
  }
  assert.ok(hub.artifacts(parent.id).some((a: any) => a.kind === 'synthesis'));
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
  assert.equal((await rpc(2, 'tools/list', {})).tools.length, 6);
  assert.equal((await rpc(3, 'tools/call', { name: 'avity_memory_add', arguments: { kind: 'pitfall', text: 'Le port 7710 est réservé à AvityOne' } })).content[0].text, 'Mémorisé.');
  assert.match((await rpc(4, 'tools/call', { name: 'avity_memory_search', arguments: { query: 'port réservé' } })).content[0].text, /7710/);
  mcp.kill();
});
test('plans: edit, reorder, selection, revision and dependency validation are persisted', async () => {
  const { scheduleTasks } = await import('../src/orchestration.ts');
  const p = await hub.createProject({ name: 'plans' }), s = hub.createSession(p.id);
  const tasks = [
    { id: 'later', content: 'Puis modifier', dependencies: ['first'], files: ['src/a.ts'] },
    { id: 'first', content: 'Modifier', dependencies: [], files: ['src/a.ts'] },
    { id: 'skipped', content: 'Non sélectionnée', selected: false },
  ];
  const plan = hub.updatePlan(s.id, { specification: 'Spécification conservée', tasks, revision: 0 });
  assert.equal(plan.revision, 1);
  assert.deepEqual(hub.getPlan(s.id), plan);
  assert.deepEqual(scheduleTasks(plan.tasks).map((t) => [t.id, t.dependencies]), [['first', []], ['later', ['first']]]);
  assert.throws(() => hub.updatePlan(s.id, { tasks, revision: 0 }), /recharge/);
  assert.throws(() => hub.updatePlan(s.id, { tasks: [{ id: 'a', content: 'a', dependencies: ['b'] }, { id: 'b', content: 'b', dependencies: ['a'] }] }), /cycle/);
  assert.throws(() => hub.updatePlan(s.id, { tasks: [{ content: 'a', dependencies: ['missing'] }] }), /inconnue/);
  assert.throws(() => hub.updatePlan(s.id, { tasks: [{ content: 'a', files: ['../secret'] }] }), /relatifs/);
  assert.throws(() => hub.updatePlan(s.id, { tasks: [{ id: 'a', content: 'a', dependencies: ['b'] }, { id: 'b', content: 'b', selected: false }] }), /non sélectionnée/);
  assert.deepEqual(hub.artifacts(s.id).map((a) => a.kind), ['specification', 'plan']);
});

test('queue: global limit, FIFO per session, cancellation, watchdog and targeted retry', async () => {
  const c = config as typeof config & { globalConcurrency: number; stallTimeoutMs: number };
  const previous = { globalConcurrency: c.globalConcurrency, stallTimeoutMs: c.stallTimeoutMs };
  c.globalConcurrency = 1;
  try {
    const p = await hub.createProject({ name: 'queue' }), a = hub.createSession(p.id), b = hub.createSession(p.id);
    hub.enqueue(a.id, 'slow-task premier');
    hub.enqueue(a.id, 'deuxième');
    hub.enqueue(b.id, 'troisième');
    assert.deepEqual(hub.jobs(a.id).map((j) => j.status), ['running', 'queued']);
    assert.equal(hub.jobs(b.id)[0].status, 'queued');
    await waitIdle(a.id); await waitIdle(b.id);
    assert.deepEqual(hub.jobs(a.id).map((j) => j.status), ['done', 'done']);
    assert.deepEqual(hub.snapshot(a.id).items.filter((i: any) => i.type === 'user').map((i: any) => i.text), ['slow-task premier', 'deuxième']);
    const retry = hub.createSession(p.id);
    const job = hub.enqueue(retry.id, 'retry-once');
    await waitIdle(retry.id);
    assert.equal(hub.jobs(retry.id)[0].status, 'error');
    hub.retryJob(job.jobId); await waitIdle(retry.id);
    assert.equal(hub.jobs(retry.id)[0].status, 'done');
    assert.equal(hub.jobs(retry.id)[0].attempts, 2);
    assert.throws(() => hub.retryJob(job.jobId), /seule une demande/);
    c.stallTimeoutMs = 100;
    const stalled = hub.createSession(p.id);
    hub.enqueue(stalled.id, 'stall-forever'); await waitIdle(stalled.id);
    assert.equal(hub.jobs(stalled.id)[0].status, 'error');
    assert.match(hub.jobs(stalled.id)[0].error, /bloqué/);
    const cancelled = hub.createSession(p.id);
    hub.enqueue(cancelled.id, 'slow-task annuler'); hub.enqueue(cancelled.id, 'ne pas exécuter'); hub.cancel(cancelled.id);
    await waitFor(() => hub.jobs(cancelled.id).every((j) => j.status === 'cancelled'));
    assert.ok(!hub.snapshot(cancelled.id).items.some((i: any) => i.type === 'user' && i.text === 'ne pas exécuter'));
  } finally { Object.assign(c, previous); }
});

test('merge: failed checks and unresolved review findings block changes to the target', async () => {
  const repo = gitRepo(), p = await hub.createProject({ name: 'gates', path: repo });
  const s = hub.createSession(p.id, undefined, { isolated: true });
  hub.prompt(s.id, '## Ta tâche\nwrite:a.txt'); await waitIdle(s.id);
  const base = git(repo, 'rev-parse', 'HEAD'), wt = hub.snapshot(s.id).state.worktree!;
  const c = config as typeof config & { validationCommands: string[] };
  const previous = c.validationCommands;
  try {
    c.validationCommands = ["node -e 'process.exit(1)'"];
    await assert.rejects(hub.merge(s.id), /validation a échoué/);
    assert.equal(git(repo, 'rev-parse', 'HEAD'), base);
    assert.equal(hub.validations(s.id)[0].status, 'failed');
    c.validationCommands = ['git reset --hard HEAD^'];
    await assert.rejects(hub.merge(s.id), /validation a échoué/);
    assert.equal(git(repo, 'rev-parse', 'HEAD'), base);
    assert.ok(existsSync(join(wt, 'a.txt')), 'a clean commit change during checks must never discard source work');
    assert.match(hub.validations(s.id)[0].output, /commit contrôlé/);
    c.validationCommands = ['git diff --check'];
    writeFileSync(join(wt, 'a.txt'), 'review-fail\n');
    await assert.rejects(hub.merge(s.id), /revue croisée/);
    assert.equal(git(repo, 'rev-parse', 'HEAD'), base);
    const finding = hub.findings(s.id)[0];
    assert.equal(finding.status, 'open');
    assert.throws(() => hub.updateFinding(s.id, finding.id, { status: 'resolved' }), /correction/);
    writeFileSync(join(wt, 'a.txt'), 'corrigé\n');
    await assert.rejects(hub.merge(s.id), /remarques restent ouvertes/);
    hub.updateFinding(s.id, finding.id, { status: 'resolved', resolution: 'Valeur remplacée' });
    assert.deepEqual(await hub.merge(s.id), { merged: 1, failed: 0 });
    assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'corrigé\n');
  } finally { c.validationCommands = previous; }
});

test('merge: select one branch and one hunk, retain other changes and reject stale previews', async () => {
  const repo = gitRepo();
  writeFileSync(join(repo, 'lines.txt'), Array.from({ length: 30 }, (_, i) => `line ${i + 1}\n`).join(''));
  git(repo, 'add', '-A'); git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'fixture');
  const p = await hub.createProject({ name: 'selection', path: repo }), parent = hub.createSession(p.id);
  const a = hub.createSession(p.id, 'A', { isolated: true, parentId: parent.id }), b = hub.createSession(p.id, 'B', { isolated: true, parentId: parent.id });
  hub.prompt(a.id, 'go'); hub.prompt(b.id, '## Ta tâche\nwrite:b.txt'); await waitIdle(a.id); await waitIdle(b.id);
  for (const id of [a.id, b.id]) { const job = hub.jobs(id).find(j => j.session_id === id); assert.equal(job?.status, 'done', JSON.stringify(job)); }
  const wt = hub.snapshot(a.id).state.worktree!;
  assert.ok(wt);
  writeFileSync(join(wt, 'lines.txt'), readFileSync(join(wt, 'lines.txt'), 'utf8').replace('line 2\n', 'FIRST\n').replace('line 28\n', 'LAST\n'));
  const preview = await hub.mergePreview(parent.id), hunks = preview.branches.find((x) => x.id === a.id)!.hunks;
  assert.equal(hunks.length, 2);
  await assert.rejects(hub.merge(parent.id, { branches: ['unknown'] }), /sélection de branches/);
  await assert.rejects(hub.merge(parent.id, { fingerprint: 'stale' }), /recharge/);
  assert.deepEqual(await hub.merge(parent.id, { branches: [a.id], hunks: [hunks[0].id], fingerprint: preview.fingerprint }), { merged: 1, failed: 0 });
  assert.match(readFileSync(join(repo, 'lines.txt'), 'utf8'), /FIRST/);
  assert.doesNotMatch(readFileSync(join(repo, 'lines.txt'), 'utf8'), /LAST/);
  assert.ok(!existsSync(join(repo, 'b.txt')));
  assert.ok(existsSync(wt), 'partial merge preserves remaining work');
});

test('merge: conflict aborts the complete selection and preserves every worktree', async () => {
  const repo = gitRepo(), p = await hub.createProject({ name: 'conflicts', path: repo }), parent = hub.createSession(p.id);
  hub.updatePlan(parent.id, { tasks: [{ id: 'a', content: 'write:same.txt', files: [] }, { id: 'b', content: 'write:same.txt', files: [] }] });
  const card = await hub.parallel(parent.id);
  await waitFor(() => hub.jobs(parent.id).every((j) => j.status === 'done'));
  const base = git(repo, 'rev-parse', 'HEAD');
  const result = await hub.merge(parent.id);
  assert.equal(result.merged, 0); assert.equal(result.failed, 2);
  assert.deepEqual(result.conflicts, ['same.txt']);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), base);
  assert.equal(git(repo, 'status', '--porcelain'), '');
  assert.ok(card.children.every((k: any) => existsSync(hub.snapshot(k.id).state.worktree!)));
});

test('queue: restart resumes queued work and marks interrupted attempts for explicit retry', () => {
  const restartHome = mkdtempSync(join(tmpdir(), 'avity-restart-'));
  const cfg = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
  cfg.projectsDir = join(restartHome, 'projects'); cfg.globalConcurrency = 1;
  writeFileSync(join(restartHome, 'config.json'), JSON.stringify(cfg));
  const hubUrl = new URL('../src/hub.ts', import.meta.url).href;
  const storeUrl = new URL('../src/store.ts', import.meta.url).href;
  const execute = (code: string) => execFileSync(process.execPath, ['--input-type=module', '--eval', code], {
    encoding: 'utf8', timeout: 10_000, env: { ...process.env, AVITY_HOME: restartHome }, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const created = JSON.parse(execute(`
    const {hub}=await import(${JSON.stringify(hubUrl)});
    const p=await hub.createProject({name:'restart'}), a=hub.createSession(p.id), b=hub.createSession(p.id);
    hub.enqueue(a.id,'stall-forever'); hub.enqueue(b.id,'après redémarrage');
    console.log(JSON.stringify({a:a.id,b:b.id})); setTimeout(()=>process.exit(0),100);
  `));
  const resumed = JSON.parse(execute(`
    const {hub}=await import(${JSON.stringify(hubUrl)});
    const {run}=await import(${JSON.stringify(storeUrl)});
    const first=hub.jobs(${JSON.stringify(created.a)})[0];
    const interrupted=first.status;
    run('UPDATE execution_jobs SET prompt = ?, options = ? WHERE id = ?', 'reprendre', JSON.stringify({...first.options,route:{...first.options.route,prompt:'reprendre'}}),first.id);
    hub.retryJob(first.id);
    while([...hub.jobs(${JSON.stringify(created.a)}),...hub.jobs(${JSON.stringify(created.b)})].some(j=>['queued','running'].includes(j.status))) await new Promise(r=>setTimeout(r,20));
    console.log(JSON.stringify({interrupted,a:hub.jobs(${JSON.stringify(created.a)})[0].status,b:hub.jobs(${JSON.stringify(created.b)})[0].status})); hub.shutdown();
  `));
  assert.deepEqual(resumed, { interrupted: 'interrupted', a: 'done', b: 'done' });
});

test('worktree preparation runs configured setup and never hides its failure', async () => {
  const { prepareWorktree } = await import('../src/worktree.ts');
  const c = config as typeof config & { prepareCommand: string };
  const previous = c.prepareCommand, dir = mkdtempSync(join(tmpdir(), 'avity-setup-'));
  try {
    c.prepareCommand = "node -e 'require(\"node:fs\").writeFileSync(\"ready\",\"ok\")'";
    await prepareWorktree(dir); assert.equal(readFileSync(join(dir, 'ready'), 'utf8'), 'ok');
    c.prepareCommand = "node -e 'process.exit(2)'";
    await assert.rejects(prepareWorktree(dir), /préparation.*échouée/);
  } finally { c.prepareCommand = previous; }
});

test('routing: a connection failure falls back before execution and preserves the session trace', async () => {
  const p = await hub.createProject({ name: 'fallback' }), s = hub.createSession(p.id);
  const previous = config.agents.fake.env, fallback = config.routing.fallback;
  try {
    config.routing.fallback = true; config.agents.fake.env = { FAKE_INIT_FAIL: '1' };
    hub.prompt(s.id, 'démarrer', { agent: 'fake' });
    const snap = await waitIdle(s.id);
    assert.equal(hub.jobs(s.id)[0].status, 'done');
    assert.equal(snap.state.agent, 'fake2');
    assert.match(snap.items.find((i: any) => i.type === 'user').reason, /bascule/);
    assert.equal(hub.get(s.id).a!.conn.traceSessionId, s.id);
  } finally { config.agents.fake.env = previous; config.routing.fallback = fallback; }
});

test('session deletion removes durable jobs and prevents retrying orphaned work', async () => {
  const p = await hub.createProject({ name: 'delete-jobs' }), s = hub.createSession(p.id);
  const job = hub.enqueue(s.id, 'crash'); await waitIdle(s.id);
  hub.updatePlan(s.id, { tasks: [{ content: 'Une étape' }] });
  assert.equal(hub.jobs(s.id)[0].status, 'error');
  hub.deleteSession(s.id);
  assert.equal(one('SELECT 1 FROM execution_jobs WHERE id = ?', job.jobId), undefined);
  assert.equal(one('SELECT 1 FROM execution_artifacts WHERE session_id = ?', s.id), undefined);
  assert.equal(one('SELECT 1 FROM execution_plans WHERE session_id = ?', s.id), undefined);
  assert.throws(() => hub.retryJob(job.jobId), /demande inconnue/);
});

test('cancellation stops dependency preparation before its child process can write', async () => {
  const repo = gitRepo(), p = await hub.createProject({ name: 'cancel-preparation', path: repo });
  const s = hub.createSession(p.id, undefined, { isolated: true }), previous = config.prepareCommand;
  try {
    config.prepareCommand = `node -e 'const fs=require("node:fs");fs.writeFileSync("started.txt","yes");setTimeout(()=>fs.writeFileSync("late.txt","late"),400)'`;
    hub.prompt(s.id, 'go');
    const wt = join(repo, '.avity', 'worktrees', s.id);
    await waitFor(() => existsSync(join(wt, 'started.txt')));
    hub.cancel(s.id); await waitIdle(s.id);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(hub.jobs(s.id)[0].status, 'cancelled');
    assert.ok(!existsSync(join(wt, 'late.txt')), 'cancel kills the preparation process group');
  } finally { config.prepareCommand = previous; }
});

test('multimodal content survives edit, regeneration and fork context handoff', async () => {
  const p = await hub.createProject({ name: 'media-handoff' }), s = hub.createSession(p.id);
  const content = [{ type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' }];
  hub.prompt(s.id, 'image', { content }, { attachments: [{ name: 'image.png' }] });
  const first = await waitIdle(s.id), item = first.items.find((i: any) => i.type === 'user');
  assert.deepEqual(item.content, content);
  assert.match(first.items.find((i: any) => i.type === 'assistant').text, /images=1/);
  hub.edit(s.id, item.id, 'image corrigée');
  assert.match((await waitIdle(s.id)).items.find((i: any) => i.type === 'assistant').text, /images=1/);
  hub.regenerate(s.id, 'fake2');
  assert.match((await waitIdle(s.id)).items.find((i: any) => i.type === 'assistant').text, /images=1/);
  const fork = hub.fork(s.id);
  hub.prompt(fork.id, 'continuer avec cette image');
  assert.match((await waitIdle(fork.id)).items.filter((i: any) => i.type === 'assistant').at(-1).text, /images=1/);
});

test('merge selection decodes accented filenames, spaces and escaped tabs', async () => {
  const { worktreeDiff, diffHunks } = await import('../src/worktree.ts');
  const repo = gitRepo(), names = ['résumé.md', 'un espace.txt', 'un\tretour.txt'];
  for (const name of names) writeFileSync(join(repo, name), 'avant\n');
  git(repo, 'add', '-A'); git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'noms');
  for (const name of names) writeFileSync(join(repo, name), 'après\n');
  assert.deepEqual(diffHunks(await worktreeDiff(repo, repo)).map((h) => h.path).sort(), names.sort());
});


test('knowledge: versions, restored deletion, contradictions, expiry, consolidation and project isolation', async () => {
  const p = await hub.createProject({ name: 'knowledge' });
  const foreign = await hub.createProject({ name: 'knowledge-other' });
  addMemory(p.id, 'fact', 'Moteur: SQLite');
  addMemory(p.id, 'fact', 'Moteur: Postgres');
  const first = listKnowledge(p.id).memory.find((m) => m.text.endsWith('SQLite'))!;
  assert.equal(listKnowledge(p.id).memory[0].contradictions.length, 1);
  assert.equal(addMemory(p.id, 'fact', ' moteur:   SQLite '), false, 'automatic normalization consolidates duplicates');
  const initial = knowledgeHistory(p.id, first.id)[0];
  updateKnowledge(p.id, first.id, { text: 'Alice maintient SQLite', subject: 'Alice', predicate: 'maintient', object: 'SQLite', entityType: 'person', occurredAt: '2026-01-01', validUntil: '2020-01-01' });
  assert.equal(searchMemory(p.id, 'Alice').length, 0, 'expired facts do not enter automatic recall');
  assert.equal(listKnowledge(p.id).memory.find((m) => m.id === first.id)!.stale, true);
  assert.equal(knowledgeGraph(p.id).edges[0].source, 'entity:moteur');
  assert.ok(knowledgeGraph(p.id).nodes.some((n) => n.type === 'person'));
  assert.match(exportKnowledge(p.id).markdown, /Alice maintient SQLite/);
  assert.throws(() => updateKnowledge(foreign.id, first.id, { text: 'fuite' }), /inconnue/);
  assert.throws(() => restoreKnowledge(foreign.id, first.id, initial.id), /inconnue/);
  assert.throws(() => updateKnowledge(p.id, first.id, { validUntil: 'demain' }), /date ISO/);
  removeKnowledge(p.id, first.id);
  addMemory(p.id, 'fact', 'Autre fait');
  restoreKnowledge(p.id, first.id, initial.id);
  assert.equal(listKnowledge(p.id).memory.find((m) => m.id === first.id)!.text, 'Moteur: SQLite');
  run('INSERT INTO memory (text, kind, project_id) VALUES (?, ?, ?)', 'Moteur: SQLite', 'fact', p.id);
  assert.equal(consolidateKnowledge(p.id).merged, 1);
});

test('knowledge: incremental code indexing, deleted sources and symlink boundaries', async () => {
  const p = await hub.createProject({ name: 'indexing' });
  writeFileSync(join(p.path, 'auth.ts'), 'export function authenticateAccount() { return "jeton authentification"; }');
  assert.equal(indexProject(p).updated, 1);
  const row = one('SELECT rowid AS id FROM kb WHERE project_id = ? AND path = ?', p.id, 'auth.ts')!;
  assert.equal(indexProject(p).updated, 0);
  assert.equal(one('SELECT rowid AS id FROM kb WHERE project_id = ? AND path = ?', p.id, 'auth.ts')!.id, row.id);
  assert.equal(searchKb(p.id, 'authenticate account')[0].path, 'auth.ts');
  writeFileSync(join(p.path, 'auth.ts'), 'export function login() { return "nouvelle authentification"; }');
  assert.equal(indexProject(p).updated, 1);
  assert.match(readSource(p.id, 'auth.ts').text, /nouvelle/);
  const outside = join(home, 'private.md'); writeFileSync(outside, 'secret interdit');
  symlinkSync(outside, join(p.path, 'external.md'));
  assert.match(indexProject(p).failed.join(), /hors du projet/);
  assert.throws(() => readSource(p.id, '../private.md'), /inconnue/);
  assert.equal(searchKb(p.id, 'secret interdit').length, 0);
  unlinkSync(join(p.path, 'auth.ts'));
  assert.equal(indexProject(p).removed, 1);
  assert.equal(searchKb(p.id, 'authentification').length, 0);
});

test('knowledge: latent retrieval finds co-occurring concepts without an exact query word', async () => {
  const p = await hub.createProject({ name: 'semantic' });
  for (const text of ['dog puppy canine kennel', 'puppy canine kennel companion', 'car engine motor highway', 'engine motor highway vehicle']) addMemory(p.id, 'fact', text);
  const hits = searchMemory(p.id, 'dog');
  assert.ok(hits.some((h) => h.text === 'puppy canine kennel companion'), 'latent co-occurrence recalls a document without dog');
  assert.ok(!hits.some((h) => h.text.includes('engine')), 'unrelated latent topic is excluded');
});

test('projects and context: documents, filters, folder selection and exact injected context', async () => {
  const p = await hub.createProject({ name: 'project-edit' });
  const other = await hub.createProject({ name: 'project-neighbor' });
  updateProject(p.id, { name: 'Renommé', archived: true, brief: 'Brief explicite', instructions: 'Instructions du projet' });
  assert.equal(listProjects({ q: 'renommé', archived: true })[0].id, p.id);
  assert.equal(listProjects({ q: 'renommé', archived: false }).length, 0);
  assert.deepEqual(projectDocuments(p.id), { brief: 'Brief explicite', instructions: 'Instructions du projet' });
  assert.ok(listFolders(join(home, 'projects')).folders.some((f) => f.path === realpathSync(p.path)));
  assert.throws(() => updateProject(p.id, { name: 'project-neighbor' }), /existe/);
  addMemory(p.id, 'fact', 'Mémoire volontaire'); addMemory(other.id, 'fact', 'Mémoire interdite');
  const id = listKnowledge(p.id).memory[0].id, foreignId = listKnowledge(other.id).memory[0].id;
  const s = hub.createSession(p.id);
  indexProject(p);
  assert.throws(() => setContextSelection(s.id, { memoryIds: [foreignId] }), /étrangère/);
  assert.throws(() => setContextSelection(s.id, { paths: ['../private.md'] }), /étrangère/);
  setContextSelection(s.id, { memoryIds: [id], paths: [], custom: 'Contexte choisi', includeBrief: false, includeGit: false, includeRecent: false });
  const pack = buildPack(p, s.id, 'autre requête');
  assert.match(pack.text, /Mémoire volontaire/); assert.match(pack.text, /Contexte choisi/); assert.match(pack.text, /Instructions du projet/);
  assert.doesNotMatch(pack.text, /Brief explicite|Mémoire interdite/);
  const imported = importDocument(p.id, { name: 'note.md', base64: Buffer.from('Document complet importé').toString('base64') });
  assert.equal(readSource(p.id, imported.path).text, 'Document complet importé');
  assert.throws(() => importDocument(p.id, { name: '../note.md', base64: 'eA==' }), /invalide/);
  unlinkSync(join(p.path, 'AGENTS.md'));
  const absent = join(home, 'must-not-create.md');
  symlinkSync(absent, join(p.path, 'AGENTS.md'));
  assert.throws(() => updateProject(p.id, { instructions: 'ne pas écrire' }), /symbolique/);
  assert.equal(existsSync(absent), false, 'a dangling symlink cannot write outside the project');
  assert.deepEqual(removeProject(p.id), { removed: true, filesRetained: true });
  assert.ok(existsSync(p.path)); assert.equal(one('SELECT 1 FROM sessions WHERE id = ?', s.id), undefined);
});

test('knowledge: real PDF and office extraction, original source and actionable missing-tool errors', async () => {
  const p = await hub.createProject({ name: 'documents' });
  const office = 'UEsDBBQAAAAIAPGhT13BCYZVVwAAAHoAAAARABwAd29yZC9kb2N1bWVudC54bWxVVAkAA0YY0WpGGNFqdXgLAAEE9QEAAAQUAAAARc1LDoAgDATQqxAu4L5BVl5EoAsTfkIb9PamGOPmzaYzNQNC8Zwwk7pSzB3GqrllIOykrRngSrglq9AEsttXcdxwZzpORuVLqhHJLHIhtmmdvivL/80+UEsBAh4DFAAAAAgA8aFPXcEJhlVXAAAAegAAABEAGAAAAAAAAQAAAKSBAAAAAHdvcmQvZG9jdW1lbnQueG1sVVQFAANGGNFqdXgLAAEE9QEAAAQUAAAAUEsFBgAAAAABAAEAVwAAAKIAAAAAAA==';
  const imported = importDocument(p.id, { name: 'document.docx', base64: office });
  if (imported.failed.length) assert.match(imported.failed.join(), /installer unzip/);
  else {
    assert.match(readSource(p.id, imported.path).text, /Document bureautique complet/);
    assert.deepEqual(readFileSync(sourceFile(p.id, imported.path).absolute), Buffer.from(office, 'base64'));
    const sheet = importDocument(p.id, { name: 'tableau.xlsx', base64: 'UEsDBBQAAAAIAAWiT12M0z6UHgAAACIAAAAUAAAAeGwvc2hhcmVkU3RyaW5ncy54bWyzKS4usbMpzrSzKbELSk1OLSlJtdEHiuiDhPRBkgBQSwMEFAAAAAgABaJPXebfKqtHAAAAbAAAABgAAAB4bC93b3Jrc2hlZXRzL3NoZWV0MS54bWyzKc8vyi7OSE0tsbMBUy6JJYl2NkX55XY2yQpFtkqOhkoKJbZKxUp2NmV2Bjb6ZXY2+slQOSdDsKiJEVxYH6xRH8kkfYQFAFBLAQIeAxQAAAAIAAWiT12M0z6UHgAAACIAAAAUAAAAAAAAAAEAAACkgQAAAAB4bC9zaGFyZWRTdHJpbmdzLnhtbFBLAQIeAxQAAAAIAAWiT13m3yqrRwAAAGwAAAAYAAAAAAAAAAEAAACkgVAAAAB4bC93b3Jrc2hlZXRzL3NoZWV0MS54bWxQSwUGAAAAAAIAAgCIAAAAzQAAAAAA' });
    assert.match(readSource(p.id, sheet.path).text, /Recette\s+42/);
  }
  const stream = 'BT /F1 12 Tf 50 750 Td (Document PDF complet) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n${xref}\n%%EOF\n`;
  const doc = importDocument(p.id, { name: 'document.pdf', base64: Buffer.from(pdf).toString('base64') });
  if (doc.failed.some((f) => f.startsWith(doc.path))) assert.match(doc.failed.join(), /installer Poppler/);
  else assert.match(readSource(p.id, doc.path).text, /Document PDF complet/);
  const saved = process.env.PATH;
  try { process.env.PATH = join(home, 'no-binaries'); assert.throws(() => extractDocument(join(p.path, doc.path)), /installer Poppler/); }
  finally { process.env.PATH = saved; }
});

test.after(() => hub.shutdown());

test('workspace: confines symlinks and paths, rejects stale edits, exports tracked context', async () => {
  const { symlinkSync } = await import('node:fs');
  const { listFiles, readWorkspaceFile, writeWorkspaceFile, repositoryContext } = await import('../src/workspace.ts');
  const dir = gitRepo();
  symlinkSync(home, join(dir, 'outside'));
  const alias = join(home, 'workspace-alias');
  symlinkSync(dir, alias);
  assert.equal((await listFiles(alias)).entries.find(e => e.name === 'README.md')?.path, 'README.md');
  assert.match((await readWorkspaceFile(alias, 'README.md')).text, /./);
  await assert.rejects(() => listFiles(dir, '../'), /hors du projet/);
  await assert.rejects(() => listFiles(dir, 'outside'), /hors du projet/);
  await assert.rejects(() => listFiles(dir, '.git'), /interdit/i);
  symlinkSync(join(dir, '.git', 'config'), join(dir, 'git-alias'));
  await assert.rejects(() => readWorkspaceFile(dir, 'git-alias'), /interdit/i);
  const initial = await readWorkspaceFile(dir, 'README.md');
  const saved = await writeWorkspaceFile(dir, 'README.md', 'nouveau\n', initial.revision);
  assert.equal(readFileSync(join(dir, 'README.md'), 'utf8'), 'nouveau\n');
  await assert.rejects(() => writeWorkspaceFile(dir, 'README.md', 'perdu', initial.revision), /changé/);
  assert.notEqual(saved.revision, initial.revision);
  const concurrent = await Promise.allSettled([writeWorkspaceFile(dir, 'README.md', 'concurrent a', saved.revision), writeWorkspaceFile(dir, 'README.md', 'concurrent b', saved.revision)]);
  assert.equal(concurrent.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((concurrent.find(r => r.status === 'rejected') as PromiseRejectedResult).reason.status, 409);
  const pack = await repositoryContext(dir);
  assert.equal(pack.files, 1); assert.match(pack.text, /concurrent/);
});

test('workspace: accepts one diff hunk, preserves the other, refuses a stale selection', async () => {
  const { workspaceDiff, selectChange } = await import('../src/workspace.ts');
  const dir = gitRepo(), file = join(dir, 'multiple.txt');
  writeFileSync(file, Array.from({ length: 30 }, (_, i) => `line ${i}\n`).join(''));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8' });
  git('add', '.'); git('commit', '-qm', 'fixture');
  writeFileSync(file, readFileSync(file, 'utf8').replace('line 1\n', 'first change\n').replace('line 28\n', 'last change\n'));
  const diff = await workspaceDiff(dir);
  await selectChange(dir, { path: 'multiple.txt', hunk: 0, action: 'accept', revision: diff.revision });
  assert.match(git('diff', '--cached'), /first change/); assert.doesNotMatch(git('diff', '--cached'), /last change/);
  assert.match(git('diff'), /last change/);
  await assert.rejects(() => selectChange(dir, { path: 'multiple.txt', action: 'reject', revision: diff.revision }), /changé/);
  const remaining = await workspaceDiff(dir);
  await selectChange(dir, { path: 'multiple.txt', action: 'reject', revision: remaining.revision });
  assert.equal(git('diff'), ''); assert.match(git('diff', '--cached'), /first change/);
});

test('workspace: quoted Unicode paths keep their selectable diff hunks', async () => {
  const { workspaceDiff, selectChange } = await import('../src/workspace.ts');
  const dir = gitRepo(), path = 'mémoire\tlocale.txt';
  writeFileSync(join(dir, path), 'initial\n');
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8' });
  git('add', '.'); git('commit', '-qm', 'fixture');
  writeFileSync(join(dir, path), 'modification\n');
  const diff = await workspaceDiff(dir);
  assert.equal(diff.hunks[0].path, path); assert.match(diff.hunks[0].patch, /modification/);
  await selectChange(dir, { path, hunk: 0, action: 'accept', revision: diff.revision });
  assert.equal(git('diff'), ''); assert.match(git('diff', '--cached'), /modification/);
});

test('terminal: interactive stdin, output and workspace isolation', async () => {
  const { openTerminal, readTerminal, writeTerminal, closeTerminal } = await import('../src/workspace.ts');
  const root = gitRepo(), { id } = openTerminal(root);
  try {
    assert.throws(() => readTerminal(home, id), /inconnu/);
    writeTerminal(root, id, 'printf "input-ready\\n"; read answer; printf "response:%s\\n" "$answer"\n');
    await waitFor(() => readTerminal(root, id).output.includes('input-ready'));
    writeTerminal(root, id, 'hello\n');
    await waitFor(() => readTerminal(root, id).output.includes('response:hello'));
  } finally { closeTerminal(root, id); }
  assert.throws(() => writeTerminal(root, id, 'x'), /inconnu/);
});

test('attachments: retain bytes, produce ACP content and enforce session isolation', async () => {
  const { addAttachment, attachmentContent, readAttachment, decodeUpload } = await import('../src/attachments.ts');
  const p = await hub.createProject({ name: 'pieces' }), s = hub.createSession(p.id), other = hub.createSession(p.id);
  const a = await addAttachment(s.id, { name: 'notes.txt', mime: 'text/plain', base64: Buffer.from('Document original').toString('base64') });
  assert.equal((await readAttachment(a.id)).data.toString(), 'Document original');
  assert.equal((await attachmentContent(s.id, [a.id]))[0].resource?.text, 'Document original');
  await assert.rejects(() => attachmentContent(other.id, [a.id]), /autre session/);
  await assert.rejects(() => addAttachment(s.id, { name: '../escape', mime: 'text/plain', base64: 'YQ==' }), /Nom/);
  assert.throws(() => decodeUpload('***'), /invalide/);
  assert.equal(decodeUpload(Buffer.alloc(5 << 20).toString('base64')).length, 5 << 20);
  assert.throws(() => decodeUpload(Buffer.alloc((5 << 20) + 1).toString('base64')), /volumineux|supérieur/);
  await assert.rejects(() => attachmentContent(s.id, [a.id, a.id]), /Sélection/);
});

test('speech: configurable engine receives isolated recording and selected language', async () => {
  const { transcribe } = await import('../src/speech.ts');
  const cfg = config as typeof config & { transcription: { command: string; args: string[] } }, before = cfg.transcription;
  try {
    cfg.transcription = { command: '', args: [] };
    await assert.rejects(() => transcribe({ mime: 'audio/webm', language: 'fr-FR', base64: 'YQ==' }), /Configure/);
    cfg.transcription = { command: process.execPath, args: [fileURLToPath(new URL('./fake-transcription.mjs', import.meta.url)), '{file}', '{language}'] };
    const result = await transcribe({ mime: 'audio/webm', language: 'en-US', base64: Buffer.from('fake-audio').toString('base64') });
    assert.equal(result.text, 'recognized en-US');
    await assert.rejects(() => transcribe({ mime: 'audio/webm', language: 'bad;command', base64: 'YQ==' }), /Langue/);
  } finally { cfg.transcription = before; }
});
test('dictée locale : CPU hors ligne, langue régionale et erreurs du modèle', async (t) => {
  const { which } = await import('../src/config.ts');
  const python = which('python3');
  if (!python) { t.skip('Python 3 requis uniquement pour vérifier le moteur de dictée optionnel'); return; }
  const { transcribe } = await import('../src/speech.ts');
  const previous = config.transcription, pythonPath = process.env.PYTHONPATH;
  const model = join(home, 'test-whisper-model');
  mkdirSync(model);
  writeFileSync(join(model, 'model.bin'), 'fake model');
  process.env.PYTHONPATH = fileURLToPath(new URL('./fake-whisper', import.meta.url));
  try {
    config.transcription = { command: python, args: ['-B', fileURLToPath(new URL('../deploy/transcribe.py', import.meta.url)),
      '--file', '{file}', '--language', '{language}', '--model', model, '--threads', '2'] };
    const input = { mime: 'audio/webm', language: 'fr-FR', base64: Buffer.from('fake-audio').toString('base64') };
    assert.equal((await transcribe(input)).text, 'Bonjour en français. Deuxième phrase.');
    const concurrent = await Promise.all([transcribe(input), transcribe(input)]);
    assert.equal(concurrent.length, 2, 'les chargements concurrents du modèle sont sérialisés');
    unlinkSync(join(model, 'model.bin'));
    await assert.rejects(() => transcribe(input), /moteur de transcription/);
  } finally {
    config.transcription = previous;
    if (pythonPath === undefined) delete process.env.PYTHONPATH; else process.env.PYTHONPATH = pythonPath;
  }
});
test('administration: configuration validée, secrets préservés et rotation persistante', async () => {
  const { publicConfig, updateConfig, rotateToken } = await import('../src/config.ts');
  const saved = structuredClone(config);
  try {
    config.agents.fake.env = { PRIVATE_KEY: 'secret-only-on-host' };
    config.transcription = { command: 'transcriber', args: ['--api-key', 'private-transcription-key', '{file}'] };
    const safe = publicConfig();
    assert.equal('token' in safe, false);
    assert.equal(safe.agents.fake.env.PRIVATE_KEY, '••••••');
    assert.equal(safe.transcription.args[1], '••••••');
    updateConfig({ transcription: safe.transcription });
    assert.equal(config.transcription.args[1], 'private-transcription-key');
    updateConfig({ agents: safe.agents, routes: [{ match: '^bug', agent: 'fake' }], globalConcurrency: 2 });
    assert.equal(config.agents.fake.env?.PRIVATE_KEY, 'secret-only-on-host');
    assert.throws(() => updateConfig({ routes: [{ match: '[', agent: 'fake' }] }));
    assert.throws(() => updateConfig({ defaultAgent: 'missing' }));
    assert.throws(() => updateConfig({ token: 'unsafe' }));
    assert.throws(() => updateConfig(JSON.parse('{"__proto__":{"unsafe":true}}')));
    assert.throws(() => updateConfig({ defaultAgent: 'constructor' }));
    assert.throws(() => updateConfig({ mcpServers: [{ name: 'x', command: 'node', args: [], env: { bad: 1 }, enabled: true }] }));
    const token = rotateToken();
    assert.notEqual(token, saved.token);
    assert.equal(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).token, token);
  } finally { Object.assign(config, saved); writeFileSync(join(home, 'config.json'), JSON.stringify(saved)); }
});

test('configuration: les en-têtes MCP sensibles restent masqués après aller-retour', async () => {
  const { publicConfig, updateConfig } = await import('../src/config.ts');
  const saved = structuredClone(config);
  try {
    config.mcpServers = [{ name: 'remote', command: 'mcp-remote', args: ['--header', 'Authorization: Bearer header-secret', '--header=X-Api-Key: another-secret', '--header', 'Cookie: session=cookie-secret'], env: {}, enabled: true }];
    const safe = publicConfig();
    assert.deepEqual(safe.mcpServers[0].args, ['--header', '••••••', '••••••', '--header', '••••••']);
    updateConfig({ mcpServers: safe.mcpServers });
    assert.equal(config.mcpServers[0].args[1], 'Authorization: Bearer header-secret');
    assert.equal(config.mcpServers[0].args[2], '--header=X-Api-Key: another-secret');
  } finally { Object.assign(config, saved); writeFileSync(join(home, 'config.json'), JSON.stringify(saved)); }
});

test('configuration: un masque déplacé ne remplace jamais un secret par un autre argument', async () => {
  const { publicConfig, updateConfig } = await import('../src/config.ts');
  const saved = structuredClone(config), disk = readFileSync(join(home, 'config.json'), 'utf8');
  try {
    config.transcription = { command: 'transcriber', args: ['--profile', 'default', '--token', 'private-token'] };
    assert.throws(() => updateConfig({ transcription: { command: 'transcriber', args: ['--token', '••••••'] } }), /secret/);
    assert.throws(() => updateConfig({ transcription: { command: 'transcriber', args: ['--token', '••••••', '--profile', 'default'] } }), /secret/);
    assert.throws(() => updateConfig({ transcription: { command: 'transcriber', args: ['--profile', 'default', '--password', '••••••'] } }), /secret/);
    assert.equal(config.transcription.args[3], 'private-token');
    assert.equal(readFileSync(join(home, 'config.json'), 'utf8'), disk, 'les refus ne doivent rien persister');
    const safe = publicConfig().transcription;
    safe.args[1] = 'updated';
    updateConfig({ transcription: safe });
    assert.equal(config.transcription.args[3], 'private-token', 'un argument indépendant peut changer sans perdre le secret');
  } finally { Object.assign(config, saved); writeFileSync(join(home, 'config.json'), JSON.stringify(saved)); }
});

test('configuration: résumé et revue refusent les agents inconnus avant persistance', async () => {
  const { updateConfig } = await import('../src/config.ts');
  const saved = structuredClone(config), disk = readFileSync(join(home, 'config.json'), 'utf8');
  try {
    assert.throws(() => updateConfig({ summarizer: { agent: 'missing-agent' } }), /agent/);
    assert.throws(() => updateConfig({ reviewer: { fake: 'missing-agent' } }), /agent/);
    assert.throws(() => updateConfig({ reviewer: { 'missing-agent': 'fake' } }), /agent/);
    assert.throws(() => updateConfig({ summarizer: { agent: 'constructor' } }), /agent/);
    assert.equal(readFileSync(join(home, 'config.json'), 'utf8'), disk);
    updateConfig({ summarizer: { agent: 'fake2' }, reviewer: { fake: 'fake2', fake2: 'fake' } });
    assert.equal(config.summarizer.agent, 'fake2');
  } finally { Object.assign(config, saved); writeFileSync(join(home, 'config.json'), JSON.stringify(saved)); }
});

test('agents: readiness, commandes ACP et authentification inconnue ou requise', async () => {
  const { probeAgent, nativeCommands, agentOperation } = await import('../src/agents.ts');
  config.agents.adminfake = { name: 'Admin fake', cmd: process.execPath, args: [fileURLToPath(new URL('./admin-agent.mjs', import.meta.url))], strengths: 'tests' };
  try {
    const health = await probeAgent('adminfake');
    assert.equal(health.status, 'ready');
    assert.equal(health.authentication, 'unknown', 'un handshake ne prouve pas la facturation ni les identifiants fournisseur');
    assert.equal(health.quota, 'unknown');
    assert.equal((await nativeCommands('adminfake')).commands[0].name, 'compact');
    config.agents.adminfake.env = { FAIL_AUTH: '1' };
    assert.equal((await probeAgent('adminfake')).authentication, 'required');
    await assert.rejects(agentOperation('shell injection', 'install'), /catalogue/);
  } finally { delete config.agents.adminfake; }
});

test('quotas: migration additive conserve les anciennes mesures après deux démarrages', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const legacyHome = mkdtempSync(join(home, 'legacy-quota-'));
  const legacy = new DatabaseSync(join(legacyHome, 'avity.db'));
  legacy.exec(`CREATE TABLE agent_quotas (agent TEXT PRIMARY KEY, source_hash TEXT NOT NULL, status TEXT NOT NULL,
    remaining REAL, quota_limit REAL, unit TEXT, reset_at TEXT, checked_at TEXT NOT NULL, error TEXT);
    INSERT INTO agent_quotas VALUES('saved','source','available',12,100,'requests',NULL,'2026-01-01',NULL)`);
  legacy.close();
  const script = `await import(${JSON.stringify(new URL('../src/admin.ts', import.meta.url).href)});
    const { db } = await import(${JSON.stringify(new URL('../src/store.ts', import.meta.url).href)});
    console.log(JSON.stringify(db.prepare("SELECT remaining, details FROM agent_quotas WHERE agent = 'saved'").get()));`;
  for (let i = 0; i < 2; i++) {
    const result = execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, AVITY_HOME: legacyHome }, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(result), { remaining: 12, details: null });
  }
});

test('quotas: le délai propre à une source est borné et conservé par la configuration', async () => {
  const { probeQuota } = await import('../src/agents.ts');
  const { publicConfig, updateConfig } = await import('../src/config.ts');
  const saved = structuredClone(config);
  try {
    const agents = publicConfig().agents;
    agents.fake.quota = { cmd: process.execPath, args: [fileURLToPath(new URL('./quota-source.mjs', import.meta.url))], env: { QUOTA_MODE: 'timeout' }, timeoutMs: 1000 };
    updateConfig({ agents });
    assert.equal(publicConfig().agents.fake.quota.timeoutMs, 1000);
    assert.match((await probeQuota('fake')).error!, /expirée après 1 s/);
    config.agents.fake.quota = { cmd: process.execPath, args: ['-e', 'console.log(JSON.stringify({ remaining: Number(process.env.AVITY_QUOTA_TIMEOUT_MS), limit: 30000, unit: "ms" }))'], env: { AVITY_QUOTA_TIMEOUT_MS: '30000' }, timeoutMs: 1000 };
    assert.equal((await probeQuota('fake')).remaining, 1000);
    for (const timeoutMs of [0, 999, 30001, 1500.5]) {
      assert.throws(() => updateConfig({ agents: { ...publicConfig().agents, fake: { ...config.agents.fake, quota: { ...config.agents.fake.quota, timeoutMs } } } }), /quota/);
    }
  } finally { Object.assign(config, saved); }
});

test('quotas: le runner accepte les mesures Cursor et ses réserves non bloquantes', async () => {
  const { normalizeCursorQuota } = await import('../src/cursor-quota.ts');
  const { cursorMonthly } = await import('./cursor-quota-fixtures.ts');
  const { probeQuota } = await import('../src/agents.ts');
  const { assertBudget } = await import('../src/admin.ts');
  const paid = cursorMonthly();
  (paid.usage as any).planUsage = { autoPercentUsed: 100, apiPercentUsed: 100, totalPercentUsed: 100 };
  paid.onDemand = { usageBasedPremiumRequests: true };
  const source = { cmd: process.execPath, args: [fileURLToPath(new URL('./quota-source.mjs', import.meta.url))], env: { QUOTA_JSON: '' } };
  config.agents.cursorFixture = { ...config.agents.fake, quota: source };
  try {
    for (const expected of [normalizeCursorQuota(cursorMonthly()), normalizeCursorQuota(paid), normalizeCursorQuota({})]) {
      source.env.QUOTA_JSON = JSON.stringify(expected);
      const actual = await probeQuota('cursorFixture');
      assert.equal(actual.status, expected.status);
      assert.equal(actual.details, expected.details ?? null);
      assert.equal(actual.error, expected.reason ?? null);
      assert.doesNotThrow(() => assertBudget('cursorFixture'));
    }
  } finally { delete config.agents.cursorFixture; }
});

test('quotas: une source sans plafond publié conserve sa preuve sans inventer de solde', async () => {
  const { probeQuota } = await import('../src/agents.ts');
  const { agentQuota, assertBudget } = await import('../src/admin.ts');
  const source = { cmd: process.execPath, args: [fileURLToPath(new URL('./quota-source.mjs', import.meta.url))], env: { QUOTA_JSON: '' } };
  config.agents.unpublished = { ...config.agents.fake, quota: source };
  const evidence = { status: 'unknown', remaining: null, limit: null, reason: 'Plafond non publié par le fournisseur.', details: 'Modèle gratuit temporairement ; aucune promesse de capacité illimitée.' };
  try {
    source.env.QUOTA_JSON = JSON.stringify(evidence);
    const result = await probeQuota('unpublished');
    assert.equal(result.error, evidence.reason);
    assert.equal(result.details, evidence.details);
    assert.equal(result.remaining, null);
    assert.equal(result.limit, null);
    assert.equal(agentQuota('unpublished').details, evidence.details);
    assert.doesNotThrow(() => assertBudget('unpublished'));
    source.env.QUOTA_JSON = JSON.stringify({ remaining: 0.001, limit: 1, unit: 'USD', details: 'Un crédit mesuré positif reste utilisable.' });
    assert.equal((await probeQuota('unpublished')).status, 'available');
    assert.doesNotThrow(() => assertBudget('unpublished'));
    run("UPDATE agent_quotas SET checked_at = ? WHERE agent = 'unpublished'", new Date(Date.now() - 300_001).toISOString());
    assert.equal(agentQuota('unpublished').status, 'unknown');
    for (const invalid of [{ ...evidence, remaining: 0 }, { ...evidence, reason: '' }, { ...evidence, details: 'x'.repeat(1001) }, { ...evidence, details: 'ligne\ninterdite' }]) {
      source.env.QUOTA_JSON = JSON.stringify(invalid);
      assert.equal((await probeQuota('unpublished')).error, 'schéma de quota invalide');
    }
    const secrets = ['synthetic-private-provider-key', 'synthetic-inline-key', 'synthetic-auth-key'];
    source.args.push('--token', secrets[0], `--api-key=${secrets[1]}`, `Authorization: Bearer ${secrets[2]}`);
    source.env.QUOTA_JSON = JSON.stringify({ ...evidence, reason: secrets.join(' '), details: `Source : ${secrets.join(' ')}` });
    const safe = await probeQuota('unpublished');
    for (const secret of secrets) assert.ok(!JSON.stringify(safe).includes(secret), 'aucun secret des arguments dans la mesure publique');
  } finally { delete config.agents.unpublished; }
});

test('quotas: source locale validée, secrets masqués et épuisement expirant', async () => {
  const { probeAgent, probeQuota } = await import('../src/agents.ts');
  const { usageReport, agentQuota, assertBudget } = await import('../src/admin.ts');
  const { publicConfig, updateConfig } = await import('../src/config.ts');
  const { openAgent } = await import('../src/acp.ts');
  const saved = structuredClone(config);
  config.agents.quotaFake = { name: 'Quota fake', cmd: process.execPath, args: [fileURLToPath(new URL('./admin-agent.mjs', import.meta.url))], strengths: '', quota: { cmd: process.execPath, args: [fileURLToPath(new URL('./quota-source.mjs', import.meta.url)), '--token', 'synthetic-private-provider-key'], env: { PROVIDER_KEY: 'synthetic-env-key' } } };
  try {
    const safe = publicConfig();
    assert.equal(safe.agents.quotaFake.quota.args[2], '••••••');
    assert.equal(safe.agents.quotaFake.quota.env.PROVIDER_KEY, '••••••');
    updateConfig({ agents: safe.agents });
    assert.equal(config.agents.quotaFake.quota?.env?.PROVIDER_KEY, 'synthetic-env-key');
    const ready = await probeAgent('quotaFake');
    assert.equal(ready.quota, 'available');
    assert.equal(ready.quotaSnapshot.remaining, 12);
    assert.equal(usageReport().quotas.find(q => q.agent === 'quotaFake')?.limit, 100);
    const source = config.agents.quotaFake.quota!;
    source.env = { QUOTA_JSON: JSON.stringify({ remaining: 0, limit: 100, unit: 'requests', resetAt: new Date(Date.now() + 60_000).toISOString() }) };
    assert.equal((await probeQuota('quotaFake')).status, 'exhausted');
    assert.throws(() => assertBudget('quotaFake'), /quota épuisé/);
    const a = await openAgent('quotaFake', home, { onUpdate() {}, onPermission: async () => ({}) }, []);
    try { await assert.rejects(a.conn.request('session/prompt', { sessionId: a.acpId, prompt: [{ type: 'text', text: 'quota' }] }), /quota épuisé/); }
    finally { a.conn.kill(); }
    run("UPDATE agent_quotas SET checked_at = ? WHERE agent = 'quotaFake'", new Date(Date.now() - 300_001).toISOString());
    assert.equal(agentQuota('quotaFake').status, 'unknown');
    assert.doesNotThrow(() => assertBudget('quotaFake'));
    await probeQuota('quotaFake');
    run("UPDATE agent_quotas SET reset_at = ? WHERE agent = 'quotaFake'", new Date(Date.now() - 1000).toISOString());
    assert.doesNotThrow(() => assertBudget('quotaFake'), 'le reset passé invalide un épuisement ancien');
    await probeQuota('quotaFake');
    source.args = [...source.args, '--new-account'];
    assert.equal(agentQuota('quotaFake').status, 'unknown', 'changer la source invalide la mesure précédente');
  } finally { Object.assign(config, saved); writeFileSync(join(home, 'config.json'), JSON.stringify(saved)); }
});

test('quotas: absence, erreur, JSON invalide, schéma invalide et délai restent inconnus', async () => {
  const { probeQuota } = await import('../src/agents.ts');
  const saved = structuredClone(config);
  config.agents.quotaError = { name: 'Quota error', cmd: process.execPath, args: [fake], strengths: '' };
  try {
    assert.equal((await probeQuota('quotaError')).status, 'unknown');
    const source = { cmd: process.execPath, args: [fileURLToPath(new URL('./quota-source.mjs', import.meta.url))], env: {} as Record<string, string> };
    config.agents.quotaError.quota = source;
    const failures: Record<string, string>[] = [{ QUOTA_MODE: 'error' }, { QUOTA_JSON: 'not-json' }, { QUOTA_JSON: '{"remaining":101,"limit":100,"unit":"requests"}' }, { QUOTA_JSON: '{"remaining":0,"limit":1,"unit":"requests","resetAt":"invalid"}' }];
    for (const env of failures) {
      source.env = env;
      const result = await probeQuota('quotaError');
      assert.equal(result.status, 'unknown');
      assert.ok(result.error);
      assert.doesNotMatch(JSON.stringify(result), /synthetic-private-provider-key/);
    }
    source.env = { QUOTA_MODE: 'timeout' };
    const start = performance.now(), result = await probeQuota('quotaError');
    assert.equal(result.status, 'unknown');
    assert.match(result.error!, /après 5 s$/);
    assert.ok(performance.now() - start < 6500, 'le délai de la source est borné');
  } finally { Object.assign(config, saved); writeFileSync(join(home, 'config.json'), JSON.stringify(saved)); }
});

test('routage: classification LLM validée, priorité manuelle et repli', async () => {
  const { selectRoute, fallbackAgents } = await import('../src/router.ts');
  const saved = config.routing;
  config.agents.classifier = { name: 'Classifier', cmd: process.execPath, args: [fileURLToPath(new URL('./admin-agent.mjs', import.meta.url))], strengths: 'route' };
  config.routing = { strategy: 'llm', agent: 'classifier', model: '', fallback: true };
  try {
    assert.equal((await selectRoute('construis ceci', [...avail, 'classifier'], {}, null, undefined, home)).agent, 'fake2');
    assert.equal((await selectRoute('construis ceci', [...avail, 'classifier'], { agent: 'fake' }, null, undefined, home)).agent, 'fake');
    config.routing.agent = 'missing';
    assert.match((await selectRoute('bonjour', avail, {}, null, undefined, home)).reason, /indisponible/);
    assert.deepEqual(fallbackAgents(['fake'], avail), ['fake2']);
    config.routing.fallback = false;
    assert.deepEqual(fallbackAgents(['fake'], avail), []);
  } finally { config.routing = saved; delete config.agents.classifier; }
});

test('ACP: serveurs MCP supplémentaires transmis et processus bloqué terminé', async () => {
  const { openAgent, oneShot } = await import('../src/acp.ts');
  const saved = config.mcpServers, timeout = config.agentTimeoutMs;
  config.agents.extra = { name: 'Extra', cmd: process.execPath, args: [fileURLToPath(new URL('./admin-agent.mjs', import.meta.url))], strengths: '' };
  config.mcpServers = [{ name: 'context7', command: 'example-mcp', args: ['--stdio'], env: { TEST: 'value' }, enabled: true }, { name: 'disabled', command: 'unused', args: [], env: {}, enabled: false }];
  try {
    const servers = JSON.parse(await oneShot('extra', home, 'ECHO_MCP'));
    assert.deepEqual(servers, [{ name: 'context7', command: 'example-mcp', args: ['--stdio'], env: [{ name: 'TEST', value: 'value' }] }]);
    config.agents.extra.env = { STALL_INIT: '1' }; config.agentTimeoutMs = 50;
    await assert.rejects(openAgent('extra', home, { onUpdate() {}, onPermission: async () => ({}) }, []), /délai ACP/);
    config.agentTimeoutMs = 10_000;
    const cancelled = new AbortController();
    const opening = openAgent('extra', home, { onUpdate() {}, onPermission: async () => ({}) }, [], undefined, cancelled.signal);
    setTimeout(() => cancelled.abort(), 20);
    await assert.rejects(opening, /agent arrêté/);
    await assert.rejects(openAgent('extra', home, { onUpdate() {}, onPermission: async () => ({}) }, [], undefined, cancelled.signal), /annulée/);
  } finally { config.mcpServers = saved; config.agentTimeoutMs = timeout; delete config.agents.extra; }
});

test('métriques: coûts cumulatifs sans doublon, tokens réels et budgets fail closed', async () => {
  const { openAgent } = await import('../src/acp.ts');
  const { usageReport, assertBudget, recordUsage } = await import('../src/admin.ts');
  const saved = config.budgets;
  config.agents.metered = { name: 'Metered', cmd: process.execPath, args: [fileURLToPath(new URL('./admin-agent.mjs', import.meta.url))], strengths: '' };
  const a = await openAgent('metered', home, { onUpdate() {}, onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) }, []);
  try {
    for (let i = 0; i < 2; i++) await a.conn.request('session/prompt', { sessionId: a.acpId, prompt: [{ type: 'text', text: 'mesure' }] });
    const metrics = usageReport().agents.find((r) => r.agent === 'metered')!;
    assert.equal(metrics.input_tokens, 20);
    assert.equal(metrics.output_tokens, 10);
    assert.ok(Math.abs(metrics.cost_usd - 0.04) < 1e-9);
    assert.equal(recordUsage(a.acpId, 'metered', { used: 42, size: 1000, cost: { amount: 0.04, currency: 'USD' } }), 0);
    config.budgets = { dailyTokens: 1, dailyCostUsd: 0, requireUsage: false };
    assert.throws(assertBudget, /budget/);
    config.budgets = { dailyTokens: 1_000_000, dailyCostUsd: 0, requireUsage: true };
    assert.throws(assertBudget, /invérifiable/);
  } finally { a.conn.kill(); config.budgets = saved; delete config.agents.metered; }
});

test('ACP: concurrence globale couvre les connexions indépendantes', async () => {
  const { openAgent } = await import('../src/acp.ts');
  const saved = config.globalConcurrency;
  config.globalConcurrency = 1;
  config.agents.limited = { name: 'Limited', cmd: process.execPath, args: [fileURLToPath(new URL('./admin-agent.mjs', import.meta.url))], strengths: '' };
  const a = await openAgent('limited', home, { onUpdate() {}, onPermission: async () => ({}) }, []);
  const b = await openAgent('limited', home, { onUpdate() {}, onPermission: async () => ({}) }, []);
  try {
    const start = performance.now();
    await Promise.all([a, b].map((s) => s.conn.request('session/prompt', { sessionId: s.acpId, prompt: [{ type: 'text', text: 'WAIT' }] })));
    assert.ok(performance.now() - start >= 285, 'deux prompts de 150 ms doivent être sérialisés');
  } finally { a.conn.kill(); b.conn.kill(); config.globalConcurrency = saved; delete config.agents.limited; }
});

test('comparaison: résultats mesurés et sélection par critère explicite', async () => {
  const { benchmarkAgents } = await import('../src/agents.ts');
  const { rankedAgents } = await import('../src/admin.ts');
  config.agents.evaluated = { name: 'Evaluated', cmd: process.execPath, args: [fileURLToPath(new URL('./admin-agent.mjs', import.meta.url))], strengths: '' };
  try {
    const result = await benchmarkAgents({ agents: ['evaluated'], prompt: 'réponds', expected: 'résultat attendu' });
    assert.equal(result.results[0].passed, 1);
    assert.equal(rankedAgents(['fake', 'evaluated'])[0], 'evaluated');
    const failed = await benchmarkAgents({ agents: ['evaluated'], prompt: 'réponds', expected: 'autre résultat' });
    assert.equal(failed.results[0].passed, 0);
  } finally { delete config.agents.evaluated; }
});

test('HTTP: authenticated workshop, plans, knowledge, multimodal prompts and token revocation', async () => {
  const { server } = await import('../src/server.ts');
  const previous = config.token;
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  const request = (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', token = config.token) => fetch(origin + '/api' + path, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    assert.equal((await request('/state', undefined, 'GET', 'wrong')).status, 401);
    assert.equal((await request('/projects', null)).status, 400);
    const p = await hub.createProject({ name: 'http-workshop', path: gitRepo() }), s = hub.createSession(p.id), other = hub.createSession(p.id);
    const base = `/sessions/${s.id}`;
    assert.equal((await request('/config')).status, 200);
    assert.equal('token' in await (await request('/config')).json(), false);
    const files = await (await request(`${base}/files`)).json(); assert.ok(files.entries.some((f: any) => f.name === 'README.md'));
    assert.equal((await request(`${base}/file?path=..%2Foutside`)).status, 403);
    const file = await (await request(`${base}/file?path=README.md`)).json();
    assert.equal((await request(`${base}/file`, { ...file, text: '# Édité depuis HTTP' }, 'PUT')).status, 200);
    assert.equal((await request(`${base}/file`, { ...file, text: 'stale' }, 'PUT')).status, 409);
    const plan = await (await request(`${base}/plan`)).json();
    const saved = await request(`${base}/plan`, { ...plan, specification: 'Test API', tasks: [{ id: 'one', content: 'analyser', files: [], dependencies: [], selected: true }] }, 'PUT');
    assert.equal(saved.status, 200); assert.equal((await saved.json()).tasks.length, 1);
    assert.equal((await request(`${base}/jobs`)).status, 200);
    assert.equal((await request(`${base}/findings/9999`, { status: 'resolved', resolution: 'preuve' }, 'PATCH')).status, 404);
    addMemory(p.id, 'fact', 'Connaissance HTTP');
    const memory = await (await request(`/projects/${p.id}/memory`)).json();
    assert.equal((await request(`${base}/context-selection`, { memoryIds: [memory.memory[0].id], paths: [] }, 'PATCH')).status, 200);
    const a = await (await request(`${base}/attachments`, { name: 'input.txt', mime: 'text/plain', base64: Buffer.from('pièce').toString('base64') })).json();
    assert.equal((await request(`/sessions/${other.id}/prompt`, { text: 'lire', agent: 'fake', attachments: [a.id] })).status, 403);
    assert.equal((await request(`${base}/prompt`, { text: 'lire', agent: 'fake', attachments: [a.id] })).status, 200);
    await waitIdle(s.id);
    const ask = hub.snapshot(s.id).items.find((i: any) => i.type === 'user');
    assert.equal(ask.content[0].resource.text, 'pièce'); assert.equal(ask.attachments[0].name, 'input.txt');
    assert.equal((await request(`/attachments/${a.id}`)).headers.get('content-type'), 'application/octet-stream');
    assert.equal((await request('/logout', {})).headers.get('set-cookie')?.includes('Max-Age=0'), true);
    const old = config.token, rotated = await (await request('/token/rotate', {})).json();
    assert.notEqual(rotated.token, old); assert.equal((await request('/state', undefined, 'GET', old)).status, 401);
    assert.equal((await request('/state', undefined, 'GET', rotated.token)).status, 200);
  } finally { config.token = previous; writeFileSync(join(home, 'config.json'), JSON.stringify(config)); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
});

test('projects: removal closes cached sessions and retains project files', async () => {
  const p = await hub.createProject({ name: 'project-removal' }), s = hub.createSession(p.id);
  hub.prompt(s.id, 'hello'); await waitIdle(s.id);
  assert.ok(hub.snapshot(s.id).state.connected);
  await waitFor(() => hub.backgroundWork === 0);
  assert.equal(hub.deleteProject(p.id).removed, true);
  assert.throws(() => hub.snapshot(s.id), /session inconnue/);
  assert.ok(existsSync(p.path));
});

test('maintenance : attendre les opérations actives et bloquer les anciens corps HTTP après restauration', async () => {
  const { request } = await import('node:http');
  const { server } = await import('../src/server.ts');
  const { createBackup } = await import('../src/admin.ts');
  const settings = config.transcription;
  const summarizer = config.summarizer;
  const marker = join(home, 'transcription-started');
  const release = join(home, 'transcription-release');
  const summaryMarker = join(home, 'summary-started');
  const summaryRelease = join(home, 'summary-release');
  const summaryFake = join(home, 'maintenance-summary.mjs');
  writeFileSync(summaryFake, readFileSync(fake, 'utf8').replace("if (text.includes('<transcript>')) {", `if (text.includes('<transcript>')) {
    writeFileSync(${JSON.stringify(summaryMarker)}, 'started');
    while (!existsSync(${JSON.stringify(summaryRelease)})) await new Promise(resolve => setTimeout(resolve, 10));
  `));
  config.agents.maintenance_summary = { name: 'Résumé simulé', cmd: process.execPath, args: [summaryFake], strengths: '' };
  config.summarizer = { ...config.summarizer, agent: 'maintenance_summary' };
  config.transcription = { command: process.execPath, args: ['--input-type=module', '-e', `
    import { writeFileSync, existsSync } from 'node:fs';
    writeFileSync(${JSON.stringify(marker)}, 'started');
    while (!existsSync(${JSON.stringify(release)})) await new Promise(resolve => setTimeout(resolve, 10));
    console.log('transcription terminée');
  `] };
  const snapshot = await createBackup();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' };
  let transcription: Promise<Response> | undefined;
  let pending: ReturnType<typeof request> | undefined;
  try {
    transcription = fetch(`${url}/api/transcribe`, { method: 'POST', headers, body: JSON.stringify({ base64: Buffer.from('fake audio').toString('base64'), mime: 'audio/webm', language: 'fr' }) });
    await waitFor(() => existsSync(marker));
    const busy = await fetch(`${url}/api/backups/${snapshot.id}/restore`, { method: 'POST', headers, body: '{}' });
    assert.equal(busy.status, 409, 'une opération encore en cours interdit la restauration');
    writeFileSync(release, 'release');
    assert.equal((await transcription).status, 200);

    const projectId = Number(run('INSERT INTO projects(name,path) VALUES(?,?)', 'maintenance-summary', home).lastInsertRowid);
    run('INSERT INTO sessions(id,project_id,turns) VALUES(?,?,1)', 'maintenance-summary', projectId);
    run('INSERT INTO items(session_id,data) VALUES(?,?)', 'maintenance-summary', JSON.stringify({ type: 'user', text: 'Conversation à résumer' }));
    hub.summarizeBg('maintenance-summary');
    await waitFor(() => existsSync(summaryMarker));
    const summarizing = await fetch(`${url}/api/backups/${snapshot.id}/restore`, { method: 'POST', headers, body: '{}' });
    assert.equal(summarizing.status, 409, 'un résumé de session inactive doit finir avant la restauration');
    writeFileSync(summaryRelease, 'release');
    await waitFor(() => !hub.backgroundWork && one('SELECT summary FROM sessions WHERE id = ?', 'maintenance-summary')?.summary);

    const received = new Promise<void>(resolve => server.once('request', () => resolve()));
    const delayed = new Promise<number>((resolve, reject) => {
      pending = request(`${url}/api/projects/1/memory`, { method: 'POST', headers }, response => {
        response.resume();
        response.once('end', () => resolve(response.statusCode!));
      });
      pending.once('error', reject);
    });
    pending!.write('{');
    await received;
    const restored = await fetch(`${url}/api/backups/${snapshot.id}/restore`, { method: 'POST', headers, body: '{}' });
    assert.equal(restored.status, 200);
    pending!.end('"kind":"fact","text":"Cette écriture après restauration doit être refusée"}');
    assert.equal(await delayed, 503, 'le corps reçu après la restauration ne doit pas exécuter son handler');
    assert.equal(one('SELECT count(*) AS n FROM memory WHERE text = ?', 'Cette écriture après restauration doit être refusée')!.n, 0);
    assert.equal((await fetch(`${url}/api/state`, { headers })).status, 503);
  } finally {
    writeFileSync(release, 'release');
    writeFileSync(summaryRelease, 'release');
    pending?.destroy();
    await transcription?.catch(() => {});
    await waitFor(() => !hub.backgroundWork);
    config.summarizer = summarizer;
    delete config.agents.maintenance_summary;
    config.transcription = settings;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('sauvegarde: intégrité, restauration atomique SQLite FTS et pièces jointes', async () => {
  hub.shutdown();
  const { db } = await import('../src/store.ts');
  const { createBackup, validateBackup, restoreBackup } = await import('../src/admin.ts');
  const { randomUUID } = await import('node:crypto');
  db.exec('CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY,session_id TEXT,name TEXT,mime TEXT,size INTEGER,created_at TEXT)');
  const id = randomUUID();
  mkdirSync(join(home, 'attachments'), { recursive: true });
  writeFileSync(join(home, 'attachments', id), 'original');
  run('INSERT INTO attachments(id,session_id,name,mime,size) VALUES(?,?,?,?,?)', id, 'backup-fixture', 'original.txt', 'text/plain', 8);
  addMemory(9998, 'fact', 'Trou avant sauvegarde');
  const removed = one('SELECT max(rowid) AS id FROM memory')!.id;
  addMemory(9998, 'fact', 'Souvenir avant restauration');
  const preserved = one('SELECT max(rowid) AS id FROM memory')!.id;
  run('DELETE FROM memory WHERE rowid = ?', removed);
  const snap = await createBackup();
  assert.equal(validateBackup(snap.id).valid, true);
  db.exec('CREATE TABLE incompatible_backup_version(id INTEGER)');
  assert.throws(() => validateBackup(snap.id), /schéma incompatible/);
  db.exec('DROP TABLE incompatible_backup_version');
  addMemory(9998, 'fact', 'Souvenir ajouté après sauvegarde');
  writeFileSync(join(home, 'attachments', id), 'modifié');
  const restored = await restoreBackup(snap.id);
  assert.equal(restored.restartRequired, true);
  assert.equal(readFileSync(join(home, 'attachments', id), 'utf8'), 'original');
  assert.equal(searchMemory(9998, 'ajouté').length, 0);
  assert.equal(searchMemory(9998, 'restauration').length, 1);
  assert.equal(searchMemory(9998, 'restauration')[0].id, preserved, 'les identifiants FTS et leurs références restent stables');
  addMemory(9998, 'fact', 'Recherche après restauration');
  assert.equal(searchMemory(9998, 'Recherche')[0].text, 'Recherche après restauration', 'le résultat lexical exact reste prioritaire après restauration');
  assert.throws(() => validateBackup('../avity'), /inconnue/);
  writeFileSync(join(home, 'backups', snap.id + '.files', id), 'corrompu');
  assert.throws(() => validateBackup(snap.id), /corrompue/);
});

test('restauration: un échec COMMIT rétablit aussi les octets des pièces jointes', async () => {
  const { db } = await import('../src/store.ts');
  const { createBackup, restoreBackup } = await import('../src/admin.ts');
  const attachment = one('SELECT id FROM attachments LIMIT 1')!.id;
  const file = join(home, 'attachments', attachment);
  db.exec('PRAGMA foreign_keys=OFF; CREATE TABLE restore_parent(id INTEGER PRIMARY KEY); CREATE TABLE restore_child(parent_id INTEGER REFERENCES restore_parent(id)); INSERT INTO restore_child VALUES(999)');
  writeFileSync(file, 'sauvegarde');
  const invalid = await createBackup();
  db.exec('DELETE FROM restore_child; PRAGMA foreign_keys=ON');
  writeFileSync(file, 'état courant');
  try {
    await assert.rejects(restoreBackup(invalid.id), /FOREIGN KEY/);
    assert.equal(readFileSync(file, 'utf8'), 'état courant');
    assert.equal(one('SELECT count(*) AS n FROM restore_child')!.n, 0);
  } finally { db.exec('PRAGMA foreign_keys=OFF; DROP TABLE restore_child; DROP TABLE restore_parent'); }
});

test('sources de quotas: fenêtres réelles, sélection du bucket et crédits sans faux épuisement', () => {
  const now = Date.now(), soon = Math.ceil(now / 1000) + 3600, later = soon + 86400;
  const bucket = { limitId: 'codex', primary: { usedPercent: 80, windowDurationMins: 300, resetsAt: soon }, secondary: { usedPercent: 30, windowDurationMins: 10080, resetsAt: later } };
  const codex = { rateLimits: { primary: { usedPercent: 99 } }, rateLimitsByLimitId: { codex: bucket } };
  assert.deepEqual(normalizeCodexQuota(codex, 'codex', now), { remaining: 20, limit: 100, unit: 'pourcentage restant (Codex 300 min)', resetAt: new Date(soon * 1000).toISOString() });
  assert.throws(() => normalizeCodexQuota(codex, 'missing'), /absent/);
  assert.throws(() => normalizeCodexQuota({ rateLimitsByLimitId: {}, rateLimits: bucket }), /absent/, 'pas de fallback silencieux vers un bucket différent');
  bucket.primary.usedPercent = bucket.secondary.usedPercent = 100;
  assert.equal(normalizeCodexQuota(codex).resetAt, new Date(later * 1000).toISOString());
  assert.equal(normalizeCodexQuota(codex).remaining, 0);
  for (const credits of [{ hasCredits: true }, { unlimited: true }]) assert.throws(() => normalizeCodexQuota({ rateLimits: { ...bucket, credits } }), /crédits supplémentaires/);
  for (const usedPercent of [null, '10', -1, 101, NaN]) assert.throws(() => normalizeCodexQuota({ rateLimits: { primary: { usedPercent } } }), /invalide/);
  assert.throws(() => normalizeCodexQuota({ rateLimits: { primary: { usedPercent: 10, resetsAt: 1 } } }), /périmée/);
  assert.throws(() => normalizeCodexQuota({ rateLimits: {} }), /aucune fenêtre/);
  const claude = { five_hour: { utilization: 4, resets_at: new Date(soon * 1000).toISOString() }, seven_day: { utilization: 34, resets_at: new Date(later * 1000).toISOString() }, seven_day_sonnet: { utilization: 85, resets_at: new Date(later * 1000).toISOString() } };
  assert.equal(normalizeClaudeQuota(claude).remaining, 66);
  assert.equal(normalizeClaudeQuota(claude, 'sonnet').remaining, 15);
  assert.throws(() => normalizeClaudeQuota(claude, 'missing'), /invalide/);
  assert.throws(() => normalizeClaudeQuota({ five_hour: { utilization: 100 }, extra_usage: { is_enabled: true } }), /crédits supplémentaires/);
  assert.throws(() => normalizeClaudeQuota({ five_hour: { utilization: null } }), /invalide/);
});

test('source Codex: protocole natif simulé, erreurs expurgées, sortie bornée et timeout', async () => {
  const fixture = fileURLToPath(new URL('./provider-quota.mjs', import.meta.url));
  const read = (mode: string, timeoutMs = 1000) => readCodexQuota({ cmd: process.execPath, args: [fixture, mode], timeoutMs });
  const result = await read('valid');
  assert.equal(result.remaining, 20);
  assert.equal(result.limit, 100);
  assert.match(result.unit, /10080 min/);
  for (const [mode, error] of [['error', /connexion ChatGPT/], ['oversized', /volumineuse/], ['malformed', /invalide/]] as const) {
    await assert.rejects(read(mode), (e: Error) => error.test(e.message) && !e.message.includes('synthetic-secret'));
  }
  const start = performance.now();
  await assert.rejects(read('hang', 50), /expirée/);
  assert.ok(performance.now() - start < 1500);
  await assert.rejects(readCodexQuota({ cmd: join(home, 'missing-quota-cli'), timeoutMs: 100 }), /indisponible/);
  if (process.platform !== 'win32') {
    const pidFile = join(home, 'quota-child.pid');
    await assert.rejects(readCodexQuota({ cmd: process.execPath, args: [fixture, 'hang-child', pidFile], timeoutMs: 500 }), /expirée/);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    let running = true;
    for (let attempt = 0; attempt < 20 && running; attempt++) {
      try { process.kill(pid, 0); if (process.platform === 'linux' && readFileSync(`/proc/${pid}/stat`, 'utf8').includes(') Z ')) running = false; }
      catch { running = false; }
      if (running) await new Promise(resolve => setTimeout(resolve, 25));
    }
    if (running) process.kill(pid, 'SIGKILL');
    assert.equal(running, false, 'le binaire natif enfant doit aussi être arrêté');
  }
});

test('source Claude: identifiants locaux, endpoint fixe, lecture bornée et erreurs sans secret', async () => {
  const credentialsPath = join(home, 'claude-quota-credentials.json');
  writeFileSync(credentialsPath, JSON.stringify({ claudeAiOauth: { accessToken: 'synthetic-quota-token', expiresAt: Date.now() + 60000 } }), { mode: 0o600 });
  let called = 0;
  const fetcher: typeof fetch = async (url, init) => {
    called++;
    assert.equal(String(url), 'https://api.anthropic.com/api/oauth/usage');
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer synthetic-quota-token');
    assert.equal(new Headers(init?.headers).get('anthropic-beta'), 'oauth-2025-04-20');
    return Response.json({ five_hour: { utilization: 2, resets_at: new Date(Date.now() + 60000).toISOString() } });
  };
  assert.equal((await readClaudeQuota({ credentialsPath, fetcher })).remaining, 98);
  assert.equal(called, 1);
  for (const status of [401, 403, 429, 500]) {
    await assert.rejects(readClaudeQuota({ credentialsPath, fetcher: async () => new Response('synthetic-quota-token', { status }) }), (e: Error) => !e.message.includes('synthetic-quota-token') && /Claude/.test(e.message));
  }
  await assert.rejects(readClaudeQuota({ credentialsPath, fetcher: async () => new Response('x'.repeat(70_000)) }), /volumineuse/);
  await assert.rejects(readClaudeQuota({ credentialsPath, fetcher: async () => new Response('synthetic-quota-token') }), (e: Error) => !e.message.includes('synthetic-quota-token'));
  await assert.rejects(readClaudeQuota({ credentialsPath, timeoutMs: 5, fetcher: async (_url, init) => new Promise((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new Error('synthetic-quota-token')), { once: true }); setTimeout(() => {}, 10); }) }), /impossible ou expirée/);
  writeFileSync(credentialsPath, JSON.stringify({ claudeAiOauth: { accessToken: 'synthetic-quota-token', expiresAt: 1 } }));
  await assert.rejects(readClaudeQuota({ credentialsPath, fetcher }), /expirée/);
  assert.equal(called, 1, 'aucun appel réseau avec une connexion expirée');
  await assert.rejects(readClaudeQuota({ credentialsPath: join(home, 'missing-credentials'), fetcher }), /absente ou illisible/);
});

test('sources de quotas: le répartiteur rejette les sources non prises en charge', () => {
  const script = fileURLToPath(new URL('../src/quota-source.ts', import.meta.url));
  for (const provider of ['non-configure', 'inconnu']) {
    try { execFileSync(process.execPath, [script, provider], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); assert.fail('source non disponible acceptée'); }
    catch (e: any) {
      assert.equal(e.status, 1);
      assert.equal(e.stdout, '');
      assert.equal(JSON.parse(e.stderr).status, 'unknown');
      assert.match(JSON.parse(e.stderr).error, /non prise en charge/);
    }
  }
});

test('Cursor quotas: total natif et deux pools sans déduire un plafond depuis le tarif', () => {
  const now = Date.now(), readings = cursorMonthly(now), result = normalizeCursorQuota(readings, now);
  assert.equal(result.status, 'available');
  assert.equal(result.remaining, 40);
  assert.equal(result.limit, 100);
  assert.match(result.details ?? '', /modèles Cursor : 46,875 %/);
  assert.match(result.details ?? '', /autres modèles : 0 %/);
  assert.match(result.details ?? '', /demande : désactivé/);
  assert.equal(result.resetAt, new Date(now + 86400000).toISOString());
  assert.ok(result.details && result.details.length <= 1000);
  const usage = readings.usage as any;
  usage.planUsage.totalPercentUsed = 100;
  assert.equal(normalizeCursorQuota(readings, now).status, 'unknown', 'un pool disponible interdit un épuisement global');
  for (const value of [undefined, null, '50', NaN, -1, 101]) {
    usage.planUsage.totalPercentUsed = value;
    assert.equal(normalizeCursorQuota(readings, now).status, 'unknown');
  }
  usage.planUsage.totalPercentUsed = 60;
  delete usage.planUsage.apiPercentUsed;
  assert.equal(normalizeCursorQuota(readings, now).status, 'unknown', 'un pool manquant ne vaut pas zéro');
  const expired = cursorMonthly(now); (expired.usage as any).billingCycleEnd = String(now - 1);
  assert.equal(normalizeCursorQuota(expired, now).status, 'unknown');
});

test('Cursor quotas: aucun épuisement global avec crédit, paiement, autre modèle ou mode lent', () => {
  const base = cursorMonthly();
  (base.usage as any).planUsage = { autoPercentUsed: 100, apiPercentUsed: 100, totalPercentUsed: 100 };
  base.policy = { stage: 'LIMIT_HIT_STAGE_HARD_BLOCK' };
  assert.equal(normalizeCursorQuota(base).status, 'exhausted');
  const variants: Partial<CursorReadings>[] = [
    { onDemand: { usageBasedPremiumRequests: true } }, { onDemand: undefined },
    { credits: { hasCreditGrants: true, creditBalanceCents: '500' } }, { credits: undefined },
    { policy: undefined }, { policy: {} }, { policy: { stage: 'LIMIT_HIT_STAGE_WEEKLY_LIMIT' } },
    { policy: { stage: 'LIMIT_HIT_STAGE_AUTO_SWITCH' } }, { policy: { stage: 'LIMIT_HIT_STAGE_SLOW_POOL' } },
    { policy: { stage: 'LIMIT_HIT_STAGE_HARD_BLOCK', isInSlowPool: true } },
    { policy: { stage: 'LIMIT_HIT_STAGE_HARD_BLOCK', allowedModelIds: ['free-model'] } },
  ];
  for (const change of variants) {
    const result = normalizeCursorQuota({ ...base, ...change });
    assert.equal(result.status, 'unknown');
    assert.equal(result.remaining, null); assert.equal(result.limit, null); assert.equal(result.unit, null);
    assert.equal(Object.hasOwn(result, 'resetAt'), false);
    assert.ok(result.details && result.details.length <= 1000);
  }
  const paid = normalizeCursorQuota({ ...base, onDemand: { usageBasedPremiumRequests: true } });
  assert.match(paid.details ?? '', /aucun accès illimité déduit/);
  assert.equal(Object.hasOwn(paid, 'resetAt'), false, 'unknown ne porte pas de date de remise à zéro exploitable');
  const limited = structuredClone(base);
  limited.onDemand = { usageBasedPremiumRequests: true };
  (limited.usage as any).spendLimitUsage = { overallLimit: 1234, overallRemaining: 19 };
  assert.match(normalizeCursorQuota(limited).details ?? '', /1234 centimes USD ; reste 19 centimes USD/);
});

test('Cursor quotas: pool hebdomadaire et prépayé séparés, données masquées restent inconnues', () => {
  const now = Date.now(), readings = cursorWeekly(now);
  const result = normalizeCursorQuota(readings, now);
  assert.equal(result.remaining, 75);
  assert.equal(result.resetAt, new Date(now + 6 * 86400000).toISOString());
  assert.match(result.details ?? '', /prépayé : 1234 centimes USD/);
  const weekly = readings.weekly as any;
  weekly.usagePercent = 100;
  readings.policy = { stage: 'LIMIT_HIT_STAGE_HARD_BLOCK' };
  assert.equal(normalizeCursorQuota(readings, now).status, 'unknown');
  weekly.prepaidBalanceCents = '0';
  assert.equal(normalizeCursorQuota(readings, now).status, 'exhausted');
  weekly.prepaidBalanceWithheld = true;
  assert.equal(normalizeCursorQuota(readings, now).status, 'unknown');
  assert.match(normalizeCursorQuota(readings, now).details ?? '', /masqué/);
  weekly.prepaidBalanceWithheld = false;
  weekly.prepaidBalanceCents = '9007199254740993';
  assert.equal(normalizeCursorQuota(readings, now).status, 'unknown', 'les int64 non représentables exactement sont rejetés');
});

test('Cursor quotas: lectures natives bornées, sans mutation, secret ni identité dans la sortie', async () => {
  const credentialsPath = join(home, 'cursor-quota-auth.json'), fixture = cursorMonthly();
  writeFileSync(credentialsPath, JSON.stringify({ accessToken: 'synthetic-cursor-token', refreshToken: 'synthetic-refresh' }), { mode: 0o600 });
  const methods: Record<string, keyof CursorReadings> = { GetCurrentPeriodUsage: 'usage', GetPlanInfo: 'plan', GetCreditGrantsBalance: 'credits', GetUsageBasedPremiumRequests: 'onDemand', GetUsageLimitPolicyStatus: 'policy', GetXaiUserUsageSnapshot: 'weekly' };
  const called: string[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    const endpoint = new URL(String(url)), method = endpoint.pathname.split('/').at(-1)!;
    assert.equal(endpoint.origin, 'https://api2.cursor.sh');
    assert.equal(endpoint.pathname, `/aiserver.v1.DashboardService/${method}`);
    assert.ok(Object.hasOwn(methods, method));
    assert.equal(init?.method, 'POST'); assert.equal(init?.body, '{}'); assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer synthetic-cursor-token');
    assert.equal(new Headers(init?.headers).get('connect-protocol-version'), '1');
    called.push(method);
    return Response.json(fixture[methods[method]]);
  };
  assert.equal((await readCursorQuota({ credentialsPath, fetcher })).remaining, 40);
  assert.equal(called.length, 5);
  Object.assign(fixture, cursorWeekly()); called.length = 0;
  assert.equal((await readCursorQuota({ credentialsPath, fetcher })).remaining, 75);
  assert.ok(called.includes('GetXaiUserUsageSnapshot'));
  for (const status of [401, 403, 429, 500]) {
    const result = await readCursorQuota({ credentialsPath, fetcher: async () => new Response('synthetic-cursor-token private@example.invalid', { status }) });
    assert.equal(result.status, 'unknown'); assert.doesNotMatch(JSON.stringify(result), /synthetic-cursor-token|private@/);
    assert.equal(Object.hasOwn(result, 'resetAt'), false);
    assert.equal(Object.hasOwn(result, 'details'), false);
  }
  for (const text of ['bad JSON synthetic-cursor-token', 'x'.repeat(70_000)]) {
    const result = await readCursorQuota({ credentialsPath, fetcher: async () => new Response(text) });
    assert.equal(result.status, 'unknown'); assert.doesNotMatch(JSON.stringify(result), /synthetic-cursor-token/);
  }
  const start = performance.now();
  const result = await readCursorQuota({ credentialsPath, timeoutMs: 10, fetcher: async (_url, init) => new Promise((_resolve, reject) => {
    if (init?.signal?.aborted) reject(new Error('synthetic-cursor-token'));
    else init?.signal?.addEventListener('abort', () => reject(new Error('synthetic-cursor-token')), { once: true });
    setTimeout(() => {}, 20);
  }) });
  assert.equal(result.status, 'unknown'); assert.ok(performance.now() - start < 1000);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-cursor-token/);
  const absent = await readCursorQuota({ credentialsPath: join(home, 'absent-cursor-auth'), fetcher });
  assert.equal(absent.status, 'unknown');
  assert.equal(Object.hasOwn(absent, 'resetAt'), false);
  assert.equal(Object.hasOwn(absent, 'details'), false);
});

test('source OpenCode: sélection native isolée, catalogue courant et aucun quota inventé', async () => {
  const { readOpenCodeQuota } = await import('../src/opencode-quota.ts');
  const { DatabaseSync } = await import('node:sqlite');
  const root = mkdtempSync(join(home, 'opencode-quota-'));
  const env = { HOME: root, PATH: process.env.PATH };
  const configDir = join(root, '.config/opencode'), cacheDir = join(root, '.cache/opencode');
  mkdirSync(configDir, { recursive: true }); mkdirSync(cacheDir, { recursive: true });
  const dataDir = join(root, '.local/share/opencode'); mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'opencode.db'));
  db.exec('CREATE TABLE credential (value TEXT); CREATE TABLE account (id TEXT); CREATE TABLE account_state (id TEXT)'); db.close();
  const before = readFileSync(join(dataDir, 'opencode.db'));
  writeFileSync(join(root, '.real-home'), 'must not be copied');
  writeFileSync(join(configDir, 'opencode.jsonc'), JSON.stringify({ $schema: 'https://opencode.ai/config.json' }));
  writeFileSync(join(configDir, 'package.json'), JSON.stringify({ dependencies: { '@opencode-ai/plugin': '1.19.0' } }));
  mkdirSync(join(configDir, 'node_modules'));
  const catalog = JSON.parse(readFileSync(new URL('./opencode-quota-models.json', import.meta.url), 'utf8'));
  writeFileSync(join(cacheDir, 'models.json'), JSON.stringify(catalog));
  const cli = fileURLToPath(new URL('./opencode-quota-cli.mjs', import.meta.url));
  const marker = join(root, 'private-home');
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(init?.redirect, 'error'); assert.equal(init?.headers, undefined);
    assert.equal(init?.body, undefined); assert.ok(init?.signal);
    assert.ok(['https://models.dev/api.json', 'https://opencode.ai/zen/v1/models'].includes(String(url)));
    return Response.json(String(url).includes('models.dev') ? catalog : { data: Object.keys(catalog.opencode.models).map((id) => ({ id })) });
  };
  const options = { cmd: process.execPath, args: [cli, `marker=${marker}`], env, fetcher, timeoutMs: 1500 };
  const result = await readOpenCodeQuota(options);
  assert.equal(result.status, 'unknown'); assert.equal(result.remaining, null); assert.equal(result.limit, null);
  assert.match(result.reason, /non publiés/); assert.match(result.details!, /par défaut opencode\/big-pickle/);
  assert.match(result.details!, /tarif catalogue nul vérifié/); assert.match(result.details!, /Limites IP possibles/);
  assert.ok(result.details!.length <= 1000); assert.equal(existsSync(readFileSync(marker, 'utf8')), false);
  assert.equal(readFileSync(join(root, '.real-home'), 'utf8'), 'must not be copied');
  writeFileSync(join(configDir, 'opencode.jsonc'), JSON.stringify({ model: 'opencode/other-free' }));
  const configured = await readOpenCodeQuota(options);
  assert.match(configured.details!, /configuré opencode\/other-free/);
  catalog.opencode.models['other-free'].cost.input = 1;
  const changedPrice = await readOpenCodeQuota(options);
  assert.match(changedPrice.details!, /Tarification gratuite non confirmée/);
  assert.doesNotMatch(changedPrice.details!, /tarif catalogue nul vérifié/);
  for (const mode of ['hang', 'oversized', 'redirect', 'connected']) {
    const started = performance.now();
    const failure = await readOpenCodeQuota({ ...options, args: [cli, mode], timeoutMs: mode === 'hang' ? 80 : 1500 });
    assert.equal(failure.status, 'unknown'); assert.equal(failure.details, undefined);
    assert.ok(performance.now() - started < 2000, mode);
  }
  const lateMarker = join(root, 'stopped-process');
  await readOpenCodeQuota({ ...options, args: [cli, `hang-marker=${lateMarker}`], timeoutMs: 150 });
  assert.equal(existsSync(readFileSync(lateMarker, 'utf8')), false);
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(existsSync(`${lateMarker}-late`), false);
  const runnerStarted = performance.now();
  const shorterRunner = await readOpenCodeQuota({ ...options, args: [cli, 'hang'], timeoutMs: 5000, env: { ...env, AVITY_QUOTA_TIMEOUT_MS: '1000' } });
  assert.equal(shorterRunner.details, undefined);
  assert.ok(performance.now() - runnerStarted >= 400 && performance.now() - runnerStarted < 900, 'reserve cleanup time before the runner kills the source');
  const changed = await readOpenCodeQuota({ ...options, fetcher: async (url, init) => {
    writeFileSync(join(configDir, 'opencode.jsonc'), JSON.stringify({ model: 'opencode/big-pickle' }));
    return fetcher(url, init);
  } });
  assert.match(changed.reason, /modifiée pendant/);
  const slow = await readOpenCodeQuota({ ...options, timeoutMs: 80, fetcher: async (_url, init) => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{'));
    init!.signal!.addEventListener('abort', () => controller.error(new Error('synthetic-stream-key')), { once: true });
  } })) });
  assert.match(slow.reason, /expirée/); assert.ok(!JSON.stringify(slow).includes('synthetic-stream-key'));
  const secret = 'synthetic-private-upstream-key';
  const errors = await Promise.all([
    readOpenCodeQuota({ ...options, fetcher: async () => new Response(secret, { status: 401 }) }),
    readOpenCodeQuota({ ...options, fetcher: async () => { throw new Error(secret); } }),
    readOpenCodeQuota({ ...options, fetcher: async () => new Response(secret) }),
    readOpenCodeQuota({ ...options, fetcher: async () => Response.json({ data: [] }) }),
    readOpenCodeQuota({ ...options, fetcher: async () => new Response('x'.repeat(13 * 1024 * 1024)) }),
  ]);
  for (const failure of errors) {
    assert.equal(failure.status, 'unknown'); assert.equal(failure.details, undefined);
    assert.ok(!JSON.stringify(failure).includes(secret));
  }
  assert.deepEqual(readFileSync(join(dataDir, 'opencode.db')), before);
});

test('source OpenCode: configurations ambiguës et connexions ne deviennent jamais un accès gratuit', async () => {
  const { readOpenCodeQuota } = await import('../src/opencode-quota.ts');
  const { DatabaseSync } = await import('node:sqlite');
  const root = mkdtempSync(join(home, 'opencode-context-'));
  const configDir = join(root, '.config/opencode'), cacheDir = join(root, '.cache/opencode'), stateDir = join(root, '.local/state/opencode'), dataDir = join(root, '.local/share/opencode');
  for (const dir of [configDir, cacheDir, stateDir, dataDir]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(cacheDir, 'models.json'), readFileSync(new URL('./opencode-quota-models.json', import.meta.url)));
  const env = { HOME: root, PATH: process.env.PATH };
  const options = { cmd: process.execPath, env, fetcher: (async () => { assert.fail('no request for an unverified context'); }) as typeof fetch };
  for (const contents of ['{ /* comment */ }', '{"provider":{"private":{"apiKey":"synthetic-config-key"}}}', '{"model":"other/paid"}', '{"plugin":["never-execute"]}']) {
    writeFileSync(join(configDir, 'opencode.jsonc'), contents);
    const result = await readOpenCodeQuota(options);
    assert.equal(result.details, undefined); assert.ok(!JSON.stringify(result).includes('synthetic-config-key'));
  }
  writeFileSync(join(configDir, 'opencode.jsonc'), '{}');
  const keyed = await readOpenCodeQuota({ ...options, env: { ...env, OPENCODE_API_KEY: 'synthetic-env-key' } });
  assert.match(keyed.reason, /Environnement fournisseur/);
  const cli = fileURLToPath(new URL('../src/opencode-quota.ts', import.meta.url));
  const stdout = execFileSync(process.execPath, [cli], { env: { ...env, OPENCODE_API_KEY: 'synthetic-env-key' }, encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.deepEqual(JSON.parse(stdout), keyed);
  assert.ok(!stdout.includes('synthetic-env-key'));
  writeFileSync(join(stateDir, 'model.json'), JSON.stringify({ recent: [{ providerID: 'opencode', modelID: 'other-free' }] }));
  assert.match((await readOpenCodeQuota(options)).reason, /Sélection récente/);
  unlinkSync(join(stateDir, 'model.json'));
  writeFileSync(join(dataDir, 'auth.json'), JSON.stringify({ opencode: { type: 'api', key: 'synthetic-auth-key' } }));
  assert.match((await readOpenCodeQuota(options)).reason, /Connexion OpenCode/);
  unlinkSync(join(dataDir, 'auth.json'));
  const db = new DatabaseSync(join(dataDir, 'opencode.db'));
  db.exec('CREATE TABLE credential (value TEXT); CREATE TABLE account (id TEXT); CREATE TABLE account_state (id TEXT); INSERT INTO credential VALUES (\'synthetic-db-key\')'); db.close();
  const connected = await readOpenCodeQuota(options);
  assert.match(connected.reason, /Connexion OpenCode/); assert.ok(!JSON.stringify(connected).includes('synthetic-db-key'));
  unlinkSync(join(dataDir, 'opencode.db'));
  writeFileSync(join(configDir, 'package.json'), JSON.stringify({ scripts: { postinstall: 'never-execute' }, dependencies: { '@opencode-ai/plugin': '1.19.0' } }));
  assert.match((await readOpenCodeQuota(options)).reason, /Extensions OpenCode personnalisées/);
});

test('administration: cartes de quotas lisibles, périmées et inconnues sans faux solde actuel', async () => {
  const require = createRequire(import.meta.url), { transformWithOxc } = await import('vite');
  const { createElement } = require('react'), { renderToStaticMarkup } = require('react-dom/server');
  const compiled = await transformWithOxc(readFileSync(new URL('../web/src/AgentCard.tsx', import.meta.url), 'utf8'), 'AgentCard.tsx', { jsx: { runtime: 'classic' } });
  const components = await import('data:text/javascript;base64,' + Buffer.from(`import * as React from ${JSON.stringify(pathToFileURL(require.resolve('react')).href)};\n${compiled.code}`).toString('base64'));
  const now = Date.now(), checkedAt = new Date(now - 1000).toISOString();
  const agent = { id: 'synthetic', name: 'Agent de test', strengths: 'Code', installed: true, catalog: {}, health: {
    status: 'ready', checkedAt, quotaSnapshot: { status: 'available', remaining: 44.704684, limit: 100, unit: 'pourcentage restant (total natif)',
      checkedAt, resetAt: new Date(now + 600000).toISOString(), error: null, details: 'Pool Cursor : 45,8 % restants. Autres modèles : 0 %. Crédits : 0 centimes USD.' },
  } };
  const original = JSON.stringify(agent), noop = () => {};
  const render = (value = agent, extra: any = {}) => renderToStaticMarkup(createElement(components.AgentCard, {
    agent: value, now, operationBusy: false, onProbe: noop, onInstall: noop, onConnect: noop, ...extra,
  }));
  const available = render();
  assert.match(available, /Connexion vérifiée/); assert.match(available, /44,7 % restants/);
  assert.match(available, /Autres modèles : 0 %/); assert.match(available, /Remise à zéro annoncée/);
  assert.match(available, /<details><summary>Détails techniques/); assert.doesNotMatch(available, /<details open/);
  const exhausted = structuredClone(agent); exhausted.health.quotaSnapshot.status = 'exhausted'; exhausted.health.quotaSnapshot.remaining = 0;
  assert.match(render(exhausted), /Quota épuisé/); assert.match(render(exhausted), /0 % restants/);
  const expired = render(agent, { now: now + 299000 });
  assert.match(expired, /Quota expiré/); assert.match(expired, /Relance la vérification/);
  assert.doesNotMatch(expired.split('<details>')[0], /44,7 %|45,8 %|Quota disponible/);
  assert.equal(components.quotaState(agent.health.quotaSnapshot, now + 298999), 'available');
  const reset = structuredClone(agent); reset.health.quotaSnapshot.resetAt = new Date(now).toISOString();
  assert.match(render(reset), /Quota expiré/);
  const unknown = structuredClone(agent); unknown.health.quotaSnapshot.status = 'unknown';
  unknown.health.quotaSnapshot.error = 'Le fournisseur ne publie pas de solde global' as any;
  const uncertain = render(unknown).split('<details>')[0];
  assert.match(uncertain, /Quota inconnu/); assert.match(uncertain, /ne publie pas de solde global/);
  assert.match(uncertain, /Crédits : 0 centimes USD/); assert.doesNotMatch(uncertain, /44,7 % restants/);
  const small = structuredClone(agent); small.health.quotaSnapshot.remaining = 0.0001;
  assert.match(render(small), /&lt; 0,1 % restants/);
  const busy = render(agent, { probe: { busy: true } });
  assert.match(busy, /aria-busy="true"/); assert.match(busy, /disabled="">Vérification en cours/);
  assert.match(busy, /role="status"/); assert.equal((busy.match(/disabled=""/g) ?? []).length, 3);
  const failed = render(agent, { probe: { busy: false, error: 'Réseau indisponible' } });
  assert.match(failed, /role="alert"/); assert.match(failed, /Réseau indisponible/); assert.match(failed, /Tu peux réessayer/);
  assert.doesNotMatch(failed, /disabled=""/);
  assert.equal(JSON.stringify(agent), original, 'le rendu ne modifie ni la mesure ni la définition de l’agent');
});

test('administration: une sonde en vol survit à la réouverture sans doublon et permet le réessai après erreur', async () => {
  const calls: string[] = [], waiting = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  const requests = createAgentProbeRequests(id => {
    calls.push(id);
    return new Promise((resolve, reject) => waiting.set(id, { resolve, reject }));
  });
  const first = requests.run('fake');
  await Promise.resolve();
  assert.equal(requests.entries()[0][0], 'fake');
  const reopened = requests.entries()[0][1];
  assert.equal(reopened, first, 'la modale remontée observe la requête existante');
  assert.equal(requests.run('fake'), first, 'un second clic ne lance pas un autre appel');
  assert.deepEqual(calls, ['fake']);
  const health = { status: 'ready', quota: 'available' };
  waiting.get('fake')!.resolve(health);
  assert.deepEqual(await reopened, health); assert.equal(requests.entries().length, 0);
  const failed = requests.run('fake');
  await Promise.resolve(); waiting.get('fake')!.reject(new Error('Réseau indisponible'));
  await assert.rejects(failed, /Réseau indisponible/); assert.equal(requests.entries().length, 0);
  const retry = requests.run('fake');
  await Promise.resolve(); waiting.get('fake')!.resolve(health);
  assert.deepEqual(await retry, health); assert.deepEqual(calls, ['fake', 'fake', 'fake']);
  const pending = requests.run('fake');
  let finishLoad!: () => void;
  let displayed = { status: 'old' };
  const resumed = requests.resume(async () => {
    const staleCatalog = { status: 'old' };
    await new Promise<void>(resolve => { finishLoad = resolve; });
    displayed = staleCatalog;
  }, async (_id, result) => { displayed = await result as typeof displayed; });
  await Promise.resolve(); waiting.get('fake')!.resolve(health);
  await pending;
  finishLoad(); await resumed;
  assert.deepEqual(displayed, health, 'une sonde terminée pendant le chargement remplace le catalogue ancien');
});

test('administration: brouillon JSON conservé, réponse enregistrée canonique et conflit explicite', async () => {
  const require = createRequire(import.meta.url), { transformWithOxc } = await import('vite');
  const { createElement } = require('react'), { renderToStaticMarkup } = require('react-dom/server');
  const compiled = await transformWithOxc(readFileSync(new URL('../web/src/Administration.tsx', import.meta.url), 'utf8'), 'Administration.tsx', { jsx: { runtime: 'classic' } });
  // Only the draft transition and controlled form are exercised; unrelated UI dependencies stay unloaded.
  const code = compiled.code.replace(/^import .*?;$/gm, '');
  const logic = await import('data:text/javascript;base64,' + Buffer.from(`import * as React from ${JSON.stringify(pathToFileURL(require.resolve('react')).href)};
    const createAgentProbeRequests = () => ({}); const guard = action => action;
    ${code}
    export { Configuration };`).toString('base64'));
  const saved = { concurrency: 3, secret: '••••••' }, updated = { concurrency: 4, secret: '••••••' };
  let draft = logic.receiveConfigurationDraft(null, saved);
  assert.equal(draft.text, JSON.stringify(saved, null, 2)); assert.equal(draft.text, draft.saved);
  draft = { ...draft, text: '{"concurrency":5,"secret":"synthetic-new-secret"}' };
  assert.deepEqual(logic.receiveConfigurationDraft(draft, saved), draft, 'changer d’onglet/recharger conserve le brouillon');
  assert.deepEqual(logic.receiveConfigurationDraft(draft, updated), draft, 'une nouvelle configuration ne détruit pas les modifications locales');
  assert.notEqual(draft.saved, JSON.stringify(updated, null, 2), 'le brouillon détecte une base enregistrée différente');
  const invalid = { ...draft, text: '{' };
  assert.deepEqual(logic.receiveConfigurationDraft(invalid, updated), invalid, 'même un JSON incomplet reste éditable');
  const submitted = draft.text, response = { concurrency: 5, secret: '••••••', defaultsApplied: true };
  const accepted = logic.receiveConfigurationDraft(draft, response, submitted);
  assert.equal(accepted.text, JSON.stringify(response, null, 2)); assert.equal(accepted.text, accepted.saved);
  assert.ok(!accepted.text.includes('synthetic-new-secret'), 'le retour masqué remplace le secret saisi après sauvegarde');
  assert.equal(logic.receiveConfigurationDraft(accepted, updated).text, JSON.stringify(updated, null, 2));
  const props = { draft, saving: false, conflict: false, onChange() {}, onSave: async () => {}, onReset() {} };
  const render = (extra: any = {}) => renderToStaticMarkup(createElement(logic.Configuration, { ...props, ...extra }));
  assert.match(render(), /synthetic-new-secret/);
  const pending = render({ saving: true });
  assert.match(pending, /Enregistrement…/); assert.equal((pending.match(/disabled=""/g) ?? []).length, 3);
  const conflict = render({ conflict: true });
  assert.match(conflict, /role="alert"/); assert.match(conflict, /disabled="">Valider et enregistrer/);
  assert.match(conflict, /Reprendre la configuration enregistrée/);
});
