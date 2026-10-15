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
`);

export type Row = Record<string, any>;
export const all = (sql: string, ...p: any[]) => db.prepare(sql).all(...p) as Row[];
export const one = (sql: string, ...p: any[]) => db.prepare(sql).get(...p) as Row | undefined;
export const run = (sql: string, ...p: any[]) => db.prepare(sql).run(...p);

// Columns added after v0.1, created in place so existing databases keep working.
const cols = all('PRAGMA table_info(sessions)').map((c) => c.name);
for (const [c, def] of [['parent_id', 'TEXT'], ['isolated', 'INTEGER DEFAULT 0'], ['worktree', 'TEXT'],
  ['pinned', 'INTEGER DEFAULT 0'], ['archived', 'INTEGER DEFAULT 0'], ['renamed', 'INTEGER DEFAULT 0'], ['draft', 'TEXT']]) {
  if (!cols.includes(c)) db.exec(`ALTER TABLE sessions ADD COLUMN ${c} ${def}`);
}

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
const words = (text: string) => {
  const w = text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').match(/[\p{L}\p{N}_]{3,}/gu) ?? [];
  return [...new Set(w)].filter((x) => !STOP.has(x)).slice(0, 24);
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
  return m ? all(`SELECT rowid AS id, kind, text, session_id FROM memory WHERE memory MATCH ? AND project_id = ? ORDER BY bm25(memory) LIMIT ?`, m, projectId, k) : [];
}

export function searchKb(projectId: number, text: string, k = 4) {
  const m = ftsQuery(text);
  return m ? all(`SELECT path, text FROM kb WHERE kb MATCH ? AND project_id = ? ORDER BY bm25(kb) LIMIT ?`, m, projectId, k) : [];
}

export function addMemory(projectId: number, kind: string, text: string, sessionId: string | null = null): boolean {
  text = text.trim();
  if (!text || one(`SELECT 1 FROM memory WHERE project_id = ? AND text = ?`, projectId, text)) return false;
  run(`INSERT INTO memory (text, kind, project_id, session_id, created_at) VALUES (?, ?, ?, ?, datetime('now'))`, text, kind, projectId, sessionId);
  return true;
}
