// Context engine: per-project knowledge base, git state, memory recall, context packs and session summaries.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { all, one, run, searchMemory, searchKb, addMemory, DB_PATH, type Row } from './store.ts';
import { config } from './config.ts';
import { oneShot, type McpServer } from './acp.ts';
import { consolidateKnowledge, getContextSelection, indexKnowledge, readSource } from './knowledge.ts';
import { projectPath } from './projects.ts';

const git = (cwd: string, args: string[]) => {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 20 << 20 }); } catch { return ''; }
};

/** Splits markdown on headings, then caps chunk size so each FTS hit stays prompt-sized. */
export function chunk(text: string, max = 1500): string[] {
  const out: string[] = [];
  for (const sec of text.split(/\n(?=#{1,3} )/)) {
    for (let i = 0; i < sec.length; i += max) { const c = sec.slice(i, i + max).trim(); if (c) out.push(c); }
  }
  return out;
}

/**
 * (Re)indexes a project's docs (README, docs/, AGENTS.md, .serena/memories, notes…) into the FTS knowledge base.
 * A file that can't be read is skipped and listed in `failed` instead of failing the whole index.
 */
export const indexProject = indexKnowledge;

export function gitState(cwd: string): string {
  const branch = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  if (!branch) return '';
  const status = git(cwd, ['status', '--short']).split('\n').filter(Boolean);
  const log = git(cwd, ['log', '--oneline', '-8']).trim();
  return [`branche: ${branch}`, status.length ? `modifiés (${status.length}):\n${status.slice(0, 30).join('\n')}` : 'arbre propre', log && `derniers commits:\n${log}`]
    .filter(Boolean).join('\n');
}

/** Working-tree diff (with untracked files), or the diff of a commit range such as `base..HEAD`. */
export function gitDiff(cwd: string, range = '', max = 60_000): string {
  const d = range ? git(cwd, ['diff', range]) : git(cwd, ['diff', 'HEAD']) || git(cwd, ['diff']);
  const untracked = range ? '' : git(cwd, ['ls-files', '--others', '--exclude-standard']).trim();
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

/** A file that may legitimately be absent: missing is '', any other failure (permissions, a directory…) throws. */
const readOptional = (f: string) => {
  try { return readFileSync(f, 'utf8'); } catch (e: any) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return ''; throw e; }
};

/**
 * The context pack injected as the first message of every fresh agent session. `cwd` is the session's worktree, if any.
 * A section that fails to load is skipped and reported in `warnings`: the agent still gets the rest.
 */
export function buildPack(p: Row, sessionId: string, prompt: string, handoff = '', cwd = p.path): { text: string; stats: string; warnings: string[] } {
  const parts: string[] = [];
  const warnings: string[] = [];
  const load = <T>(what: string, fn: () => T, fallback: T): T => {
    try { return fn(); } catch (e: any) { warnings.push(`${what} (${String(e.message ?? e).slice(0, 200)})`); return fallback; }
  };
  if (!existsSync(cwd)) warnings.push(`dossier de travail introuvable (${cwd})`);
  const selection = getContextSelection(sessionId);
  load('réindexation indisponible', () => indexProject(p), null);
  if (cwd !== p.path) parts.push(`## Worktree isolé\nTu travailles dans ${cwd}, un worktree git sur sa propre branche. Ne modifie rien en dehors : AvityOne mergera ta branche.`);
  const brief = selection.includeBrief === false ? '' : load('brief illisible', () => readOptional(projectPath(p.id, '.avity/brief.md')), '').trim();
  if (brief) parts.push(`## Brief projet\n${brief.slice(0, 3000)}`);
  const instructions = selection.includeInstructions === false ? '' : load('instructions illisibles', () => readOptional(projectPath(p.id, 'AGENTS.md')), '').trim();
  if (instructions) parts.push(`## Instructions projet\n${instructions.slice(0, 12_000)}`);
  const gs = selection.includeGit === false ? '' : gitState(cwd); // a project that isn't a git repository is normal, not an error
  if (gs) parts.push(`## État git\n${gs}`);
  const mems = load('mémoire du projet indisponible', () => selection.memoryIds == null ? searchMemory(p.id, prompt, 10) :
    selection.memoryIds.map((id) => one('SELECT rowid AS id, kind, text FROM memory WHERE rowid = ? AND project_id = ?', id, p.id)).filter((m): m is Row => !!m), []);
  if (mems.length) parts.push(`## Mémoire projet pertinente\n${mems.map((m) => `- [${m.kind}] ${m.text}`).join('\n')}`);
  const docs = load('base de connaissance indisponible', () => selection.paths == null ? searchKb(p.id, prompt, 4) : selection.paths.map((path) => readSource(p.id, path)), []);
  if (docs.length) parts.push(`## Extraits de la base de connaissance\n${docs.map((d) => `### ${d.path}\n${d.text.slice(0, 1200)}`).join('\n\n')}`);
  const recent = selection.includeRecent === false ? [] : load('sessions récentes indisponibles', () => all(`SELECT title, summary FROM sessions WHERE project_id = ? AND id <> ? AND summary IS NOT NULL ORDER BY updated_at DESC LIMIT 3`, p.id, sessionId), []);
  if (recent.length) parts.push(`## Sessions récentes\n${recent.map((r) => `- ${r.title ?? 'session'} : ${r.summary}`).join('\n')}`);
  if (selection.custom?.trim()) parts.push(`## Contexte personnalisé\n${selection.custom}`);
  if (handoff) parts.push(`## Reprise : conversation précédente de cette session (avec toi ou un autre agent)\n${handoff}`);
  const text = `<avity-context>
Contexte fourni par AvityOne, l'orchestrateur qui te pilote. Le serveur MCP "avity" te donne avity_memory_search
(mémoire + docs du projet) et avity_memory_add (enregistre une décision, convention ou piège DURABLE).

${parts.join('\n\n') || '(aucun contexte projet pour l\'instant)'}
</avity-context>`;
  return { text, warnings, stats: `${mems.length} mémoires, ${docs.length} docs, ${recent.length} sessions${gs ? ', git' : ''}${handoff ? ', reprise' : ''}` };
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
    if (it.type === 'parallel') return `  · exécution parallèle: ${it.children.map((c: Row) => `${c.task} → ${c.agent} (${c.status})`).join(' | ')}`;
    return '';
  }).filter(Boolean).join('\n');
  return lines.length > max ? lines.slice(0, max * 0.25) + '\n…\n' + lines.slice(-max * 0.75) : lines;
}

/** Full session as a Markdown document (thoughts left out), with a file name for downloads. */
export function exportMarkdown(sessionId: string): { filename: string; markdown: string } {
  const s = one('SELECT s.*, p.name AS project FROM sessions s JOIN projects p ON p.id = s.project_id WHERE s.id = ?', sessionId);
  if (!s) throw Object.assign(new Error('session inconnue'), { status: 404 });
  const name = (id?: string) => (id && config.agents[id]?.name) || id || 'agent';
  const quote = (t: string) => t.split('\n').map((l) => `> ${l}`).join('\n');
  const title = s.title ?? 'Session sans titre';
  const out = [`# ${title}`, '', `- Projet : ${s.project}`, `- Session : \`${s.id}\``, `- Créée le ${s.created_at} UTC, mise à jour le ${s.updated_at} UTC`];
  if (s.summary) out.push('', quote(`**Résumé** : ${s.summary}`));
  for (const r of all('SELECT data FROM items WHERE session_id = ? ORDER BY id', sessionId)) {
    const it = JSON.parse(r.data);
    if (it.type === 'user') out.push('', '---', '', `### Toi → ${name(it.agent)}${it.mode === 'plan' ? ' (plan)' : ''}`, '', it.text);
    else if (it.type === 'assistant') out.push('', `### ${name(it.agent)}`, '', it.text);
    else if (it.type === 'tool') out.push('', `- 🔧 ${it.title}${it.status && it.status !== 'completed' ? ` (${it.status})` : ''}${it.paths?.length ? ` — ${it.paths.join(', ')}` : ''}`);
    else if (it.type === 'plan') out.push('', '**Plan**', '', ...it.entries.map((e: Row) => `- [${e.status === 'completed' ? 'x' : ' '}] ${e.content}`));
    else if (it.type === 'review') out.push('', `### Revue croisée par ${name(it.agent)}`, '', it.text);
    else if (it.type === 'parallel') out.push('', '**Exécution parallèle**', '', ...it.children.map((c: Row) => `- ${c.task} → ${name(c.agent)} (${c.status})`));
    else if (it.type === 'permission') out.push('', quote(`🔐 ${it.title}${it.resolved ? ` → ${it.resolved}` : ''}`));
    else if (it.type === 'info' || it.type === 'error') out.push('', quote(`${it.type === 'error' ? '⚠️ ' : ''}${it.text}`));
  }
  const slug = title.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'session';
  return { filename: `${slug}-${String(s.updated_at).slice(0, 10)}.md`, markdown: out.join('\n') + '\n' };
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
    consolidateKnowledge(s.project_id);
    run(`UPDATE sessions SET summary = ?, title = CASE WHEN renamed = 1 THEN title ELSE COALESCE(?, title) END, summarized_turns = ? WHERE id = ?`,
      String(parsed.summary ?? '').slice(0, 2000), parsed.title ?? null, s.turns, sessionId);
    return { summary: parsed.summary, title: parsed.title, added };
  } finally { summarizing.delete(sessionId); }
}
