import { backup, DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, chmodSync, rmSync, existsSync, lstatSync, copyFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config, HOME, which } from './config.ts';
import { db, all, one, run } from './store.ts';

const exec = promisify(execFile);
db.exec(`
CREATE TABLE IF NOT EXISTS executions (
  id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, agent TEXT NOT NULL, status TEXT NOT NULL,
  duration_ms REAL NOT NULL, input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL, error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS agent_usage (
  session_id TEXT PRIMARY KEY, agent TEXT NOT NULL, context_used INTEGER, context_size INTEGER,
  cost_amount REAL, currency TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS agent_quotas (
  agent TEXT PRIMARY KEY, source_hash TEXT NOT NULL, status TEXT NOT NULL, remaining REAL,
  quota_limit REAL, unit TEXT, reset_at TEXT, checked_at TEXT NOT NULL, error TEXT);
CREATE TABLE IF NOT EXISTS agent_evaluations (
  id INTEGER PRIMARY KEY, suite TEXT NOT NULL, agent TEXT NOT NULL, prompt TEXT NOT NULL,
  expected TEXT NOT NULL, answer TEXT NOT NULL, passed INTEGER NOT NULL, duration_ms REAL NOT NULL,
  error TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
`);

const validNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const integer = (v: unknown) => validNumber(v) && Number.isSafeInteger(v) ? v : null;
const problem = (message: string, status = 400) => Object.assign(new Error(message), { status });
export function redact(value: string) {
  let s = value.replace(/(?:sk-(?:proj-)?[\w-]{10,}|Bearer\s+[\w.\-]{10,}|(?:token|api[_-]?key|password)\s*[=:]\s*[^\s,;]+)/gi, '[secret masqué]');
  const secrets = [config.token, ...Object.values(config.agents).flatMap((a) => [...Object.values(a.env ?? {}), ...Object.values(a.quota?.env ?? {})]), ...config.mcpServers.flatMap((s) => Object.values(s.env))];
  for (const secret of secrets) if (secret.length >= 4) s = s.split(secret).join('[secret masqué]');
  return s;
}

/** ACP context usage is a gauge, never a billable token counter. Costs are cumulative per session. */
export function recordUsage(sessionId: string, agent: string, update: Record<string, any>) {
  sessionId = `${agent}:${sessionId}`;
  const previous = one('SELECT * FROM agent_usage WHERE session_id = ?', sessionId);
  const cost = validNumber(update.cost?.amount) && /^[A-Z]{3}$/.test(update.cost?.currency ?? '') ? update.cost : null;
  run(`INSERT INTO agent_usage (session_id,agent,context_used,context_size,cost_amount,currency) VALUES (?,?,?,?,?,?)
    ON CONFLICT(session_id) DO UPDATE SET context_used=excluded.context_used,context_size=excluded.context_size,
      cost_amount=excluded.cost_amount,currency=excluded.currency,updated_at=CURRENT_TIMESTAMP`,
  sessionId, agent, integer(update.used), integer(update.size), cost?.amount ?? previous?.cost_amount ?? null, cost?.currency ?? previous?.currency ?? null);
  return cost?.currency === 'USD' ? Math.max(0, cost.amount - (previous?.currency === 'USD' ? previous.cost_amount ?? 0 : 0)) : null;
}

export function recordExecution(e: { sessionId: string; agent: string; status: 'success' | 'error' | 'cancelled'; durationMs: number; inputTokens?: number; outputTokens?: number; costUsd?: number | null; error?: string }) {
  run(`INSERT INTO executions(session_id,agent,status,duration_ms,input_tokens,output_tokens,cost_usd,error) VALUES(?,?,?,?,?,?,?,?)`,
    e.sessionId, e.agent, e.status, Math.max(0, e.durationMs), integer(e.inputTokens), integer(e.outputTokens), validNumber(e.costUsd) ? e.costUsd : null, e.error ? redact(e.error).slice(0, 1000) : null);
}

