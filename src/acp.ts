// Minimal Agent Client Protocol (ACP v1) client: JSON-RPC 2.0, newline-delimited, over an agent's stdio.
// Spec: https://agentclientprotocol.com — we only implement the client side we need.
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { config, type AgentDef } from './config.ts';

export type Json = any;
export type Handlers = {
  onUpdate: (acpSessionId: string, update: Json) => void;
  onPermission: (acpSessionId: string, params: Json) => Promise<Json>;
  onExit?: (code: number | null, stderr: string) => void;
};
export type McpServer = { name: string; command: string; args: string[]; env: { name: string; value: string }[] };
export type ModeOption = { id: string; name: string };

export const READ_ONLY_KINDS = ['read', 'search', 'fetch', 'think'];

export class AcpConnection {
  proc: ChildProcess;
  stderr = '';
  caps: Json = {};
  alive = true;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  private h: Handlers;

  constructor(def: AgentDef, cwd: string, h: Handlers) {
    this.h = h;
    this.proc = spawn(def.cmd, def.args, { cwd, env: { ...process.env, ...def.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    createInterface({ input: this.proc.stdout! }).on('line', (l) => this.onLine(l));
    this.proc.stderr!.on('data', (d) => { this.stderr = (this.stderr + d).slice(-8000); });
    this.proc.stdin!.on('error', () => {}); // EPIPE when the agent dies; surfaced via 'exit'
    const die = (code: number | null, err?: Error) => {
      if (!this.alive) return;
      this.alive = false;
      const e = err ?? new Error(`${def.name} s'est arrêté (code ${code}). ${this.stderr.slice(-600)}`);
      for (const p of this.pending.values()) p.reject(e);
      this.pending.clear();
      h.onExit?.(code, this.stderr);
    };
    this.proc.on('exit', (code) => die(code));
    this.proc.on('error', (err) => die(null, new Error(`impossible de lancer ${def.cmd}: ${err.message}`)));
  }

  private send(msg: Json) { if (this.alive) this.proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n'); }

  request(method: string, params: Json): Promise<Json> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (!this.alive) return reject(new Error('agent arrêté'));
      this.pending.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params: Json) { this.send({ method, params }); }

  private async onLine(line: string) {
    let m: Json;
    try { m = JSON.parse(line); } catch { return; } // agents occasionally log to stdout
    if (m.id != null && m.method == null) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(Object.assign(new Error(m.error.message + (m.error.data ? ` ${JSON.stringify(m.error.data)}` : '')), { code: m.error.code }));
      else p.resolve(m.result);
    } else if (m.method && m.id != null) {
      try {
        if (m.method !== 'session/request_permission') throw Object.assign(new Error(`méthode non supportée: ${m.method}`), { code: -32601 });
        this.send({ id: m.id, result: await this.h.onPermission(m.params.sessionId, m.params) });
      } catch (e: any) {
        this.send({ id: m.id, error: { code: e.code ?? -32603, message: String(e.message ?? e) } });
      }
    } else if (m.method === 'session/update') {
      this.h.onUpdate(m.params.sessionId, m.params.update);
    }
  }

  kill() { this.alive = false; this.proc.kill(); }
}

export type AgentSession = {
  conn: AcpConnection; acpId: string; loaded: boolean;
  modes: ModeOption[]; modeId: string | null; modeConfigId: string | null; configOptions: Json[];
};

/** Spawns an agent, initializes it and opens (or reloads) a session in `cwd`. */
export async function openAgent(agentId: string, cwd: string, h: Handlers, mcpServers: McpServer[], resumeId?: string | null): Promise<AgentSession> {
  const def = config.agents[agentId];
  if (!def) throw new Error(`agent inconnu: ${agentId}`);
  const conn = new AcpConnection(def, cwd, h);
  try {
    conn.caps = await conn.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'avityone', title: 'AvityOne', version: '0.1.0' },
    });
    if (def.authMethod) await conn.request('authenticate', { methodId: def.authMethod });
    let res: Json = null;
    let loaded = false;
    if (resumeId && conn.caps.agentCapabilities?.loadSession) {
      try { res = await conn.request('session/load', { sessionId: resumeId, cwd, mcpServers }); loaded = true; } catch { /* fall back to a fresh session */ }
    }
    if (!loaded) res = await conn.request('session/new', { cwd, mcpServers });
    const acpId = loaded ? resumeId! : res.sessionId;
    const s: AgentSession = { conn, acpId, loaded, modes: [], modeId: null, modeConfigId: null, configOptions: [] };
    applySessionInfo(s, res);
    return s;
  } catch (e) { conn.kill(); throw e; }
}

