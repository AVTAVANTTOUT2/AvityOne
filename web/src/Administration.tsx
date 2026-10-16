import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { guard, toast } from './ui';
import { ToolDialog } from './Workbench';
import { AgentCard, type ProbeState } from './AgentCard';
import { createAgentProbeRequests } from './agentProbes';

const probeRequests = createAgentProbeRequests(id => api(`/agents/${id}/probe`, {}));

type ConfigurationDraft = { text: string; saved: string };
export function receiveConfigurationDraft(draft: ConfigurationDraft | null, settings: unknown, submitted?: string): ConfigurationDraft {
  const saved = JSON.stringify(settings, null, 2);
  if (draft && draft.text !== draft.saved && draft.text !== submitted) return draft;
  return { text: saved, saved };
}

export function Administration({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState('agents'), [settings, setSettings] = useState<any>(null), [status, setStatus] = useState<any>(null), [agents, setAgents] = useState<any[]>([]), [error, setError] = useState('');
  const [draft, setDraft] = useState<ConfigurationDraft | null>(null), [saving, setSaving] = useState(false);
  const savingRef = useRef(false), configRevision = useRef(0);
  const dirty = !!draft && draft.text !== draft.saved, conflict = dirty && draft.saved !== JSON.stringify(settings, null, 2);
  const mounted = useRef(true), [probes, setProbes] = useState<Record<string, ProbeState>>(() => Object.fromEntries(probeRequests.entries().map(([id]) => [id, { busy: true }])));
  const receiveSettings = (value: any, submitted?: string) => { setSettings(value); setDraft(current => receiveConfigurationDraft(current, value, submitted)); };
  const load = async () => {
    const revision = configRevision.current;
    const [c, s, a] = await Promise.all([api('/config'), api('/administration'), api('/agents')]);
    if (revision === configRevision.current && !savingRef.current) receiveSettings(c);
    setStatus(s); setAgents(a);
  };
  const saveSettings = async (patch: unknown, submitted?: string) => {
    if (savingRef.current) throw new Error('Un enregistrement de configuration est déjà en cours.');
    savingRef.current = true; setSaving(true); configRevision.current++;
    try { receiveSettings(await api('/config', patch, 'PATCH'), submitted); }
    finally { configRevision.current++; savingRef.current = false; setSaving(false); }
  };
  const close = () => {
    if ((saving || dirty) && !confirm(saving ? 'Un enregistrement est encore en cours. Fermer l’administration ?' : 'Abandonner les modifications non enregistrées de la configuration ?')) return;
    onClose();
  };
  useEffect(() => {
    if (!dirty && !saving) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, saving]);
  const observeProbe = async (id: string, request: Promise<any>) => {
    setProbes(current => ({ ...current, [id]: { busy: true } }));
    try {
      const health = await request;
      if (!mounted.current) return;
      setAgents(current => current.map(agent => agent.id === id ? { ...agent, health, installed: health.status !== 'missing' } : agent));
      setProbes(current => ({ ...current, [id]: { busy: false } }));
    } catch (e) { if (mounted.current) setProbes(current => ({ ...current, [id]: { busy: false, error: e instanceof Error ? e.message : 'erreur réseau' } })); }
  };
  const probe = (id: string) => observeProbe(id, probeRequests.run(id));
  useEffect(() => {
    mounted.current = true;
    void probeRequests.resume(load, async (id, request) => { if (mounted.current) await observeProbe(id, request); }).catch(e => { if (mounted.current) setError(e.message); });
    return () => { mounted.current = false; };
  }, []);
  return <ToolDialog title="Administration" onClose={close}><nav className="tool-tabs" aria-label="Administration">{[['agents', 'Agents'], ['routing', 'Routage'], ['mcp', 'Serveurs MCP'], ['config', 'Configuration'], ['operations', 'Exploitation']].map(([id, label]) => <button key={id} className={`chip ${tab === id ? 'on' : ''}`} onClick={() => setTab(id)}>{label}{id === 'config' && dirty ? ' · Modifiée' : ''}</button>)}</nav>
    {error && <p role="alert">{error}</p>}{!settings ? <p>Chargement…</p> : tab === 'agents' ? <Agents agents={agents} probes={probes} probe={probe} reload={load} /> : tab === 'routing' ? <Routing settings={settings} agents={agents} save={async patch => { await saveSettings(patch); toast('Règles enregistrées.'); }} />
      : tab === 'mcp' ? <Mcp settings={settings} save={async patch => { await saveSettings(patch); toast('Serveurs enregistrés ; utilisés à la prochaine connexion d’agent.'); }} />
        : tab === 'config' ? draft && <Configuration draft={draft} saving={saving} conflict={conflict} onChange={text => setDraft({ ...draft, text })}
          onReset={() => { if (confirm('Remplacer le brouillon par la configuration enregistrée ?')) setDraft(receiveConfigurationDraft(null, settings)); }}
          onSave={async () => { if (conflict) throw new Error('La configuration a changé. Reprends la version enregistrée avant de modifier ce brouillon.'); await saveSettings(JSON.parse(draft.text), draft.text); toast('Configuration enregistrée. Hôte et port nécessitent un redémarrage.'); }} /> : <Operations status={status} reload={load} />}
  </ToolDialog>;
}

function Agents({ agents, probes, probe, reload }: { agents: any[]; probes: Record<string, ProbeState>; probe: (id: string) => Promise<void>; reload: () => Promise<void> }) {
  const [operation, setOperation] = useState<any>(null), [input, setInput] = useState(''), [result, setResult] = useState<any>(null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => { if (!operation || operation.state !== 'running') return; const timer = setInterval(() => api(`/agent-operations/${operation.id}`).then(setOperation, e => toast(e.message, true)), 1500); return () => clearInterval(timer); }, [operation?.id, operation?.state]);
  return <div className="tool-stack">{agents.map(a => <AgentCard key={a.id} agent={a} probe={probes[a.id]} now={now} operationBusy={operation?.state === 'running'} onProbe={() => { void probe(a.id); }}
    onInstall={guard(async () => { setOperation(await api(`/agents/${a.id}/install`, {})); await reload(); })} onConnect={guard(async () => setOperation(await api(`/agents/${a.id}/connect`, {})))} />)}
    <p className="muted">Les quotas non fournis par l’agent restent inconnus. Installer télécharge le CLI du catalogue ; connecter lance son parcours d’authentification.</p>
    {operation && <section className="tool-stack"><b>{operation.action} · {operation.state}</b><pre className="terminal-output">{operation.output}</pre>{operation.state === 'running' && operation.action === 'connect' && <form className="row" onSubmit={guard(async e => { e.preventDefault(); await api(`/agent-operations/${operation.id}/input`, { input: input + '\n' }); setInput(''); })}><input className="input grow" type="password" autoComplete="off" aria-label="Réponse à la connexion de l’agent" value={input} onChange={e => setInput(e.target.value)} /><button className="btn">Transmettre au CLI</button></form>}<button className="chip" onClick={guard(reload)}>Actualiser les agents</button></section>}
    <details><summary>Évaluation comparative</summary><form className="tool-stack" onSubmit={guard(async e => { e.preventDefault(); const data = new FormData(e.currentTarget); setResult(await api('/benchmarks', { agents: data.getAll('agents'), prompt: data.get('prompt'), expected: data.get('expected') })); })}>
      <p>Chaque agent reçoit la même demande dans un dossier temporaire en lecture seule. Le score vérifie la présence du résultat attendu ; ce critère ne mesure pas toute la qualité du code.</p>
      {agents.filter(a => a.installed).map(a => <label key={a.id}><input name="agents" type="checkbox" value={a.id} /> {a.name}</label>)}<label>Demande<textarea className="input" name="prompt" required /></label><label>Texte attendu<input className="input" name="expected" required /></label><button className="btn">Exécuter la comparaison</button>
    </form>{result && <pre className="ctx">{JSON.stringify(result, null, 2)}</pre>}</details>
  </div>;
}
function Routing({ settings, agents, save }: { settings: any; agents: any[]; save: (patch: any) => Promise<void> }) {
  const [rules, setRules] = useState<any[]>(settings.routes), [routing, setRouting] = useState(settings.routing);
  return <form className="tool-stack" onSubmit={guard(async e => { e.preventDefault(); await save({ routes: rules, routing }); })}>
    <label>Stratégie<select className="select" value={routing.strategy} onChange={e => setRouting({ ...routing, strategy: e.target.value })}><option value="rules">Règles</option><option value="performance">Performances mesurées</option><option value="llm">Décision par un agent LLM</option></select></label>
    {routing.strategy === 'llm' && <label>Agent chargé de router<select className="select" value={routing.agent} onChange={e => setRouting({ ...routing, agent: e.target.value })}><option value="">Sélectionner</option>{agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>}
    <label><input type="checkbox" checked={routing.fallback} onChange={e => setRouting({ ...routing, fallback: e.target.checked })} /> Bascule après un échec de connexion avant tout travail</label>
    {rules.map((rule, i) => <fieldset key={i} className="task-editor"><legend>Règle {i + 1} (première correspondance prioritaire)</legend><label>Expression de recherche<input className="input" value={rule.match} onChange={e => setRules(rules.map((r, n) => n === i ? { ...r, match: e.target.value } : r))} /></label><div className="row wrap">
      <select className="select" aria-label={`Agent de la règle ${i + 1}`} value={rule.agent} onChange={e => setRules(rules.map((r, n) => n === i ? { ...r, agent: e.target.value } : r))}>{agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
      <select className="select" aria-label={`Mode de la règle ${i + 1}`} value={rule.mode ?? ''} onChange={e => setRules(rules.map((r, n) => n === i ? { ...r, mode: e.target.value || undefined } : r))}><option value="">Automatique</option><option value="plan">Plan</option><option value="agent">Agent</option></select>
      <button type="button" className="chip" disabled={!i} onClick={() => { const r = [...rules]; [r[i - 1], r[i]] = [r[i], r[i - 1]]; setRules(r); }}>↑</button><button type="button" className="chip" onClick={() => setRules(rules.filter((_, n) => i !== n))}>Supprimer</button></div></fieldset>)}
    <div className="row"><button type="button" className="btn" onClick={() => setRules([...rules, { match: '', agent: agents[0]?.id ?? '' }])}>Ajouter une règle</button><button className="btn primary">Enregistrer</button></div>
  </form>;
}
function Mcp({ settings, save }: { settings: any; save: (patch: any) => Promise<void> }) {
  const [servers, setServers] = useState<any[]>(settings.mcpServers ?? []);
  const change = (i: number, patch: any) => setServers(servers.map((s, n) => i === n ? { ...s, ...patch } : s));
  return <form className="tool-stack" onSubmit={guard(async e => { e.preventDefault(); await save({ mcpServers: servers }); })}><p>Ajoute Serena, Context7 ou un autre serveur MCP stdio installé sur le serveur. Chaque argument occupe une ligne.</p>
    {servers.map((s, i) => <fieldset className="task-editor" key={i}><label>Nom<input className="input" value={s.name} onChange={e => change(i, { name: e.target.value })} required /></label><label>Commande<input className="input" value={s.command} onChange={e => change(i, { command: e.target.value })} required /></label><label>Arguments<textarea className="input" value={s.args.join('\n')} onChange={e => change(i, { args: e.target.value.split('\n').filter(Boolean) })} /></label><label><input type="checkbox" checked={s.enabled} onChange={e => change(i, { enabled: e.target.checked })} /> Activé</label><button className="chip" type="button" onClick={() => setServers(servers.filter((_, n) => i !== n))}>Retirer</button></fieldset>)}
    <div className="row"><button className="btn" type="button" onClick={() => setServers([...servers, { name: '', command: '', args: [], env: {}, enabled: true }])}>Ajouter un serveur MCP</button><button className="btn primary">Enregistrer</button></div>
  </form>;
}
function Configuration({ draft, saving, conflict, onChange, onSave, onReset }: { draft: ConfigurationDraft; saving: boolean; conflict: boolean; onChange: (text: string) => void; onSave: () => Promise<void>; onReset: () => void }) {
  return <form className="tool-stack" onSubmit={guard(async e => { e.preventDefault(); await onSave(); })}>
    <p>Configuration globale : agents, modèles, parallélisme, délais, budgets, commandes de validation et moteur de transcription. Les valeurs secrètes sont masquées et conservées si elles ne sont pas remplacées.</p>
    {conflict && <p role="alert">La configuration enregistrée a changé pendant cette modification. Conserve une copie de ton brouillon, puis reprends la version enregistrée pour éviter d’écraser ces changements.</p>}
    <textarea className="code-editor" aria-label="Configuration globale JSON" spellCheck={false} disabled={saving} value={draft.text} onChange={e => onChange(e.target.value)} />
    <div className="row wrap"><button className="btn primary" disabled={saving || conflict}>{saving ? 'Enregistrement…' : 'Valider et enregistrer'}</button><button className="btn" type="button" disabled={saving} onClick={onReset}>Reprendre la configuration enregistrée</button></div>
  </form>;
}
function Operations({ status, reload }: { status: any; reload: () => Promise<void> }) {
  const [token, setToken] = useState(''), [maintenance, setMaintenance] = useState(false);
  return <div className="tool-stack"><div className="row wrap"><button className="btn" onClick={guard(async () => { await api('/logout', {}); location.reload(); })}>Se déconnecter</button><button className="btn" onClick={guard(async () => { if (confirm('Révoquer tous les accès existants et générer un nouveau jeton ?')) { const r = await api('/token/rotate', {}); setToken(r.token); } })}>Renouveler le jeton et révoquer les accès</button></div>
    {token && <label>Nouveau jeton : conserve-le maintenant<input className="input" type="password" readOnly value={token} onFocus={e => e.target.select()} /><button className="chip" onClick={guard(async () => { await navigator.clipboard.writeText(token); toast('Nouveau jeton copié.'); })}>Copier le nouveau jeton</button></label>}
    <h3>Sauvegardes</h3><p>Base SQLite et pièces jointes. Les dossiers de code et la configuration contenant les accès doivent être sauvegardés séparément.</p><button className="btn" disabled={maintenance} onClick={guard(async () => { await api('/backups', {}); await reload(); })}>Créer une sauvegarde</button>
    {(status?.backups ?? []).map((b: any) => <div className="row wrap" key={b.id}><span className="grow">{b.createdAt ?? b.id}</span><button className="btn" disabled={maintenance} onClick={guard(async () => { if (!confirm('Restaurer cette sauvegarde ? Une copie de sécurité sera créée. Le service devra ensuite être redémarré.')) return; const r = await api(`/backups/${b.id}/restore`, {}); setMaintenance(r.restartRequired); toast('Restauration effectuée. Redémarre le service pour reprendre le travail.'); })}>Restaurer</button></div>)}
    {maintenance && <p role="status">Service en maintenance après restauration. Redémarrage requis.</p>}
    <h3>HTTPS et Tailscale</h3><pre className="ctx">{JSON.stringify(status?.network, null, 2)}</pre><div className="row wrap"><button className="btn" onClick={guard(async () => { await api('/network', { enabled: true }); await reload(); })}>Activer HTTPS via Tailscale</button><button className="btn" onClick={guard(async () => { if (confirm('Désactiver l’accès HTTPS Tailscale ? Cette connexion peut être coupée.')) { await api('/network', { enabled: false }); await reload(); } })}>Désactiver le service HTTPS</button></div>
    <h3>Usage et traces</h3><p>Coûts et tokens sont ceux rapportés par les agents. Une valeur absente reste inconnue.</p><button className="chip" onClick={guard(reload)}>Actualiser</button><pre className="ctx">{JSON.stringify(status?.usage, null, 2)}</pre><details><summary>Traces centralisées</summary><pre className="ctx">{JSON.stringify(status?.traces, null, 2)}</pre></details><details><summary>Historique des évaluations</summary><pre className="ctx">{JSON.stringify(status?.benchmarks, null, 2)}</pre></details>
  </div>;
}
