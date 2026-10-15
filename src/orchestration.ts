import { createHash } from 'node:crypto';
import { db, all, one, run, type Row } from './store.ts';
import { config } from './config.ts';

export type PlanTask = { id: string; content: string; dependencies: string[]; files: string[]; selected: boolean; agent?: string };
export type Plan = { specification: string; tasks: PlanTask[]; revision: number };
export const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const invalid = (message: string) => Object.assign(new Error(message), { status: 400 });

db.exec(`
  CREATE TABLE IF NOT EXISTS execution_plans (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS execution_jobs (
    id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    parent_id TEXT, task_id TEXT, prompt TEXT NOT NULL, options TEXT NOT NULL, dependencies TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0, result TEXT, error TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS execution_jobs_status ON execution_jobs(status, id);
  CREATE TABLE IF NOT EXISTS execution_artifacts (
    id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    kind TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS execution_validations (
    id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    fingerprint TEXT NOT NULL, command TEXT NOT NULL, status TEXT NOT NULL, output TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS execution_findings (
    id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    fingerprint TEXT NOT NULL, agent TEXT NOT NULL, path TEXT NOT NULL, message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open', resolution TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

export function normalizePlan(input: Row, revision: number): Plan {
  if (!Array.isArray(input.tasks) || !input.tasks.length || input.tasks.length > 100) throw invalid('le plan attend entre 1 et 100 tâches');
  const tasks: PlanTask[] = input.tasks.map((t: Row, i: number) => {
    if (!t || typeof t.content !== 'string' || !t.content.trim() || t.content.length > 20_000) throw invalid('contenu de tâche invalide');
    const id = String(t.id ?? `task-${i + 1}`);
    if (!/^[\w-]{1,64}$/.test(id)) throw invalid('identifiant de tâche invalide');
    const dependencies = t.dependencies ?? [], files = t.files ?? [];
    if (!Array.isArray(dependencies) || dependencies.some((d: unknown) => typeof d !== 'string')) throw invalid('dépendances invalides');
    if (!Array.isArray(files) || files.some((f: unknown) => typeof f !== 'string' || !f || f.startsWith('/') || f.includes('\\') || f.split('/').includes('..'))) throw invalid('fichiers invalides : chemins relatifs requis');
    if (t.agent != null && (typeof t.agent !== 'string' || !(t.agent in config.agents))) throw invalid('agent de tâche inconnu');
    return { id, content: t.content.trim(), dependencies: [...new Set<string>(dependencies)], files: [...new Set<string>(files)], selected: t.selected !== false, ...(t.agent ? { agent: t.agent } : {}) };
  });
  const byId = new Map(tasks.map((t) => [t.id, t]));
  if (byId.size !== tasks.length) throw invalid('identifiants de tâche dupliqués');
  const visited = new Set<string>(), stack = new Set<string>();
  const visit = (t: PlanTask) => {
    if (stack.has(t.id)) throw invalid('cycle dans les dépendances');
    if (visited.has(t.id)) return;
    stack.add(t.id);
    for (const d of t.dependencies) {
      const dep = byId.get(d);
      if (!dep) throw invalid(`dépendance inconnue : ${d}`);
      if (t.selected && !dep.selected) throw invalid(`la tâche ${t.id} dépend d'une tâche non sélectionnée`);
      visit(dep);
    }
    stack.delete(t.id); visited.add(t.id);
  };
  tasks.forEach(visit);
  return { specification: String(input.specification ?? '').slice(0, 100_000), tasks, revision };
}

/** File overlap serializes work after explicit dependencies; the topological order prevents accidental cycles. */
export function scheduleTasks(tasks: PlanTask[]): PlanTask[] {
  const remaining = tasks.filter((t) => t.selected).map((t) => ({ ...t, dependencies: [...t.dependencies] }));
  const ordered: PlanTask[] = [];
  while (remaining.length) {
    const i = remaining.findIndex((t) => t.dependencies.every((d) => ordered.some((p) => p.id === d)));
    if (i < 0) throw invalid('dépendance non sélectionnée ou cyclique');
    const t = remaining.splice(i, 1)[0];
    for (const prev of ordered) if (t.files.some((f) => prev.files.some((p) => f === p || f.startsWith(p + '/') || p.startsWith(f + '/')))) t.dependencies.push(prev.id);
    t.dependencies = [...new Set(t.dependencies)]; ordered.push(t);
  }
  return ordered;
}

export function saveArtifact(sessionId: string, kind: string, data: unknown) {
  run('INSERT INTO execution_artifacts (session_id, kind, data) VALUES (?, ?, ?)', sessionId, kind, JSON.stringify(data));
}
export const readArtifacts = (sessionId: string): Row[] => all('SELECT * FROM execution_artifacts WHERE session_id = ? ORDER BY id', sessionId).map((r) => ({ ...r, data: JSON.parse(r.data) }));
export const readJob = (r: Row): Row => ({ ...r, options: JSON.parse(r.options), dependencies: JSON.parse(r.dependencies), result: r.result ? JSON.parse(r.result) : null });
export const readJobs = (sessionId: string) => all('SELECT * FROM execution_jobs WHERE session_id = ? OR parent_id = ? ORDER BY id', sessionId, sessionId).map(readJob);
export const savedPlan = (sessionId: string): Plan | null => {
  const row = one('SELECT data FROM execution_plans WHERE session_id = ?', sessionId);
  return row ? JSON.parse(row.data) : null;
};