const flatten = (opts: Json[] = []): Json[] => opts.flatMap((o) => (o.options ? flatten(o.options) : [o]));

export function applySessionInfo(s: AgentSession, res: Json) {
  if (res?.configOptions) s.configOptions = res.configOptions;
  const modeOpt = s.configOptions.find((o) => o.category === 'mode');
  if (res?.modes) {
    s.modes = res.modes.availableModes.map((m: Json) => ({ id: m.id, name: m.name }));
    s.modeId = res.modes.currentModeId;
  } else if (modeOpt) {
    s.modes = flatten(modeOpt.options).map((o) => ({ id: o.value, name: o.name }));
    s.modeId = modeOpt.currentValue;
    s.modeConfigId = modeOpt.id;
  }
}

const MODE_PREFS: Record<string, RegExp[]> = {
  plan: [/plan/i, /read.?only|^ask$|architect/i],
  agent: [/^(agent|build|code|auto|default)$/i, /accept|edit|write|full/i],
};

/** Maps our two modes onto whatever mode ids this agent exposes. Returns false if the agent has no such mode. */
export async function setMode(s: AgentSession, want: 'plan' | 'agent'): Promise<boolean> {
  const pick = MODE_PREFS[want].map((re) => s.modes.find((m) => re.test(m.id) || re.test(m.name))).find(Boolean);
  if (!pick) return false;
  if (pick.id === s.modeId) return true;
  if (s.modeConfigId) applySessionInfo(s, await s.conn.request('session/set_config_option', { sessionId: s.acpId, configId: s.modeConfigId, value: pick.id }));
  else await s.conn.request('session/set_mode', { sessionId: s.acpId, modeId: pick.id });
  s.modeId = pick.id;
  return true;
}

export async function setConfigOption(s: AgentSession, configId: string, value: Json) {
  applySessionInfo(s, await s.conn.request('session/set_config_option', { sessionId: s.acpId, configId, value }));
}

/** Picks a model option whose id/name contains `hint` (e.g. "haiku"), if the agent exposes model selection. */
export async function preferModel(s: AgentSession, hint?: string) {
  const opt = hint && s.configOptions.find((o) => o.category === 'model');
  const match = opt && flatten(opt.options).find((o) => `${o.value} ${o.name}`.toLowerCase().includes(hint.toLowerCase()));
  if (match && match.value !== opt.currentValue) await setConfigOption(s, opt.id, match.value).catch(() => {});
}

/**
 * Runs a single read-only prompt on a throwaway agent session and returns the agent's text
 * (used for summaries and cross-reviews). Only read-only tool calls are allowed.
 */
export async function oneShot(agentId: string, cwd: string, prompt: string, opts: { model?: string; mcpServers?: McpServer[]; onText?: (t: string) => void } = {}): Promise<string> {
  let text = '';
  const s = await openAgent(agentId, cwd, {
    onUpdate: (_, u) => {
      if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') { text += u.content.text; opts.onText?.(text); }
    },
    onPermission: async (_, p) => {
      const ok = READ_ONLY_KINDS.includes(p.toolCall?.kind) ? p.options.find((o: Json) => o.kind.startsWith('allow')) : null;
      const no = p.options.find((o: Json) => o.kind.startsWith('reject'));
      return { outcome: ok ? { outcome: 'selected', optionId: ok.optionId } : no ? { outcome: 'selected', optionId: no.optionId } : { outcome: 'cancelled' } };
    },
  }, opts.mcpServers ?? []);
  try {
    await setMode(s, 'plan').catch(() => false);
    await preferModel(s, opts.model);
    await s.conn.request('session/prompt', { sessionId: s.acpId, prompt: [{ type: 'text', text: prompt }] });
    return text;
  } finally { s.conn.kill(); }
}
