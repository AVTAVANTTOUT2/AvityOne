import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, type Project } from './api';
import { guard, toast } from './ui';
import { Icon } from './icons';

export function ToolDialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} className="tool-dialog" onCancel={e => { e.preventDefault(); onClose(); }} aria-label={title}>
    <header className="row"><h2 className="grow">{title}</h2><button className="chip icon" onClick={onClose} aria-label="Fermer"><Icon name="x" /></button></header>
    {children}
  </dialog>;
}
export function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' })), a = document.createElement('a');
  a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function Workbench({ project, sessionId, onClose }: { project: Project; sessionId: string | null; onClose: () => void }) {
  const [tab, setTab] = useState('files');
  const dirty = useRef(false), mayLeave = () => !dirty.current || confirm('Abandonner les modifications non enregistrées du fichier ?');
  return <ToolDialog title="Atelier du projet" onClose={() => { if (mayLeave()) onClose(); }}>
    <nav className="tool-tabs" aria-label="Outils">{[['files', 'Fichiers'], ['plan', 'Plan et tâches'], ['changes', 'Changements'], ['terminal', 'Terminal'], ['project', 'Projet']].map(([id, label]) => <button className={`chip ${tab === id ? 'on' : ''}`} key={id} onClick={() => { if (id !== tab && mayLeave()) { dirty.current = false; setTab(id); } }} aria-pressed={tab === id}>{label}</button>)}</nav>
    {tab === 'project' ? <ProjectEditor project={project} /> : !sessionId ? <p>Ouvre une session pour utiliser les outils dans son espace de travail.</p>
      : tab === 'files' ? <FileEditor key={sessionId} sessionId={sessionId} onDirty={v => { dirty.current = v; }} mayLeave={mayLeave} /> : tab === 'terminal' ? <Terminal key={sessionId} sessionId={sessionId} />
        : tab === 'plan' ? <PlanEditor key={sessionId} sessionId={sessionId} /> : <Changes key={sessionId} sessionId={sessionId} />}
  </ToolDialog>;
}

function FileEditor({ sessionId, onDirty, mayLeave }: { sessionId: string; onDirty: (dirty: boolean) => void; mayLeave: () => boolean }) {
  const base = `/sessions/${sessionId}`;
  const original = useRef(''), request = useRef(0);
  const [folder, setFolder] = useState(''), [entries, setEntries] = useState<any[]>([]), [file, setFile] = useState<{ path: string; text: string; revision: string } | null>(null), [error, setError] = useState('');
  useEffect(() => { let current = true; api(`${base}/files?path=${encodeURIComponent(folder)}`).then(r => { if (current) { setEntries(r.entries); setError(''); } }, e => current && setError(e.message)); return () => { current = false; }; }, [base, folder]);
  return <div className="tool-grid"><aside className="file-tree">
    <button className="chip" onClick={() => setFolder(folder.split('/').slice(0, -1).join('/'))}>↑ Dossier parent</button>
    <p className="mono">/{folder}</p>{error && <p role="alert">{error}</p>}
    {entries.map(e => <button className="file-entry" key={e.path} onClick={guard(async () => {
      if (e.directory) return setFolder(e.path);
      if (!mayLeave()) return;
      const turn = ++request.current, next = await api(`${base}/file?path=${encodeURIComponent(e.path)}`);
      if (turn === request.current) { original.current = next.text; onDirty(false); setFile(next); }
    })}>{e.directory ? '▸ ' : ''}{e.name}{e.symlink ? ' ↗' : ''}</button>)}
  </aside><section className="tool-stack">{file ? <>
    <div className="row"><b className="grow mono">{file.path}</b><button className="btn primary" onClick={guard(async () => { const saved = await api(`${base}/file`, file, 'PUT'); setFile(current => { if (!current || current.path !== saved.path) return current; original.current = saved.text; onDirty(current.text !== saved.text); return { ...current, revision: saved.revision }; }); toast('Fichier enregistré.'); })}>Enregistrer</button></div>
    <textarea className="code-editor" spellCheck={false} aria-label={`Code de ${file.path}`} value={file.text} onChange={e => { request.current++; onDirty(e.target.value !== original.current); setFile({ ...file, text: e.target.value }); }} />
  </> : <p>Sélectionne un fichier texte. La sauvegarde refuse d’écraser une modification concurrente.</p>}
    <button className="chip" onClick={guard(async () => { const r = await api(`${base}/repository-context`); download('contexte-depot.txt', r.text); toast(`${r.files} fichiers exportés, ${r.skipped.length} exclus ou trop volumineux.`, r.skipped.length > 0); })}>Exporter le contexte du dépôt pour une revue</button>
  </section></div>;
}

