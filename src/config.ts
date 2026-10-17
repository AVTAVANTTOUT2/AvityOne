import { readFileSync, writeFileSync, mkdirSync, existsSync, accessSync, renameSync, constants } from 'node:fs';
import { join, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

export type AgentDef = { name: string; cmd: string; args: string[]; env?: Record<string, string>; authMethod?: string; strengths: string; quota?: { cmd: string; args: string[]; env?: Record<string, string>; timeoutMs?: number } };
export type RouteRule = { match: string; agent: string; mode?: 'plan' | 'agent' };
export type ExtraMcp = { name: string; command: string; args: string[]; env: Record<string, string>; enabled: boolean };

export const HOME = process.env.AVITY_HOME ?? join(homedir(), '.avityone');
mkdirSync(HOME, { recursive: true });

const DEFAULTS = {
  port: 7710,
  host: '0.0.0.0',
  token: '',
  projectsDir: join(homedir(), 'projects'),
  // Each agent is spawned as an ACP server over stdio. Cursor and OpenCode speak ACP natively,
  // Claude Code and Codex go through the official agentclientprotocol adapters.
  agents: {
    claude: { name: 'Claude Code', cmd: 'claude-agent-acp', args: [], strengths: 'architecture, plans, raisonnement long, refactors transverses' },
    codex: { name: 'Codex', cmd: 'codex-acp', args: [], strengths: 'implémentation autonome, debug, tests, revue de code' },
    cursor: { name: 'Cursor', cmd: 'agent', args: ['acp'], authMethod: 'cursor_login', strengths: 'éditions rapides, UI/front, itérations courtes' },
    opencode: { name: 'OpenCode', cmd: 'opencode', args: ['acp'], strengths: 'questions, exploration, modèles alternatifs' },
  } as Record<string, AgentDef>,
  defaultAgent: 'claude',
  // First matching rule wins when a session has no agent yet. Regex, case-insensitive.
  routes: [
    { match: '^/review\\b|\\b(review|relis|relecture|audit)', agent: 'codex', mode: 'plan' },
    { match: '\\b(plan|planifie|architecture|archi|con[çc]ois|design|spec|strat[ée]gie)', agent: 'claude', mode: 'plan' },
    { match: '\\b(bug|debug|fix|corrige|erreur|crash|test|tests|refactor)', agent: 'codex' },
    { match: '\\b(ui|css|style|composant|front|maquette|tailwind)', agent: 'cursor' },
    { match: '\\b(explique|pourquoi|comment marche|o[ùu] est|cherche|r[ée]sume)', agent: 'opencode', mode: 'plan' },
  ] as RouteRule[],
  // Cross-model review: who reviews whose work.
  reviewer: { claude: 'codex', codex: 'claude', cursor: 'codex', opencode: 'claude' } as Record<string, string>,
  summarizer: { agent: 'claude', model: 'haiku' },
  summarizeEvery: 4,
  autoApprove: true,
  // Max sub-sessions (each in its own git worktree) for « Exécuter en parallèle ».
  parallel: 4,
  globalConcurrency: 3,
  idleTimeoutMs: 300_000,
  stallTimeoutMs: 600_000,
  validationTimeoutMs: 300_000,
  validationCommands: [] as string[],
  prepareCommand: '',
  transcription: { command: '', args: [] as string[] },
  routing: { strategy: 'rules' as 'rules' | 'performance' | 'llm', agent: '', model: '', fallback: true },
  mcpServers: [] as ExtraMcp[],
  budgets: { dailyTokens: 0, dailyCostUsd: 0, requireUsage: false },
  agentTimeoutMs: 120_000,
};

const file = join(HOME, 'config.json');
if (!existsSync(file)) writeFileSync(file, JSON.stringify({ token: randomBytes(24).toString('base64url') }, null, 2) + '\n', { mode: 0o600 });
const user = JSON.parse(readFileSync(file, 'utf8'));

export const config: typeof DEFAULTS = { ...DEFAULTS, ...user, agents: { ...DEFAULTS.agents, ...user.agents },
  routing: { ...DEFAULTS.routing, ...user.routing }, budgets: { ...DEFAULTS.budgets, ...user.budgets },
  transcription: { ...DEFAULTS.transcription, ...user.transcription } };

const MASK = '••••••';
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max = 4096) => typeof v === 'string' && v.length <= max && !v.includes('\0');
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 100 && v.every((s) => text(s));
const fail = (key: string): never => { throw Object.assign(new Error(`configuration invalide : ${key}`), { status: 400 }); };
const maskEnv = (env: Record<string, string> = {}) => Object.fromEntries(Object.keys(env).map((k) => [k, MASK]));
const sensitiveArg = /(?:token|api[-_]?key|password|secret|authorization|cookie)/i;
export const maskArgs = (args: string[]) => args.map((arg, i) => (i > 0 && sensitiveArg.test(args[i - 1]) && args[i - 1].startsWith('-') && !args[i - 1].includes('=')) || /^(?:sk-|Bearer )/i.test(arg) || (arg.includes('=') && sensitiveArg.test(arg.split('=')[0])) || (arg.includes(':') && sensitiveArg.test(arg.split(':')[0])) ? MASK : arg);
function restoreArgs(args: string[], old: string[] = []) {
  const masked = maskArgs(old);
  return args.map((arg, i) => {
    if (arg !== MASK) return arg;
    if (args.length !== old.length || masked[i] !== MASK || args[i - 1] !== masked[i - 1]) return fail('argument secret déplacé : saisis à nouveau sa valeur');
    return old[i];
  });
}

