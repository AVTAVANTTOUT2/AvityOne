// Right panel: project memory (search, add, forget, reindex docs) and a preview of the injected context pack.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Memory, type Project } from './api';
import { Icon } from './icons';
import { Segmented, guard, toast } from './ui';
import { download, ToolDialog } from './Workbench';
import { encodeFile } from './uploads';

type Tab = 'memory' | 'context';
const KINDS: Record<string, string> = { decision: 'décision', convention: 'convention', pitfall: 'piège', fact: 'fait', todo: 'à faire' };

export function Panel({ project, sessionId, draft, onClose }: { project: Project; sessionId: string | null; draft: string; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('memory');
  return (
    <aside className="panel" aria-label="Mémoire et contexte">
      <div className="panel-head">
        <Segmented label="Panneau" value={tab} onChange={setTab}
          options={[{ value: 'memory', label: 'Mémoire' }, { value: 'context', label: 'Contexte injecté' }]} />
        <span className="grow" />
        <button className="chip icon" onClick={onClose} aria-label="Fermer le panneau"><Icon name="x" size={15} /></button>
      </div>
      {tab === 'memory' ? <MemoryTab key={project.id} project={project} /> : <ContextTab key={sessionId} sessionId={sessionId} draft={draft} />}
    </aside>
  );
}

function MemoryTab({ project }: { project: Project }) {
  const [q, setQ] = useState('');
  const [data, setData] = useState<{ memory: Memory[]; docs: { path: string; text: string }[]; kbChunks: number }>({ memory: [], docs: [], kbChunks: 0 });
  const [kind, setKind] = useState('fact');
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState<any>(null), [history, setHistory] = useState<any[] | null>(null), [graph, setGraph] = useState<any>(null), [source, setSource] = useState<any>(null);
  const request = useRef(0);
  const load = useCallback(() => { const n = ++request.current; return api(`/projects/${project.id}/memory${q ? `?q=${encodeURIComponent(q)}` : ''}`)
    .then((d) => { if (n === request.current) { setData(d); setErr(''); } }, (e) => { if (n === request.current) setErr(e.message); }); }, [project.id, q]);
  useEffect(() => { const t = setTimeout(load, q ? 220 : 0); return () => { clearTimeout(t); request.current++; }; }, [load, q]);
  return (
    <div className="panel-body">
      <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Chercher dans la mémoire et les docs…" />
      <div className="stat">
        <span className="tag">{data.memory.length} connaissance{data.memory.length > 1 ? 's' : ''}{q ? ' trouvée(s)' : ''}</span>
        <span className="tag">{data.kbChunks} extraits de docs</span>
        <button className="chip sm" onClick={guard(async () => {
          const r = await api<{ chunks: number; failed: string[] }>(`/projects/${project.id}/reindex`, {});
          const bad = r.failed.length;
          toast(`${r.chunks} extraits indexés.${bad ? ` ${bad} fichier(s) illisible(s) : ${r.failed.slice(0, 3).join(', ')}${bad > 3 ? '…' : ''}` : ''}`, bad > 0);
          load();
        })}>
          <Icon name="refresh" size={12} />Réindexer
        </button>
      </div>
      {err && <div className="panel-err" role="alert">Mémoire indisponible : {err}</div>}
      <div className="row wrap"><button className="chip sm" onClick={guard(async () => { const r = await api(`/projects/${project.id}/memory/consolidate`, {}); toast(`${r.merged} doublon(s) consolidé(s), ${r.stale} fait(s) périmé(s).`); load(); })}>Consolider</button>
        <button className="chip sm" onClick={guard(async () => { const r = await api(`/projects/${project.id}/memory/export`); download(r.filename, r.markdown); })}>Exporter Markdown</button>
        <button className="chip sm" onClick={guard(async () => setGraph(await api(`/projects/${project.id}/memory/graph`)))}>Graphe temporel</button></div>
      <label className="chip">Importer un document<input type="file" accept=".pdf,.docx,.odt,.pptx,.xlsx,.md,.txt" onChange={guard(async e => { const file = e.target.files?.[0]; if (!file) return; const r = await api(`/projects/${project.id}/documents/import`, { name: file.name, base64: await encodeFile(file) }); toast(r.failed.length ? `Indexation partielle : ${r.failed.slice(0, 3).join(' ; ')}` : `${r.chunks} extraits indexés.`, r.failed.length > 0); load(); })} /></label>
      <form className="row" onSubmit={guard(async (e) => {
        e.preventDefault();
        if (!text.trim()) return;
        const r = await api(`/projects/${project.id}/memory`, { kind, text });
        toast(r.added ? 'Mémorisé, partagé avec tous les agents.' : 'Déjà connu.');
        setText(''); load();
      })}>
        <select className="select" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Type">{Object.entries(KINDS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}</select>
        <input className="input grow" style={{ height: 32 }} value={text} onChange={(e) => setText(e.target.value)} placeholder="Ajouter une connaissance durable…" />
      </form>
      {data.memory.map((m) => (
        <div key={m.id} className="mem">
          <div className={`k k-${m.kind}`}>#{m.id} · {KINDS[m.kind] ?? m.kind}</div>
          {m.text}
          {(m as any).stale && <span className="tag">Périmé</span>}{(m as any).contradictions?.length > 0 && <span className="tag">Contradiction avec {(m as any).contradictions.join(', ')}</span>}
          <div className="row"><button className="chip sm" onClick={() => { setEditing(m); setHistory(null); }}>Modifier</button><button className="chip sm" onClick={guard(async () => { setEditing(m); setHistory(await api(`/projects/${project.id}/memory/${m.id}/history`)); })}>Historique</button></div>
          <button className="chip icon sm x" style={{ width: 24, height: 24 }} aria-label="Oublier" title="Oublier"
            onClick={guard(async () => { await api(`/projects/${project.id}/memory/${m.id}`, {}, 'DELETE'); load(); })}><Icon name="trash" size={13} /></button>
        </div>
      ))}
      {data.docs.map((d, i) => (
        <div key={`${d.path}${i}`} className="mem"><div className="k k-doc">📄 {d.path}</div>{d.text?.slice(0, 420)}<button className="chip sm" onClick={guard(async () => setSource(await api(`/projects/${project.id}/source?path=${encodeURIComponent(d.path)}`)))}>Ouvrir la source complète</button></div>
      ))}
      {!data.memory.length && !data.docs.length && <p className="muted" style={{ fontSize: 13 }}>Rien encore. Les agents et les résumés de session alimentent cette mémoire.</p>}
      {source && <ToolDialog title={source.path} onClose={() => setSource(null)}><a className="btn" href={`/api/projects/${project.id}/source/download?path=${encodeURIComponent(source.path)}`} download>Télécharger le document original</a><pre className="ctx">{source.text}</pre></ToolDialog>}
      {editing && <ToolDialog title="Connaissance et historique" onClose={() => { setEditing(null); setHistory(null); }}><form className="tool-stack" onSubmit={guard(async e => { e.preventDefault(); await api(`/projects/${project.id}/memory/${editing.id}`, { text: editing.text, kind: editing.kind, subject: editing.subject ?? '', predicate: editing.predicate ?? '', object: editing.object ?? '', entityType: editing.entity_type ?? 'fact', occurredAt: editing.occurred_at || null, validUntil: editing.valid_until || null }, 'PATCH'); setEditing(null); load(); })}>
        <textarea className="code-editor short" aria-label="Texte de la connaissance" value={editing.text} onChange={e => setEditing({ ...editing, text: e.target.value })} />
        <div className="row wrap">{[['subject', 'Sujet ou personne'], ['predicate', 'Relation'], ['object', 'Valeur ou événement'], ['occurred_at', 'Date de l’événement (ISO)'], ['valid_until', 'Valide jusqu’au (ISO)']].map(([key, label]) => <label className="grow" key={key}>{label}<input className="input" value={editing[key] ?? ''} onChange={e => setEditing({ ...editing, [key]: e.target.value })} /></label>)}</div><label>Type d’entité<select className="select" value={editing.entity_type ?? 'fact'} onChange={e => setEditing({ ...editing, entity_type: e.target.value })}><option value="fact">Fait</option><option value="person">Personne</option><option value="event">Événement</option></select></label>
        <button className="btn primary">Enregistrer une nouvelle version</button>
      </form>{history?.map(v => <article className="card tool-stack" key={v.id}><span>{v.created_at} · {v.action}</span><pre className="ctx">{v.snapshot.text}</pre><button className="btn" onClick={guard(async () => { await api(`/projects/${project.id}/memory/${editing.id}/restore`, { versionId: v.id }); setEditing(null); load(); })}>Restaurer cette version</button></article>)}</ToolDialog>}
      {graph && <ToolDialog title="Graphe temporel des connaissances" onClose={() => setGraph(null)}><div className="tool-stack"><p>{graph.nodes.length} entités · {graph.edges.length} relations</p><ul>{graph.edges.map((edge: any, i: number) => <li key={i}>{String(edge.source ?? edge.from)} → {String(edge.target ?? edge.to)} : {edge.label ?? edge.predicate}</li>)}</ul><h3>Chronologie</h3>{graph.timeline.map((event: any) => <article className="card tool-row" key={event.id}><time>{event.at}</time><span className="grow">{event.text}</span>{event.validUntil && <span>Valide jusqu’au {event.validUntil}</span>}</article>)}</div></ToolDialog>}
    </div>
  );
}

function ContextTab({ sessionId, draft }: { sessionId: string | null; draft: string }) {
  const [q, setQ] = useState('');
  const [pack, setPack] = useState<{ text: string; stats: string; warnings: string[] } | null>(null);
  const [err, setErr] = useState('');
  const [selection, setSelection] = useState<any>({}), [selectionLoaded, setSelectionLoaded] = useState(false);
  useEffect(() => { setSelectionLoaded(false); if (sessionId) api(`/sessions/${sessionId}/context-selection`).then(s => { setSelection(s); setSelectionLoaded(true); }, e => setErr(e.message)); }, [sessionId]);
  useEffect(() => {
    if (!sessionId) return;
    let current = true;
    const t = setTimeout(() => api(`/sessions/${sessionId}/context?q=${encodeURIComponent(q || draft)}`)
      .then((p) => { if (current) { setPack(p); setErr(''); } }, (e) => current && setErr(e.message)), 250);
    return () => { current = false; clearTimeout(t); };
  }, [sessionId, q, draft]);
  if (!sessionId) return <div className="panel-body"><p className="muted">Ouvre une session.</p></div>;
  return (
    <div className="panel-body">
      <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>Ce que reçoit un agent au démarrage d'une session : brief, état git, mémoire, docs, sessions récentes.</p>
      <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Simuler pour une demande…" />
      {err && <div className="panel-err" role="alert">Contexte indisponible : {err}</div>}
      {selectionLoaded && <form className="tool-stack" onSubmit={guard(async e => { e.preventDefault(); setSelection(await api(`/sessions/${sessionId}/context-selection`, selection, 'PATCH')); setPack(await api(`/sessions/${sessionId}/context?q=${encodeURIComponent(q || draft)}`)); toast('Sélection enregistrée pour la prochaine connexion d’agent.'); })}>
        {([['includeBrief', 'Brief'], ['includeInstructions', 'Instructions'], ['includeGit', 'État Git'], ['includeRecent', 'Sessions récentes']] as const).map(([key, label]) => <label key={key}><input type="checkbox" checked={selection[key] !== false} onChange={e => setSelection({ ...selection, [key]: e.target.checked })} /> {label}</label>)}
        <label>Connaissances sélectionnées (identifiants séparés par virgules, vide : automatique)<input className="input" value={selection.memoryIds?.join(', ') ?? ''} onChange={e => setSelection({ ...selection, memoryIds: e.target.value.trim() ? e.target.value.split(',').map(Number) : null })} /></label>
        <label><input type="checkbox" checked={Array.isArray(selection.memoryIds) && selection.memoryIds.length === 0} onChange={e => setSelection({ ...selection, memoryIds: e.target.checked ? [] : null })} /> N’injecter aucune connaissance</label>
        <label>Sources sélectionnées (un chemin par ligne, vide : automatique)<textarea className="input" value={selection.paths?.join('\n') ?? ''} onChange={e => setSelection({ ...selection, paths: e.target.value.trim() ? e.target.value.split('\n').filter(Boolean) : null })} /></label>
        <label><input type="checkbox" checked={Array.isArray(selection.paths) && selection.paths.length === 0} onChange={e => setSelection({ ...selection, paths: e.target.checked ? [] : null })} /> N’injecter aucun document</label>
        <label>Contexte supplémentaire<textarea className="input" value={selection.custom ?? ''} onChange={e => setSelection({ ...selection, custom: e.target.value })} /></label><button className="btn">Appliquer au contexte injecté</button>
      </form>}
      {pack?.warnings.map((w) => <div key={w} className="panel-err">Contexte partiel : {w}</div>)}
      {pack && <div className="stat">{pack.stats.split(', ').map((s) => <span key={s} className="tag">{s}</span>)}</div>}
      <pre className="ctx">{pack?.text ?? '…'}</pre>
    </div>
  );
}
