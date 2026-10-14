// Context engine: per-project knowledge base, git state, memory recall, context packs and session summaries.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { all, one, run, db, searchMemory, searchKb, addMemory, DB_PATH, type Row } from './store.ts';
import { config } from './config.ts';
import { oneShot, type McpServer } from './acp.ts';

const DOC_EXT = /\.(md|mdx|markdown|txt|rst|adoc)$/i;
const SKIP_DIR = /(^|\/)(node_modules|\.git|dist|build|vendor|\.venv|venv|target|\.next|coverage)(\/|$)/;
const MAX_FILES = 2000;

const git = (cwd: string, args: string[]) => {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 20 << 20 }); } catch { return ''; }
};

function listDocs(root: string): string[] {
  const tracked = git(root, ['ls-files', '-co', '--exclude-standard']);
  const files = tracked ? tracked.split('\n') : readdirSync(root, { recursive: true }) as string[];
  return files.filter((f) => f && DOC_EXT.test(f) && !SKIP_DIR.test(f)).slice(0, MAX_FILES);
}

/** Splits markdown on headings, then caps chunk size so each FTS hit stays prompt-sized. */
export function chunk(text: string, max = 1500): string[] {
  const out: string[] = [];
  for (const sec of text.split(/\n(?=#{1,3} )/)) {
    for (let i = 0; i < sec.length; i += max) { const c = sec.slice(i, i + max).trim(); if (c) out.push(c); }
  }
  return out;
}

/** (Re)indexes a project's docs (README, docs/, AGENTS.md, .serena/memories, notes…) into the FTS knowledge base. */
export function indexProject(p: Row): number {
  if (!existsSync(p.path)) return 0;
  const files = new Set(listDocs(p.path));
  const serena = join(p.path, '.serena/memories');
  if (existsSync(serena)) for (const f of readdirSync(serena)) files.add(relative(p.path, join(serena, f)));
  let n = 0;
  db.exec('BEGIN');
  try {
    run('DELETE FROM kb WHERE project_id = ?', p.id);
    for (const f of files) {
      const abs = join(p.path, f);
      try { if (statSync(abs).size > 300_000) continue; } catch { continue; }
      for (const c of chunk(readFileSync(abs, 'utf8'))) { run('INSERT INTO kb (text, path, project_id) VALUES (?, ?, ?)', c, f, p.id); n++; }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return n;
}

export function gitState(cwd: string): string {
  const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  if (!branch) return '';
  const status = git(cwd, ['status', '--short']).split('\n').filter(Boolean);
  const log = git(cwd, ['log', '--oneline', '-8']).trim();
  return [`branche: ${branch}`, status.length ? `modifiés (${status.length}):\n${status.slice(0, 30).join('\n')}` : 'arbre propre', log && `derniers commits:\n${log}`]
    .filter(Boolean).join('\n');
}

export function gitDiff(cwd: string, max = 60_000): string {
  const d = git(cwd, ['diff', 'HEAD']) || git(cwd, ['diff']);
  const untracked = git(cwd, ['ls-files', '--others', '--exclude-standard']).trim();
  const out = d + (untracked ? `\n# Fichiers non suivis:\n${untracked}` : '');
  return out.length > max ? out.slice(0, max) + `\n… (diff tronqué, ${out.length} caractères)` : out;
}

export function mcpServersFor(projectId: number): McpServer[] {
  return [{
    name: 'avity',
    command: process.execPath,
    args: [fileURLToPath(new URL('./mcp.ts', import.meta.url)), String(projectId)],
    env: [{ name: 'AVITY_DB', value: DB_PATH }, { name: 'NODE_NO_WARNINGS', value: '1' }],
  }];
}

const readIf = (f: string) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };

/** The context pack injected as the first message of every fresh agent session. */
export function buildPack(p: Row, sessionId: string, prompt: string, handoff = ''): { text: string; stats: string } {
  const parts: string[] = [];
  const brief = readIf(join(p.path, '.avity/brief.md')).trim();
  if (brief) parts.push(`## Brief projet\n${brief.slice(0, 3000)}`);
  const gs = gitState(p.path);
  if (gs) parts.push(`## État git\n${gs}`);
  const mems = searchMemory(p.id, prompt, 10);
  if (mems.length) parts.push(`## Mémoire projet pertinente\n${mems.map((m) => `- [${m.kind}] ${m.text}`).join('\n')}`);
  const docs = searchKb(p.id, prompt, 4);
  if (docs.length) parts.push(`## Extraits de la base de connaissance\n${docs.map((d) => `### ${d.path}\n${d.text.slice(0, 1200)}`).join('\n\n')}`);
  const recent = all(`SELECT title, summary FROM sessions WHERE project_id = ? AND id <> ? AND summary IS NOT NULL ORDER BY updated_at DESC LIMIT 3`, p.id, sessionId);
  if (recent.length) parts.push(`## Sessions récentes\n${recent.map((r) => `- ${r.title ?? 'session'} : ${r.summary}`).join('\n')}`);
  if (handoff) parts.push(`## Reprise : transcript de cette session avec un autre agent\n${handoff}`);
  const text = `<avity-context>
Contexte fourni par AvityOne, l'orchestrateur qui te pilote. Le serveur MCP "avity" te donne avity_memory_search
(mémoire + docs du projet) et avity_memory_add (enregistre une décision, convention ou piège DURABLE).

${parts.join('\n\n') || '(aucun contexte projet pour l\'instant)'}
</avity-context>`;
  return { text, stats: `${mems.length} mémoires, ${docs.length} docs, ${recent.length} sessions${gs ? ', git' : ''}${handoff ? ', reprise' : ''}` };
}

/** Plain-text transcript of a session (user/assistant/tools), keeping the head and the most recent tail. */
export function transcript(sessionId: string, max = 12_000): string {
  const lines = all('SELECT data FROM items WHERE session_id = ? ORDER BY id', sessionId).map((r) => {
    const it = JSON.parse(r.data);
    if (it.type === 'user') return `\n[utilisateur → ${it.agent}${it.mode === 'plan' ? ' (plan)' : ''}] ${it.text}`;
    if (it.type === 'assistant') return `[${it.agent}] ${it.text}`;
    if (it.type === 'tool') return `  · outil ${it.kind ?? ''}: ${it.title} (${it.status})`;
    if (it.type === 'plan') return `  · plan: ${it.entries.map((e: Row) => `[${e.status}] ${e.content}`).join(' | ')}`;
    if (it.type === 'review') return `[revue ${it.agent}] ${it.text}`;
    return '';
  }).filter(Boolean).join('\n');
  return lines.length > max ? lines.slice(0, max * 0.25) + '\n…\n' + lines.slice(-max * 0.75) : lines;
}

const summarizing = new Set<string>();

/** Summarizes a session and extracts durable memories with a cheap model. Safe to call concurrently. */
export async function summarize(sessionId: string): Promise<Row | null> {
  const s = one('SELECT * FROM sessions WHERE id = ?', sessionId);
  if (!s || summarizing.has(sessionId)) return null;
  const p = one('SELECT * FROM projects WHERE id = ?', s.project_id)!;
  const t = transcript(sessionId, 30_000);
  if (!t.trim()) return null;
  summarizing.add(sessionId);
  try {
    const out = await oneShot(config.summarizer.agent, p.path, `Tu es le module mémoire d'AvityOne. Résume la session ci-dessous et extrais les connaissances DURABLES du projet.
Réponds UNIQUEMENT avec un objet JSON valide, sans texte autour :
{"title": "titre court (max 8 mots)", "summary": "3 à 6 phrases : objectif, ce qui a été fait, état final, prochaines étapes", "memories": [{"kind": "decision|convention|pitfall|fact|todo", "text": "une phrase autonome et précise"}]}
Au plus 8 memories, uniquement ce qui restera vrai et utile dans de futures sessions. Jamais de secrets ni de tokens.
N'utilise aucun outil.

<transcript>
${t}
</transcript>`, { model: config.summarizer.model });
    let parsed: Row;
    try { parsed = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)); } catch { parsed = { summary: out.trim().slice(0, 1500), memories: [] }; }
    const kinds = ['decision', 'convention', 'pitfall', 'fact', 'todo'];
    let added = 0;
    for (const m of parsed.memories ?? []) if (typeof m?.text === 'string' && addMemory(s.project_id, kinds.includes(m.kind) ? m.kind : 'fact', m.text, sessionId)) added++;
    run(`UPDATE sessions SET summary = ?, title = COALESCE(?, title), summarized_turns = ? WHERE id = ?`, String(parsed.summary ?? '').slice(0, 2000), parsed.title ?? null, s.turns, sessionId);
    return { summary: parsed.summary, title: parsed.title, added };
  } finally { summarizing.delete(sessionId); }
}
