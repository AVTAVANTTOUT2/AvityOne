// Git worktrees: one isolated checkout + branch per session, merged back into the project's current branch.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, appendFileSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { digest } from './orchestration.ts';
import { config } from './config.ts';
import { redact } from './admin.ts';

const exec = promisify(execFile);
export const git = async (cwd: string, ...args: string[]) => (await exec('git', args, { cwd, timeout: 120_000, maxBuffer: 20 << 20 })).stdout.trim();

export const branchOf = (sessionId: string) => `avity/${sessionId}`;

/** True when `root` is a git repository with at least one commit, i.e. something to branch from. */
export const canBranch = (root: string) => git(root, 'rev-parse', '--verify', 'HEAD').then(() => true, () => false);

/**
 * Keeps AvityOne's own files (worktrees, imported documents, brief) out of the project's status and indexing without
 * touching its .gitignore. Files the project already tracks under .avity/ stay tracked.
 */
export async function ignoreAvity(root: string) {
  const exclude = join(resolve(root, await git(root, 'rev-parse', '--git-common-dir')), 'info', 'exclude');
  let cur = '';
  try { cur = readFileSync(exclude, 'utf8'); } catch { mkdirSync(dirname(exclude), { recursive: true }); }
  if (!cur.split('\n').includes('.avity/')) appendFileSync(exclude, `${cur && !cur.endsWith('\n') ? '\n' : ''}.avity/\n`);
}

export async function addWorktree(root: string, sessionId: string): Promise<string> {
  const dir = join(root, '.avity', 'worktrees', sessionId);
  await ignoreAvity(root);
  await git(root, 'worktree', 'add', dir, '-b', branchOf(sessionId));
  return dir;
}

// Agents' work is committed as AvityOne unless the machine has a git identity.
const ident = async (root: string) => ((await git(root, 'config', 'user.email').catch(() => '')) ? [] : ['-c', 'user.name=AvityOne', '-c', 'user.email=avityone@localhost']);

export async function removeWorktree(root: string, dir: string, sessionId: string) {
  await git(root, 'worktree', 'remove', '--force', dir);
  await git(root, 'branch', '-D', branchOf(sessionId));
}

export async function commitWorktree(dir: string, message: string) {
  await git(dir, 'add', '-A');
  if (await git(dir, 'diff', '--cached', '--name-only')) await git(dir, ...await ident(dir), 'commit', '-qm', message);
  return git(dir, 'rev-parse', 'HEAD');
}

/** Bounded output and a process-group timeout also stop subprocesses created by package scripts. */
export function runCommand(cwd: string, command: string, timeout = config.validationTimeoutMs, signal?: AbortSignal): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolveResult) => {
    if (signal?.aborted) return resolveResult({ ok: false, output: 'Opération annulée.' });
    const child = spawn('/bin/sh', ['-c', command], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', timedOut = false;
    const capture = (b: Buffer) => { output = (output + b.toString()).slice(-20_000); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    const kill = () => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeout);
    signal?.addEventListener('abort', kill, { once: true });
    const clean = () => { clearTimeout(timer); signal?.removeEventListener('abort', kill); };
    child.on('error', (e) => { clean(); resolveResult({ ok: false, output: redact(e.message) }); });
    child.on('close', (code) => { clean(); resolveResult({ ok: code === 0 && !timedOut && !signal?.aborted, output: redact(signal?.aborted ? output + '\nOpération annulée.' : timedOut ? output + '\nDélai dépassé.' : output) }); });
  });
}

export async function prepareWorktree(dir: string, signal?: AbortSignal) {
  const command = config.prepareCommand || (existsSync(join(dir, 'package-lock.json')) && !existsSync(join(dir, 'node_modules')) ? 'npm ci --ignore-scripts' : '');
  if (!command) return;
  const result = await runCommand(dir, command, config.validationTimeoutMs, signal);
  if (!result.ok) throw new Error(`préparation du worktree échouée : ${result.output}`);
}

