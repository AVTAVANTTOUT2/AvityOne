// Git worktrees: one isolated checkout + branch per session, merged back into the project's current branch.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';

const exec = promisify(execFile);
export const git = async (cwd: string, ...args: string[]) => (await exec('git', args, { cwd, timeout: 120_000, maxBuffer: 20 << 20 })).stdout.trim();

export const branchOf = (sessionId: string) => `avity/${sessionId}`;

/** True when `root` is a git repository with at least one commit, i.e. something to branch from. */
export const canBranch = (root: string) => git(root, 'rev-parse', '--verify', 'HEAD').then(() => true, () => false);

export async function addWorktree(root: string, sessionId: string): Promise<string> {
  const dir = join(root, '.avity', 'worktrees', sessionId);
  // Keeps worktrees out of the project's status and indexing without touching its .gitignore.
  const exclude = join(resolve(root, await git(root, 'rev-parse', '--git-common-dir')), 'info', 'exclude');
  let cur = '';
  try { cur = readFileSync(exclude, 'utf8'); } catch { mkdirSync(dirname(exclude), { recursive: true }); }
  if (!cur.split('\n').includes('.avity/worktrees/')) appendFileSync(exclude, `${cur && !cur.endsWith('\n') ? '\n' : ''}.avity/worktrees/\n`);
  await git(root, 'worktree', 'add', dir, '-b', branchOf(sessionId));
  return dir;
}

// Agents' work is committed as AvityOne unless the machine has a git identity.
const ident = async (root: string) => ((await git(root, 'config', 'user.email').catch(() => '')) ? [] : ['-c', 'user.name=AvityOne', '-c', 'user.email=avityone@localhost']);

/** Commits whatever the agent left in the worktree, then merges its branch. On conflict the merge is aborted. */
export async function mergeWorktree(root: string, dir: string, sessionId: string, message: string): Promise<{ ok: boolean; conflicts: string[]; error?: string }> {
  const id = await ident(root);
  await git(dir, 'add', '-A');
  if (await git(dir, 'status', '--porcelain')) await git(dir, ...id, 'commit', '-qm', message);
  try {
    await git(root, ...id, 'merge', '--no-ff', '--no-edit', branchOf(sessionId));
    return { ok: true, conflicts: [] };
  } catch (e: any) {
    const conflicts = (await git(root, 'diff', '--name-only', '--diff-filter=U').catch(() => '')).split('\n').filter(Boolean);
    await git(root, 'merge', '--abort').catch(() => {});
    return { ok: false, conflicts, error: String(e.stderr || e.message).trim().slice(0, 600) };
  }
}

export async function removeWorktree(root: string, dir: string, sessionId: string) {
  await git(root, 'worktree', 'remove', '--force', dir);
  await git(root, 'branch', '-D', branchOf(sessionId));
}