export type QuotaSnapshot = { agent: string; status: 'available' | 'exhausted' | 'unknown'; remaining: number | null; limit: number | null; unit: string | null; resetAt: string | null; checkedAt: string | null; error: string | null };
const quotaSource = (agent: string) => createHash('sha256').update(JSON.stringify(config.agents[agent]?.quota ?? null)).digest('hex');
export function recordQuota(snapshot: QuotaSnapshot) {
  run(`INSERT INTO agent_quotas(agent,source_hash,status,remaining,quota_limit,unit,reset_at,checked_at,error) VALUES(?,?,?,?,?,?,?,?,?)
    ON CONFLICT(agent) DO UPDATE SET source_hash=excluded.source_hash,status=excluded.status,remaining=excluded.remaining,
      quota_limit=excluded.quota_limit,unit=excluded.unit,reset_at=excluded.reset_at,checked_at=excluded.checked_at,error=excluded.error`,
  snapshot.agent, quotaSource(snapshot.agent), snapshot.status, snapshot.remaining, snapshot.limit, snapshot.unit, snapshot.resetAt, snapshot.checkedAt ?? new Date().toISOString(), snapshot.error);
  return agentQuota(snapshot.agent);
}

export function agentQuota(agent: string): QuotaSnapshot {
  const unknown: QuotaSnapshot = { agent, status: 'unknown', remaining: null, limit: null, unit: null, resetAt: null, checkedAt: null, error: 'aucune source de quota configurée' };
  if (!config.agents[agent]?.quota?.cmd) return unknown;
  const r = one('SELECT * FROM agent_quotas WHERE agent = ?', agent);
  if (!r || r.source_hash !== quotaSource(agent)) return { ...unknown, error: 'source de quota non vérifiée' };
  const result: QuotaSnapshot = { agent, status: r.status, remaining: r.remaining, limit: r.quota_limit, unit: r.unit, resetAt: r.reset_at, checkedAt: r.checked_at, error: r.error };
  const checked = Date.parse(r.checked_at), now = Date.now();
  if (!Number.isFinite(checked) || checked > now || now - checked >= 300_000 || (r.reset_at && Date.parse(r.reset_at) <= now)) return { ...result, status: 'unknown', error: 'mesure de quota expirée : relance la vérification' };
  return result;
}

export function usageReport() {
  const quotas = Object.keys(config.agents).map(agentQuota);
  return {
    daily: one(`SELECT count(*) AS executions, sum(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)) AS reported_tokens,
      sum(cost_usd) AS reported_cost_usd, sum(input_tokens IS NULL OR output_tokens IS NULL) AS unknown_token_executions,
      sum(cost_usd IS NULL) AS unknown_cost_executions FROM executions WHERE date(created_at)=date('now')`),
    agents: all(`SELECT agent,count(*) AS executions,sum(status='success') AS successes,avg(duration_ms) AS duration_ms,
      sum(input_tokens) AS input_tokens,sum(output_tokens) AS output_tokens,sum(cost_usd) AS cost_usd FROM executions GROUP BY agent`),
    context: all('SELECT * FROM agent_usage ORDER BY updated_at DESC LIMIT 100'),
    budgets: config.budgets,
    quotas,
    quota: { status: quotas.some((q) => q.status === 'unknown') ? 'unknown' : 'reported', reason: 'Les quotas proviennent des commandes configurées et expirent après cinq minutes ou à leur remise à zéro. Sans mesure, leur état reste inconnu.' },
  };
}

export function assertBudget(agent?: string) {
  if (agent && agentQuota(agent).status === 'exhausted') throw problem(`quota épuisé pour ${agent}`, 429);
  const day = usageReport().daily!;
  const b = config.budgets;
  if (b.dailyTokens && day.reported_tokens >= b.dailyTokens) throw problem('budget quotidien de tokens atteint', 429);
  if (b.dailyCostUsd && day.reported_cost_usd >= b.dailyCostUsd) throw problem('budget quotidien de coût atteint', 429);
  if (b.requireUsage && ((b.dailyTokens && day.unknown_token_executions) || (b.dailyCostUsd && day.unknown_cost_executions))) throw problem('budget invérifiable : métriques absentes, exécution bloquée', 429);
}

export function rankedAgents(available: string[]) {
  const scores = new Map(all(`SELECT agent, avg(passed) AS score, avg(duration_ms) AS latency, count(*) AS samples FROM agent_evaluations GROUP BY agent`).map((r) => [r.agent, r]));
  return [...available].sort((a, b) => {
    const x = scores.get(a), y = scores.get(b);
    if (!x || !y) return Number(!!y) - Number(!!x);
    return y.score - x.score || x.latency - y.latency;
  });
}

