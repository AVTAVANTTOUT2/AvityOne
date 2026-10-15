import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { all, db, normalizeMemory, one, run, searchKb, searchMemory, type Row } from './store.ts';
import { getProject, projectPath } from './projects.ts';

const error = (status: number, message: string) => Object.assign(new Error(message), { status });
const memoryRow = (projectId: number, id: number) => one(`SELECT m.rowid AS id, m.*, k.subject, k.predicate, k.object, k.entity_type, k.occurred_at, k.valid_until, k.updated_at
  FROM memory m LEFT JOIN knowledge_meta k ON k.memory_id = m.rowid WHERE m.project_id = ? AND m.rowid = ?`, projectId, id);
const version = (row: Row, action: string) => run('INSERT INTO knowledge_versions (memory_id, project_id, snapshot, action) VALUES (?, ?, ?, ?)', row.id, row.project_id, JSON.stringify(row), action);

export function listKnowledge(projectId: number, query = '') {
  getProject(projectId);
  const memory = query ? searchMemory(projectId, query, 100) : all('SELECT rowid AS id FROM memory WHERE project_id = ? ORDER BY rowid DESC', projectId);
  const allFacts = all('SELECT * FROM knowledge_meta WHERE project_id = ?', projectId);
  return { memory: memory.map<Row>((m) => {
    const row = memoryRow(projectId, m.id)!;
    const contradictions = allFacts.filter((other) => row.subject && row.predicate && other.memory_id !== row.id &&
      normalizeMemory(other.subject) === normalizeMemory(row.subject) && normalizeMemory(other.predicate) === normalizeMemory(row.predicate) && normalizeMemory(other.object) !== normalizeMemory(row.object));
    return { ...row, stale: !!row.valid_until && Date.parse(row.valid_until) < Date.now(), contradictions: contradictions.map((r) => r.memory_id) };
  }), docs: query ? searchKb(projectId, query, 30) : all('SELECT path, updated_at, length(text) AS characters FROM indexed_files WHERE project_id = ? ORDER BY path', projectId),
  kbChunks: one('SELECT count(*) AS n FROM kb WHERE project_id = ?', projectId)!.n };
}

