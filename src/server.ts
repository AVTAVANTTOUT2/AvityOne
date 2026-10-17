// HTTP API + SSE event stream + static web UI. Single-user: one bearer token (cookie for the browser).
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { config, availableAgents, publicConfig, updateConfig, rotateToken, listenAddress } from './config.ts';
import { all, one, run, searchMemory, searchKb, addMemory, searchHistory } from './store.ts';
import { hub, httpError } from './hub.ts';
import { indexProject, buildPack, summarize, exportMarkdown } from './context.ts';
import { listFiles, readWorkspaceFile, writeWorkspaceFile, workspaceDiff, selectChange, gitStatus, commitChanges, pushBranch, pullRequest, repositoryContext, openTerminal, readTerminal, writeTerminal, closeTerminal, closeTerminals } from './workspace.ts';
import { addAttachment, attachmentContent, readAttachment } from './attachments.ts';
import { transcribe } from './speech.ts';
import { listProjects, updateProject, projectDocuments, listFolders } from './projects.ts';
import { listKnowledge, updateKnowledge, knowledgeHistory, restoreKnowledge, removeKnowledge, consolidateKnowledge, exportKnowledge, knowledgeGraph, readSource, sourceFile, importDocument, getContextSelection, setContextSelection } from './knowledge.ts';
import { agentCatalog, probeAgent, agentOperation, operationStatus, operationInput, nativeCommands, benchmarkAgents } from './agents.ts';
import { administration, createBackup, validateBackup, restoreBackup, configureNetwork, redact } from './admin.ts';

const WEB = fileURLToPath(new URL('../web/dist/', import.meta.url)); // built by `npm run build`
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };

const safeEq = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const tokenOf = (req: IncomingMessage) => {
  const c = /(?:^|;\s*)avity=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
  return c ? decodeURIComponent(c) : (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
};
const authed = (req: IncomingMessage) => !!config.token && safeEq(tokenOf(req), config.token);

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > 8 << 20) throw httpError(413, 'requête trop grosse'); chunks.push(c); }
  if (!chunks.length) return {};
  try { const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(); return body; } catch { throw httpError(400, 'Objet JSON attendu'); }
}