function Terminal({ sessionId }: { sessionId: string }) {
  const [id, setId] = useState(''), [output, setOutput] = useState(''), [command, setCommand] = useState(''), [closed, setClosed] = useState(false);
  const base = `/sessions/${sessionId}/terminals`, offset = useRef(0);
  useEffect(() => {
    if (!id) return;
    let alive = true, running = false;
    const poll = async () => { if (running) return; running = true; try { const r = await api(`${base}/${id}?offset=${offset.current}`); if (alive) { offset.current = r.offset; setOutput(s => (s + r.output).slice(-200_000)); setClosed(r.closed); } } catch (e) { if (alive) { setClosed(true); toast((e as Error).message, true); } } finally { running = false; } };
    void poll(); const t = setInterval(poll, 1000);
    return () => { alive = false; clearInterval(t); api(`${base}/${id}`, {}, 'DELETE').catch(() => {}); };
  }, [base, id]);
  return <div className="tool-stack"><p>Shell du serveur dans le dossier de cette session. Les commandes s’exécutent avec les droits du service. Fermeture après dix minutes d’inactivité ; applications plein écran non prises en charge.</p>
    {!id ? <button className="btn" onClick={guard(async () => setId((await api(base, {})).id))}>Ouvrir un terminal</button> : <>
      <pre className="terminal-output" aria-live="polite" tabIndex={0}>{output || 'Connexion…'}</pre>
      <form className="row" onSubmit={guard(async e => { e.preventDefault(); await api(`${base}/${id}`, { input: command + '\n' }); setCommand(''); })}><input className="input grow mono" aria-label="Commande ou réponse au terminal" value={command} onChange={e => setCommand(e.target.value)} disabled={closed} /><button className="btn" disabled={closed}>Envoyer</button><button className="btn" type="button" onClick={guard(async () => { await api(`${base}/${id}`, {}, 'DELETE'); setId(''); offset.current = 0; setOutput(''); setClosed(false); })}>Fermer</button></form>
    </>}
  </div>;
}

