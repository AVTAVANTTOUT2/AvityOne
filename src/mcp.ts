// Stdio MCP server injected into every agent session: one shared project brain for Claude, Codex, Cursor and OpenCode.
// Usage: node src/mcp.ts <projectId>   (AVITY_DB points at the AvityOne database)
import { createInterface } from 'node:readline';
import { all, one, searchMemory, searchKb, addMemory } from './store.ts';
import { indexKnowledge, knowledgeHistory, readSource, updateKnowledge } from './knowledge.ts';

const projectId = Number(process.argv[2]);

const TOOLS = [
  {
    name: 'avity_memory_search',
    description: 'Cherche dans la mémoire durable du projet (décisions, conventions, pièges) et dans sa base de connaissance (docs). À utiliser avant de trancher une question d\'architecture ou de convention.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] },
  },
  {
    name: 'avity_memory_add',
    description: 'Enregistre une connaissance DURABLE du projet, partagée avec tous les agents et les sessions futures. Pas de détails transitoires ni de secrets.',
    inputSchema: {
      type: 'object',
      properties: { kind: { type: 'string', enum: ['decision', 'convention', 'pitfall', 'fact', 'todo'] }, text: { type: 'string' } },
      required: ['kind', 'text'],
    },
  },
  {
    name: 'avity_knowledge_edit',
    description: 'Modifie une connaissance existante du projet en conservant son historique. Les dates sont ISO ; sujet, prédicat et objet rendent les contradictions vérifiables.',
    inputSchema: { type: 'object', properties: { id: { type: 'number' }, text: { type: 'string' }, subject: { type: 'string' }, predicate: { type: 'string' }, object: { type: 'string' }, validUntil: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'avity_knowledge_history', description: 'Lit les versions précédentes d’une connaissance du projet.',
    inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
  },
  {
    name: 'avity_source_read', description: 'Lit le texte complet d’un document indexé appartenant à ce projet.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'avity_recent_sessions',
    description: 'Résumés des sessions de travail récentes sur ce projet (tous agents confondus).',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
  },
];

function call(name: string, a: any): string {
  if (name === 'avity_memory_search') {
    const p = one('SELECT * FROM projects WHERE id = ?', projectId);
    if (p) indexKnowledge(p);
    const k = Math.min(Number(a.limit) || 8, 30);
    const mem = searchMemory(projectId, String(a.query ?? ''), k).map((m) => `- #${m.id} [${m.kind}] ${m.text}`);
    const kb = searchKb(projectId, String(a.query ?? ''), Math.ceil(k / 2)).map((d) => `### ${d.path}\n${d.text}`);
    return [mem.length ? `## Mémoire\n${mem.join('\n')}` : '', kb.length ? `## Docs\n${kb.join('\n\n')}` : ''].filter(Boolean).join('\n\n') || 'Aucun résultat.';
  }
  if (name === 'avity_knowledge_edit') return JSON.stringify(updateKnowledge(projectId, Number(a.id), a));
  if (name === 'avity_knowledge_history') return JSON.stringify(knowledgeHistory(projectId, Number(a.id)));
  if (name === 'avity_source_read') return readSource(projectId, String(a.path ?? '')).text;
  if (name === 'avity_memory_add') {
    const text = String(a.text ?? '').slice(0, 1000);
    return addMemory(projectId, String(a.kind ?? 'fact'), text, null) ? 'Mémorisé.' : 'Déjà connu (ou vide).';
  }
  if (name === 'avity_recent_sessions') {
    const rows = all(`SELECT title, agent, summary, updated_at FROM sessions WHERE project_id = ? AND summary IS NOT NULL ORDER BY updated_at DESC LIMIT ?`, projectId, Math.min(Number(a.limit) || 5, 20));
    return rows.map((r) => `- ${r.updated_at} [${r.agent}] ${r.title}: ${r.summary}`).join('\n') || 'Aucune session résumée.';
  }
  throw new Error(`outil inconnu: ${name}`);
}

const send = (msg: object) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');

createInterface({ input: process.stdin }).on('line', (line) => {
  let m: any;
  try { m = JSON.parse(line); } catch { return; }
  if (m.id == null) return; // notifications (initialized, cancelled) need no answer
  try {
    if (m.method === 'initialize') {
      send({ id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'avity', version: '0.1.0' } } });
    } else if (m.method === 'tools/list') {
      send({ id: m.id, result: { tools: TOOLS } });
    } else if (m.method === 'tools/call') {
      send({ id: m.id, result: { content: [{ type: 'text', text: call(m.params.name, m.params.arguments ?? {}) }] } });
    } else if (m.method === 'ping') {
      send({ id: m.id, result: {} });
    } else {
      send({ id: m.id, error: { code: -32601, message: `méthode non supportée: ${m.method}` } });
    }
  } catch (e: any) {
    send({ id: m.id, result: { isError: true, content: [{ type: 'text', text: String(e.message ?? e) }] } });
  }
});