const backupsDir = join(HOME, 'backups');
const backupId = (id: string) => { if (!/^[0-9a-f-]{36}$/.test(id)) throw problem('sauvegarde inconnue', 404); return join(backupsDir, id); };
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
export function listBackups() {
  mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
  return readdirSync(backupsDir).filter((p) => /^[0-9a-f-]{36}\.json$/.test(p)).flatMap((p) => {
    try { return [JSON.parse(readFileSync(join(backupsDir, p), 'utf8'))]; } catch { return []; }
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function createBackup() {
  mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
  const id = randomUUID(), base = backupId(id);
  try {
    await backup(db, `${base}.db`);
    chmodSync(`${base}.db`, 0o600);
    const snapshot = new DatabaseSync(`${base}.db`, { readOnly: true });
    let attachmentIds: string[];
    try { attachmentIds = snapshot.prepare("SELECT 1 FROM sqlite_master WHERE name='attachments'").get() ? snapshot.prepare('SELECT id FROM attachments').all().map((r) => String(r.id)) : []; }
    finally { snapshot.close(); }
    const attachments: Record<string, string> = {};
    mkdirSync(`${base}.files`, { mode: 0o700 });
    for (const attachment of attachmentIds) {
      if (!/^[0-9a-f-]{36}$/.test(attachment)) throw problem('identifiant de pièce jointe invalide');
      const path = join(HOME, 'attachments', attachment), target = join(`${base}.files`, attachment);
      if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw problem('pièce jointe non régulière');
      copyFileSync(path, target); chmodSync(target, 0o600); attachments[attachment] = digest(target);
    }
    const metadata = { id, createdAt: new Date().toISOString(), sha256: digest(`${base}.db`), attachments, scope: 'base SQLite et pièces jointes ; fichiers projets et configuration exclus' };
    writeFileSync(`${base}.json`, JSON.stringify(metadata) + '\n', { mode: 0o600 });
    return metadata;
  } catch (e) { rmSync(`${base}.db`, { force: true }); rmSync(`${base}.files`, { recursive: true, force: true }); throw e; }
}

const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;
const schema = (source: DatabaseSync) => source.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name").all();

export function validateBackup(id: string) {
  const base = backupId(id);
  let manifest: any;
  try { manifest = JSON.parse(readFileSync(`${base}.json`, 'utf8')); } catch { throw problem('sauvegarde introuvable', 404); }
  if (manifest.id !== id || manifest.sha256 !== digest(`${base}.db`)) throw problem('sauvegarde corrompue');
  if (!manifest.attachments || typeof manifest.attachments !== 'object' || Array.isArray(manifest.attachments)) throw problem('manifest des pièces jointes absent');
  for (const [attachment, hash] of Object.entries(manifest.attachments)) {
    if (!/^[0-9a-f-]{36}$/.test(attachment)) throw problem('pièce jointe invalide');
    const path = join(`${base}.files`, attachment);
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() || digest(path) !== hash) throw problem('pièce jointe corrompue');
  }
  const source = new DatabaseSync(`${base}.db`, { readOnly: true });
  try {
    if (Object.values(source.prepare('PRAGMA integrity_check').get() ?? {})[0] !== 'ok') throw problem('intégrité SQLite invalide');
    if (JSON.stringify(schema(source)) !== JSON.stringify(schema(db))) throw problem('schéma incompatible : restaurer avec la même version');
    const ids = source.prepare("SELECT 1 FROM sqlite_master WHERE name='attachments'").get() ? source.prepare('SELECT id FROM attachments').all().map((r) => String(r.id)).sort() : [];
    if (JSON.stringify(ids) !== JSON.stringify(Object.keys(manifest.attachments).sort())) throw problem('pièces jointes manquantes dans la sauvegarde');
  } finally { source.close(); }
  return { id, attachments: Object.keys(manifest.attachments).length, valid: true };
}

/** Same-schema restore is one SQLite transaction; the caller must suspend writes and invalidate live sessions. */
export async function restoreBackup(id: string) {
  validateBackup(id);
  const base = backupId(id);
  const manifest = JSON.parse(readFileSync(`${base}.json`, 'utf8'));
  const safety = await createBackup();
  const liveFiles = join(HOME, 'attachments'), staged = join(HOME, `attachments.restore-${randomUUID()}`), previousFiles = `${staged}.previous`;
  if (existsSync(liveFiles) && (!lstatSync(liveFiles).isDirectory() || lstatSync(liveFiles).isSymbolicLink())) throw problem('dossier de pièces jointes invalide');
  mkdirSync(liveFiles, { recursive: true, mode: 0o700 });
  mkdirSync(staged, { mode: 0o700 });
  mkdirSync(previousFiles, { mode: 0o700 });
  for (const attachment of Object.keys(manifest.attachments)) { copyFileSync(join(`${base}.files`, attachment), join(staged, attachment)); chmodSync(join(staged, attachment), 0o600); }
  const tables = all('PRAGMA table_list').filter((t) => t.schema === 'main' && ['table', 'virtual'].includes(t.type) && !t.name.startsWith('sqlite_'));
  const triggers = all("SELECT name,sql FROM sqlite_master WHERE type='trigger'");
  db.prepare('ATTACH DATABASE ? AS restore_source').run(`${base}.db`);
  const replaced: string[] = [];
  try {
    db.exec('BEGIN IMMEDIATE; PRAGMA defer_foreign_keys=ON');
    for (const t of triggers) db.exec(`DROP TRIGGER ${quote(t.name)}`);
    for (const t of tables) {
      const table = quote(t.name);
      const columns = [...(t.type === 'virtual' ? ['rowid'] : []), ...all(`PRAGMA table_info(${table})`).map((c) => quote(c.name))].join(',');
      db.exec(`DELETE FROM main.${table}; INSERT INTO main.${table} (${columns}) SELECT ${columns} FROM restore_source.${table}`);
    }
    for (const t of triggers) db.exec(t.sql);
    // Keep the current bytes until COMMIT, including files repaired from the backup.
    for (const attachment of Object.keys(manifest.attachments)) {
      const target = join(liveFiles, attachment);
      if (existsSync(target)) {
        if (!lstatSync(target).isFile() || lstatSync(target).isSymbolicLink()) throw problem('pièce jointe existante non régulière');
        copyFileSync(target, join(previousFiles, attachment)); chmodSync(join(previousFiles, attachment), 0o600);
      }
      renameSync(join(staged, attachment), target); replaced.push(attachment);
    }
    db.exec('COMMIT');
  } catch (e) {
    if (db.isTransaction) db.exec('ROLLBACK');
    for (const attachment of replaced.reverse()) {
      const previous = join(previousFiles, attachment), target = join(liveFiles, attachment);
      if (existsSync(previous)) renameSync(previous, target); else rmSync(target, { force: true });
    }
    throw e;
  } finally { db.exec('DETACH DATABASE restore_source'); rmSync(staged, { recursive: true, force: true }); rmSync(previousFiles, { recursive: true, force: true }); }
  return { restored: id, safetyBackup: safety.id, restartRequired: true };
}

export async function networkStatus() {
  if (!which('tailscale')) return { installed: false, state: 'unavailable' };
  try {
    const { stdout } = await exec('tailscale', ['status', '--json'], { timeout: 10_000, maxBuffer: 1024 * 1024 });
    const status = JSON.parse(stdout);
    const { stdout: served } = await exec('tailscale', ['serve', 'status', '--json'], { timeout: 10_000, maxBuffer: 1024 * 1024 });
    const settings = JSON.parse(served);
    return { installed: true, state: status.BackendState, hostname: status.Self?.DNSName, https: settings.TCP?.['443']?.HTTPS === true, port: config.port };
  } catch (e: any) { return { installed: true, state: 'error', error: redact(e.message).slice(0, 500) }; }
}

export async function configureNetwork(input: { enabled: boolean }) {
  if (typeof input?.enabled !== 'boolean') throw problem('enabled doit être un booléen');
  if (!which('tailscale')) throw problem('Tailscale doit être installé et connecté sur le serveur', 409);
  const args = ['serve', '--bg', '--https=443', `http://127.0.0.1:${config.port}`, ...(!input.enabled ? ['off'] : [])];
  try { await exec('tailscale', args, { timeout: 20_000, maxBuffer: 256 * 1024 }); }
  catch (e: any) { throw problem(`configuration Tailscale échouée : ${redact(e.stderr || e.message).slice(0, 500)}`, 409); }
  return networkStatus();
}

export async function administration() {
  return { usage: usageReport(), traces: all('SELECT * FROM executions ORDER BY id DESC LIMIT 200'),
    benchmarks: all('SELECT * FROM agent_evaluations ORDER BY id DESC LIMIT 100'), backups: listBackups(), network: await networkStatus() };
}
