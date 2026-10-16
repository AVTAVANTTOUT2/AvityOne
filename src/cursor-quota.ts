/** Cursor native DashboardService reads; no billing mutation or credential refresh. */
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type CursorQuota = {
  status: 'available' | 'exhausted' | 'unknown'; remaining: number | null; limit: number | null;
  unit: string | null; resetAt?: string; reason?: string; details?: string;
};
export type CursorReadings = { usage?: unknown; plan?: unknown; credits?: unknown; onDemand?: unknown; policy?: unknown; weekly?: unknown };
const MAX_BYTES = 64 * 1024;
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
class InvalidQuota extends Error {}
function invalid(reason: string): never { throw new InvalidQuota(reason); }
function percent(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) return invalid('Pourcentage de quota Cursor absent ou invalide.');
  return 100 - value;
}
function integer(value: unknown): number {
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) value = Number(value);
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return invalid('Montant ou date Cursor invalide.');
  return value;
}
function flag(value: unknown): boolean {
  if (value === undefined) return false; // Non-optional proto3 booleans omit their false default in JSON.
  if (typeof value !== 'boolean') return invalid('Indicateur Cursor invalide.');
  return value;
}
function date(value: unknown, now: number): string {
  const timestamp = integer(value);
  if (timestamp <= now || timestamp > 8.64e15) return invalid('Date de remise à zéro Cursor absente ou périmée.');
  return new Date(timestamp).toISOString();
}
function unknown(reason: string, details: string[]): CursorQuota {
  return { status: 'unknown', remaining: null, limit: null, unit: null, reason, ...(details.length ? { details: details.join(' ').slice(0, 1000) } : {}) };
}
const shown = (value: number) => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 6 }).format(value);

export function normalizeCursorQuota(readings: CursorReadings, now = Date.now()): CursorQuota {
  const details: string[] = [];
  let resetAt: string | undefined;
  try {
    if (!object(readings.plan) || !object(readings.plan.planInfo)) return unknown('Période et type de forfait Cursor indisponibles.', details);
    const plan = readings.plan.planInfo;
    const weekly = flag(readings.plan.isMerged) || plan.includedUsagePeriod === 'INCLUDED_USAGE_PERIOD_WEEKLY';
    let remaining: number, allEmpty: boolean, prepaid: number | undefined;
    if (weekly) {
      const snapshot = readings.weekly;
      if (!object(snapshot)) return unknown('Pool hebdomadaire Cursor indisponible.', details);
      remaining = percent(snapshot.usagePercent);
      resetAt = date(snapshot.currentPeriodEndMs, now);
      allEmpty = remaining === 0;
      details.push(`Pool hebdomadaire partagé : ${shown(remaining)} % restants. Réinitialisation : ${resetAt}.`);
      if (flag(snapshot.prepaidBalanceWithheld)) details.push('Solde prépayé masqué par le fournisseur.');
      else if (snapshot.prepaidBalanceCents !== undefined) {
        prepaid = integer(snapshot.prepaidBalanceCents);
        details.push(`Crédit prépayé : ${prepaid} centimes USD.`);
      } else details.push('Solde prépayé non fourni.');
    } else {
      if (plan.includedUsagePeriod !== 'INCLUDED_USAGE_PERIOD_MONTHLY') return unknown('Période de quota Cursor non reconnue.', details);
      const usage = readings.usage;
      if (!object(usage) || usage.enabled !== true || !object(usage.planUsage)) return unknown('Mesure du forfait Cursor indisponible.', details);
      const pools = usage.planUsage;
      resetAt = date(usage.billingCycleEnd, now);
      const auto = percent(pools.autoPercentUsed), api = percent(pools.apiPercentUsed);
      details.push(`Pool modèles Cursor : ${shown(auto)} % restants. Pool autres modèles : ${shown(api)} % restants. Réinitialisation mensuelle : ${resetAt}.`);
      remaining = percent(pools.totalPercentUsed);
      allEmpty = auto === 0 && api === 0;
      if ((remaining === 0) !== allEmpty) return unknown('Le total natif Cursor et les pools sont incohérents : aucun blocage automatique.', details);
    }
    let onDemand: boolean | undefined, creditBalance: number | undefined;
    if (object(readings.onDemand)) {
      onDemand = flag(readings.onDemand.usageBasedPremiumRequests);
      details.push(`Usage à la demande : ${onDemand ? 'activé' : 'désactivé'}.`);
      if (onDemand) {
        const spending = object(readings.usage) && object(readings.usage.spendLimitUsage) ? readings.usage.spendLimitUsage : undefined;
        if (spending?.overallLimit !== undefined) details.push(`Plafond supplémentaire : ${integer(spending.overallLimit)} centimes USD ; reste ${integer(spending.overallRemaining ?? 0)} centimes USD.`);
        else details.push('Plafond supplémentaire non fourni ; aucun accès illimité déduit.');
      }
    } else details.push('Usage à la demande : état inconnu.');
    if (object(readings.credits)) {
      const hasGrants = flag(readings.credits.hasCreditGrants);
      creditBalance = integer(readings.credits.creditBalanceCents ?? 0);
      if (!hasGrants && creditBalance !== 0) return unknown('Solde de crédits Cursor incohérent.', details);
      details.push(`Crédits accordés disponibles : ${creditBalance} centimes USD.`);
    } else details.push('Solde des crédits accordés : inconnu.');
    const policy = object(readings.policy) ? readings.policy : undefined;
    if (!policy) details.push('Restrictions actuelles du fournisseur : inconnues.');
    const stage = policy?.stage ?? 'LIMIT_HIT_STAGE_UNSPECIFIED';
    const hardBlocked = stage === 'LIMIT_HIT_STAGE_HARD_BLOCK' || stage === 3;
    const slow = policy ? flag(policy.isInSlowPool) || ['LIMIT_HIT_STAGE_SLOW_POOL', 'LIMIT_HIT_STAGE_AUTO_SWITCH', 1, 2].includes(stage) : false;
    const alternatives = policy && ['allowedModelIds', 'allowedModelTags', 'allowedModelSelections'].some(key => {
      if (policy[key] === undefined) return false;
      if (!Array.isArray(policy[key])) return invalid('Restrictions Cursor invalides.');
      return policy[key].length > 0;
    });
    if (slow || alternatives) details.push('Le fournisseur prévoit un mode lent ou des modèles de remplacement.');
    if (hardBlocked) details.push('Le fournisseur signale un blocage strict.');
    if (remaining > 0) {
      if (hardBlocked) return unknown('Quota inclus restant mais blocage fournisseur : vérifier les restrictions du compte.', details);
      return { status: 'available', remaining, limit: 100, unit: weekly ? 'pourcentage restant (pool Cursor hebdomadaire)' : 'pourcentage restant (total natif Cursor)', resetAt, details: details.join(' ').slice(0, 1000) };
    }
    // One exhausted pool must never stop the entire agent; paid or slow alternatives may remain.
    if (!allEmpty || onDemand !== false || creditBalance !== 0 || (weekly && prepaid !== 0) || !hardBlocked || slow || alternatives) {
      return unknown('Forfait inclus épuisé ; disponibilité globale non confirmée (crédits, paiement ou restrictions fournisseur).', details);
    }
    return { status: 'exhausted', remaining: 0, limit: 100, unit: 'pourcentage restant (quota global Cursor)', resetAt, details: details.join(' ').slice(0, 1000) };
  } catch (e) { return unknown(e instanceof InvalidQuota ? e.message : 'Réponse de quota Cursor invalide.', details); }
}