type Task = { id: string; content: string; selected: boolean; dependencies: string[]; files: string[]; agent?: string };
function PlanEditor({ sessionId }: { sessionId: string }) {
  const base = `/sessions/${sessionId}`, [plan, setPlan] = useState<{ specification: string; tasks: Task[]; revision: number } | null>(null), [jobs, setJobs] = useState<any[]>([]), [artifacts, setArtifacts] = useState<any>(null), [text, setText] = useState(''), [error, setError] = useState('');
  const load = async () => { const [p, j] = await Promise.all([api(`${base}/plan`), api(`${base}/jobs`)]); setPlan(p); setJobs(j); };
  useEffect(() => { load().catch(e => setError(e.message)); }, [base]);
  const change = (i: number, patch: Partial<Task>) => setPlan(p => p && ({ ...p, tasks: p.tasks.map((t, n) => i === n ? { ...t, ...patch } : t) }));
  return <div className="tool-stack">{error && <p role="alert">{error}</p>}{plan && <>
    <label>Spécification<textarea className="input" value={plan.specification} onChange={e => setPlan({ ...plan, specification: e.target.value })} /></label>
    {plan.tasks.map((t, i) => <fieldset key={t.id} className="task-editor"><legend><input type="checkbox" aria-label={`Sélectionner ${t.id}`} checked={t.selected} onChange={e => change(i, { selected: e.target.checked })} /> {t.id}</legend>
      <textarea className="input" aria-label={`Contenu ${t.id}`} value={t.content} onChange={e => change(i, { content: e.target.value })} />
      <div className="row"><label className="grow">Dépend de (identifiants séparés par une virgule)<input className="input" value={t.dependencies.join(', ')} onChange={e => change(i, { dependencies: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })} /></label>
        <label className="grow">Fichiers concernés<input className="input" value={t.files.join(', ')} onChange={e => change(i, { files: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })} /></label></div>
      <div className="row"><label>Agent (vide : automatique)<input className="input" value={t.agent ?? ''} onChange={e => change(i, { agent: e.target.value || undefined })} /></label>
        <button className="chip" disabled={!i} onClick={() => { const tasks = [...plan.tasks]; [tasks[i - 1], tasks[i]] = [tasks[i], tasks[i - 1]]; setPlan({ ...plan, tasks }); }}>↑ Monter</button>
        <button className="chip" disabled={i === plan.tasks.length - 1} onClick={() => { const tasks = [...plan.tasks]; [tasks[i + 1], tasks[i]] = [tasks[i], tasks[i + 1]]; setPlan({ ...plan, tasks }); }}>↓ Descendre</button>
        <button className="chip" onClick={() => setPlan({ ...plan, tasks: plan.tasks.filter((_, n) => i !== n) })}>Retirer</button></div>
    </fieldset>)}
    <div className="row wrap"><button className="btn" onClick={() => setPlan({ ...plan, tasks: [...plan.tasks, { id: crypto.randomUUID(), content: '', selected: true, dependencies: [], files: [] }] })}>Ajouter une étape</button>
      <button className="btn primary" onClick={guard(async () => { setPlan(await api(`${base}/plan`, plan, 'PUT')); toast('Plan enregistré.'); })}>Enregistrer</button>
      <button className="btn" onClick={guard(async () => { await api(`${base}/plan`, plan, 'PUT'); await api(`${base}/parallel`, {}); await load(); toast('Tâches mises en file.'); })}>Lancer la sélection en parallèle</button></div>
  </>}
    <form className="row" onSubmit={guard(async e => { e.preventDefault(); await api(`${base}/queue`, { text }); setText(''); await load(); })}><input className="input grow" aria-label="Demande à mettre en file" placeholder="Demande à exécuter après les travaux en cours…" value={text} onChange={e => setText(e.target.value)} required /><button className="btn">Mettre en file</button></form>
    <div className="row"><h3 className="grow">File persistante</h3><button className="chip" onClick={guard(load)}>Actualiser</button></div>
    {jobs.map(j => <div className="card tool-row" key={j.id}><span className="grow">{j.text ?? j.prompt ?? j.id}</span><span>{j.status}</span>{['error', 'interrupted', 'cancelled'].includes(j.status) && <button className="chip" onClick={guard(async () => { await api(`/jobs/${j.id}/retry`, {}); await load(); })}>Relancer</button>}{j.error && <p role="alert">{j.error}</p>}</div>)}
    <button className="chip" onClick={guard(async () => setArtifacts(await api(`${base}/artifacts`)))}>Afficher spécification, plan et résultats persistants</button>{artifacts && <pre className="ctx">{JSON.stringify(artifacts, null, 2)}</pre>}
  </div>;
}

