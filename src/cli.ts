// `avity` — terminal client for a running AvityOne server.
//   avity ask [-a agent] [--plan] [-p project] [-s session] "demande"
//   avity projects | avity sessions <projet> | avity memory <projet> [recherche]
//   avity search <projet> <texte> | avity export <session> > session.md
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { config } from './config.ts';
import { readFileSync } from 'node:fs';

const BASE = process.env.AVITY_URL ?? `http://127.0.0.1:${config.port}`;
const TOKEN = process.env.AVITY_TOKEN ?? config.token;

async function api(path: string, body?: object, method = body ? 'POST' : 'GET') {
  const r = await fetch(BASE + '/api' + path, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error ?? r.statusText);
  return data;
}

async function projectId(name?: string) {
  const { projects } = await api('/state');
  const p = name ? projects.find((x: any) => x.name === name) : projects[0];
  if (!p) throw new Error(`projet introuvable: ${name ?? '(aucun)'}`);
  return p.id as number;
}

async function ask(text: string, o: { agent?: string; plan?: boolean; project?: string; session?: string }) {
  const sid = o.session ?? (await api(`/projects/${await projectId(o.project)}/sessions`, {})).id;
  const events = await fetch(BASE + '/api/events', { headers: { authorization: `Bearer ${TOKEN}` } });
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const shown = new Map<number, number>(); // item id -> chars of text already printed
  await api(`/sessions/${sid}/prompt`, { text, agent: o.agent ?? 'auto', mode: o.plan ? 'plan' : undefined });
  let buf = '';
  for await (const chunk of events.body!.pipeThrough(new TextDecoderStream())) {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      if (!line.startsWith('data: ')) continue;
      const ev = JSON.parse(line.slice(6));
      if (ev.sessionId !== sid || ev.type !== 'item') continue;
      const it = ev.item;
      if (it.type === 'assistant') { process.stdout.write(it.text.slice(shown.get(it.id) ?? 0)); shown.set(it.id, it.text.length); }
      else if (shown.has(it.id)) continue;
      else if (it.type === 'user') { shown.set(it.id, 0); console.log(`\x1b[2m→ ${it.agent} (${it.mode}, ${it.reason})\x1b[0m`); }
      else if (it.type === 'tool' && it.status !== 'pending') { shown.set(it.id, 0); console.log(`\n\x1b[2m· ${it.title}\x1b[0m`); }
      else if (it.type === 'info' || it.type === 'error') { shown.set(it.id, 0); console.log(`\n\x1b[33m${it.text}\x1b[0m`); }
      else if (it.type === 'permission' && !it.resolved) {
        shown.set(it.id, 0);
        console.log(`\n\x1b[33m⚠ ${it.title}\x1b[0m\n${it.text ?? ''}`);
        it.options.forEach((op: any, k: number) => console.log(`  ${k + 1}. ${op.name}`));
        const n = Number(await rl.question('choix> ')) - 1;
        await api(`/sessions/${sid}/permission`, { permId: it.id, optionId: it.options[n]?.id ?? null });
      } else if (it.type === 'end') { console.log(`\n\x1b[2m(session ${sid})\x1b[0m`); rl.close(); process.exit(0); }
    }
  }
}

const { values: o, positionals: [cmd, ...rest] } = parseArgs({
  allowPositionals: true,
  options: { agent: { type: 'string', short: 'a' }, plan: { type: 'boolean' }, project: { type: 'string', short: 'p' }, session: { type: 'string', short: 's' },
    file: { type: 'string' }, branches: { type: 'string' }, files: { type: 'string' }, hunks: { type: 'string' }, fingerprint: { type: 'string' } },
});

try {
  if (cmd === 'ask' && rest.length) await ask(rest.join(' '), o);
  else if (cmd === 'projects') for (const p of (await api('/state')).projects) console.log(`${p.id}\t${p.name}\t${p.path}`);
  else if (cmd === 'sessions') for (const s of await api(`/projects/${await projectId(rest[0])}/sessions`)) console.log(`${s.id}\t${s.agent ?? '-'}\t${s.title ?? ''}`);
  else if (cmd === 'memory') {
    const r = await api(`/projects/${await projectId(rest[0])}/memory${rest[1] ? '?q=' + encodeURIComponent(rest.slice(1).join(' ')) : ''}`);
    for (const m of r.memory) console.log(`[${m.kind}] ${m.text}`);
    for (const d of r.docs) console.log(`📄 ${d.path}: ${d.text.slice(0, 160).replace(/\n/g, ' ')}`);
  } else if (cmd === 'search' && rest.length > 1) {
    for (const h of await api(`/projects/${await projectId(rest[0])}/search?q=${encodeURIComponent(rest.slice(1).join(' '))}`)) {
      console.log(`${h.session_id}\t${h.title ?? ''}\t${h.hits} résultat(s)\n  ${h.snippet.replace(/\s+/g, ' ').replace(/\u0002/g, '\x1b[1m').replace(/\u0003/g, '\x1b[0m')}`);
    }
  } else if (cmd === 'export' && rest[0]) process.stdout.write((await api(`/sessions/${rest[0]}/export`)).markdown);
  else if (cmd === 'plan' && rest[0]) {
    const body = o.file ? JSON.parse(readFileSync(o.file, 'utf8')) : undefined;
    console.log(JSON.stringify(await api(`/sessions/${rest[0]}/plan`, body, body ? 'PUT' : 'GET'), null, 2));
  } else if (cmd === 'retry' && rest[0]) console.log(JSON.stringify(await api(`/jobs/${Number(rest[0])}/retry`, {}), null, 2));
  else if (['execute', 'parallel', 'review', 'validate', 'conflicts', 'isolate', 'merge', 'preview', 'jobs', 'artifacts'].includes(cmd ?? '') && rest[0]) {
    const action = cmd === 'isolate' ? 'isolated' : cmd === 'preview' ? 'merge-preview' : cmd;
    const read = ['preview', 'jobs', 'artifacts'].includes(cmd!);
    const body = read ? undefined : cmd === 'merge' ? {
      branches: o.branches?.split(','), files: o.files?.split(','), hunks: o.hunks?.split(','), fingerprint: o.fingerprint,
    } : { agent: o.agent, on: true };
    console.log(JSON.stringify(await api(`/sessions/${rest[0]}/${action}`, body), null, 2));
  } else if (cmd === 'queue' && rest.length > 1) console.log(JSON.stringify(await api(`/sessions/${rest[0]}/queue`, { text: rest.slice(1).join(' '), agent: o.agent, mode: o.plan ? 'plan' : 'agent' }), null, 2));
  else console.log('usage: avity ask [-a agent] [--plan] [-p projet] [-s session] "demande" | projects | sessions [projet] | memory [projet] [recherche] | search <projet> <texte> | export <session>\n' +
    'Plans : plan <session> [--file plan.json] | execute <session> [-a agent] | parallel <session> | queue <session> "demande" | jobs <session> | retry <job> | artifacts <session>\n' +
    'Git : isolate <session> | preview <session> | validate <session> | review <session> [-a agent] | conflicts <session> | merge <session> [--branches id,id] [--files chemin,chemin] [--hunks id,id] [--fingerprint sha]');
} catch (e: any) { console.error('erreur:', e.message); process.exit(1); }
