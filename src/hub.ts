// Orchestrator: owns live agent connections, routes prompts, streams items to the UI and drives plan → execute → review.
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, existsSync } from 'node:fs';
import { join, isAbsolute, relative } from 'node:path';
import { all, one, run, type Row } from './store.ts';
import { config, availableAgents } from './config.ts';
import { route, type Forced, type Mode } from './router.ts';
import { openAgent, setMode, setConfigOption, applySessionInfo, oneShot, READ_ONLY_KINDS, type AgentSession, type Json } from './acp.ts';
import { buildPack, transcript, summarize, gitDiff, mcpServersFor, indexProject } from './context.ts';
import { git, canBranch, addWorktree, mergeWorktree, removeWorktree, branchOf } from './worktree.ts';

export const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });

const PLAN_PREFIX = `MODE PLAN : ne crée, ne modifie et ne supprime aucun fichier. Explore et analyse, puis propose un plan
d'implémentation détaillé et numéroté (fichiers touchés, étapes, risques, comment vérifier).\n\n`;
const EXECUTE_PROMPT = `Le plan ci-dessus est approuvé. Exécute-le maintenant étape par étape, vérifie (build, tests, lint)
et termine par un résumé de ce qui a été fait et de ce qui reste.`;
const PARALLEL_PROMPT = (plan: string, tasks: string[]) => `Tu exécutes UNE partie d'un plan, en parallèle d'autres agents
qui travaillent chacun dans leur propre worktree git.

## Plan global (contexte)
${plan}

## Ta tâche
${tasks.map((t) => `- ${t}`).join('\n')}

Ne fais que ta tâche : les autres étapes sont confiées à d'autres agents. Vérifie (build, tests, lint) et termine par
un résumé. Ne merge rien toi-même : AvityOne mergera ta branche.`;

type Live = {
  id: string; projectId: number; agent: string | null; mode: Mode; busy: boolean; autoApprove: boolean;
  isolated: boolean; worktree: string | null; parentId: string | null;
  a: AgentSession | null; fresh: boolean;
  last: Row | null; tools: Map<string, Row>; plan: Row | null;
  pending: Map<number, (optionId: string | null) => void>;
};

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '\n…' : s);

function toolFields(u: Json): Row {
  const f: Row = {};
  if (u.title) f.title = u.title;
  if (u.kind) f.kind = u.kind;
  if (u.status) f.status = u.status;
  if (u.locations?.length) f.paths = u.locations.map((l: Json) => l.path + (l.line ? `:${l.line}` : ''));
  if (u.rawInput?.command) f.command = [].concat(u.rawInput.command).join(' ');
  if (u.content?.length) {
    const diffs = u.content.filter((c: Json) => c.type === 'diff').map((c: Json) => ({ path: c.path, old: clip(c.oldText ?? '', 8000), new: clip(c.newText ?? '', 8000) }));
    const out = u.content.filter((c: Json) => c.type === 'content' && c.content?.type === 'text').map((c: Json) => c.content.text).join('\n');
    if (diffs.length) f.diffs = diffs;
    if (out) f.output = out.slice(-4000);
  }
  return f;
}

