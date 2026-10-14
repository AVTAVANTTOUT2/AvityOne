import { readFileSync, writeFileSync, mkdirSync, existsSync, accessSync, constants } from 'node:fs';
import { join, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

export type AgentDef = { name: string; cmd: string; args: string[]; env?: Record<string, string>; authMethod?: string; strengths: string };
export type RouteRule = { match: string; agent: string; mode?: 'plan' | 'agent' };

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
};

const file = join(HOME, 'config.json');
if (!existsSync(file)) writeFileSync(file, JSON.stringify({ token: randomBytes(24).toString('base64url') }, null, 2) + '\n', { mode: 0o600 });
const user = JSON.parse(readFileSync(file, 'utf8'));

export const config: typeof DEFAULTS = { ...DEFAULTS, ...user, agents: { ...DEFAULTS.agents, ...user.agents } };

export function which(cmd: string): string | null {
  if (cmd.includes('/')) return existsSync(cmd) ? cmd : null;
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    try { accessSync(join(dir, cmd), constants.X_OK); return join(dir, cmd); } catch {}
  }
  return null;
}

export const availableAgents = () => Object.keys(config.agents).filter((id) => which(config.agents[id].cmd));
