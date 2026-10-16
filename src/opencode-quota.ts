import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

export type OpenCodeQuota = { status: 'unknown'; remaining: null; limit: null; reason: string; details?: string };
type ObjectValue = Record<string, any>;
const object = (value: unknown): value is ObjectValue => !!value && typeof value === 'object' && !Array.isArray(value);
const MAX_CATALOG_BYTES = 12 * 1024 * 1024;
const CATALOG_URL = 'https://models.dev/api.json';
const MODELS_URL = 'https://opencode.ai/zen/v1/models';
const DOC_URL = 'https://opencode.ai/docs/zen/';
const unknown = (reason: string, details?: string): OpenCodeQuota => ({ status: 'unknown', remaining: null, limit: null, reason, ...(details ? { details } : {}) });
class Unverified extends Error {}

function readJson(file: string, maxBytes = 64 * 1024): ObjectValue {
  if (statSync(file).size > maxBytes) throw new Unverified('Métadonnées OpenCode trop volumineuses.');
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!object(value)) throw new Unverified('Métadonnées OpenCode invalides.');
  return value;
}

// Only this anonymous, global configuration can be reproduced without copying secrets or executing user plugins.
function anonymousContext(env: NodeJS.ProcessEnv) {
  const home = env.HOME || homedir();
  const config = join(env.XDG_CONFIG_HOME || join(home, '.config'), 'opencode');
  const data = join(env.XDG_DATA_HOME || join(home, '.local/share'), 'opencode');
  const state = join(env.XDG_STATE_HOME || join(home, '.local/state'), 'opencode');
  const cache = join(env.XDG_CACHE_HOME || join(home, '.cache'), 'opencode/models.json');
  const managed = ['/etc/opencode', '/Library/Application Support/opencode', '/Library/Managed Preferences/ai.opencode.managed.plist', join('/Library/Managed Preferences', userInfo().username, 'ai.opencode.managed.plist'), join(home, '.opencode')];
  if (process.platform === 'win32' || managed.some((path) => existsSync(path))) throw new Unverified('Configuration OpenCode gérée ou supplémentaire : modèle global non vérifiable.');
  const files = ['config.json', 'opencode.json', 'opencode.jsonc'];
  const generated = ['.gitignore', 'package.json', 'package-lock.json', 'bun.lock', 'bun.lockb', 'node_modules'];
  if (existsSync(config) && readdirSync(config).some((file) => !files.includes(file) && !generated.includes(file))) throw new Unverified('Configuration ou extensions OpenCode supplémentaires : modèle global non vérifiable.');
  if (existsSync(join(config, 'package.json'))) {
    const pkg = readJson(join(config, 'package.json'));
    if (Object.keys(pkg).some((key) => key !== 'dependencies') || !object(pkg.dependencies) || Object.keys(pkg.dependencies).some((key) => key !== '@opencode-ai/plugin') || typeof pkg.dependencies['@opencode-ai/plugin'] !== 'string' || !/^\d+\.\d+\.\d+$/.test(pkg.dependencies['@opencode-ai/plugin'])) throw new Unverified('Extensions OpenCode personnalisées : modèle global non vérifiable.');
  }
  let settings: ObjectValue = {};
  for (const file of files) {
    if (!existsSync(join(config, file))) continue;
    const value = readJson(join(config, file));
    if (Object.keys(value).some((key) => !['$schema', 'model'].includes(key)) || (value.model !== undefined && (typeof value.model !== 'string' || !/^opencode\/[a-zA-Z0-9_.-]{1,120}$/.test(value.model)))) throw new Unverified('Configuration OpenCode personnalisée : fournisseur et quota à vérifier séparément.');
    settings = { ...settings, ...value };
  }
  if (existsSync(join(state, 'model.json'))) {
    const recent = readJson(join(state, 'model.json')).recent;
    if (!Array.isArray(recent) || recent.length) throw new Unverified('Sélection récente OpenCode présente : modèle de session non vérifiable par la source globale.');
  }
  if (existsSync(join(data, 'auth.json')) && Object.keys(readJson(join(data, 'auth.json'))).length) throw new Unverified('Connexion OpenCode présente : solde du fournisseur non exposé par cette source.');
  const dbPath = join(data, 'opencode.db');
  if (existsSync(dbPath)) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      for (const table of ['credential', 'account', 'account_state']) if (db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) throw new Unverified('Connexion OpenCode présente : solde du fournisseur non exposé par cette source.');
    } finally { db.close(); }
  }
  const catalog = readJson(cache, MAX_CATALOG_BYTES);
  const providerEnv = Object.values(catalog).flatMap((provider) => object(provider) && Array.isArray(provider.env) ? provider.env.filter((key: unknown) => typeof key === 'string') : []);
  if (providerEnv.some((key) => env[key]) || Object.keys(env).some((key) => env[key] && /^(OPENCODE_|AWS_|GOOGLE_|GCP_|GCLOUD_|VERTEX_|AICORE_|CLOUDFLARE_|GITLAB_)/.test(key))) throw new Unverified('Environnement fournisseur OpenCode personnalisé : accès anonyme non vérifiable.');
  return { settings: { $schema: 'https://opencode.ai/config.json', ...(settings.model ? { model: settings.model } : {}) }, catalog };
}

