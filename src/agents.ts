import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { config, HOME, which } from './config.ts';
import { AcpConnection, openAgent, oneShot } from './acp.ts';
import { redact, usageReport, recordQuota, agentQuota, type QuotaSnapshot } from './admin.ts';
import { all, run } from './store.ts';

const catalog = {
  claude: { packages: ['@anthropic-ai/claude-code', '@agentclientprotocol/claude-agent-acp'], command: 'claude', login: ['auth', 'login'], docs: 'https://code.claude.com/docs/en/setup' },
  codex: { packages: ['@openai/codex', '@agentclientprotocol/codex-acp'], command: 'codex', login: ['login', '--device-auth'], docs: 'https://developers.openai.com/codex/auth' },
  cursor: { packages: [], command: 'agent', login: ['login'], docs: 'https://cursor.com/docs/cli/installation' },
  opencode: { packages: ['opencode-ai'], command: 'opencode', login: ['auth', 'login'], docs: 'https://opencode.ai/docs/' },
} as const;
type CatalogId = keyof typeof catalog;
const health = new Map<string, Awaited<ReturnType<typeof probeAgent>>>();

export function agentCatalog() {
  return Object.entries(config.agents).map(([id, a]) => {
    const quotaSnapshot = agentQuota(id);
    return { id, name: a.name, strengths: a.strengths, installed: !!which(a.cmd), catalog: catalog[id as CatalogId] ?? null,
      health: { ...(health.get(id) ?? { status: 'unknown', authentication: 'unknown' }), quota: quotaSnapshot.status, quotaSnapshot } };
  });
}

export async function probeQuota(id: string): Promise<QuotaSnapshot> {
  const source = config.agents[id]?.quota;
  const snapshot: QuotaSnapshot = { agent: id, status: 'unknown', remaining: null, limit: null, unit: null, resetAt: null, checkedAt: new Date().toISOString(), error: 'aucune source de quota configurée' };
  if (!source?.cmd) return recordQuota(snapshot);
  const timeoutMs = source.timeoutMs ?? 5000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) return recordQuota({ ...snapshot, error: 'délai de quota invalide (1 à 30 secondes)' });
  try {
    const { stdout } = await promisify(execFile)(source.cmd, source.args, { cwd: HOME, env: { ...process.env, ...source.env, AVITY_QUOTA_TIMEOUT_MS: String(timeoutMs) }, signal: AbortSignal.timeout(timeoutMs), killSignal: 'SIGKILL', maxBuffer: 64 * 1024 });
    let value: any;
    try { value = JSON.parse(stdout); } catch { throw new Error('JSON de quota invalide'); }
    const description = (text: unknown, max: number) => typeof text === 'string' && !!text.trim() && text.length <= max && !/[\x00-\x1f]/.test(text);
    if (!value || typeof value !== 'object' || Array.isArray(value) || (value.details !== undefined && !description(value.details, 1000))) throw new Error('schéma de quota invalide');
    if (config.agents[id]?.quota !== source) return recordQuota({ ...snapshot, error: 'configuration modifiée pendant la mesure : relance la vérification' });
    const details = value.details ? redact(value.details) : null;
    if (value.status === 'unknown') {
      if (value.remaining !== null || value.limit !== null || value.unit != null || value.resetAt != null || !description(value.reason, 500)) throw new Error('schéma de quota invalide');
      return recordQuota({ ...snapshot, details, error: redact(value.reason) });
    }
    const status = value.remaining === 0 ? 'exhausted' : 'available';
    if ((value.status !== undefined && value.status !== status) || !Number.isFinite(value.remaining) || value.remaining < 0 || !Number.isFinite(value.limit) || value.limit < value.remaining || !description(value.unit, 80) || (value.resetAt !== undefined && (typeof value.resetAt !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(value.resetAt) || !Number.isFinite(Date.parse(value.resetAt))))) throw new Error('schéma de quota invalide');
    return recordQuota({ ...snapshot, status, remaining: value.remaining, limit: value.limit, unit: value.unit, resetAt: value.resetAt ? new Date(value.resetAt).toISOString() : null, error: null, details });
  } catch (e: any) {
    const error = ['JSON de quota invalide', 'schéma de quota invalide'].includes(e.message) ? e.message : e.name === 'AbortError' ? `commande de quota expirée après ${timeoutMs / 1000} s` : 'commande de quota en échec';
    return recordQuota({ ...snapshot, error });
  }
}

export async function probeAgent(id: string): Promise<{ id: string; status: string; authentication: string; quota: string; quotaSnapshot: QuotaSnapshot; checkedAt: string; latencyMs: number; capabilities?: unknown; authMethods?: unknown; commands?: unknown; error?: string }> {
  const def = config.agents[id];
  if (!def) throw Object.assign(new Error('agent inconnu'), { status: 404 });
  const start = performance.now();
  const quotaSnapshot = await probeQuota(id);
  const result = { id, status: 'unknown', authentication: 'unknown', quota: quotaSnapshot.status, quotaSnapshot, checkedAt: new Date().toISOString(), latencyMs: 0 };
  if (!which(def.cmd)) { result.status = 'missing'; health.set(id, result); return result; }
  // Opening a session probes readiness without sending a paid prompt or authorizing tools.
  let conn: AcpConnection | undefined;
  try {
    conn = new AcpConnection(def, HOME, { onUpdate() {}, onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) });
    const initialized = await conn.request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'avityone', version: '0.1.0' } });
    await conn.request('session/new', { cwd: HOME, mcpServers: [] });
    const ready = { ...result, status: 'ready', capabilities: initialized.agentCapabilities, authMethods: initialized.authMethods ?? [], latencyMs: performance.now() - start };
    health.set(id, ready); return ready;
  } catch (e: any) {
    const failed = { ...result, status: 'unavailable', authentication: /auth|login|credential/i.test(e.message) ? 'required' : 'unknown', error: redact(e.message).slice(0, 500), latencyMs: performance.now() - start };
    health.set(id, failed); return failed;
  } finally { conn?.kill(); }
}