export function validationCommands(dir: string): string[] {
  if (config.validationCommands.length) return config.validationCommands;
  let scripts: Record<string, string> = {};
  try { scripts = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).scripts ?? {}; }
  catch (e: any) { if (e.code !== 'ENOENT') throw new Error('package.json invalide : impossible de déterminer les validations'); }
  return ['git diff --check', ...['check', 'lint', 'test', 'build'].filter((key) => scripts[key]).map((key) => `npm run ${key}`)];
}

export type DiffHunk = { id: string; path: string; patch: string };
const decodeGitPath = (path: string): string => path.startsWith('"')
  ? JSON.parse(path.replace(/\\./g, (escape) => escape === '\\a' ? '\\u0007' : escape === '\\v' ? '\\u000b' : escape))
  : path.replace(/\t$/, '');
export function diffHunks(diff: string): DiffHunk[] {
  const result: DiffHunk[] = [];
  for (const file of diff.split(/(?=^diff --git )/m).filter(Boolean)) {
    const after = /^\+\+\+ (.+)$/m.exec(file)?.[1], before = /^--- (.+)$/m.exec(file)?.[1];
    const quoted = /^diff --git ("(?:\\.|[^"\\])*") ("(?:\\.|[^"\\])*")$/m.exec(file)?.[2];
    const raw = after && after !== '/dev/null' ? after : before;
    const path = raw ? decodeGitPath(raw).replace(/^[ab]\//, '') : quoted ? decodeGitPath(quoted).slice(2) : /^diff --git a\/(.+) b\/\1$/m.exec(file)?.[1];
    if (!path) continue;
    const at = file.indexOf('\n@@ ');
    if (at < 0) { result.push({ id: digest(file), path, patch: file }); continue; }
    const header = file.slice(0, at + 1);
    const chunks = file.slice(at + 1).split(/(?=^@@ )/m);
    // A new or deleted file needs its entire patch to preserve file lifecycle semantics.
    if (file.includes('--- /dev/null') || file.includes('+++ /dev/null')) result.push({ id: digest(file), path, patch: file });
    else for (const hunk of chunks) result.push({ id: digest(header + hunk), path, patch: header + hunk });
  }
  return result;
}

export async function worktreeDiff(root: string, dir: string) {
  const base = await git(dir, 'merge-base', 'HEAD', await git(root, 'rev-parse', 'HEAD'));
  let diff = (await exec('git', ['-c', 'core.quotePath=false', 'diff', '--binary', '--no-renames', base, '--'], { cwd: dir, maxBuffer: 20 << 20 })).stdout;
  const untracked = (await git(dir, 'ls-files', '--others', '--exclude-standard', '-z')).split('\0').filter(Boolean);
  for (const file of untracked) {
    // Refuse escaping symlinks; git can otherwise expose content outside this checkout in a preview.
    const full = resolve(dir, file);
    if (!realpathSync(full).startsWith(realpathSync(dir) + '/')) throw new Error('fichier hors du worktree');
    try { diff += (await exec('git', ['-c', 'core.quotePath=false', 'diff', '--no-index', '--binary', '--', '/dev/null', file], { cwd: dir, maxBuffer: 20 << 20 })).stdout; }
    catch (e: any) { if (e.code !== 1) throw e; diff += e.stdout; }
  }
  return diff;
}

export async function applyPatch(dir: string, patch: string) {
  await new Promise<void>((ok, fail) => {
    const child = spawn('git', ['apply', '--index', '--whitespace=nowarn', '-'], { cwd: dir, stdio: ['pipe', 'ignore', 'pipe'] });
    let error = '';
    child.stderr.on('data', (b) => { error = (error + b.toString()).slice(-2000); });
    child.on('error', fail); child.on('close', (code) => code === 0 ? ok() : fail(new Error(error || 'patch refusé')));
    child.stdin.on('error', () => {}); child.stdin.end(patch);
  });
}

export const mergeBranch = async (cwd: string, branch: string) => git(cwd, ...await ident(cwd), 'merge', '--no-ff', '--no-edit', branch);