async function jsonResponse(response: Response, maxBytes: number): Promise<ObjectValue> {
  if (!response.ok || !response.body) throw new Unverified('Source OpenCode indisponible : réessayer la vérification.');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxBytes) throw new Unverified('Réponse OpenCode trop volumineuse.');
      chunks.push(part.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!object(value)) throw new Unverified('Réponse OpenCode invalide.');
  return value;
}

function stop(child: ChildProcess) {
  try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { child.kill('SIGKILL'); }
}

/** No prompt, billing request or credential transmission. The local server and all writes live in a disposable HOME. */
export async function readOpenCodeQuota(options: { cmd?: string; args?: string[]; env?: NodeJS.ProcessEnv; timeoutMs?: number; fetcher?: typeof fetch } = {}): Promise<OpenCodeQuota> {
  const env = options.env ?? process.env;
  let directory: string | undefined, child: ChildProcess | undefined, closed: Promise<void> | undefined;
  const controller = new AbortController();
  const runnerTimeout = Number(env.AVITY_QUOTA_TIMEOUT_MS);
  const timeout = Number.isInteger(runnerTimeout) && runnerTimeout >= 1000 && runnerTimeout <= 30_000 ? Math.min(options.timeoutMs ?? 18_000, Math.max(100, runnerTimeout - 500)) : options.timeoutMs ?? 18_000;
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const context = anonymousContext(env);
    directory = mkdtempSync(join(tmpdir(), 'avity-opencode-quota-'));
    const childEnv: NodeJS.ProcessEnv = { PATH: env.PATH, SystemRoot: env.SystemRoot, LANG: 'C.UTF-8', HOME: directory, USERPROFILE: directory, OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_MODELS_FETCH: 'true' };
    for (const [key, name] of [['XDG_CONFIG_HOME', 'config'], ['XDG_DATA_HOME', 'data'], ['XDG_STATE_HOME', 'state'], ['XDG_CACHE_HOME', 'cache']]) {
      childEnv[key!] = join(directory, name!);
      mkdirSync(join(directory, name!, 'opencode'), { recursive: true });
    }
    writeFileSync(join(directory, 'config/opencode/opencode.json'), JSON.stringify(context.settings));
    writeFileSync(join(directory, 'cache/opencode/models.json'), JSON.stringify(context.catalog));
    child = spawn(options.cmd ?? 'opencode', [...(options.args ?? []), 'serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: directory, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    closed = new Promise<void>((resolve) => child!.once('close', () => resolve()));
    const local = new Promise<string>((resolve, reject) => {
      let output = '', bytes = 0;
      const fail = () => reject(new Unverified('CLI OpenCode indisponible ou vérification expirée.'));
      controller.signal.addEventListener('abort', fail, { once: true });
      child!.once('error', fail); child!.once('close', fail);
      const receive = (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > 64 * 1024) return fail();
        output += chunk.toString();
        const match = output.match(/http:\/\/127\.0\.0\.1:(\d{1,5})(?:\s|$)/);
        if (match && Number(match[1]) > 0 && Number(match[1]) <= 65535) resolve(`http://127.0.0.1:${match[1]}`);
      };
      child!.stdout!.on('data', receive); child!.stderr!.on('data', receive);
    });
    const request = { signal: controller.signal, redirect: 'error' as const };
    const providerPromise = local.then(async (url) => Promise.all([
      fetch(`${url}/provider`, request).then((r) => jsonResponse(r, MAX_CATALOG_BYTES)),
      fetch(`${url}/global/health`, request).then((r) => jsonResponse(r, 4096)),
    ]));
    const [catalog, listed, [providers, health]] = await Promise.all([
      (options.fetcher ?? fetch)(CATALOG_URL, request).then((r) => jsonResponse(r, MAX_CATALOG_BYTES)),
      (options.fetcher ?? fetch)(MODELS_URL, request).then((r) => jsonResponse(r, 1024 * 1024)),
      providerPromise,
    ]);
    if (JSON.stringify(context) !== JSON.stringify(anonymousContext(env))) throw new Unverified('Configuration OpenCode modifiée pendant la vérification : relancer.');
    if (health.healthy !== true || typeof health.version !== 'string' || !/^[a-zA-Z0-9.+-]{1,40}$/.test(health.version) || !Array.isArray(providers.connected) || providers.connected.length !== 1 || providers.connected[0] !== 'opencode') throw new Unverified('Fournisseur OpenCode natif non vérifiable en accès anonyme.');
    const model = context.settings.model?.slice('opencode/'.length) ?? providers.default?.opencode;
    const native = Array.isArray(providers.all) ? providers.all.find((item: any) => item?.id === 'opencode')?.models?.[model] : undefined;
    const current = catalog.opencode?.models?.[model];
    if (typeof model !== 'string' || !/^[a-zA-Z0-9_.-]{1,120}$/.test(model) || !object(native) || !object(current) || !Array.isArray(listed.data) || !listed.data.some((item: any) => item?.id === model)) throw new Unverified('Modèle OpenCode absent du catalogue officiel courant.');
    const free = object(native.cost) && native.cost.input === 0 && native.cost.output === 0 && native.cost.cache?.read === 0 && native.cost.cache?.write === 0 && Object.keys(native.cost).every((key) => ['input', 'output', 'cache'].includes(key)) && object(current.cost) && current.cost.input === 0 && current.cost.output === 0 && Object.values(current.cost).every((cost) => cost === 0);
    const details = `OpenCode ${health.version}, modèle global ${context.settings.model ? 'configuré' : 'par défaut'} opencode/${model}. ${free ? 'CLI sans compte, tarif catalogue nul vérifié ; cela ne garantit aucun volume gratuit. Limites IP possibles.' : 'Tarification gratuite non confirmée ; aucun solde vérifiable.'} Les choix des projets et sessions peuvent différer. Sources : ${CATALOG_URL} ; ${MODELS_URL} ; ${DOC_URL}`;
    return unknown('Plafond et solde non publiés par OpenCode.', details);
  } catch (error) {
    return unknown(error instanceof Unverified ? error.message : controller.signal.aborted ? 'Vérification OpenCode expirée.' : 'Source OpenCode non vérifiable : configuration, connexion ou réponse indisponible.');
  } finally {
    clearTimeout(timer); controller.abort();
    if (child) { stop(child); await closed; }
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await readOpenCodeQuota().catch(() => unknown('Vérification OpenCode interrompue.'));
  process.stdout.write(JSON.stringify(result) + '\n');
}