function Changes({ sessionId }: { sessionId: string }) {
  const base = `/sessions/${sessionId}`, [preview, setPreview] = useState<any>(null), [selected, setSelected] = useState<string[]>([]), [hunks, setHunks] = useState<string[]>([]), [diff, setDiff] = useState<any>(null), [staged, setStaged] = useState(false), [findings, setFindings] = useState<any[]>([]), [validation, setValidation] = useState<any>(null), [error, setError] = useState(''), [working, setWorking] = useState(false);
  const load = async () => { const [p, d, f] = await Promise.all([api(`${base}/merge-preview`).catch(e => { if (e.status === 409) return { branches: [], fingerprint: '' }; throw e; }), api(`${base}/diff?staged=${staged ? 1 : 0}`), api(`${base}/findings`)]); setPreview(p); setSelected(p.branches.map((b: any) => b.id)); setHunks(p.branches.flatMap((b: any) => b.hunks.map((h: any) => h.id))); setDiff(d); setFindings(f); setError(''); };
  useEffect(() => { load().catch(e => setError(e.message)); }, [base, staged]);
  const toggle = (values: string[], v: string) => values.includes(v) ? values.filter(x => x !== v) : [...values, v];
  const action = (fn: () => Promise<void>) => guard(async () => { setWorking(true); try { await fn(); } finally { setWorking(false); } });
  return <div className="tool-stack">{error && <p role="alert">{error}</p>}
    <div className="row wrap"><button className="btn" disabled={working} onClick={action(async () => setValidation(await api(`${base}/validate`, {})))}>Lancer tests, lint et build</button><button className="btn" disabled={working} onClick={action(async () => { await api(`${base}/review`, {}); await load(); })}>Demander une revue croisée</button><button className="chip" onClick={guard(load)}>Actualiser</button></div>
    {validation && <pre className="ctx">{JSON.stringify(validation, null, 2)}</pre>}
    {findings.map(f => <article className="card tool-stack" key={f.id}><b>{f.path ?? f.title}</b><p>{f.message ?? f.body ?? f.description}</p><span>{f.status}</span>{f.status === 'open' && <form className="row" onSubmit={guard(async e => { e.preventDefault(); const form = e.currentTarget; await api(`${base}/findings/${f.id}`, { status: 'resolved', resolution: new FormData(form).get('resolution') }, 'PATCH'); await load(); })}><input className="input grow" name="resolution" placeholder="Correction appliquée et vérification…" aria-label="Justification de la correction" required /><button className="btn">Marquer corrigé</button></form>}</article>)}
    <h3>Branches à intégrer</h3>{preview?.branches.map((b: any) => <fieldset className="task-editor" key={b.id}><legend><input type="checkbox" checked={selected.includes(b.id)} onChange={() => setSelected(toggle(selected, b.id))} /> {b.branch}</legend>
      <details><summary>Comparer tous les changements ({b.files.length} fichiers)</summary><pre className="ctx">{b.diff}</pre></details>
      {b.hunks.map((h: any) => <label className="hunk-choice" key={h.id}><input type="checkbox" checked={hunks.includes(h.id)} onChange={() => setHunks(toggle(hunks, h.id))} />{h.path}<pre className="ctx">{h.patch}</pre></label>)}
    </fieldset>)}
    <div className="row wrap"><button className="btn primary" disabled={working || !selected.length} onClick={action(async () => { const available = preview.branches.filter((b: any) => selected.includes(b.id)).flatMap((b: any) => b.hunks.map((h: any) => h.id)); const chosen = hunks.filter(id => available.includes(id)); const r = await api(`${base}/merge`, { branches: selected, ...(chosen.length === available.length ? {} : { hunks: chosen }), fingerprint: preview.fingerprint }); await load(); toast(r.failed ? `Fusion bloquée : ${r.failed} branche(s), ${(r.conflicts ?? []).join(', ')}` : `${r.merged} branche(s) fusionnée(s) après contrôles.`, !!r.failed); })}>Valider, relire et fusionner la sélection</button><button className="btn" disabled={working} onClick={action(async () => { const r = await api(`${base}/conflicts`, {}); toast(r.message ?? 'Résolution assistée démarrée ; contrôle le diff avant de fusionner.'); })}>Résolution assistée des conflits</button></div>
    <h3>Modifications locales</h3><label><input type="checkbox" checked={staged} onChange={e => setStaged(e.target.checked)} /> Afficher les modifications déjà sélectionnées (index Git)</label>
    {diff?.files.map((path: string) => { const blocks: string[] = diff.hunks.filter((h: any) => h.path === path).map((h: any) => h.patch); const section = blocks.join('\n');
      const choose = (act: string, hunk?: number) => guard(async () => { if (act === 'reject' && !staged && !confirm('Annuler cette modification locale ?')) return; if (section.includes('--- /dev/null') || section.includes('+++ /dev/null')) hunk = undefined; await api(`${base}/changes`, { path, hunk, action: act, staged, revision: diff.revision }); await load(); });
      return <details key={path}><summary>{path}</summary><div className="row">{!staged && <button className="chip" onClick={choose('accept')}>Sélectionner le fichier</button>}<button className="chip" onClick={choose('reject')}>{staged ? 'Retirer de la sélection' : 'Annuler le fichier'}</button></div>{blocks.length ? blocks.map((block: string, i: number) => <div key={i}><pre className="ctx">{block}</pre><div className="row">{!staged && <button className="chip" onClick={choose('accept', i)}>Accepter ce bloc</button>}<button className="chip" onClick={choose('reject', i)}>{staged ? 'Désélectionner' : 'Rejeter'} ce bloc</button></div></div>) : <pre className="ctx">{section}</pre>}</details>; })}
  </div>;
}

