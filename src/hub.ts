// Orchestrator: owns live agent connections, routes prompts, streams items to the UI and drives plan → execute → review.
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { all, one, run, type Row } from './store.ts';
import { config, availableAgents } from './config.ts';
import { route, type Forced, type Mode } from './router.ts';
import { openAgent, setMode, setConfigOption, applySessionInfo, oneShot, READ_ONLY_KINDS, type AgentSession, type Json } from './acp.ts';
import { buildPack, transcript, summarize, gitDiff, mcpServersFor, indexProject } from './context.ts';

export const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });

const PLAN_PREFIX = `MODE PLAN : ne crée, ne modifie et ne supprime aucun fichier. Explore et analyse, puis propose un plan
d'implémentation détaillé et numéroté (fichiers touchés, étapes, risques, comment vérifier).\n\n`;
const EXECUTE_PROMPT = `Le plan ci-dessus est approuvé. Exécute-le maintenant étape par étape, vérifie (build, tests, lint)
et termine par un résumé de ce qui a été fait et de ce qui reste.`;

type Live = {
  id: string; projectId: number; agent: string | null; mode: Mode; busy: boolean; autoApprove: boolean;
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

const contentText = (tc: Json) => (tc.content ?? []).map((c: Json) => c.content?.text ?? (c.type === 'diff' ? `✎ ${c.path}` : '')).filter(Boolean).join('\n');

export class Hub {
  live = new Map<string, Live>();
  listeners = new Set<(ev: Json) => void>();

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
      a: null, fresh: false, last: null, tools: new Map(), plan: null, pending: new Map() };
    this.live.set(id, L);
    return L;
  }

  state(L: Live) {
    return { busy: L.busy, agent: L.agent, mode: L.mode, autoApprove: L.autoApprove, connected: !!L.a,
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

  createSession(projectId: number, title?: string) {
    this.project(projectId);
    const id = randomUUID();
    run('INSERT INTO sessions (id, project_id, title) VALUES (?, ?, ?)', id, projectId, title || null);
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
    const a = await openAgent(agentId, p.path, {
      onUpdate: (_, u) => { if (mine()) this.onUpdate(L, u); },
      onPermission: (_, params) => this.onPermission(mine() ? L : null, params),
      onExit: () => { if (mine()) this.drop(L); this.emitState(L); },
    }, mcpServersFor(p.id), s.agent === agentId ? s.acp_session_id : null);
    holder.a = a;
    L.a = a; L.agent = agentId; L.fresh = !a.loaded;
    run('UPDATE sessions SET agent = ?, acp_session_id = ? WHERE id = ?', agentId, a.acpId, L.id);
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

  private onPermission(L: Live | null, params: Json): Promise<Json> {
    const tc = params.toolCall ?? {};
    const opts: Json[] = params.options ?? [];
    const allow = opts.find((o) => o.kind === 'allow_always') ?? opts.find((o) => o.kind === 'allow_once');
    const known = L?.tools.get(tc.toolCallId);
    const kind = tc.kind ?? known?.kind;
    const risky = L?.mode === 'plan' ? ['edit', 'delete', 'move', 'execute'] : [];
    // switch_mode is the "plan is ready" gate: always the user's call.
    if (L && allow && kind !== 'switch_mode' && (READ_ONLY_KINDS.includes(kind) || (L.autoApprove && !risky.includes(kind)))) {
      return Promise.resolve({ outcome: { outcome: 'selected', optionId: allow.optionId } });
    }
    if (!L) return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    const item = this.addItem(L, { type: 'permission', title: tc.title ?? known?.title ?? 'Action', kind,
      text: clip(contentText(tc), 20_000), options: opts.map((o) => ({ id: o.optionId, name: o.name, kind: o.kind })) });
    return new Promise((resolve) => L.pending.set(item.id, (optionId) => {
      L.pending.delete(item.id);
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
    (async () => {
      try {
        const p = this.project(L.projectId);
        if (L.a && L.agent !== r.agent) this.drop(L);
        if (!L.a) await this.connect(L, r.agent);
        const a = L.a!;
        L.mode = r.mode;
        await setMode(a, r.mode).catch(() => false);
        this.emitState(L);
        const blocks: Json[] = [];
        if (L.fresh) {
          const pack = buildPack(p, L.id, r.prompt, prior);
          blocks.push({ type: 'text', text: pack.text });
          L.fresh = false;
          this.addItem(L, { type: 'info', text: `Contexte injecté → ${config.agents[r.agent].name} : ${pack.stats}` });
        }
        blocks.push({ type: 'text', text: r.mode === 'plan' ? PLAN_PREFIX + r.prompt : r.prompt });
        run(`UPDATE sessions SET agent = ?, mode = ?, title = COALESCE(title, ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?`, r.agent, r.mode, r.prompt.slice(0, 60), L.id);
        this.emit({ type: 'sessions', projectId: L.projectId });
        const res = await a.conn.request('session/prompt', { sessionId: a.acpId, prompt: blocks });
        this.addItem(L, { type: 'end', stopReason: res?.stopReason ?? 'end_turn', agent: r.agent });
        run('UPDATE sessions SET turns = turns + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?', L.id);
        const s = one('SELECT turns, summarized_turns FROM sessions WHERE id = ?', L.id)!;
        if (s.turns - s.summarized_turns >= config.summarizeEvery) this.summarizeBg(L.id);
      } catch (e: any) {
        this.addItem(L, { type: 'error', text: String(e.message ?? e) });
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

  execute(sessionId: string, agent?: string) {
    return this.prompt(sessionId, EXECUTE_PROMPT, { agent, mode: 'agent' });
  }

  /** Cross-model review of the working-tree diff by a different agent, streamed into the session. */
  review(sessionId: string, agent?: string) {
    const L = this.get(sessionId);
    const p = this.project(L.projectId);
    const avail = availableAgents();
    const wanted = agent && agent !== 'auto' ? agent : config.reviewer[L.agent ?? ''];
    const who = avail.includes(wanted) ? wanted : avail.find((x) => x !== L.agent) ?? avail[0];
    if (!who) throw httpError(409, 'aucun agent installé');
    const diff = gitDiff(p.path);
    if (!diff.trim()) return this.addItem(L, { type: 'info', text: 'Revue : rien à relire (git diff vide).' });
    const goals = all(`SELECT data FROM items WHERE session_id = ? AND json_extract(data, '$.type') = 'user' ORDER BY id DESC LIMIT 3`, L.id)
      .map((r) => JSON.parse(r.data).text).reverse().join('\n---\n');
    const item = this.addItem(L, { type: 'review', agent: who, status: 'running', text: '' });
    oneShot(who, p.path, `Tu es relecteur senior pour une revue de code croisée (un autre agent a écrit ce code).
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
