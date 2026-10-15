import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { HOME } from './config.ts';

export const DB_PATH = process.env.AVITY_DB ?? join(HOME, 'avity.db');
export const db = new DatabaseSync(DB_PATH);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, path TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id),
  title TEXT, agent TEXT, mode TEXT DEFAULT 'agent', acp_session_id TEXT,
  summary TEXT, turns INTEGER DEFAULT 0, summarized_turns INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS items_by_session ON items(session_id, id);
CREATE VIRTUAL TABLE IF NOT EXISTS memory USING fts5(
  text, kind UNINDEXED, project_id UNINDEXED, session_id UNINDEXED, created_at UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2');
CREATE VIRTUAL TABLE IF NOT EXISTS kb USING fts5(
  text, path UNINDEXED, project_id UNINDEXED,
  tokenize = 'unicode61 remove_diacritics 2');
CREATE TABLE IF NOT EXISTS knowledge_meta (
  memory_id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, subject TEXT DEFAULT '', predicate TEXT DEFAULT '',
  object TEXT DEFAULT '', entity_type TEXT DEFAULT 'fact', occurred_at TEXT, valid_until TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS knowledge_versions (
  id INTEGER PRIMARY KEY, memory_id INTEGER NOT NULL, project_id INTEGER NOT NULL,
  snapshot TEXT NOT NULL, action TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS knowledge_versions_memory ON knowledge_versions(project_id, memory_id, id);
CREATE TABLE IF NOT EXISTS indexed_files (
  project_id INTEGER NOT NULL, path TEXT NOT NULL, hash TEXT NOT NULL, text TEXT NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(project_id, path));
CREATE TABLE IF NOT EXISTS context_selection (session_id TEXT PRIMARY KEY, data TEXT NOT NULL);
`);

export type Row = Record<string, any>;
export const all = (sql: string, ...p: any[]) => db.prepare(sql).all(...p) as Row[];
export const one = (sql: string, ...p: any[]) => db.prepare(sql).get(...p) as Row | undefined;
export const run = (sql: string, ...p: any[]) => db.prepare(sql).run(...p);

// Columns added after v0.1, created in place so existing databases keep working.
const cols = all('PRAGMA table_info(sessions)').map((c) => c.name);
for (const [c, def] of [['parent_id', 'TEXT'], ['isolated', 'INTEGER DEFAULT 0'], ['worktree', 'TEXT'],
  ['pinned', 'INTEGER DEFAULT 0'], ['archived', 'INTEGER DEFAULT 0'], ['renamed', 'INTEGER DEFAULT 0'], ['draft', 'TEXT'], ['forked_from', 'TEXT']]) {
  if (!cols.includes(c)) db.exec(`ALTER TABLE sessions ADD COLUMN ${c} ${def}`);
}
if (!all('PRAGMA table_info(projects)').some((c) => c.name === 'archived')) db.exec('ALTER TABLE projects ADD COLUMN archived INTEGER DEFAULT 0');

// Conversation history search: messages, answers and reviews, kept in sync with `items` by triggers
// (streamed answers are rewritten in place, so updates re-index too).
const searchable = (data: string) => `json_extract(${data}, '$.type') IN ('user', 'assistant', 'review')`;
// One transaction: the backfill can't be skipped by a crash, nor run twice by the MCP process opening the same database.
db.exec('BEGIN IMMEDIATE');
try {
  const fresh = !one(`SELECT 1 FROM sqlite_master WHERE name = 'history'`);
  db.exec(`
CREATE VIRTUAL TABLE IF NOT EXISTS history USING fts5(
  text, session_id UNINDEXED, tokenize = 'unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS history_ai AFTER INSERT ON items WHEN ${searchable('new.data')} BEGIN
  INSERT INTO history (rowid, text, session_id) VALUES (new.id, json_extract(new.data, '$.text'), new.session_id); END;
CREATE TRIGGER IF NOT EXISTS history_au AFTER UPDATE ON items WHEN ${searchable('new.data')} BEGIN
  DELETE FROM history WHERE rowid = old.id;
  INSERT INTO history (rowid, text, session_id) VALUES (new.id, json_extract(new.data, '$.text'), new.session_id); END;
CREATE TRIGGER IF NOT EXISTS history_ad AFTER DELETE ON items BEGIN
  DELETE FROM history WHERE rowid = old.id; END;
`);
  if (fresh) db.exec(`INSERT INTO history (rowid, text, session_id) SELECT id, json_extract(data, '$.text'), session_id FROM items WHERE ${searchable('data')}`);
  db.exec('COMMIT');
} catch (e) { db.exec('ROLLBACK'); throw e; }

const STOP = new Set(('les des une est pour avec dans que qui sur pas plus par mais ont sont aux ces cette tout tous fait faire peux veux '
  + 'comment quoi quel quelle nous vous ils elles mon mes ton tes son ses leur leurs etre avoir the and for with this that from are '
  + 'you your can how what why have has was will not but all any use using into').split(' '));

/** Meaningful words of free text: accents folded, stop words dropped, deduplicated. */
const words = (text: string, limit = 24) => {
  const w = text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').match(/[\p{L}\p{N}_]{3,}/gu) ?? [];
  return [...new Set(w)].filter((x) => !STOP.has(x)).slice(0, limit);
};

/** Turns free text into an FTS5 OR-query of its meaningful words (quoted, so user text can't inject FTS syntax). */
export function ftsQuery(text: string): string {
  return words(text).map((w) => `"${w}"`).join(' OR ');
}

const MARK = ['\u0002', '\u0003']; // highlight delimiters in search snippets: plain text, never HTML

/** Searches a project's conversations: every word must match, the last one as a prefix (search as you type). */
export function searchHistory(projectId: number, text: string, limit = 30) {
  const w = words(text);
  if (!w.length) return [];
  const hits = all(`SELECT h.rowid AS item_id, h.session_id, snippet(history, 0, ?, ?, '…', 14) AS snippet,
      s.title, s.agent, s.archived, s.parent_id, s.updated_at
    FROM history h JOIN sessions s ON s.id = h.session_id
    WHERE history MATCH ? AND s.project_id = ? ORDER BY bm25(history) LIMIT 200`,
  MARK[0], MARK[1], w.map((x, i) => `"${x}"${i === w.length - 1 ? '*' : ''}`).join(' AND '), projectId);
  const bySession = new Map<string, Row>();
  for (const h of hits) {
    const s = bySession.get(h.session_id);
    if (s) s.hits++; else bySession.set(h.session_id, { ...h, hits: 1 }); // hits come best first
  }
  return [...bySession.values()].slice(0, limit);
}

export function searchMemory(projectId: number, text: string, k = 8) {
  const m = ftsQuery(text);
  if (!m) return [];
  const rows = all(`SELECT m.rowid AS id, m.kind, m.text, m.session_id FROM memory m LEFT JOIN knowledge_meta k ON k.memory_id = m.rowid
    WHERE m.project_id = ? AND (k.valid_until IS NULL OR julianday(k.valid_until) >= julianday('now')) ORDER BY m.rowid DESC LIMIT 300`, projectId);
  const lexical = all(`SELECT m.rowid AS id, m.kind, m.text, m.session_id FROM memory m LEFT JOIN knowledge_meta k ON k.memory_id = m.rowid
    WHERE memory MATCH ? AND m.project_id = ? AND (k.valid_until IS NULL OR julianday(k.valid_until) >= julianday('now')) ORDER BY bm25(memory) LIMIT 100`, m, projectId);
  return hybrid(rows, lexical, text, k);
}

export function searchKb(projectId: number, text: string, k = 4) {
  const m = ftsQuery(text);
  if (!m) return [];
  const rows = all('SELECT rowid AS id, path, text FROM kb WHERE project_id = ? ORDER BY rowid DESC LIMIT 300', projectId);
  const lexical = all(`SELECT rowid AS id, path, text FROM kb WHERE kb MATCH ? AND project_id = ? ORDER BY bm25(kb) LIMIT 100`, m, projectId);
  return hybrid(rows, lexical, text, k);
}

export function addMemory(projectId: number, kind: string, text: string, sessionId: string | null = null): boolean {
  text = text.trim();
  if (!text) return false;
  db.exec('BEGIN IMMEDIATE');
  try {
    if (all('SELECT text FROM memory WHERE project_id = ?', projectId).some((m) => normalizeMemory(m.text) === normalizeMemory(text))) { db.exec('COMMIT'); return false; }
    const id = Number(one('SELECT max(id) + 1 AS n FROM (SELECT COALESCE(max(rowid), 0) AS id FROM memory UNION ALL SELECT COALESCE(max(memory_id), 0) FROM knowledge_versions)')!.n);
    run(`INSERT INTO memory (rowid, text, kind, project_id, session_id, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))`, id, text, kind, projectId, sessionId);
    const fact = text.match(/^([^:\n]{1,160}):\s*(.{1,1000})$/s);
    run('INSERT INTO knowledge_meta (memory_id, project_id, subject, predicate, object) VALUES (?, ?, ?, ?, ?)', id, projectId, fact?.[1].trim() ?? '', fact ? 'valeur' : '', fact?.[2].trim() ?? '');
    const snapshot = one('SELECT m.rowid AS id, m.*, k.subject, k.predicate, k.object, k.entity_type, k.occurred_at, k.valid_until FROM memory m JOIN knowledge_meta k ON k.memory_id = m.rowid WHERE m.rowid = ?', id)!;
    run('INSERT INTO knowledge_versions (memory_id, project_id, snapshot, action) VALUES (?, ?, ?, ?)', id, projectId, JSON.stringify(snapshot), 'create');
    db.exec('COMMIT');
    return true;
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export const normalizeMemory = (text: string) => text.trim().replace(/\s+/g, ' ').toLocaleLowerCase();

// Existing memories get a baseline version before their first edit, without changing their text.
db.exec('BEGIN IMMEDIATE');
try {
  for (const row of all('SELECT m.rowid AS id, m.* FROM memory m LEFT JOIN knowledge_meta k ON k.memory_id = m.rowid WHERE k.memory_id IS NULL')) {
    const fact = row.text.match(/^([^:\n]{1,160}):\s*(.{1,1000})$/s);
    const meta = { subject: fact?.[1].trim() ?? '', predicate: fact ? 'valeur' : '', object: fact?.[2].trim() ?? '', entity_type: 'fact', occurred_at: null, valid_until: null };
    run('INSERT INTO knowledge_meta (memory_id, project_id, subject, predicate, object) VALUES (?, ?, ?, ?, ?)', row.id, row.project_id, meta.subject, meta.predicate, meta.object);
    run('INSERT INTO knowledge_versions (memory_id, project_id, snapshot, action) VALUES (?, ?, ?, ?)', row.id, row.project_id, JSON.stringify({ ...row, ...meta }), 'initial');
  }
  db.exec('COMMIT');
} catch (e) { db.exec('ROLLBACK'); throw e; }

/** Truncated SVD of TF-IDF documents: latent concepts capture co-occurrence beyond exact words. */
function hybrid(rows: Row[], lexical: Row[], query: string, limit: number): Row[] {
  const tokens = (s: string) => words(s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' '), 128);
  const documents = rows.map((r) => tokens(`${r.path ?? ''} ${r.text}`));
  const frequency = new Map<string, number>();
  for (const doc of documents) for (const t of doc) frequency.set(t, (frequency.get(t) ?? 0) + 1);
  const vocabulary = [...frequency.keys()].sort((a, b) => frequency.get(b)! - frequency.get(a)!).slice(0, 4096);
  const positions = new Map(vocabulary.map((t, i) => [t, i]));
  const vector = (ts: string[]) => {
    const v = new Float64Array(vocabulary.length);
    for (const t of ts) { const i = positions.get(t); if (i !== undefined) v[i] = Math.log(1 + rows.length / (frequency.get(t) ?? 1)); }
    const norm = Math.hypot(...v) || 1;
    return v.map((n) => n / norm);
  };
  const vectors = documents.map((doc) => [...vector(doc)].flatMap((value, i) => value ? [{ i, value }] : [])), q = vector(tokens(query));
  const project = (v: { i: number; value: number }[], axis: Float64Array) => v.reduce((n, x) => n + x.value * axis[x.i], 0);
  const dot = (a: Float64Array, b: Float64Array) => a.reduce((n, x, i) => n + x * b[i], 0);
  const basis: Float64Array[] = [];
  // shortcut: at most 300 recent chunks and 12 latent dimensions; use an embedding service for very large corpora.
  const rank = Math.min(12, Math.max(1, Math.floor(rows.length / 2)));
  for (let dimension = 0; dimension < rank && vocabulary.length; dimension++) {
    let axis = Float64Array.from(vocabulary, (_, i) => Math.sin((i + 1) * (dimension + 1)));
    for (let step = 0; step < 18; step++) {
      const next = new Float64Array(vocabulary.length);
      for (const v of vectors) { const scale = project(v, axis); for (const x of v) next[x.i] += x.value * scale; }
      for (const previous of basis) { const scale = dot(next, previous); for (let i = 0; i < next.length; i++) next[i] -= previous[i] * scale; }
      const norm = Math.hypot(...next);
      if (norm < 1e-9) break;
      axis = next.map((n) => n / norm);
    }
    basis.push(axis);
  }
  const latentQuery = Float64Array.from(basis, (b) => dot(q, b));
  const semantic = rows.map((r, i) => {
    const v = Float64Array.from(basis, (b) => project(vectors[i], b));
    return { id: r.id, score: dot(latentQuery, v) / ((Math.hypot(...latentQuery) * Math.hypot(...v)) || 1) };
  }).filter((r) => r.score > 0.25).sort((a, b) => b.score - a.score);
  const scores = new Map<number, number>();
  for (const ranking of [lexical, semantic]) ranking.forEach((r, i) => scores.set(r.id, (scores.get(r.id) ?? 0) + 1 / (60 + i)));
  const candidates = new Map([...rows, ...lexical.filter((r) => r.text)].map((r) => [r.id, r]));
  return [...scores].sort((a, b) => b[1] - a[1]).map<Row>(([id, score]) => ({ ...candidates.get(id), score }))
    .filter((r) => r.text).slice(0, Math.max(1, Math.min(100, Math.floor(limit) || 8)));
}
