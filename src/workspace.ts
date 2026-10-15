import { readdir, realpath, readFile, lstat } from 'node:fs/promises';
import { constants, openSync, fstatSync, readFileSync, writeFileSync, fsyncSync, renameSync, rmSync, closeSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { diffHunks } from './worktree.ts';

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
  return { diff, files, hunks: diffHunks(diff), revision: hash(diff), staged };
}

export async function selectChange(root: string, input: { path: string; hunk?: number; action: 'accept' | 'reject'; revision: string; staged?: boolean }) {
  if (!['accept', 'reject'].includes(input.action)) throw fail(400, 'Action inconnue');
  const current = await workspaceDiff(root, !!input.staged);
  if (current.revision !== input.revision) throw fail(409, 'Le diff a changé : recharge-le');
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
