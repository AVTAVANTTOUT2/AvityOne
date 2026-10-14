// End-to-end checks against a scripted ACP agent: routing, context injection, permissions, plan mode, MCP memory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
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
  agents: { fake: { name: 'Fake', cmd: process.execPath, args: [fake], strengths: '' }, fake2: { name: 'Fake2', cmd: process.execPath, args: [fake], strengths: '' } },
}));

const { route } = await import('../src/router.ts');
const { ftsQuery, addMemory, searchMemory } = await import('../src/store.ts');
const { hub } = await import('../src/hub.ts');
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