/** Credentials stay on the host; masked values round-trip without replacing secrets. */
export function publicConfig() {
  const { token: _token, ...safe } = config;
  return { ...safe,
    agents: Object.fromEntries(Object.entries(safe.agents).map(([k, a]) => [k, { ...a, args: maskArgs(a.args), env: maskEnv(a.env), quota: { cmd: a.quota?.cmd ?? '', args: maskArgs(a.quota?.args ?? []), env: maskEnv(a.quota?.env), ...(a.quota?.timeoutMs === undefined ? {} : { timeoutMs: a.quota.timeoutMs }) } }])),
    mcpServers: safe.mcpServers.map((s) => ({ ...s, args: maskArgs(s.args), env: maskEnv(s.env) })),
    transcription: { ...safe.transcription, args: maskArgs(safe.transcription.args) },
  };
}

function environment(value: unknown, old: Record<string, string> = {}): Record<string, string> {
  if (!object(value) || Object.keys(value).length > 100) return fail('env');
  return Object.fromEntries(Object.entries(value).map(([k, v]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || !text(v)) return fail('env');
    if (v === MASK && !(k in old)) return fail('secret manquant');
    return [k, v === MASK ? old[k] : v];
  }));
}

function persist(next: typeof config) {
  const pending = `${file}.pending`;
  writeFileSync(pending, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  renameSync(pending, file);
  Object.assign(config, next);
}

export function updateConfig(patch: unknown) {
  if (!object(patch)) return fail('objet attendu');
  const next = structuredClone(config);
  const bounded: Record<string, [number, number]> = { port: [1, 65535], parallel: [1, 16], globalConcurrency: [1, 32], summarizeEvery: [1, 100], idleTimeoutMs: [1000, 86_400_000], stallTimeoutMs: [1000, 86_400_000], validationTimeoutMs: [1000, 3_600_000], agentTimeoutMs: [1000, 3_600_000] };
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(DEFAULTS, key) || key === 'token') return fail(key);
    if (key in bounded) {
      const [min, max] = bounded[key];
      if (!Number.isInteger(value) || value < min || value > max) return fail(key);
    } else if (['host', 'projectsDir', 'defaultAgent', 'prepareCommand'].includes(key)) { if (!text(value)) return fail(key); }
    else if (key === 'autoApprove') { if (typeof value !== 'boolean') return fail(key); }
    else if (key === 'validationCommands') { if (!strings(value)) return fail(key); }
    else if (key === 'agents') {
      if (!object(value) || Object.keys(value).length > 32) return fail(key);
      for (const [id, a] of Object.entries(value)) {
        if (!/^[a-zA-Z0-9_-]{1,40}$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id) || !object(a) || !text(a.name, 100) || !text(a.cmd) || !a.cmd || !strings(a.args) || !text(a.strengths) || (a.authMethod !== undefined && !text(a.authMethod))) return fail(key);
        let quota: AgentDef['quota'];
        if (a.quota !== undefined) {
          if (!object(a.quota) || !text(a.quota.cmd) || !strings(a.quota.args) || (a.quota.timeoutMs !== undefined && (!Number.isInteger(a.quota.timeoutMs) || a.quota.timeoutMs < 1000 || a.quota.timeoutMs > 30000))) return fail('quota');
          quota = { cmd: a.quota.cmd, args: restoreArgs(a.quota.args, config.agents[id]?.quota?.args), env: environment(a.quota.env ?? {}, config.agents[id]?.quota?.env), ...(a.quota.timeoutMs === undefined ? {} : { timeoutMs: a.quota.timeoutMs }) };
        }
        value[id] = { name: a.name, cmd: a.cmd, args: restoreArgs(a.args, config.agents[id]?.args), strengths: a.strengths, ...(a.authMethod ? { authMethod: a.authMethod } : {}), env: environment(a.env ?? {}, config.agents[id]?.env), ...(quota ? { quota } : {}) };
      }
    } else if (key === 'routes') {
      if (!Array.isArray(value) || value.length > 100) return fail(key);
      for (const r of value) {
        if (!object(r) || !text(r.match, 500) || !text(r.agent, 40) || (r.mode !== undefined && !['plan', 'agent'].includes(r.mode))) return fail(key);
        try { new RegExp(r.match, 'i'); } catch { return fail(key); }
      }
    } else if (key === 'reviewer') {
      if (!object(value) || Object.entries(value).some(([k, v]) => !text(k, 40) || !text(v, 40))) return fail(key);
    } else if (key === 'summarizer') {
      if (!object(value) || !text(value.agent, 40) || (value.model !== undefined && !text(value.model, 200))) return fail(key);
    } else if (key === 'routing') {
      if (!object(value) || !['rules', 'performance', 'llm'].includes(value.strategy) || !text(value.agent, 40) || !text(value.model, 200) || typeof value.fallback !== 'boolean') return fail(key);
    } else if (key === 'transcription') {
      if (!object(value) || !text(value.command) || !strings(value.args)) return fail(key);
      value.args = restoreArgs(value.args, config.transcription.args);
    } else if (key === 'budgets') {
      if (!object(value) || !Number.isSafeInteger(value.dailyTokens) || value.dailyTokens < 0 || typeof value.dailyCostUsd !== 'number' || !Number.isFinite(value.dailyCostUsd) || value.dailyCostUsd < 0 || typeof value.requireUsage !== 'boolean') return fail(key);
    } else if (key === 'mcpServers') {
      if (!Array.isArray(value) || value.length > 32) return fail(key);
      const names = new Set();
      for (const s of value) {
        if (!object(s) || !/^[a-zA-Z0-9_-]{1,60}$/.test(s.name) || s.name === 'avityone' || names.has(s.name) || !text(s.command) || !s.command || !strings(s.args) || typeof s.enabled !== 'boolean') return fail(key);
        names.add(s.name);
        const old = config.mcpServers.find((o) => o.name === s.name);
        s.env = environment(s.env ?? {}, old?.env); s.args = restoreArgs(s.args, old?.args);
      }
    }
    (next as Record<string, unknown>)[key] = value;
  }
  const referenced = [next.defaultAgent, next.summarizer.agent, ...next.routes.map((r) => r.agent), ...Object.keys(next.reviewer), ...Object.values(next.reviewer), ...(next.routing.agent ? [next.routing.agent] : [])];
  if (referenced.some((id) => !Object.hasOwn(next.agents, id))) return fail('agent référencé inconnu');
  persist(next);
  return publicConfig();
}

export function rotateToken() {
  const token = randomBytes(32).toString('base64url');
  persist({ ...config, token });
  return token;
}

/** AVITY_HOST/AVITY_PORT (set by the macOS app) win over config.json, without ever being written into it. */
export function listenAddress() {
  const port = process.env.AVITY_PORT ? Number(process.env.AVITY_PORT) : config.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('AVITY_PORT invalide : entier de 1 à 65535 attendu');
  return { host: process.env.AVITY_HOST || config.host, port };
}

export function which(cmd: string): string | null {
  if (cmd.includes('/')) return existsSync(cmd) ? cmd : null;
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    try { accessSync(join(dir, cmd), constants.X_OK); return join(dir, cmd); } catch {}
  }
  return null;
}

export const availableAgents = () => Object.keys(config.agents).filter((id) => which(config.agents[id].cmd));
