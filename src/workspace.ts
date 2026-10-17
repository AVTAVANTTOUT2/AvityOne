import { readdir, realpath, readFile, lstat } from 'node:fs/promises';
import { constants, openSync, fstatSync, readFileSync, writeFileSync, fsyncSync, renameSync, rmSync, closeSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { diffHunks, ident } from './worktree.ts';
import { which } from './config.ts';

const exec = promisify(execFile);
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const inside = (root: string, path: string) => path === root || path.startsWith(root + sep);

export async function workspacePath(root: string, path: string) {
  if (typeof path !== 'string' || path.includes('\0') || path.split(/[\\/]/).includes('.git')) throw fail(400, 'Chemin interdit');
  const base = await realpath(root), candidate = resolve(base, path);
  if (!inside(base, candidate)) throw fail(403, 'Chemin hors du projet');
  const actual = await realpath(candidate).catch(() => { throw fail(404, 'Fichier introuvable'); });
  if (!inside(base, actual)) throw fail(403, 'Lien hors du projet');
  if (relative(base, actual).split(sep).includes('.git')) throw fail(403, 'Métadonnées Git interdites');
  return actual;
}

export async function listFiles(root: string, path = '') {
  const base = await realpath(root), dir = await workspacePath(base, path);
  const entries = await readdir(dir, { withFileTypes: true });
  return { path, entries: entries.filter(e => !['.git', 'node_modules', '.avity'].includes(e.name)).map(e => ({ name: e.name, directory: e.isDirectory(), symlink: e.isSymbolicLink(), path: relative(base, resolve(dir, e.name)) })).sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name)) };
}

export async function readWorkspaceFile(root: string, path: string) {
  const file = await workspacePath(root, path), stat = await lstat(file);
  if (!stat.isFile() || stat.size > 1 << 20) throw fail(413, 'Seuls les fichiers texte de moins de 1 Mio sont éditables');
  const text = await readFile(file, 'utf8');
  if (text.includes('\0')) throw fail(415, 'Fichier binaire non éditable');
  return { path, text, revision: hash(text) };
}

export async function writeWorkspaceFile(root: string, path: string, text: string, revision: string) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 1 << 20) throw fail(413, 'Fichier trop volumineux');
  const file = await workspacePath(root, path);
  // Keep compare and write in one event-loop turn, so concurrent saves cannot share a revision.
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW), pending = `${file}.avity-${randomUUID()}.tmp`;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 1 << 20) throw fail(400, 'Fichier texte de moins de 1 Mio attendu');
    const current = readFileSync(fd, 'utf8');
    if (hash(current) !== revision) throw fail(409, 'Le fichier a changé : recharge-le avant de sauvegarder');
    const temp = openSync(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, stat.mode & 0o777);
    try { writeFileSync(temp, text); fsyncSync(temp); } finally { closeSync(temp); }
    if (hash(readFileSync(file, 'utf8')) !== revision) throw fail(409, 'Le fichier a changé pendant la sauvegarde');
    renameSync(pending, file);
  } finally { closeSync(fd); rmSync(pending, { force: true }); }
  return { path, text, revision: hash(text) };
}

async function git(root: string, args: string[], input?: string) {
  const result = exec('git', args, { cwd: root, timeout: 30_000, maxBuffer: 4 << 20 });
  if (input !== undefined) result.child.stdin?.end(input);
  return (await result).stdout;
}

