type Quota = {
  status: string; remaining: number | null; limit: number | null; unit: string | null;
  checkedAt: string | null; resetAt: string | null; error?: string | null; details?: string | null;
};
type Health = { status: string; authentication?: string; checkedAt?: string; error?: string; quotaSnapshot?: Quota };
type Agent = { id: string; name: string; strengths: string; installed: boolean; catalog: unknown; health?: Health };
export type ProbeState = { busy: boolean; error?: string };

export function quotaState(quota: Quota | undefined, now: number) {
  if (!quota) return 'unknown';
  const checked = Date.parse(quota.checkedAt ?? ''), reset = Date.parse(quota.resetAt ?? '');
  if (Number.isFinite(checked) && (now - checked >= 300_000 || (Number.isFinite(reset) && reset <= now))) return 'expired';
  if (!Number.isFinite(checked) || checked > now || !['available', 'exhausted'].includes(quota.status)) return 'unknown';
  return quota.status;
}

const date = (value?: string | null) => {
  const timestamp = Date.parse(value ?? '');
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString('fr-FR') : 'jamais';
};
const amount = (value: number) => value > 0 && value < 0.1 ? '< 0,1' : value.toLocaleString('fr-FR', { maximumFractionDigits: 1 });

export function AgentCard({ agent, probe, operationBusy, now, onProbe, onInstall, onConnect }: {
  agent: Agent; probe?: ProbeState; operationBusy: boolean; now: number;
  onProbe: () => void; onInstall: () => void; onConnect: () => void;
}) {
  const health = agent.health, quota = health?.quotaSnapshot, state = quotaState(quota, now);
  const measured = (state === 'available' || state === 'exhausted') && typeof quota?.remaining === 'number' && Number.isFinite(quota.remaining);
  const percentage = !!quota?.unit && /pourcent|%/i.test(quota.unit);
  const connection = !agent.installed || health?.status === 'missing' ? 'CLI non installé' : health?.authentication === 'required' ? 'Authentification requise'
    : health?.status === 'ready' ? 'Connexion vérifiée' : health?.status === 'unavailable' ? 'Connexion indisponible' : 'Connexion à vérifier';
  return <article className="card tool-stack agent-card" aria-busy={probe?.busy || undefined}>
    <div className="row wrap"><b className="grow">{agent.name}</b><span className={`tag ${health?.status === 'ready' ? 'ok' : ''}`}>{connection}</span></div>
    <p className="agent-strengths muted">{agent.strengths}</p>
    <div className="agent-quota">
      <span className={`tag ${state === 'available' ? 'ok' : state === 'exhausted' ? 'bad' : ''}`}>{state === 'expired' ? 'Quota expiré' : state === 'unknown' ? 'Quota inconnu' : state === 'exhausted' ? 'Quota épuisé' : 'Quota disponible'}</span>
      {measured && <strong className="agent-quota-value">{amount(quota!.remaining!)}{percentage ? ' % restants' : ` / ${quota!.limit == null ? '?' : amount(quota!.limit)} ${quota!.unit ?? ''} restants`}</strong>}
      {percentage && measured && <span className="muted">{quota!.unit}</span>}
      {state === 'expired' ? <p>Cette mesure n’est plus à jour. Relance la vérification pour connaître le quota actuel.</p>
        : quota?.error && <p>{quota.error}</p>}
      {!quota && <p>Aucune mesure disponible. Vérifie la connexion et le quota.</p>}
      {state !== 'expired' && quota?.details && <p className="agent-quota-details">{quota.details}</p>}
      <span className="muted">Dernière mesure du quota : {date(quota?.checkedAt)}{quota?.resetAt && <> · Remise à zéro annoncée : {date(quota.resetAt)}</>}</span>
      {health?.checkedAt && <span className="muted">Dernier contrôle de connexion : {date(health.checkedAt)}</span>}
    </div>
    {health?.error && <p className="err">{health.error}</p>}
    <div className="row wrap"><button className="chip" disabled={probe?.busy || operationBusy} onClick={onProbe}>{probe?.busy ? 'Vérification en cours…' : 'Vérifier connexion et quota'}</button>
      <button className="chip" disabled={!agent.catalog || operationBusy || probe?.busy} onClick={onInstall}>Installer</button><button className="chip" disabled={!agent.catalog || !agent.installed || operationBusy || probe?.busy} onClick={onConnect}>Connecter</button></div>
    {probe?.busy && <p className="muted" role="status">Lecture du quota et test de connexion en cours. Cela peut prendre quelques dizaines de secondes.</p>}
    {probe?.error && <p className="err" role="alert">La vérification a échoué : {probe.error}. Tu peux réessayer.</p>}
    {health && <details><summary>Détails techniques du dernier contrôle</summary><pre className="ctx">{JSON.stringify(health, null, 2)}</pre></details>}
  </article>;
}
