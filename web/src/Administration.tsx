import { useEffect, useState } from 'react';
import { api } from './api';
import { guard, toast } from './ui';
import { ToolDialog } from './Workbench';

export function Administration({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState('agents'), [settings, setSettings] = useState<any>(null), [status, setStatus] = useState<any>(null), [agents, setAgents] = useState<any[]>([]), [error, setError] = useState('');
  const load = async () => { const [c, s, a] = await Promise.all([api('/config'), api('/administration'), api('/agents')]); setSettings(c); setStatus(s); setAgents(a); };
  useEffect(() => { load().catch(e => setError(e.message)); }, []);
  return <ToolDialog title="Administration" onClose={onClose}><nav className="tool-tabs" aria-label="Administration">{[['agents', 'Agents'], ['routing', 'Routage'], ['mcp', 'Serveurs MCP'], ['config', 'Configuration'], ['operations', 'Exploitation']].map(([id, label]) => <button key={id} className={`chip ${tab === id ? 'on' : ''}`} onClick={() => setTab(id)}>{label}</button>)}</nav>
    {error && <p role="alert">{error}</p>}{!settings ? <p>Chargement…</p> : tab === 'agents' ? <Agents agents={agents} reload={load} /> : tab === 'routing' ? <Routing settings={settings} agents={agents} save={async patch => { setSettings(await api('/config', patch, 'PATCH')); toast('Règles enregistrées.'); }} />
      : tab === 'mcp' ? <Mcp settings={settings} save={async patch => { setSettings(await api('/config', patch, 'PATCH')); toast('Serveurs enregistrés ; utilisés à la prochaine connexion d’agent.'); }} />
        : tab === 'config' ? <Configuration settings={settings} reload={load} /> : <Operations status={status} reload={load} />}
  </ToolDialog>;
}

function Agents({ agents, reload }: { agents: any[]; reload: () => Promise<void> }) {
  const [operation, setOperation] = useState<any>(null), [input, setInput] = useState(''), [result, setResult] = useState<any>(null);
  useEffect(() => { if (!operation || operation.state !== 'running') return; const timer = setInterval(() => api(`/agent-operations/${operation.id}`).then(setOperation, e => toast(e.message, true)), 1500); return () => clearInterval(timer); }, [operation?.id, operation?.state]);
  return <div className="tool-stack">{agents.map(a => <article className="card tool-stack" key={a.id}><div className="row"><b className="grow">{a.name}</b><span>{a.installed ? 'Installé' : 'Non installé'}</span></div><div className="row wrap"><button className="chip" onClick={guard(async () => { await api(`/agents/${a.id}/probe`, {}); await reload(); })}>Vérifier connexion et disponibilité</button>
    <button className="chip" disabled={!a.catalog || operation?.state === 'running'} onClick={guard(async () => { setOperation(await api(`/agents/${a.id}/install`, {})); await reload(); })}>Installer</button><button className="chip" disabled={!a.catalog || !a.installed || operation?.state === 'running'} onClick={guard(async () => setOperation(await api(`/agents/${a.id}/connect`, {})))}>Connecter</button></div>
    <p>{a.strengths}</p>{a.health && <pre className="ctx">{JSON.stringify(a.health, null, 2)}</pre>}</article>)}
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
function Configuration({ settings, reload }: { settings: any; reload: () => Promise<void> }) {
  const [json, setJson] = useState(JSON.stringify(settings, null, 2));
  return <form className="tool-stack" onSubmit={guard(async e => { e.preventDefault(); await api('/config', JSON.parse(json), 'PATCH'); await reload(); toast('Configuration enregistrée. Hôte et port nécessitent un redémarrage.'); })}>
    <p>Configuration globale : agents, modèles, parallélisme, délais, budgets, commandes de validation et moteur de transcription. Les valeurs secrètes sont masquées et conservées si elles ne sont pas remplacées.</p>
    <textarea className="code-editor" aria-label="Configuration globale JSON" spellCheck={false} value={json} onChange={e => setJson(e.target.value)} /><button className="btn primary">Valider et enregistrer</button>
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