const project = (id: string) => { const p = one('SELECT * FROM projects WHERE id = ?', Number(id)); if (!p) throw httpError(404, 'projet inconnu'); return p; };
const workspace = (id: string) => { const s = one('SELECT project_id, worktree FROM sessions WHERE id = ?', id); if (!s) throw httpError(404, 'session inconnue'); return s.worktree ?? project(s.project_id).path; };
const S = '([\\w-]+)';
type Handler = (m: RegExpMatchArray, b: any, u: URL) => any;
const routes: [string, RegExp, Handler][] = [
  ['GET', /^\/api\/config$/, () => publicConfig()],
  ['PATCH', /^\/api\/config$/, (_, b) => updateConfig(b)],
  ['GET', /^\/api\/administration$/, () => administration()],
  ['GET', /^\/api\/agents$/, () => agentCatalog()],
  ['POST', /^\/api\/agents\/([\w-]+)\/probe$/, (m) => probeAgent(m[1])],
  ['GET', /^\/api\/agents\/([\w-]+)\/commands$/, (m) => nativeCommands(m[1])],
  ['POST', /^\/api\/agents\/([\w-]+)\/install$/, (m) => agentOperation(m[1], 'install')],
  ['POST', /^\/api\/agents\/([\w-]+)\/connect$/, (m) => agentOperation(m[1], 'connect')],
  ['GET', /^\/api\/agent-operations\/([\w-]+)$/, (m) => operationStatus(m[1])],
  ['POST', /^\/api\/agent-operations\/([\w-]+)\/input$/, (m, b) => operationInput(m[1], b.input)],
  ['POST', /^\/api\/benchmarks$/, (_, b) => benchmarkAgents(b)],
  ['POST', /^\/api\/backups$/, () => createBackup()],
  ['POST', /^\/api\/network$/, (_, b) => configureNetwork(b)],
  ['GET', /^\/api\/state$/, () => {
    const avail = availableAgents();
    return {
      agents: Object.entries(config.agents).map(([id, a]) => ({ id, name: a.name, strengths: a.strengths, installed: avail.includes(id) })),
      projects: listProjects({ archived: false }),
      activity: hub.activityList(),
    };
  }],
  ['POST', /^\/api\/projects$/, (_, b) => hub.createProject(b)],
  ['GET', /^\/api\/projects\/(\d+)$/, (m) => project(m[1])],
  ['GET', /^\/api\/projects$/, (_, __, u) => listProjects({ q: u.searchParams.get('q') ?? '', archived: u.searchParams.get('archived') === 'true' })],
  ['PATCH', /^\/api\/projects\/(\d+)$/, (m, b) => updateProject(Number(m[1]), b)],
  ['DELETE', /^\/api\/projects\/(\d+)$/, (m) => { const p = one('SELECT path FROM projects WHERE id = ?', Number(m[1])); const result = hub.deleteProject(Number(m[1])); closeTerminals(p!.path); return result; }],
  ['GET', /^\/api\/projects\/(\d+)\/documents$/, (m) => projectDocuments(Number(m[1]))],
  ['GET', /^\/api\/folders$/, (_, __, u) => listFolders(u.searchParams.get('path') || undefined)],
  ['POST', /^\/api\/projects\/(\d+)\/documents\/import$/, (m, b) => importDocument(Number(m[1]), b)],
  ['GET', /^\/api\/projects\/(\d+)\/source$/, (m, _, u) => readSource(Number(m[1]), u.searchParams.get('path') ?? '')],
  ['POST', /^\/api\/projects\/(\d+)\/reindex$/, (m) => indexProject(project(m[1]))],
  ['GET', /^\/api\/projects\/(\d+)\/sessions$/, (m) => hub.listSessions(Number(m[1]))],
  ['GET', /^\/api\/projects\/(\d+)\/search$/, (m, _, u) => searchHistory(Number(m[1]), u.searchParams.get('q') ?? '')],
  ['POST', /^\/api\/projects\/(\d+)\/sessions$/, (m, b) => hub.createSession(Number(m[1]), b.title, { isolated: !!b.isolated })],
  ['GET', /^\/api\/projects\/(\d+)\/memory$/, (m, _, u) => listKnowledge(Number(m[1]), u.searchParams.get('q') ?? '')],
  ['POST', /^\/api\/projects\/(\d+)\/memory$/, (m, b) => ({ added: addMemory(Number(m[1]), String(b.kind ?? 'fact'), String(b.text ?? '').slice(0, 1000)) })],
  ['DELETE', /^\/api\/memory\/(\d+)$/, (m) => { const row = one('SELECT project_id FROM memory WHERE rowid = ?', Number(m[1])); if (!row) throw httpError(404, 'Connaissance inconnue'); return removeKnowledge(row.project_id, Number(m[1])); }],
  ['PATCH', /^\/api\/projects\/(\d+)\/memory\/(\d+)$/, (m, b) => updateKnowledge(Number(m[1]), Number(m[2]), b)],
  ['DELETE', /^\/api\/projects\/(\d+)\/memory\/(\d+)$/, (m) => removeKnowledge(Number(m[1]), Number(m[2]))],
  ['GET', /^\/api\/projects\/(\d+)\/memory\/(\d+)\/history$/, (m) => knowledgeHistory(Number(m[1]), Number(m[2]))],
  ['POST', /^\/api\/projects\/(\d+)\/memory\/(\d+)\/restore$/, (m, b) => restoreKnowledge(Number(m[1]), Number(m[2]), b.versionId)],
  ['POST', /^\/api\/projects\/(\d+)\/memory\/consolidate$/, (m) => consolidateKnowledge(Number(m[1]))],
  ['GET', /^\/api\/projects\/(\d+)\/memory\/export$/, (m) => exportKnowledge(Number(m[1]))],
  ['GET', /^\/api\/projects\/(\d+)\/memory\/graph$/, (m) => knowledgeGraph(Number(m[1]))],
  ['GET', new RegExp(`^/api/sessions/${S}$`), (m) => hub.snapshot(m[1])],
  ['PATCH', new RegExp(`^/api/sessions/${S}$`), (m, b) => hub.updateSession(m[1], b)],
  ['DELETE', new RegExp(`^/api/sessions/${S}$`), (m) => hub.deleteSession(m[1])],
  ['PUT', new RegExp(`^/api/sessions/${S}/draft$`), (m, b) => hub.setDraft(m[1], String(b.text ?? ''))],
  ['GET', new RegExp(`^/api/sessions/${S}/context-selection$`), (m) => getContextSelection(m[1])],
  ['PATCH', new RegExp(`^/api/sessions/${S}/context-selection$`), (m, b) => setContextSelection(m[1], b)],
  ['GET', new RegExp(`^/api/sessions/${S}/export$`), (m) => exportMarkdown(m[1])],
  ['GET', new RegExp(`^/api/sessions/${S}/context$`), (m, _, u) => {
    const s = one('SELECT project_id, worktree FROM sessions WHERE id = ?', m[1]);
    if (!s) throw httpError(404, 'session inconnue');
    const p = project(s.project_id);
    return buildPack(p, m[1], u.searchParams.get('q') ?? '', '', s.worktree ?? p.path);
  }],
  ['POST', new RegExp(`^/api/sessions/${S}/prompt$`), async (m, b) => { const content = await attachmentContent(m[1], b.attachments); return hub.prompt(m[1], String(b.text ?? ''), { agent: b.agent, mode: b.mode, content }, { attachments: (b.attachments ?? []).map((id: string) => one('SELECT id,name,mime,size FROM attachments WHERE id = ?', id)) }); }],
  ['POST', new RegExp(`^/api/sessions/${S}/cancel$`), (m) => hub.cancel(m[1])],
  ['POST', new RegExp(`^/api/sessions/${S}/fork$`), (m, b) => hub.fork(m[1], { before: b.before == null ? undefined : Number(b.before) })],
  ['POST', new RegExp(`^/api/sessions/${S}/edit$`), (m, b) => hub.edit(m[1], Number(b.itemId), String(b.text ?? ''), { fork: !!b.fork })],
  ['POST', new RegExp(`^/api/sessions/${S}/regenerate$`), (m, b) => hub.regenerate(m[1], b.agent)],
  ['POST', new RegExp(`^/api/sessions/${S}/permission$`), (m, b) => hub.respondPermission(m[1], b.permId, b.optionId ?? null)],
  ['POST', new RegExp(`^/api/sessions/${S}/config$`), (m, b) => hub.setConfig(m[1], String(b.configId), b.value)],
  ['POST', new RegExp(`^/api/sessions/${S}/auto-approve$`), (m, b) => hub.setAutoApprove(m[1], !!b.on)],
  ['POST', new RegExp(`^/api/sessions/${S}/execute$`), (m, b) => hub.execute(m[1], b.agent)],
  ['POST', new RegExp(`^/api/sessions/${S}/isolated$`), (m, b) => hub.setIsolated(m[1], !!b.on)],
  ['POST', new RegExp(`^/api/sessions/${S}/parallel$`), (m) => hub.parallel(m[1])],
  ['POST', new RegExp(`^/api/sessions/${S}/merge$`), (m, b) => hub.merge(m[1], b)],
  ['POST', new RegExp(`^/api/sessions/${S}/review$`), (m, b) => hub.review(m[1], b.agent)],
  ['POST', new RegExp(`^/api/sessions/${S}/summarize$`), async (m) => (await summarize(m[1])) ?? { skipped: true }],
  ['GET', new RegExp(`^/api/sessions/${S}/plan$`), (m) => hub.getPlan(m[1])],
  ['PUT', new RegExp(`^/api/sessions/${S}/plan$`), (m, b) => hub.updatePlan(m[1], b)],
  ['GET', new RegExp(`^/api/sessions/${S}/jobs$`), (m) => hub.jobs(m[1])],
  ['POST', /^\/api\/jobs\/(\d+)\/retry$/, (m) => hub.retryJob(Number(m[1]))],
  ['POST', new RegExp(`^/api/sessions/${S}/queue$`), async (m, b) => hub.enqueue(m[1], String(b.text ?? ''), { agent: b.agent, mode: b.mode, content: await attachmentContent(m[1], b.attachments) }, { attachments: (b.attachments ?? []).map((id: string) => one('SELECT id,name,mime,size FROM attachments WHERE id = ?', id)) })],
  ['GET', new RegExp(`^/api/sessions/${S}/artifacts$`), (m) => hub.artifacts(m[1])],
  ['GET', new RegExp(`^/api/sessions/${S}/merge-preview$`), (m) => hub.mergePreview(m[1])],
  ['POST', new RegExp(`^/api/sessions/${S}/validate$`), (m) => hub.validate(m[1])],
  ['GET', new RegExp(`^/api/sessions/${S}/validations$`), (m) => hub.validations(m[1])],
  ['GET', new RegExp(`^/api/sessions/${S}/findings$`), (m) => hub.findings(m[1])],
  ['PATCH', new RegExp(`^/api/sessions/${S}/findings/([0-9]+)$`), (m, b) => hub.updateFinding(m[1], Number(m[2]), b)],
  ['POST', new RegExp(`^/api/sessions/${S}/conflicts$`), (m) => hub.resolveConflicts(m[1])],
  ['GET', new RegExp(`^/api/sessions/${S}/files$`), (m, _, u) => listFiles(workspace(m[1]), u.searchParams.get('path') ?? '')],
  ['GET', new RegExp(`^/api/sessions/${S}/file$`), (m, _, u) => readWorkspaceFile(workspace(m[1]), u.searchParams.get('path') ?? '')],
  ['PUT', new RegExp(`^/api/sessions/${S}/file$`), (m, b) => writeWorkspaceFile(workspace(m[1]), b.path, b.text, b.revision)],
  ['GET', new RegExp(`^/api/sessions/${S}/diff$`), (m, _, u) => workspaceDiff(workspace(m[1]), u.searchParams.get('staged') === '1')],
  ['POST', new RegExp(`^/api/sessions/${S}/changes$`), (m, b) => selectChange(workspace(m[1]), b)],
  ['GET', new RegExp(`^/api/sessions/${S}/git$`), (m) => gitStatus(workspace(m[1]))],
  ['POST', new RegExp(`^/api/sessions/${S}/commit$`), (m, b) => commitChanges(workspace(m[1]), b)],
  ['POST', new RegExp(`^/api/sessions/${S}/push$`), (m) => pushBranch(workspace(m[1]))],
  ['POST', new RegExp(`^/api/sessions/${S}/pull-request$`), (m, b) => pullRequest(workspace(m[1]), b)],
  ['GET', new RegExp(`^/api/sessions/${S}/repository-context$`), (m) => repositoryContext(workspace(m[1]))],
  ['POST', new RegExp(`^/api/sessions/${S}/terminals$`), (m) => openTerminal(workspace(m[1]))],
  ['GET', new RegExp(`^/api/sessions/${S}/terminals/${S}$`), (m, _, u) => readTerminal(workspace(m[1]), m[2], Number(u.searchParams.get('offset') ?? 0))],
  ['POST', new RegExp(`^/api/sessions/${S}/terminals/${S}$`), (m, b) => writeTerminal(workspace(m[1]), m[2], b.input)],
  ['DELETE', new RegExp(`^/api/sessions/${S}/terminals/${S}$`), (m) => closeTerminal(workspace(m[1]), m[2])],
  ['POST', new RegExp(`^/api/sessions/${S}/attachments$`), (m, b) => addAttachment(m[1], b)],
  ['POST', /^\/api\/transcribe$/, (_, b) => transcribe(b)],
];

