// HTTP API + SSE event stream + static web UI. Single-user: one bearer token (cookie for the browser).
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { config, availableAgents } from './config.ts';
import { all, one, run, searchMemory, searchKb, addMemory, searchHistory } from './store.ts';
import { hub, httpError } from './hub.ts';
import { indexProject, buildPack, summarize, exportMarkdown } from './context.ts';

const WEB = fileURLToPath(new URL('../web/dist/', import.meta.url)); // built by `npm run build`
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

const safeEq = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const tokenOf = (req: IncomingMessage) => {
  const c = /(?:^|;\s*)avity=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
  return c ? decodeURIComponent(c) : (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
};
const authed = (req: IncomingMessage) => !!config.token && safeEq(tokenOf(req), config.token);

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > 1 << 20) throw httpError(413, 'requête trop grosse'); chunks.push(c); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw httpError(400, 'JSON invalide'); }
}

const project = (id: string) => { const p = one('SELECT * FROM projects WHERE id = ?', Number(id)); if (!p) throw httpError(404, 'projet inconnu'); return p; };
const S = '([\\w-]+)';
type Handler = (m: RegExpMatchArray, b: any, u: URL) => any;
const routes: [string, RegExp, Handler][] = [
  ['GET', /^\/api\/state$/, () => {
    const avail = availableAgents();
    return {
      agents: Object.entries(config.agents).map(([id, a]) => ({ id, name: a.name, strengths: a.strengths, installed: avail.includes(id) })),
      projects: all('SELECT * FROM projects ORDER BY name'),
      activity: hub.activityList(),
    };
  }],
  ['POST', /^\/api\/projects$/, (_, b) => hub.createProject(b)],
  ['POST', /^\/api\/projects\/(\d+)\/reindex$/, (m) => indexProject(project(m[1]))],
  ['GET', /^\/api\/projects\/(\d+)\/sessions$/, (m) => hub.listSessions(Number(m[1]))],
  ['GET', /^\/api\/projects\/(\d+)\/search$/, (m, _, u) => searchHistory(Number(m[1]), u.searchParams.get('q') ?? '')],
  ['POST', /^\/api\/projects\/(\d+)\/sessions$/, (m, b) => hub.createSession(Number(m[1]), b.title, { isolated: !!b.isolated })],
  ['GET', /^\/api\/projects\/(\d+)\/memory$/, (m, _, u) => {
    const id = Number(m[1]), q = u.searchParams.get('q');
    const kbChunks = one('SELECT count(*) AS n FROM kb WHERE project_id = ?', id)!.n;
    return q ? { memory: searchMemory(id, q, 30), docs: searchKb(id, q, 10), kbChunks }
      : { memory: all('SELECT rowid AS id, kind, text, created_at FROM memory WHERE project_id = ? ORDER BY rowid DESC LIMIT 300', id), docs: [], kbChunks };
  }],
  ['POST', /^\/api\/projects\/(\d+)\/memory$/, (m, b) => ({ added: addMemory(Number(m[1]), String(b.kind ?? 'fact'), String(b.text ?? '').slice(0, 1000)) })],
  ['DELETE', /^\/api\/memory\/(\d+)$/, (m) => { run('DELETE FROM memory WHERE rowid = ?', Number(m[1])); return { ok: true }; }],
  ['GET', new RegExp(`^/api/sessions/${S}$`), (m) => hub.snapshot(m[1])],
  ['PATCH', new RegExp(`^/api/sessions/${S}$`), (m, b) => hub.updateSession(m[1], b)],
  ['DELETE', new RegExp(`^/api/sessions/${S}$`), (m) => hub.deleteSession(m[1])],
  ['PUT', new RegExp(`^/api/sessions/${S}/draft$`), (m, b) => hub.setDraft(m[1], String(b.text ?? ''))],
  ['GET', new RegExp(`^/api/sessions/${S}/export$`), (m) => exportMarkdown(m[1])],
  ['GET', new RegExp(`^/api/sessions/${S}/context$`), (m, _, u) => {
    const s = one('SELECT project_id, worktree FROM sessions WHERE id = ?', m[1]);
    if (!s) throw httpError(404, 'session inconnue');
    const p = project(s.project_id);
    return buildPack(p, m[1], u.searchParams.get('q') ?? '', '', s.worktree ?? p.path);
  }],
  ['POST', new RegExp(`^/api/sessions/${S}/prompt$`), (m, b) => hub.prompt(m[1], String(b.text ?? ''), { agent: b.agent, mode: b.mode })],
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
  ['POST', new RegExp(`^/api/sessions/${S}/merge$`), (m) => hub.merge(m[1])],
  ['POST', new RegExp(`^/api/sessions/${S}/review$`), (m, b) => hub.review(m[1], b.agent)],
  ['POST', new RegExp(`^/api/sessions/${S}/summarize$`), async (m) => (await summarize(m[1])) ?? { skipped: true }],
];

function sse(req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.write(': ok\n\n');
  const send = (ev: any) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  // A named event, unlike an SSE comment, reaches the page: it tells a silently dead connection from a quiet one.
  const beat = setInterval(() => res.write('event: ping\ndata: {}\n\n'), 25_000);
  hub.listeners.add(send);
  req.on('close', () => { clearInterval(beat); hub.listeners.delete(send); });
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
    if (u.pathname === '/api/events') return sse(req, res);
    // Browsers only send JSON bodies cross-site after a CORS preflight we never grant.
    if (req.method !== 'GET' && !String(req.headers['content-type'] ?? '').startsWith('application/json')) throw httpError(415, 'JSON attendu');
    for (const [method, re, h] of routes) {
      const m = req.method === method && u.pathname.match(re);
      if (m) return json(res, 200, await h(m, req.method === 'GET' ? {} : await readBody(req), u));
    }
    throw httpError(404, 'route inconnue');
  } catch (e: any) {
    if (!e.status) console.error(e);
    if (!res.headersSent) json(res, e.status ?? 500, { error: String(e.message ?? e) });
  }
});

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!all('SELECT 1 FROM projects LIMIT 1').length) await hub.createProject({ name: 'perso' }).catch((e) => console.error('projet par défaut:', e.message));
  server.listen(config.port, config.host, () => {
    console.log(`AvityOne sur http://${config.host}:${config.port} — agents installés: ${availableAgents().join(', ') || 'aucun'}`);
  });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { hub.shutdown(); process.exit(0); });
}
