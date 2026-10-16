/** Read-only provider quota sources. This CLI never prints provider responses or credentials. */
import { spawn } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type ProviderQuota = { remaining: number; limit: number; unit: string; resetAt?: string };
type Window = { used: unknown; reset: unknown; name: string };
const MAX_BYTES = 64 * 1024;
const TIMEOUT_MS = 4200;
class Unavailable extends Error {}
const unavailable = (reason: string): never => { throw new Unavailable(reason); };
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);

function quota(windows: Window[], extraCredits: boolean, now: number): ProviderQuota {
  if (!windows.length) return unavailable('Le fournisseur ne retourne aucune fenêtre de quota.');
  const values = windows.map(({ used, reset, name }) => {
    if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100) return unavailable('Pourcentage de quota invalide.');
    const resetMs = reset == null ? undefined : typeof reset === 'number' ? reset * 1000 : typeof reset === 'string' ? Date.parse(reset) : NaN;
    if (resetMs !== undefined && (!Number.isFinite(resetMs) || resetMs <= now || resetMs > 8.64e15)) return unavailable('Date de remise à zéro absente ou périmée dans la mesure du fournisseur.');
    return { remaining: 100 - used, limit: 100, unit: `pourcentage restant (${name})`, ...(resetMs === undefined ? {} : { resetAt: new Date(resetMs).toISOString() }) };
  });
  // Both windows apply. On a tie, the later reset avoids releasing an exhausted quota too soon.
  values.sort((a, b) => a.remaining - b.remaining || Date.parse(b.resetAt ?? '') - Date.parse(a.resetAt ?? ''));
  const result = values[0];
  if (result.remaining === 0 && extraCredits) return unavailable('Forfait épuisé, mais des crédits supplémentaires peuvent rester disponibles.');
  return result;
}

export function normalizeCodexQuota(value: unknown, limitId = 'codex', now = Date.now()): ProviderQuota {
  if (!object(value)) return unavailable('Réponse Codex invalide.');
  const bucket = value.rateLimitsByLimitId == null ? value.rateLimits : object(value.rateLimitsByLimitId) ? value.rateLimitsByLimitId[limitId] : undefined;
  if (!object(bucket) || (bucket.limitId != null && bucket.limitId !== limitId)) return unavailable('Quota Codex demandé absent.');
  if (bucket.rateLimitReachedType && bucket.rateLimitReachedType !== 'rate_limit_reached') return unavailable('Limite de crédits du compte : solde non fourni par la fenêtre de quota.');
  const windows: Window[] = [];
  for (const key of ['primary', 'secondary']) {
    const w = bucket[key];
    if (w == null) continue;
    if (!object(w)) return unavailable('Fenêtre Codex invalide.');
    const minutes = w.windowDurationMins;
    if (minutes != null && (!Number.isInteger(minutes) || minutes <= 0 || minutes > 525600)) return unavailable('Durée de fenêtre Codex invalide.');
    windows.push({ used: w.usedPercent, reset: w.resetsAt, name: minutes == null ? `Codex ${key}` : `Codex ${minutes} min` });
  }
  return quota(windows, bucket.credits?.hasCredits === true || bucket.credits?.unlimited === true, now);
}

export function readCodexQuota(options: { cmd?: string; args?: string[]; env?: NodeJS.ProcessEnv; timeoutMs?: number; limitId?: string } = {}): Promise<ProviderQuota> {
  return new Promise((resolveQuota, reject) => {
    const child = spawn(options.cmd ?? 'codex', options.args ?? ['app-server'], { cwd: tmpdir(), env: options.env ?? process.env, stdio: ['pipe', 'pipe', 'ignore'], detached: process.platform !== 'win32' });
    let buffer = '', bytes = 0, settled = false, initialized = false;
    const finish = (error?: Error, result?: ProviderQuota) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      // npm's CLI wrapper may spawn a native process; terminate the entire private group.
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { child.kill('SIGKILL'); }
      if (error) reject(error); else resolveQuota(result!);
    };
    const timer = setTimeout(() => finish(new Unavailable('Lecture du quota Codex expirée.')), options.timeoutMs ?? TIMEOUT_MS);
    const send = (message: unknown) => child.stdin.write(JSON.stringify(message) + '\n');
    child.on('error', () => finish(new Unavailable('CLI Codex indisponible.')));
    child.stdin.on('error', () => finish(new Unavailable('Connexion au CLI Codex interrompue.')));
    child.on('close', () => finish(new Unavailable('CLI Codex arrêté sans mesure de quota.')));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_BYTES) return finish(new Unavailable('Réponse Codex trop volumineuse.'));
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf('\n')) !== -1 && !settled) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          if (message.id === 1 && !initialized) {
            if (message.error || !object(message.result)) return finish(new Unavailable('Initialisation Codex refusée.'));
            initialized = true;
            send({ method: 'initialized', params: {} });
            send({ id: 2, method: 'account/rateLimits/read' });
          } else if (message.id === 2 && initialized) {
            if (message.error) return finish(new Unavailable('Quota Codex indisponible : vérifier la connexion ChatGPT du CLI.'));
            finish(undefined, normalizeCodexQuota(message.result, options.limitId));
          }
        } catch (e) { finish(e instanceof Unavailable ? e : new Unavailable('Réponse Codex invalide.')); }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'avityone_quota', title: 'AvityOne quotas', version: '0.2.0' } } });
  });
}