function ProjectEditor({ project }: { project: Project }) {
  const [name, setName] = useState(project.name), [docs, setDocs] = useState({ brief: '', instructions: '' }), [loaded, setLoaded] = useState(false), [error, setError] = useState('');
  useEffect(() => { let current = true; setLoaded(false); api(`/projects/${project.id}/documents`).then(d => { if (current) { setDocs(d); setLoaded(true); } }).catch(e => current && setError(e.message)); return () => { current = false; }; }, [project.id]);
  return <form className="tool-stack" onSubmit={guard(async e => { e.preventDefault(); if (!loaded) return; await api(`/projects/${project.id}`, { name, ...docs }, 'PATCH'); location.reload(); })}>
    {error && <p role="alert">{error}</p>}<label>Nom du projet<input className="input" value={name} onChange={e => setName(e.target.value)} required /></label>
    <label>Brief<textarea className="code-editor short" disabled={!loaded} value={docs.brief} onChange={e => setDocs({ ...docs, brief: e.target.value })} /></label>
    <label>Instructions du projet<textarea className="code-editor short" disabled={!loaded} value={docs.instructions} onChange={e => setDocs({ ...docs, instructions: e.target.value })} /></label>
    <div className="row wrap"><button className="btn primary" disabled={!loaded}>Enregistrer</button><button type="button" className="btn" onClick={guard(async () => { await api(`/projects/${project.id}`, { archived: true }, 'PATCH'); location.reload(); })}>Archiver</button>
      <button type="button" className="btn" onClick={guard(async () => { if (confirm('Retirer ce projet et son historique de la plateforme ? Ses fichiers restent sur disque.')) { await api(`/projects/${project.id}`, {}, 'DELETE'); location.reload(); } })}>Retirer de la plateforme</button></div>
  </form>;
}

export function FolderPicker({ onPick }: { onPick: (path: string) => void }) {
  const [folder, setFolder] = useState<any>(null), [error, setError] = useState('');
  const load = async (path = '') => { try { setFolder(await api(`/folders?path=${encodeURIComponent(path)}`)); setError(''); } catch (e) { setError((e as Error).message); } };
  return <details onToggle={e => { if (e.currentTarget.open && !folder) void load(); }}><summary>Parcourir les dossiers du serveur</summary>{error && <p role="alert">{error}</p>}{folder && <div className="tool-stack"><div className="row"><button type="button" className="chip" disabled={!folder.parent} onClick={() => load(folder.parent)}>↑ Parent</button><span className="mono grow">{folder.path}</span><button type="button" className="btn" onClick={() => onPick(folder.path)}>Choisir ce dossier</button></div>{folder.folders.map((f: any) => <button className="file-entry" type="button" key={f.path} onClick={() => load(f.path)}>{f.name}</button>)}</div>}</details>;
}