type Operation = { id: string; agent: string; action: string; state: 'running' | 'success' | 'error'; output: string; startedAt: string; exitCode: number | null; process?: ChildProcess };
const operations = new Map<string, Operation>();
const publicOperation = ({ process: _process, ...op }: Operation) => op;
export function operationStatus(id: string) {
  const op = operations.get(id);
  if (!op) throw Object.assign(new Error('opération inconnue'), { status: 404 });
  return publicOperation(op);
}

export function operationInput(id: string, input: string) {
  const op = operations.get(id);
  if (!op || op.state !== 'running' || op.action !== 'connect' || typeof input !== 'string' || input.length > 8192) throw Object.assign(new Error('connexion inactive ou entrée invalide'), { status: 400 });
  op.process?.stdin?.write(input + '\n');
  return publicOperation(op);
}

/** The UI can start only fixed catalogue commands; it cannot submit a shell command. */
export async function agentOperation(id: string, action: 'install' | 'connect') {
  const entry = catalog[id as CatalogId];
  if (!entry || !['install', 'connect'].includes(action)) throw Object.assign(new Error('opération hors catalogue'), { status: 400 });
  if ([...operations.values()].some((op) => op.agent === id && op.state === 'running')) throw Object.assign(new Error('opération déjà en cours'), { status: 409 });
  const op: Operation = { id: randomUUID(), agent: id, action, state: 'running', output: '', startedAt: new Date().toISOString(), exitCode: null };
  let command: string, args: string[], script: string | undefined;
  if (action === 'connect') { command = entry.command; args = [...entry.login]; }
  else if (id === 'cursor') {
    const response = await fetch('https://cursor.com/install', { signal: AbortSignal.timeout(20_000), redirect: 'error' });
    if (!response.ok) throw new Error('téléchargement de l’installateur Cursor échoué');
    script = await response.text();
    if (script.length > 1024 * 1024) throw new Error('installateur Cursor trop volumineux');
    command = 'bash'; args = ['-s'];
  } else { command = 'npm'; args = ['install', '--global', ...entry.packages]; }
  const child = spawn(command, args, { cwd: HOME, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, NO_COLOR: '1' } });
  op.process = child; operations.set(op.id, op);
  for (const old of [...operations.values()].filter((v) => v.state !== 'running').slice(0, Math.max(0, operations.size - 20))) operations.delete(old.id);
  const append = (data: Buffer) => { op.output = redact((op.output + data.toString()).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')).slice(-16_000); };
  child.stdout?.on('data', append); child.stderr?.on('data', append); child.stdin?.on('error', () => {});
  const timer = setTimeout(() => { op.output += '\nDélai de cinq minutes dépassé.'; op.state = 'error'; child.kill(); }, 300_000);
  timer.unref();
  child.on('error', (e) => { clearTimeout(timer); op.state = 'error'; op.output = redact(e.message); delete op.process; });
  child.on('exit', (code) => { clearTimeout(timer); op.exitCode = code; op.state = code === 0 && op.state !== 'error' ? 'success' : 'error'; delete op.process; health.delete(id); });
  if (script) child.stdin?.end(script);
  return publicOperation(op);
}

export async function nativeCommands(id: string) {
  const session = await openAgent(id, HOME, { onUpdate() {}, onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) }, []);
  try { return { agent: id, commands: session.commands, capabilities: session.conn.caps.agentCapabilities ?? {} }; }
  finally { session.conn.kill(); }
}

export async function benchmarkAgents(input: { agents: string[]; prompt: string; expected: string }) {
  if (!Array.isArray(input?.agents) || !input.agents.length || input.agents.length > 8 || new Set(input.agents).size !== input.agents.length || input.agents.some((id) => !config.agents[id] || !which(config.agents[id].cmd)) || typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 10_000 || typeof input.expected !== 'string' || !input.expected.trim() || input.expected.length > 5000) throw Object.assign(new Error('évaluation invalide : agents installés, demande et réponse attendue requis'), { status: 400 });
  const suite = randomUUID();
  for (const agent of input.agents) {
    const started = performance.now(); let answer = '', error: string | null = null;
    // An empty folder per agent: never AvityOne's data directory (token, conversations), nor another agent's leftovers.
    const cwd = await mkdtemp(join(tmpdir(), 'avity-bench-'));
    try { answer = await oneShot(agent, cwd, input.prompt); } catch (e: any) { error = redact(e.message).slice(0, 500); }
    finally { await rm(cwd, { recursive: true, force: true }); }
    run('INSERT INTO agent_evaluations(suite,agent,prompt,expected,answer,passed,duration_ms,error) VALUES(?,?,?,?,?,?,?,?)',
      suite, agent, redact(input.prompt), redact(input.expected), redact(answer).slice(0, 30_000), !error && answer.includes(input.expected) ? 1 : 0, performance.now() - started, error);
  }
  return { suite, criterion: 'la réponse contient la chaîne attendue, comparaison sensible à la casse', results: all('SELECT * FROM agent_evaluations WHERE suite=?', suite), usage: usageReport() };
}