export type KnowledgePatch = { text?: string; kind?: string; subject?: string; predicate?: string; object?: string; entityType?: string; occurredAt?: string | null; validUntil?: string | null };
export function updateKnowledge(projectId: number, id: number, patch: KnowledgePatch, action = 'edit') {
  const row = memoryRow(projectId, id);
  if (!row) throw error(404, 'connaissance inconnue');
  for (const key of ['text', 'kind', 'subject', 'predicate', 'object', 'entityType'] as const) if (patch[key] !== undefined && (typeof patch[key] !== 'string' || patch[key]!.length > 10_000)) throw error(400, `${key} invalide`);
  if (patch.text !== undefined && !patch.text.trim()) throw error(400, 'texte vide');
  if (patch.kind !== undefined && !['decision', 'convention', 'pitfall', 'fact', 'todo'].includes(patch.kind)) throw error(400, 'type de connaissance invalide');
  if (patch.entityType !== undefined && !['person', 'event', 'fact'].includes(patch.entityType)) throw error(400, 'type d’entité invalide');
  for (const key of ['occurredAt', 'validUntil'] as const) if (patch[key] != null && (typeof patch[key] !== 'string' || !/^\d{4}-\d{2}-\d{2}(T[\d:.+-]+Z?)?$/.test(patch[key]!) || !Number.isFinite(Date.parse(patch[key]!)) || new Date(`${patch[key]!.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== patch[key]!.slice(0, 10))) throw error(400, `${key} doit être une date ISO`);
  db.exec('SAVEPOINT knowledge_edit');
  try {
    if (!one('SELECT 1 FROM knowledge_versions WHERE memory_id = ? AND project_id = ?', id, projectId)) version(row, 'initial');
    run('UPDATE memory SET text = ?, kind = ? WHERE rowid = ?', patch.text?.trim() ?? row.text, patch.kind ?? row.kind, id);
    run(`INSERT INTO knowledge_meta (memory_id, project_id, subject, predicate, object, entity_type, occurred_at, valid_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(memory_id) DO UPDATE SET subject = excluded.subject, predicate = excluded.predicate, object = excluded.object, entity_type = excluded.entity_type,
      occurred_at = excluded.occurred_at, valid_until = excluded.valid_until, updated_at = CURRENT_TIMESTAMP`,
    id, projectId, patch.subject ?? row.subject ?? '', patch.predicate ?? row.predicate ?? '', patch.object ?? row.object ?? '', patch.entityType ?? row.entity_type ?? 'fact',
    patch.occurredAt === undefined ? row.occurred_at ?? null : patch.occurredAt, patch.validUntil === undefined ? row.valid_until ?? null : patch.validUntil);
    version(memoryRow(projectId, id)!, action);
    db.exec('RELEASE knowledge_edit');
  } catch (e) { db.exec('ROLLBACK TO knowledge_edit; RELEASE knowledge_edit'); throw e; }
  return memoryRow(projectId, id)!;
}

export function knowledgeHistory(projectId: number, id: number) {
  getProject(projectId);
  return all('SELECT * FROM knowledge_versions WHERE project_id = ? AND memory_id = ? ORDER BY id DESC', projectId, id).map<Row>((v) => ({ ...v, snapshot: JSON.parse(v.snapshot) }));
}

export function restoreKnowledge(projectId: number, id: number, versionId: number) {
  const v = knowledgeHistory(projectId, id).find((v) => v.id === versionId);
  if (!v) throw error(404, 'version inconnue');
  const s = v.snapshot;
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!memoryRow(projectId, id)) {
      if (one('SELECT 1 FROM memory WHERE rowid = ?', id)) throw error(409, 'identifiant de connaissance déjà utilisé');
      run('INSERT INTO memory (rowid, text, kind, project_id, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, s.text, s.kind, projectId, s.session_id ?? null, s.created_at);
    }
    const restored = updateKnowledge(projectId, id, { text: s.text, kind: s.kind, subject: s.subject ?? '', predicate: s.predicate ?? '', object: s.object ?? '', entityType: s.entity_type ?? 'fact', occurredAt: s.occurred_at, validUntil: s.valid_until }, 'restore');
    db.exec('COMMIT');
    return restored;
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export function removeKnowledge(projectId: number, id: number) {
  const row = memoryRow(projectId, id);
  if (!row) throw error(404, 'connaissance inconnue');
  db.exec('BEGIN IMMEDIATE');
  try { version(row, 'delete'); run('DELETE FROM memory WHERE rowid = ?', id); run('DELETE FROM knowledge_meta WHERE memory_id = ?', id); db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw e; }
  return { deleted: true };
}

export function consolidateKnowledge(projectId: number) {
  getProject(projectId);
  const seen = new Set<string>(); let merged = 0;
  for (const row of all('SELECT rowid AS id, text FROM memory WHERE project_id = ? ORDER BY rowid', projectId)) {
    const key = normalizeMemory(row.text);
    if (seen.has(key)) { removeKnowledge(projectId, row.id); merged++; } else seen.add(key);
  }
  const rows = listKnowledge(projectId).memory;
  return { merged, stale: rows.filter((r) => r.stale).length, contradictions: rows.filter((r) => r.contradictions.length).map((r) => ({ id: r.id, conflicts: r.contradictions })) };
}

export function exportKnowledge(projectId: number) {
  const p = getProject(projectId);
  const rows = listKnowledge(projectId).memory;
  return { filename: `connaissances-${projectId}.md`, markdown: `# Connaissances — ${p.name}\n\n` + rows.map((m) =>
    `## ${m.id} · ${m.kind}\n\n${m.text}\n\n- Création : ${m.created_at}\n- Entité : ${m.entity_type ?? 'fact'}\n` +
    (m.subject ? `- Relation : ${m.subject} → ${m.predicate} → ${m.object}\n` : '') +
    (m.occurred_at ? `- Événement : ${m.occurred_at}\n` : '') + (m.valid_until ? `- Valable jusqu’au : ${m.valid_until}\n` : '')).join('\n') };
}

export function knowledgeGraph(projectId: number) {
  const rows = listKnowledge(projectId).memory;
  const entities = new Map<string, { id: string; label: string; type: string }>();
  const edges: Row[] = [];
  for (const r of rows) {
    entities.set(`memory:${r.id}`, { id: `memory:${r.id}`, label: r.text, type: r.entity_type ?? 'fact' });
    if (r.subject) {
      const subject = `entity:${normalizeMemory(r.subject)}`;
      entities.set(subject, { id: subject, label: r.subject, type: r.entity_type ?? 'fact' });
      edges.push({ source: subject, target: `memory:${r.id}`, label: r.predicate, value: r.object, occurredAt: r.occurred_at ?? r.created_at, validUntil: r.valid_until, stale: r.stale });
    }
  }
  return { nodes: [...entities.values()], edges, timeline: rows.map((r) => ({ id: r.id, text: r.text, type: r.entity_type ?? 'fact', at: r.occurred_at ?? r.created_at, validUntil: r.valid_until })).sort((a, b) => a.at.localeCompare(b.at)) };
}

export type ContextSelection = { memoryIds?: number[] | null; paths?: string[] | null; custom?: string; includeBrief?: boolean; includeInstructions?: boolean; includeGit?: boolean; includeRecent?: boolean };
export function getContextSelection(sessionId: string): ContextSelection {
  return JSON.parse(one('SELECT data FROM context_selection WHERE session_id = ?', sessionId)?.data ?? '{}');
}
export function setContextSelection(sessionId: string, patch: ContextSelection) {
  const session = one('SELECT * FROM sessions WHERE id = ?', sessionId);
  if (!session) throw error(404, 'session inconnue');
  if (patch.memoryIds != null && (!Array.isArray(patch.memoryIds) || patch.memoryIds.length > 100 || patch.memoryIds.some((id) => !Number.isInteger(id) || !memoryRow(session.project_id, id)))) throw error(400, 'connaissance étrangère au projet ou sélection invalide');
  if (patch.paths != null && (!Array.isArray(patch.paths) || patch.paths.length > 100 || patch.paths.some((path) => typeof path !== 'string' || !one('SELECT 1 FROM indexed_files WHERE project_id = ? AND path = ?', session.project_id, path)))) throw error(400, 'source étrangère au projet ou sélection invalide');
  if (patch.paths) for (const path of patch.paths) projectPath(session.project_id, path);
  if (patch.custom !== undefined && (typeof patch.custom !== 'string' || patch.custom.length > 30_000)) throw error(400, 'contexte personnalisé trop long');
  for (const flag of ['includeBrief', 'includeInstructions', 'includeGit', 'includeRecent'] as const) if (patch[flag] !== undefined && typeof patch[flag] !== 'boolean') throw error(400, 'option de contexte invalide');
  const next = { ...getContextSelection(sessionId), ...patch };
  run('INSERT INTO context_selection VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET data = excluded.data', sessionId, JSON.stringify(next));
  return next;
}

const EXT = /\.(md|mdx|markdown|txt|rst|adoc|ts|tsx|js|jsx|mjs|cjs|py|php|go|rs|java|c|h|cpp|cs|rb|swift|sql|sh|css|html|json|yaml|yml|pdf|docx|odt|pptx|xlsx)$/i;
const SKIP = /(^|\/)(node_modules|\.git|dist|build|vendor|\.venv|venv|target|\.next|coverage|worktrees)(\/|$)/;
const binary = /\.(pdf|docx|odt|pptx|xlsx)$/i;

/** PDF uses Poppler, office documents use unzip; both are optional system tools with explicit failures. */
export function extractDocument(path: string) {
  if (statSync(path).size > (binary.test(path) ? 10_000_000 : 300_000)) throw error(400, 'document trop volumineux');
  if (!binary.test(path)) return readFileSync(path, 'utf8');
  try {
    if (/\.pdf$/i.test(path)) return execFileSync('pdftotext', ['-layout', path, '-'], { encoding: 'utf8', timeout: 15_000, maxBuffer: 5_000_000, stdio: ['ignore', 'pipe', 'pipe'] });
    const entries = execFileSync('unzip', ['-Z1', path], { encoding: 'utf8', timeout: 5_000, maxBuffer: 1_000_000, stdio: ['ignore', 'pipe', 'pipe'] }).split('\n');
    const selected = entries.filter((name) => /^(word\/(document|footnotes|endnotes|header\d+|footer\d+)\.xml|content\.xml|ppt\/slides\/slide\d+\.xml|xl\/(sharedStrings\.xml|worksheets\/sheet\d+\.xml))$/.test(name)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    if (!selected.length || selected.length > 200) throw new Error('structure bureautique absente ou trop volumineuse');
    let bytes = 0;
    const texts = selected.map((name) => {
      const text = execFileSync('unzip', ['-p', path, name], { encoding: 'utf8', timeout: 5_000, maxBuffer: 5_000_000, stdio: ['ignore', 'pipe', 'pipe'] });
      bytes += Buffer.byteLength(text);
      if (bytes > 5_000_000) throw new Error('texte extrait trop volumineux');
      return text;
    });
    const plain = (text: string) => text.replace(/<\/(?:w:p|text:p|a:p|row|si)>/g, '\n').replace(/<[^>]+>/g, ' ').replace(/&(?:amp|lt|gt|quot|apos);/g, (s) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" })[s]!);
    const shared = [...(texts[selected.indexOf('xl/sharedStrings.xml')] ?? '').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => plain(m[1]).trim());
    return texts.map((text, i) => selected[i] === 'xl/sharedStrings.xml' ? '' : plain(text.replace(/<c\b[^>]*\bt="s"[^>]*>[\s\S]*?<v>(\d+)<\/v>[\s\S]*?<\/c>/g, (_, n) => ` ${shared[Number(n)] ?? ''} `))).join('\n');
  } catch (e: any) { throw error(422, `extraction impossible : ${e.code === 'ENOENT' ? (/\.pdf$/i.test(path) ? 'installer Poppler (pdftotext)' : 'installer unzip') : String(e.message).split('\n')[0].slice(0, 160)}`); }
}

export function indexKnowledge(p: Row) {
  const result = { chunks: 0, failed: [] as string[], updated: 0, removed: 0, unchanged: 0 };
  if (!existsSync(p.path)) return result;
  let files: string[];
  try { files = execFileSync('git', ['ls-files', '-z', '-co', '--exclude-standard'], { cwd: p.path, encoding: 'utf8', timeout: 10_000, maxBuffer: 20 << 20, stdio: ['ignore', 'pipe', 'ignore'] }).split('\0'); }
  catch {
    files = [];
    const folders = [''];
    while (folders.length && files.length < 10_000) {
      const dir = folders.pop()!;
      for (const entry of readdirSync(join(p.path, dir), { withFileTypes: true })) {
        const path = dir ? `${dir}/${entry.name}` : entry.name;
        if (SKIP.test(path)) continue;
        if (entry.isDirectory() && !EXT.test(path)) folders.push(path); else files.push(path);
      }
    }
  }
  for (const dir of ['.serena/memories', '.avity/imports']) if (existsSync(join(p.path, dir))) files.push(...(readdirSync(projectPath(p.id, dir), { recursive: true }) as string[]).map((f) => `${dir}/${f}`));
  const candidates = [...new Set(files)].filter((f) => EXT.test(f) && !SKIP.test(f));
  const selected = candidates.slice(0, 2000);
  if (candidates.length > selected.length) result.failed.push('limite de 2000 fichiers atteinte');
  const known = new Map(all('SELECT path, hash FROM indexed_files WHERE project_id = ?', p.id).map((r) => [r.path, r.hash]));
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const path of selected) {
      try {
        const abs = projectPath(p.id, path);
        if (!statSync(abs).isFile()) throw new Error('pas un fichier');
        if (statSync(abs).size > (binary.test(abs) ? 10_000_000 : 300_000)) throw error(400, 'document trop volumineux');
        const hash = createHash('sha256').update(readFileSync(abs)).digest('hex');
        if (known.get(path) === hash) { result.unchanged++; continue; }
        const text = extractDocument(abs);
        run('DELETE FROM kb WHERE project_id = ? AND path = ?', p.id, path);
        for (let i = 0; i < text.length; i += 1500) if (text.slice(i, i + 1500).trim()) run('INSERT INTO kb (text, path, project_id) VALUES (?, ?, ?)', text.slice(i, i + 1500).trim(), path, p.id);
        run('INSERT INTO indexed_files (project_id, path, hash, text) VALUES (?, ?, ?, ?) ON CONFLICT(project_id, path) DO UPDATE SET hash = excluded.hash, text = excluded.text, updated_at = CURRENT_TIMESTAMP', p.id, path, hash, text);
        result.updated++;
      } catch (e: any) {
        result.failed.push(`${path}${e.status ? ` : ${e.message}` : ''}`);
        if (known.has(path)) {
          run('DELETE FROM kb WHERE project_id = ? AND path = ?', p.id, path);
          run('DELETE FROM indexed_files WHERE project_id = ? AND path = ?', p.id, path);
          result.removed++;
        }
      }
    }
    for (const path of known.keys()) if (!candidates.includes(path)) { run('DELETE FROM kb WHERE project_id = ? AND path = ?', p.id, path); run('DELETE FROM indexed_files WHERE project_id = ? AND path = ?', p.id, path); result.removed++; }
    result.chunks = one('SELECT count(*) AS n FROM kb WHERE project_id = ?', p.id)!.n;
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return result;
}

export function readSource(projectId: number, path: string) {
  if (typeof path !== 'string' || !one('SELECT 1 FROM indexed_files WHERE project_id = ? AND path = ?', projectId, path)) throw error(404, 'source inconnue');
  return { path, text: extractDocument(projectPath(projectId, path)), mime: 'text/plain; charset=utf-8' };
}

export function sourceFile(projectId: number, path: string) {
  if (typeof path !== 'string' || !one('SELECT 1 FROM indexed_files WHERE project_id = ? AND path = ?', projectId, path)) throw error(404, 'source inconnue');
  const absolute = projectPath(projectId, path);
  const size = statSync(absolute).size;
  if (size > 10_000_000) throw error(400, 'document trop volumineux');
  return { absolute, filename: basename(path), mime: /\.pdf$/i.test(path) ? 'application/pdf' : binary.test(path) ? 'application/octet-stream' : 'text/plain; charset=utf-8' };
}

export function importDocument(projectId: number, input: { name: string; base64: string }) {
  const p = getProject(projectId);
  if (typeof input.name !== 'string' || input.name !== basename(input.name) || !EXT.test(input.name) || /[\\\0]/.test(input.name)) throw error(400, 'nom ou format de document invalide');
  if (typeof input.base64 !== 'string' || input.base64.length > 14_000_000 || input.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.base64)) throw error(400, 'contenu base64 invalide ou trop volumineux');
  const data = Buffer.from(input.base64, 'base64');
  if (data.toString('base64') !== input.base64) throw error(400, 'contenu base64 invalide');
  if (!data.length || data.length > 10_000_000) throw error(400, 'document vide ou trop volumineux');
  const name = `${createHash('sha256').update(data).digest('hex').slice(0, 12)}-${input.name}`;
  const path = projectPath(projectId, `.avity/imports/${name}`);
  mkdirSync(join(p.path, '.avity/imports'), { recursive: true });
  if (!existsSync(path)) writeFileSync(path, data, { flag: 'wx' });
  return { path: `.avity/imports/${name}`, ...indexKnowledge(p) };
}