const streams = new Set<ServerResponse>();
let maintenance = false;
let activeRequests = 0;
function sse(req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.write(': ok\n\n');
  const send = (ev: any) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  // A named event, unlike an SSE comment, reaches the page: it tells a silently dead connection from a quiet one.
  const beat = setInterval(() => res.write('event: ping\ndata: {}\n\n'), 25_000);
  hub.listeners.add(send);
  streams.add(res);
  req.on('close', () => { clearInterval(beat); hub.listeners.delete(send); streams.delete(res); });
}

async function serveStatic(u: URL, res: ServerResponse) {
  const f = normalize(join(WEB, u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname)));
  if (!f.startsWith(WEB.endsWith(sep) ? WEB : WEB + sep)) throw httpError(403, 'interdit');
  try {
    const data = await readFile(f);
    res.writeHead(200, { 'content-type': TYPES[extname(f)] ?? 'application/octet-stream', 'cache-control': u.pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' });
    res.end(data);
  } catch {
    if (u.pathname === '/') throw httpError(503, 'Interface non compilée : lance `npm run build`.');
    throw httpError(404, 'introuvable');
  }
}

const json = (res: ServerResponse, status: number, body: any) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body ?? null));
};

export const server = createServer(async (req, res) => {
  const u = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (!u.pathname.startsWith('/api/')) return await serveStatic(u, res);
    if (req.method === 'POST' && u.pathname === '/api/login') {
      const b = await readBody(req);
      if (!safeEq(String(b.token ?? ''), config.token)) { await new Promise((r) => setTimeout(r, 800)); throw httpError(401, 'token invalide'); }
      res.setHeader('set-cookie', `avity=${encodeURIComponent(config.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`);
      return json(res, 200, { ok: true });
    }
    if (!authed(req)) throw httpError(401, 'non authentifié');
    if (maintenance) throw httpError(503, 'Restauration effectuée : redémarrage du service requis');
    if (u.pathname === '/api/events') return sse(req, res);
    const source = req.method === 'GET' && u.pathname.match(/^\/api\/projects\/(\d+)\/source\/download$/);
    if (source) {
      const file = sourceFile(Number(source[1]), u.searchParams.get('path') ?? '');
      res.writeHead(200, { 'content-type': file.mime, 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' });
      return res.end(await readFile(file.absolute));
    }
    if (req.method === 'GET' && /^\/api\/attachments\/[\w-]+$/.test(u.pathname)) {
      const attachment = await readAttachment(u.pathname.split('/').at(-1)!);
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(attachment.name)}`, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' });
      return res.end(attachment.data);
    }
    // Browsers only send JSON bodies cross-site after a CORS preflight we never grant.
    if (req.method !== 'GET' && !String(req.headers['content-type'] ?? '').startsWith('application/json')) throw httpError(415, 'JSON attendu');
    if (req.method === 'POST' && u.pathname === '/api/logout') {
      res.setHeader('set-cookie', 'avity=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && u.pathname === '/api/token/rotate') {
      const token = rotateToken();
      for (const stream of streams) stream.end();
      closeTerminals();
      res.setHeader('set-cookie', `avity=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`);
      return json(res, 200, { token });
    }
    const restore = req.method === 'POST' && u.pathname.match(/^\/api\/backups\/([\w-]+)\/restore$/);
    if (restore) {
      if (activeRequests || hub.backgroundWork) throw httpError(409, 'Attends la fin des opérations en cours avant de restaurer');
      if (hub.activityList().some(a => a.busy || a.waiting)) throw httpError(409, 'Arrête les sessions actives avant de restaurer');
      validateBackup(restore[1]);
      maintenance = true;
      hub.shutdown(); closeTerminals();
      for (const stream of streams) stream.end();
      return json(res, 200, await restoreBackup(restore[1]));
    }
    for (const [method, re, h] of routes) {
      const m = req.method === method && u.pathname.match(re);
      if (m) {
        const body = req.method === 'GET' ? {} : await readBody(req);
        if (maintenance) throw httpError(503, 'Restauration effectuée : redémarrage du service requis');
        if (!authed(req)) throw httpError(401, 'non authentifié');
        activeRequests++;
        try { return json(res, 200, await h(m, body, u)); }
        finally { activeRequests--; }
      }
    }
    throw httpError(404, 'route inconnue');
  } catch (e: any) {
    const message = redact(String(e.message ?? e));
    if (!e.status) console.error(message);
    if (!res.headersSent) json(res, e.status ?? 500, { error: message });
  }
});

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!all('SELECT 1 FROM projects LIMIT 1').length) await hub.createProject({ name: 'perso' }).catch((e) => console.error('projet par défaut:', e.message));
  const { host, port } = listenAddress();
  server.listen(port, host, () => {
    console.log(`AvityOne sur http://${host}:${port} — agents installés: ${availableAgents().join(', ') || 'aucun'}`);
  });
  const stop = () => { hub.shutdown(); closeTerminals(); process.exit(0); };
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, stop);
  // The macOS app holds our stdin: its end, even after a crash, stops the engine and its agents.
  if (process.env.AVITY_EMBEDDED === '1') process.stdin.on('end', stop).on('error', stop).resume();
}