/** Tasks of the session's latest plan: the agent's plan entries, else the numbered list of its last answer or plan. */
export function planTasks(sessionId: string): { plan: string; tasks: string[] } {
  const last = (where: string) => {
    const r = one(`SELECT data FROM items WHERE session_id = ? AND ${where} ORDER BY id DESC LIMIT 1`, sessionId);
    return r ? JSON.parse(r.data) : null;
  };
  const plan = last(`json_extract(data, '$.type') = 'plan'`);
  if (plan?.entries?.length) {
    const tasks: string[] = plan.entries.map((e: Row) => e.content);
    return { plan: tasks.map((t, i) => `${i + 1}. ${t}`).join('\n'), tasks };
  }
  // Claude's plan mode hands its plan over in the switch_mode permission rather than as a message.
  const text: string = last(`(json_extract(data, '$.type') = 'assistant' OR (json_extract(data, '$.type') = 'permission' AND json_extract(data, '$.kind') = 'switch_mode'))`)?.text ?? '';
  const tasks = text.split('\n').map((l) => /^(?:#{1,6}\s+)?\**\d+[.)]\**\s+(.+)/.exec(l)?.[1].replace(/\*\*/g, '').trim()).filter((t): t is string => !!t);
  return { plan: clip(text, 12_000), tasks };
}

const contentText = (tc: Json) => (tc.content ?? []).map((c: Json) => c.content?.text ?? (c.type === 'diff' ? `✎ ${c.path}` : '')).filter(Boolean).join('\n');

export class Hub {
  live = new Map<string, Live>();
  listeners = new Set<(ev: Json) => void>();
  private merging = new Set<number>();

  emit(ev: Json) { for (const l of this.listeners) l(ev); }

  private project(id: number | string): Row {
    const p = one('SELECT * FROM projects WHERE id = ?', Number(id));
    if (!p) throw httpError(404, 'projet inconnu');
    return p;
  }

  get(id: string): Live {
    let L = this.live.get(id);
    if (L) return L;
    const s = one('SELECT * FROM sessions WHERE id = ?', id);
    if (!s) throw httpError(404, 'session inconnue');
    L = { id, projectId: s.project_id, agent: s.agent, mode: s.mode ?? 'agent', busy: false, autoApprove: config.autoApprove,
      isolated: !!s.isolated, worktree: s.worktree, parentId: s.parent_id, a: null, fresh: false, last: null, tools: new Map(), plan: null, pending: new Map() };
    this.live.set(id, L);
    return L;
  }

  state(L: Live) {
    return { busy: L.busy, agent: L.agent, mode: L.mode, autoApprove: L.autoApprove, connected: !!L.a, isolated: L.isolated, worktree: L.worktree,
      modeId: L.a?.modeId ?? null, modes: L.a?.modes ?? [], configOptions: L.a?.configOptions ?? [] };
  }
  private emitState(L: Live) { this.emit({ type: 'state', sessionId: L.id, state: this.state(L) }); }

  private addItem(L: Live, item: Row): Row {
    item.id = Number(run('INSERT INTO items (session_id, data) VALUES (?, ?)', L.id, JSON.stringify(item)).lastInsertRowid);
    L.last = item;
    this.emit({ type: 'item', sessionId: L.id, item });
    return item;
  }
  private saveItem(L: Live, item: Row) {
    const { id, ...data } = item;
    run('UPDATE items SET data = ? WHERE id = ?', JSON.stringify(data), id);
    this.emit({ type: 'item', sessionId: L.id, item });
  }

  snapshot(id: string) {
    const L = this.get(id);
    const items = all('SELECT id, data FROM items WHERE session_id = ? ORDER BY id', id).map((r) => ({ ...JSON.parse(r.data), id: r.id }));
    return { session: one('SELECT * FROM sessions WHERE id = ?', id), state: this.state(L), items };
  }

  // ---------- projects & sessions ----------

  async createProject(b: Row): Promise<Row> {
    const name = String(b.name ?? '').trim();
    if (!/^[\w.-]{1,64}$/.test(name)) throw httpError(400, 'nom de projet invalide (lettres, chiffres, . _ -)');
    const path = b.path ? String(b.path) : join(config.projectsDir, name);
    if (!isAbsolute(path)) throw httpError(400, 'le chemin doit être absolu');
    if (one('SELECT 1 FROM projects WHERE name = ?', name)) throw httpError(409, 'ce projet existe déjà');
    if (b.git) {
      if (!/^(https:\/\/|git@)[\w.@:/~-]+$/.test(String(b.git))) throw httpError(400, 'URL git invalide');
      if (existsSync(path)) throw httpError(409, `${path} existe déjà`);
      await promisify(execFile)('git', ['clone', '--', String(b.git), path], { timeout: 600_000 });
    } else mkdirSync(path, { recursive: true });
    const id = Number(run('INSERT INTO projects (name, path) VALUES (?, ?)', name, path).lastInsertRowid);
    const p = this.project(id);
    return { ...p, chunks: indexProject(p) };
  }

  createSession(projectId: number, title?: string, o: { isolated?: boolean; parentId?: string } = {}) {
    this.project(projectId);
    const id = randomUUID();
    run('INSERT INTO sessions (id, project_id, title, isolated, parent_id) VALUES (?, ?, ?, ?, ?)', id, projectId, title || null, o.isolated ? 1 : 0, o.parentId ?? null);
    // Starting new work is the natural moment to fold finished sessions into project memory.
    for (const s of all('SELECT id FROM sessions WHERE project_id = ? AND id <> ? AND turns > summarized_turns ORDER BY updated_at DESC LIMIT 3', projectId, id)) this.summarizeBg(s.id);
    this.emit({ type: 'sessions', projectId });
    return one('SELECT * FROM sessions WHERE id = ?', id)!;
  }

  // ---------- agent connections ----------

  private async connect(L: Live, agentId: string) {
    const p = this.project(L.projectId);
    const s = one('SELECT agent, acp_session_id FROM sessions WHERE id = ?', L.id)!;
    // Events only count once this connection is the session's current one: that drops
    // session/load history replays and anything a replaced connection still emits.
    const holder: { a?: AgentSession } = {};
    const mine = () => !!holder.a && L.a === holder.a;
    const a = await openAgent(agentId, L.worktree ?? p.path, {
      onUpdate: (_, u) => { if (mine()) this.onUpdate(L, u); },
      onPermission: (_, params) => this.onPermission(mine() ? L : null, params),
      onExit: () => { if (mine()) this.drop(L); this.emitState(L); },
    }, mcpServersFor(p.id), s.agent === agentId ? s.acp_session_id : null);
    holder.a = a;
    L.a = a; L.agent = agentId; L.fresh = !a.loaded;
    run('UPDATE sessions SET agent = ?, acp_session_id = ? WHERE id = ?', agentId, a.acpId, L.id);
  }

  /** Moves an isolated session into its own git worktree on its first agent-mode turn. Non-git projects stay as they are. */
  private async isolate(L: Live, p: Row) {
    if (!L.isolated || L.worktree || !(await canBranch(p.path))) return;
    L.worktree = await addWorktree(p.path, L.id);
    run('UPDATE sessions SET worktree = ?, acp_session_id = NULL WHERE id = ?', L.worktree, L.id);
    this.drop(L); // an agent already running works in the project directory: it restarts in the worktree
    this.addItem(L, { type: 'info', text: `🌿 Worktree isolé : ${relative(p.path, L.worktree)} (branche ${branchOf(L.id)})` });
  }

  /** Mirrors a sub-session's status into its parent's « parallel » card. */
  private syncChild(L: Live, status: string, conflicts?: string[]) {
    if (!L.parentId) return;
    const r = one(`SELECT i.id, i.data FROM items i, json_each(i.data, '$.children') c
      WHERE i.session_id = ? AND json_extract(c.value, '$.id') = ?`, L.parentId, L.id);
    if (!r) return;
    const item = { ...JSON.parse(r.data), id: r.id };
    Object.assign(item.children.find((c: Row) => c.id === L.id), { status, conflicts });
    this.saveItem(this.get(L.parentId), item);
  }

  private drop(L: Live) {
    if (!L.a) return;
    L.a.conn.kill();
    L.a = null;
    this.cancelPending(L);
  }

  private cancelPending(L: Live) { for (const fn of [...L.pending.values()]) fn(null); }

  private onUpdate(L: Live, u: Json) {
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk': {
        const type = u.sessionUpdate === 'agent_message_chunk' ? 'assistant' : 'thought';
        const t = u.content?.type === 'text' ? u.content.text : u.content ? `[${u.content.type}]` : '';
        if (L.last?.type === type) { L.last.text += t; this.saveItem(L, L.last); } else this.addItem(L, { type, agent: L.agent, text: t });
        break;
      }
      case 'tool_call':
      case 'tool_call_update': {
        const item = L.tools.get(u.toolCallId);
        if (item) { Object.assign(item, toolFields(u)); this.saveItem(L, item); }
        else L.tools.set(u.toolCallId, this.addItem(L, { type: 'tool', toolCallId: u.toolCallId, title: 'outil', status: 'pending', ...toolFields(u) }));
        break;
      }
      case 'plan':
        if (L.plan) { L.plan.entries = u.entries; this.saveItem(L, L.plan); } else L.plan = this.addItem(L, { type: 'plan', entries: u.entries });
        break;
      case 'current_mode_update':
        if (L.a) L.a.modeId = u.currentModeId;
        this.emitState(L);
        break;
      case 'config_option_update':
        if (L.a) applySessionInfo(L.a, { configOptions: u.configOptions });
        this.emitState(L);
        break;
    }
  }

  private async onPermission(L: Live | null, params: Json): Promise<Json> {
    const tc = params.toolCall ?? {};
    const opts: Json[] = params.options ?? [];
    const allow = opts.find((o) => o.kind === 'allow_always') ?? opts.find((o) => o.kind === 'allow_once');
    const known = L?.tools.get(tc.toolCallId);
    const kind = tc.kind ?? known?.kind;
    // Leaving plan mode would execute in the project directory: an isolated session goes through « Exécuter le plan ».
    if (L?.isolated && !L.worktree && kind === 'switch_mode' && (await canBranch(this.project(L.projectId).path))) {
      this.addItem(L, { type: 'permission', title: tc.title ?? known?.title ?? 'Plan', kind, text: clip(contentText(tc), 20_000), options: [],
        resolved: '🌿 session isolée : « Exécuter le plan » le lance dans son propre worktree' });
      const no = opts.find((o) => o.kind.startsWith('reject'));
      return { outcome: no ? { outcome: 'selected', optionId: no.optionId } : { outcome: 'cancelled' } };
    }
    const risky = L?.mode === 'plan' ? ['edit', 'delete', 'move', 'execute'] : [];
    // switch_mode is the "plan is ready" gate: always the user's call.
    if (L && allow && kind !== 'switch_mode' && (READ_ONLY_KINDS.includes(kind) || (L.autoApprove && !risky.includes(kind)))) {
      return { outcome: { outcome: 'selected', optionId: allow.optionId } };
    }
    if (!L) return { outcome: { outcome: 'cancelled' } };
    const item = this.addItem(L, { type: 'permission', title: tc.title ?? known?.title ?? 'Action', kind,
      text: clip(contentText(tc), 20_000), options: opts.map((o) => ({ id: o.optionId, name: o.name, kind: o.kind })) });
    this.syncChild(L, 'waiting');
    return new Promise((resolve) => L.pending.set(item.id, (optionId) => {
      L.pending.delete(item.id);
      this.syncChild(L, 'running');
      const opt = opts.find((o) => o.optionId === optionId);
      item.resolved = opt?.name ?? 'annulé';
      this.saveItem(L, item);
      if (kind === 'switch_mode' && opt?.kind.startsWith('allow')) { L.mode = 'agent'; run('UPDATE sessions SET mode = ? WHERE id = ?', 'agent', L.id); this.emitState(L); }
      resolve({ outcome: opt ? { outcome: 'selected', optionId: opt.optionId } : { outcome: 'cancelled' } });
    }));
  }

  // ---------- user actions ----------

  prompt(sessionId: string, text: string, forced: Forced = {}) {
    const L = this.get(sessionId);
    if (L.busy) throw httpError(409, 'session occupée : attends la fin du tour ou arrête-le');
    if (!text.trim()) throw httpError(400, 'message vide');
    const r = route(text, availableAgents(), forced, L.agent, L.mode);
    const prior = one('SELECT turns FROM sessions WHERE id = ?', L.id)!.turns > 0 ? transcript(L.id, 10_000) : '';
    L.busy = true; L.plan = null; L.tools.clear();
    this.emitState(L);
    this.addItem(L, { type: 'user', text: r.prompt, agent: r.agent, mode: r.mode, reason: r.reason });
    this.syncChild(L, 'running');
    (async () => {
      try {
        const p = this.project(L.projectId);
        if (r.mode === 'agent') await this.isolate(L, p);
        if (L.a && L.agent !== r.agent) this.drop(L);
        if (!L.a) await this.connect(L, r.agent);
        const a = L.a!;
        L.mode = r.mode;
        await setMode(a, r.mode).catch(() => false);
        this.emitState(L);
        const blocks: Json[] = [];
        if (L.fresh) {
          const pack = buildPack(p, L.id, r.prompt, prior, L.worktree ?? p.path);
          blocks.push({ type: 'text', text: pack.text });
          L.fresh = false;
          this.addItem(L, { type: 'info', text: `Contexte injecté → ${config.agents[r.agent].name} : ${pack.stats}` });
        }
        blocks.push({ type: 'text', text: r.mode === 'plan' ? PLAN_PREFIX + r.prompt : r.prompt });
        run(`UPDATE sessions SET agent = ?, mode = ?, title = COALESCE(title, ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?`, r.agent, r.mode, r.prompt.slice(0, 60), L.id);
        this.emit({ type: 'sessions', projectId: L.projectId });
        const res = await a.conn.request('session/prompt', { sessionId: a.acpId, prompt: blocks });
        this.addItem(L, { type: 'end', stopReason: res?.stopReason ?? 'end_turn', agent: r.agent });
        this.syncChild(L, 'done');
        run('UPDATE sessions SET turns = turns + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?', L.id);
        const s = one('SELECT turns, summarized_turns FROM sessions WHERE id = ?', L.id)!;
        if (s.turns - s.summarized_turns >= config.summarizeEvery) this.summarizeBg(L.id);
      } catch (e: any) {
        this.addItem(L, { type: 'error', text: String(e.message ?? e) });
        this.syncChild(L, 'error');
      } finally {
        L.busy = false;
        this.emitState(L);
      }
    })();
    return r;
  }

  cancel(sessionId: string) {
    const L = this.get(sessionId);
    if (L.a) L.a.conn.notify('session/cancel', { sessionId: L.a.acpId });
    this.cancelPending(L);
    return { ok: true };
  }

  respondPermission(sessionId: string, permId: number, optionId: string | null) {
    const fn = this.get(sessionId).pending.get(Number(permId));
    if (!fn) throw httpError(404, 'demande de permission expirée');
    fn(optionId);
    return { ok: true };
  }

  async setConfig(sessionId: string, configId: string, value: Json) {
    const L = this.get(sessionId);
    if (!L.a) throw httpError(409, 'agent non connecté');
    await setConfigOption(L.a, configId, value);
    this.emitState(L);
    return this.state(L);
  }

  setAutoApprove(sessionId: string, on: boolean) {
    const L = this.get(sessionId);
    L.autoApprove = !!on;
    this.emitState(L);
    return this.state(L);
  }

  setIsolated(sessionId: string, on: boolean) {
    const L = this.get(sessionId);
    L.isolated = !!on;
    run('UPDATE sessions SET isolated = ? WHERE id = ?', L.isolated ? 1 : 0, L.id);
    this.emitState(L);
    return this.state(L);
  }

  execute(sessionId: string, agent?: string) {
    return this.prompt(sessionId, EXECUTE_PROMPT, { agent, mode: 'agent' });
  }

  /** Splits the session's latest plan into sub-sessions, each in its own worktree with the agent picked by the router. */
  async parallel(sessionId: string) {
    const P = this.get(sessionId);
    if (P.busy) throw httpError(409, 'session occupée : attends la fin du plan');
    const p = this.project(P.projectId);
    if (!(await canBranch(p.path))) throw httpError(409, 'exécution parallèle : le projet doit être un dépôt git avec au moins un commit');
    const { plan, tasks } = planTasks(P.id);
    if (!tasks.length) throw httpError(400, 'aucune tâche à répartir : ni plan d\'agent, ni liste numérotée dans la dernière réponse');
    // ponytail: consecutive chunks keep neighbouring steps together; group by touched files if this splits coupled steps.
    const n = Math.min(tasks.length, config.parallel);
    const groups = Array.from({ length: n }, (_, i) => tasks.slice(Math.floor((i * tasks.length) / n), Math.floor(((i + 1) * tasks.length) / n)));
    const avail = availableAgents();
    const kids = groups.map((g) => {
      const task = g.join(' · ');
      const s = this.createSession(p.id, task.slice(0, 60), { isolated: true, parentId: P.id });
      return { id: s.id as string, task, agent: route(task, avail).agent, status: 'running', g };
    });
    const item = this.addItem(P, { type: 'parallel', children: kids.map(({ g, ...k }) => k) });
    for (const k of kids) this.prompt(k.id, PARALLEL_PROMPT(plan, k.g), { agent: k.agent, mode: 'agent' });
    return item;
  }

  /** Merges the session's worktree and its sub-sessions' into the project's current branch, then cross-reviews the result. */
  async merge(sessionId: string) {
    const L0 = this.get(sessionId);
    const p = this.project(L0.projectId);
    const targets = [L0, ...all('SELECT id FROM sessions WHERE parent_id = ? ORDER BY rowid', L0.id).map((r) => this.get(r.id))].filter((L) => L.worktree);
    if (!targets.length) throw httpError(409, 'rien à merger : aucun worktree actif');
    if (targets.some((L) => L.busy)) throw httpError(409, 'des sessions travaillent encore : attends la fin ou arrête-les');
    if (this.merging.has(p.id)) throw httpError(409, 'un merge est déjà en cours sur ce projet');
    this.merging.add(p.id);
    try {
      const into = await git(p.path, 'rev-parse', '--abbrev-ref', 'HEAD');
      const base = await git(p.path, 'rev-parse', 'HEAD');
      const lines: string[] = [];
      let failed = 0;
      for (const L of targets) {
        const title = one('SELECT title FROM sessions WHERE id = ?', L.id)!.title ?? L.id;
        const r = await mergeWorktree(p.path, L.worktree!, L.id, `avity: ${title}`);
        if (r.ok) {
          this.drop(L);
          await removeWorktree(p.path, L.worktree!, L.id);
          L.worktree = null;
          run('UPDATE sessions SET worktree = NULL, acp_session_id = NULL WHERE id = ?', L.id);
          this.emitState(L);
          lines.push(`✓ ${title}`);
        } else {
          failed++;
          lines.push(`✗ ${title} (${branchOf(L.id)}) : ${r.conflicts.length ? `conflit sur ${r.conflicts.join(', ')}` : r.error}`);
        }
        this.syncChild(L, r.ok ? 'merged' : 'conflict', r.conflicts);
      }
      this.addItem(L0, { type: failed ? 'error' : 'info', text: `🔀 Merge dans ${into} :\n${lines.join('\n')}${failed ? `\n\nMerge annulé pour ${failed} branche(s), worktree conservé. Demande à la sous-session de merger ${into} dans sa branche et de résoudre les conflits (ou fais-le à la main), puis relance « Merger ».` : ''}` });
      const diff = gitDiff(p.path, `${base}..HEAD`);
      if (diff.trim()) this.review(L0.id, undefined, diff);
      return { merged: targets.length - failed, failed };
    } finally { this.merging.delete(p.id); }
  }

  /** Cross-model review of a diff (by default the session's working tree) by a different agent, streamed into the session. */
  review(sessionId: string, agent?: string, diff?: string) {
    const L = this.get(sessionId);
    const p = this.project(L.projectId);
    const avail = availableAgents();
    const wanted = agent && agent !== 'auto' ? agent : config.reviewer[L.agent ?? ''];
    const who = avail.includes(wanted) ? wanted : avail.find((x) => x !== L.agent) ?? avail[0];
    if (!who) throw httpError(409, 'aucun agent installé');
    const cwd = L.worktree ?? p.path;
    diff ??= gitDiff(cwd);
    if (!diff.trim()) return this.addItem(L, { type: 'info', text: 'Revue : rien à relire (git diff vide).' });
    const goals = all(`SELECT data FROM items WHERE session_id = ? AND json_extract(data, '$.type') = 'user' ORDER BY id DESC LIMIT 3`, L.id)
      .map((r) => JSON.parse(r.data).text).reverse().join('\n---\n');
    const item = this.addItem(L, { type: 'review', agent: who, status: 'running', text: '' });
    oneShot(who, cwd, `Tu es relecteur senior pour une revue de code croisée (un autre agent a écrit ce code).
Objectif de la tâche :
${goals || '(non précisé)'}

Relis le diff ci-dessous. Liste uniquement les problèmes réels, du plus grave au moins grave : bugs, régressions,
failles de sécurité, cas limites non gérés, écarts avec l'objectif. Pour chacun : fichier:ligne, pourquoi, correctif proposé.
Termine par un verdict : OK pour merger / à corriger. Ne modifie aucun fichier.

\`\`\`diff
${diff}
\`\`\``, { mcpServers: mcpServersFor(p.id), onText: (t) => { item.text = t; this.saveItem(L, item); } })
      .then((t) => { item.text = t; item.status = 'done'; })
      .catch((e) => { item.status = 'error'; item.text += `\n\n⚠️ ${e.message}`; })
      .finally(() => this.saveItem(L, item));
    return item;
  }

  summarizeBg(sessionId: string) {
    summarize(sessionId).then((r) => {
      if (!r) return;
      const L = this.get(sessionId);
      this.addItem(L, { type: 'info', text: `🧠 Session résumée${r.added ? `, ${r.added} connaissance(s) ajoutée(s) à la mémoire du projet` : ''}.` });
      this.emit({ type: 'sessions', projectId: L.projectId });
    }).catch((e) => console.error(`[summarize ${sessionId}]`, e.message));
  }

  shutdown() { for (const L of this.live.values()) this.drop(L); }
}

export const hub = new Hub();
