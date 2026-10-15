import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { config } from './config.ts';
import { all, db, one, run } from './store.ts';

const error = (status: number, message: string) => Object.assign(new Error(message), { status });
export function getProject(id: number) {
  const p = one('SELECT * FROM projects WHERE id = ?', id);
  if (!p) throw error(404, 'projet inconnu');
  return p;
}

export function listProjects({ q = '', archived }: { q?: string; archived?: boolean } = {}) {
  return all('SELECT * FROM projects ORDER BY archived, name').filter((p) =>
    (archived === undefined || !!p.archived === archived) && `${p.name} ${p.path}`.toLocaleLowerCase().includes(q.toLocaleLowerCase()));
}

/** Resolve existing parents too: a missing file below an external symlink must never escape the project. */
export function projectPath(projectId: number, path: string) {
  const root = realpathSync(getProject(projectId).path), target = resolve(root, path);
  const inside = (value: string) => { const rel = relative(root, value); return rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel); };
  if (!inside(target)) throw error(400, 'chemin hors du projet');
  let parent = target;
  while (parent !== dirname(parent)) {
    try { lstatSync(parent); break; } catch (e: any) { if (e.code !== 'ENOENT') throw e; parent = dirname(parent); }
  }
  try { if (!inside(realpathSync(parent))) throw error(400, 'lien symbolique hors du projet'); }
  catch (e: any) { throw e.status ? e : error(400, 'lien symbolique invalide dans le projet'); }
  return target;
}

export function projectDocuments(id: number) {
  const read = (file: string) => { const path = projectPath(id, file); return existsSync(path) ? readFileSync(path, 'utf8') : ''; };
  return { brief: read('.avity/brief.md'), instructions: read('AGENTS.md') };
}

export function updateProject(id: number, patch: { name?: string; archived?: boolean; brief?: string; instructions?: string }) {
  const p = getProject(id);
  if (patch.name !== undefined) {
    if (typeof patch.name !== 'string' || !patch.name.trim() || patch.name.length > 120) throw error(400, 'nom de projet invalide (1 à 120 caractères)');
    if (one('SELECT 1 FROM projects WHERE name = ? AND id <> ?', patch.name.trim(), id)) throw error(409, 'ce projet existe déjà');
  }
  if (patch.archived !== undefined && typeof patch.archived !== 'boolean') throw error(400, 'archivage invalide');
  for (const key of ['brief', 'instructions'] as const) if (patch[key] !== undefined && (typeof patch[key] !== 'string' || patch[key]!.length > 100_000)) throw error(400, `${key} invalide (100 000 caractères maximum)`);
  const files = [['brief', '.avity/brief.md'], ['instructions', 'AGENTS.md']] as const;
  const targets = files.filter(([key]) => patch[key] !== undefined).map(([key, file]) => ({ key, path: projectPath(id, file) }));
  for (const { key, path } of targets) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, patch[key]!, 'utf8'); }
  run('UPDATE projects SET name = ?, archived = ? WHERE id = ?', patch.name?.trim() ?? p.name, patch.archived === undefined ? p.archived : Number(patch.archived), id);
  return getProject(id);
}

/** The hub must stop/check live sessions before calling this. Project files are deliberately retained. */
export function removeProject(id: number) {
  getProject(id);
  if (one('SELECT 1 FROM sessions WHERE project_id = ? AND worktree IS NOT NULL', id)) throw error(409, 'projet avec worktree non mergé');
  db.exec('BEGIN IMMEDIATE');
  try {
    run('DELETE FROM context_selection WHERE session_id IN (SELECT id FROM sessions WHERE project_id = ?)', id);
    run('DELETE FROM items WHERE session_id IN (SELECT id FROM sessions WHERE project_id = ?)', id);
    for (const table of ['sessions', 'memory', 'kb', 'knowledge_meta', 'knowledge_versions', 'indexed_files']) run(`DELETE FROM ${table} WHERE project_id = ?`, id);
    run('DELETE FROM projects WHERE id = ?', id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { removed: true, filesRetained: true };
}

export function listFolders(path = config.projectsDir) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw error(400, 'chemin absolu requis');
  const root = realpathSync(path);
  if (!statSync(root).isDirectory()) throw error(400, 'ce chemin n’est pas un dossier');
  return { path: root, parent: dirname(root), folders: readdirSync(root, { withFileTypes: true }).filter((f) => f.isDirectory() && !f.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name)).map((f) => ({ name: f.name, path: join(root, f.name) })) };
}