export async function workspaceDiff(root: string, staged = false) {
  const args = ['-c', 'core.quotePath=false', 'diff', '--no-renames', '--no-ext-diff', '--no-textconv', ...(staged ? ['--cached'] : [])];
  const diff = await git(root, [...args, '--']);
  const files = (await git(root, [...args, '--name-only', '-z', '--'])).split('\0').filter(Boolean);
  const untracked = staged ? [] : (await git(root, ['-c', 'core.quotePath=false', 'ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(p => p && !p.startsWith('.avity/'));
  return { diff, files, untracked, hunks: diffHunks(diff), revision: hash(diff), staged };
}

export async function selectChange(root: string, input: { path: string; hunk?: number; action: 'accept' | 'reject'; revision: string; staged?: boolean }) {
  if (!['accept', 'reject'].includes(input.action)) throw fail(400, 'Action inconnue');
  const current = await workspaceDiff(root, !!input.staged);
  if (current.revision !== input.revision) throw fail(409, 'Le diff a changé : recharge-le');
  // A new file has no hunk to apply: accepting it stages it whole.
  if (current.untracked.includes(input.path) && input.hunk == null) {
    if (input.action !== 'accept') throw fail(400, 'Un fichier non suivi ne peut être que sélectionné');
    await git(root, ['add', '--', input.path]);
    return workspaceDiff(root);
  }
  if (!current.files.includes(input.path)) throw fail(400, 'Fichier absent du diff');
  if (input.staged && input.action === 'accept') throw fail(400, 'Modification déjà sélectionnée');
  const diff = await git(root, ['-c', 'core.quotePath=false', 'diff', '--no-renames', '--no-ext-diff', '--no-textconv', ...(input.staged ? ['--cached'] : []), '--', input.path]);
  const chunks = diff.split(/(?=^@@ )/m), header = chunks.shift()!;
  let patch = diff;
  if (input.hunk != null) {
    if (!Number.isInteger(input.hunk) || input.hunk < 0 || !chunks[input.hunk]) throw fail(400, 'Bloc inconnu');
    patch = header + chunks[input.hunk];
  }
  const flags = input.action === 'accept' ? ['--cached'] : ['--reverse', ...(input.staged ? ['--cached'] : [])];
  await git(root, ['apply', '--check', ...flags, '-'], patch);
  await git(root, ['apply', ...flags, '-'], patch);
  return workspaceDiff(root, !!input.staged);
}

const withoutCredentials = (text: string) => text.replace(/(\w+:\/\/)[^@\s/]+@/g, '$1');

export async function gitStatus(root: string) {
  if ((await git(root, ['rev-parse', '--is-inside-work-tree']).catch(() => '')).trim() !== 'true') throw fail(409, 'Ce dossier n’est pas un dépôt git');
  const optional = (args: string[]) => git(root, args).then(s => s.trim() || null, () => null);
  const branch = await optional(['branch', '--show-current']), upstream = await optional(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  const [behind, ahead] = upstream ? (await git(root, ['rev-list', '--left-right', '--count', `${upstream}...HEAD`])).trim().split(/\s+/).map(Number) : [0, 0];
  const remote = await optional(['remote', 'get-url', 'origin']);
  return { branch, head: await optional(['rev-parse', '--verify', '-q', 'HEAD']), upstream, ahead, behind, remote: remote && withoutCredentials(remote),
    clean: !(await git(root, ['status', '--porcelain'])).trim(), github: !!which('gh') };
}

export async function commitChanges(root: string, input: { message?: unknown; all?: unknown }) {
  const message = typeof input.message === 'string' ? input.message.trim() : '';
  if (!message || message.length > 10_000 || message.includes('\0')) throw fail(400, 'Message de commit requis');
  await gitStatus(root);
  if (input.all === true) await git(root, ['add', '-A', '--', '.', ':(exclude).avity']);
  if (!(await git(root, ['diff', '--cached', '--name-only'])).trim()) throw fail(409, 'Aucune modification sélectionnée à commiter');
  await git(root, [...await ident(root), 'commit', '-q', '-F', '-'], message);
  return gitStatus(root);
}

const remoteCommand = async (root: string, command: string, args: string[], timeout: number) => {
  try {
    const { stdout, stderr } = await exec(command, args, { cwd: root, timeout, maxBuffer: 4 << 20, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } });
    return withoutCredentials(`${stdout}${stderr}`.trim());
  } catch (e: any) { throw fail(502, `${command} a échoué : ${withoutCredentials(String(e.stderr || e.message)).trim().slice(0, 2000)}`); }
};

export async function pushBranch(root: string) {
  const status = await gitStatus(root);
  if (!status.branch) throw fail(409, 'HEAD détaché : crée une branche avant de pousser');
  if (!status.remote) throw fail(409, 'Aucun remote « origin » configuré');
  const output = await remoteCommand(root, 'git', ['push', '-u', 'origin', status.branch], 120_000);
  return { ...await gitStatus(root), output };
}

export async function pullRequest(root: string, input: { title?: unknown; body?: unknown }) {
  const title = typeof input.title === 'string' ? input.title.trim() : '', body = typeof input.body === 'string' ? input.body : '';
  if (!title || title.length > 300 || body.length > 60_000) throw fail(400, 'Titre de PR requis (300 caractères au plus)');
  if (!which('gh')) throw fail(409, 'GitHub CLI (gh) introuvable : installe-le puis connecte-le avec « gh auth login »');
  const status = await gitStatus(root);
  if (!status.branch || !status.upstream) throw fail(409, 'Pousse la branche avant de créer la PR');
  const output = await remoteCommand(root, 'gh', ['pr', 'create', '--head', status.branch, '--title', title, '--body', body], 60_000);
  return { url: output.match(/https:\/\/\S+/g)?.at(-1) ?? null, output };
}

export async function repositoryContext(root: string) {
  const paths = (await git(root, ['ls-files', '-z'])).split('\0').filter(Boolean);
  const sections: string[] = [], skipped: string[] = [];
  let size = 0;
  for (const path of paths) {
    if (/(^|\/)(\.env(?:\.|$)|\.git|node_modules|.*\.(?:key|pem|p12|pfx)$)/i.test(path)) { skipped.push(path); continue; }
    try {
      const file = await readWorkspaceFile(root, path);
      if (size + file.text.length > 2_000_000) { skipped.push(path); continue; }
      sections.push(`\n--- ${path} ---\n${file.text}`); size += file.text.length;
    } catch { skipped.push(path); }
  }
  return { text: sections.join('\n'), files: sections.length, skipped, complete: skipped.length === 0 };
}

type Terminal = { root: string; proc: ReturnType<typeof spawn>; output: string; offset: number; touched: number; exit: number | null; closed: boolean };
const terminals = new Map<string, Terminal>();
function terminal(id: string, root: string) {
  const t = terminals.get(id);
  if (!t || t.root !== root) throw fail(404, 'Terminal inconnu');
  return t;
}
export function openTerminal(root: string) {
  if ([...terminals.values()].filter(t => !t.closed).length >= 4) throw fail(409, 'Quatre terminaux sont déjà ouverts');
  const proc = spawn('/bin/sh', ['-i'], { cwd: root, env: { ...process.env, TERM: 'dumb' }, detached: true, stdio: 'pipe' });
  const id = randomUUID(), t: Terminal = { root, proc, output: '', offset: 0, touched: Date.now(), exit: null, closed: false };
  terminals.set(id, t);
  const append = (data: Buffer) => { t.output += data.toString('utf8'); if (t.output.length > 200_000) { const n = t.output.length - 200_000; t.output = t.output.slice(n); t.offset += n; } };
  proc.stdout!.on('data', append); proc.stderr!.on('data', append);
  proc.on('error', e => { append(Buffer.from(e.message)); t.closed = true; });
  proc.on('exit', code => { t.closed = true; t.exit = code; });
  return { id };
}
export function readTerminal(root: string, id: string, offset = 0) {
  const t = terminal(id, root);
  if (!Number.isSafeInteger(offset) || offset < 0) throw fail(400, 'Position invalide');
  return { output: t.output.slice(Math.max(0, offset - t.offset)), offset: t.offset + t.output.length, truncated: offset < t.offset, closed: t.closed, exit: t.exit };
}
export function writeTerminal(root: string, id: string, input: string) {
  const t = terminal(id, root);
  if (t.closed) throw fail(409, 'Terminal fermé');
  if (typeof input !== 'string' || input.length > 16_384) throw fail(400, 'Entrée invalide');
  t.touched = Date.now(); t.proc.stdin!.write(input); return { ok: true };
}
export function closeTerminal(root: string, id: string) {
  const t = terminal(id, root);
  t.proc.stdin?.end();
  try { if (!t.closed && t.proc.pid) process.kill(-t.proc.pid, 'SIGHUP'); } catch { /* process already exited */ }
  const kill = setTimeout(() => { try { if (t.proc.pid) process.kill(-t.proc.pid, 'SIGKILL'); } catch { /* process group already exited */ } }, 1000);
  kill.unref();
  terminals.delete(id); return { ok: true };
}
const reap = setInterval(() => { for (const [id, t] of terminals) if (Date.now() - t.touched > 600_000) closeTerminal(t.root, id); }, 30_000);
reap.unref();
export function closeTerminals(root?: string) { for (const [id, t] of terminals) if (root === undefined || t.root === root) closeTerminal(t.root, id); }