function authPath(): string {
  if (process.platform === 'darwin') return join(homedir(), '.cursor', 'auth.json');
  if (process.platform === 'win32') return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Cursor', 'auth.json');
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'cursor', 'auth.json');
}

export async function readCursorQuota(options: { credentialsPath?: string; fetcher?: typeof fetch; timeoutMs?: number } = {}): Promise<CursorQuota> {
  let token: string;
  try {
    const path = options.credentialsPath ?? authPath();
    if (statSync(path).size > MAX_BYTES) return unknown('Fichier de connexion Cursor trop volumineux.', []);
    const auth = JSON.parse(readFileSync(path, 'utf8'));
    if (!object(auth) || typeof auth.accessToken !== 'string' || !auth.accessToken || auth.accessToken.length > 16000 || /[\s\x00-\x1f]/.test(auth.accessToken)) return unknown('Connexion Cursor absente ou invalide.', []);
    token = auth.accessToken;
  } catch { return unknown('Connexion Cursor absente ou illisible : connecter le CLI.', []); }
  const signal = AbortSignal.timeout(options.timeoutMs ?? 4200);
  let failure: string | undefined;
  const read = async (method: string): Promise<unknown> => {
    try {
      const response = await (options.fetcher ?? fetch)(`https://api2.cursor.sh/aiserver.v1.DashboardService/${method}`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'connect-protocol-version': '1' }, body: '{}', redirect: 'error', signal,
      });
      if (!response.ok) {
        failure = response.status === 401 || response.status === 403 ? 'Connexion Cursor refusée : reconnecter le CLI.' : response.status === 429 ? 'Source Cursor temporairement limitée : réessayer plus tard.' : 'Source de quota Cursor indisponible.';
        await response.body?.cancel(); return undefined;
      }
      if (!response.body) return undefined;
      const reader = response.body.getReader(), chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > MAX_BYTES) return undefined;
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { failure ??= 'Lecture du quota Cursor impossible ou expirée.'; return undefined; }
  };
  const [usage, plan, credits, onDemand] = await Promise.all(['GetCurrentPeriodUsage', 'GetPlanInfo', 'GetCreditGrantsBalance', 'GetUsageBasedPremiumRequests'].map(read));
  const merged = object(plan) && (plan.isMerged === true || plan.planInfo?.includedUsagePeriod === 'INCLUDED_USAGE_PERIOD_WEEKLY');
  const [policy, weekly] = await Promise.all([read('GetUsageLimitPolicyStatus'), merged ? read('GetXaiUserUsageSnapshot') : Promise.resolve(undefined)]);
  const result = normalizeCursorQuota({ usage, plan, credits, onDemand, policy, weekly });
  if (result.status === 'unknown' && failure) result.reason = failure;
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await readCursorQuota().catch(() => unknown('Source de quota Cursor indisponible.', []));
  process.stdout.write(JSON.stringify(result) + '\n');
}