export function normalizeClaudeQuota(value: unknown, model = 'all', now = Date.now()): ProviderQuota {
  if (!object(value) || !['all', 'sonnet', 'opus'].includes(model)) return unavailable('Réponse ou famille de modèle Claude invalide.');
  const keys = ['five_hour', 'seven_day', ...(model === 'all' ? [] : [`seven_day_${model}`])];
  const names: Record<string, string> = { five_hour: 'Claude 5 h', seven_day: 'Claude 7 jours', seven_day_sonnet: 'Claude Sonnet 7 jours', seven_day_opus: 'Claude Opus 7 jours' };
  const windows: Window[] = [];
  for (const key of keys) {
    const w = value[key];
    if (w == null) continue;
    if (!object(w)) return unavailable('Fenêtre Claude invalide.');
    windows.push({ used: w.utilization, reset: w.resets_at, name: names[key] });
  }
  return quota(windows, value.extra_usage?.is_enabled === true, now);
}

export async function readClaudeQuota(options: { credentialsPath?: string; fetcher?: typeof fetch; timeoutMs?: number; model?: string } = {}): Promise<ProviderQuota> {
  let token: string;
  try {
    const file = options.credentialsPath ?? join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), '.credentials.json');
    if (statSync(file).size > MAX_BYTES) return unavailable('Fichier de connexion Claude invalide.');
    const auth = JSON.parse(readFileSync(file, 'utf8')).claudeAiOauth;
    if (!object(auth) || typeof auth.accessToken !== 'string' || !auth.accessToken || auth.accessToken.length > 16000 || /[\s\x00-\x1f]/.test(auth.accessToken)) return unavailable('Connexion Claude absente ou invalide.');
    if (typeof auth.expiresAt === 'number' && auth.expiresAt <= Date.now()) return unavailable('Connexion Claude expirée : reconnecter le CLI.');
    token = auth.accessToken;
  } catch (e) { return unavailable(e instanceof Unavailable ? e.message : 'Connexion Claude absente ou illisible.'); }
  try {
    const response = await (options.fetcher ?? fetch)('https://api.anthropic.com/api/oauth/usage', {
      headers: { authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' }, redirect: 'error', signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
    });
    if (!response.ok) return unavailable(response.status === 401 || response.status === 403 ? 'Connexion Claude refusée : reconnecter le CLI.' : response.status === 429 ? 'Source de quota Claude temporairement limitée : réessayer plus tard.' : 'Source de quota Claude indisponible.');
    if (!response.body) return unavailable('Réponse Claude vide.');
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_BYTES) return unavailable('Réponse Claude trop volumineuse.');
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    return normalizeClaudeQuota(JSON.parse(Buffer.concat(chunks).toString('utf8')), options.model);
  } catch (e) { return unavailable(e instanceof Unavailable ? e.message : 'Lecture du quota Claude impossible ou expirée.'); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [provider, selector] = process.argv.slice(2);
    const result = provider === 'codex' ? await readCodexQuota({ limitId: selector })
      : provider === 'claude' ? await readClaudeQuota({ model: selector })
      : unavailable('Source de quota non prise en charge : utiliser codex ou claude.');
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (e) {
    process.stderr.write(JSON.stringify({ status: 'unknown', error: e instanceof Unavailable ? e.message : 'Source de quota indisponible.' }) + '\n');
    process.exitCode = 1;
  }
}
