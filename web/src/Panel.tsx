// Right panel: project memory (search, add, forget, reindex docs) and a preview of the injected context pack.
import { useCallback, useEffect, useState } from 'react';
import { api, type Memory, type Project } from './api';
import { Icon } from './icons';
import { Segmented, guard, toast } from './ui';

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
      {tab === 'memory' ? <MemoryTab project={project} /> : <ContextTab sessionId={sessionId} draft={draft} />}
    </aside>
  );
}

function MemoryTab({ project }: { project: Project }) {
  const [q, setQ] = useState('');
  const [data, setData] = useState<{ memory: Memory[]; docs: { path: string; text: string }[]; kbChunks: number }>({ memory: [], docs: [], kbChunks: 0 });
  const [kind, setKind] = useState('fact');
  const [text, setText] = useState('');
  const load = useCallback(() => api(`/projects/${project.id}/memory${q ? `?q=${encodeURIComponent(q)}` : ''}`).then(setData).catch(() => {}), [project.id, q]);
  useEffect(() => { const t = setTimeout(load, q ? 220 : 0); return () => clearTimeout(t); }, [load, q]);
  return (
    <div className="panel-body">
      <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Chercher dans la mémoire et les docs…" />
      <div className="stat">
        <span className="tag">{data.memory.length} connaissance{data.memory.length > 1 ? 's' : ''}{q ? ' trouvée(s)' : ''}</span>
        <span className="tag">{data.kbChunks} extraits de docs</span>
        <button className="chip sm" onClick={guard(async () => { const r = await api(`/projects/${project.id}/reindex`, {}); toast(`${r.chunks} extraits indexés.`); load(); })}>
          <Icon name="refresh" size={12} />Réindexer
        </button>
      </div>
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
          <div className={`k k-${m.kind}`}>{KINDS[m.kind] ?? m.kind}</div>
          {m.text}
          <button className="chip icon sm x" style={{ width: 24, height: 24 }} aria-label="Oublier" title="Oublier"
            onClick={guard(async () => { await api(`/memory/${m.id}`, {}, 'DELETE'); load(); })}><Icon name="trash" size={13} /></button>
        </div>
      ))}
      {data.docs.map((d, i) => (
        <div key={`${d.path}${i}`} className="mem"><div className="k k-doc">📄 {d.path}</div>{d.text.slice(0, 420)}</div>
      ))}
      {!data.memory.length && !data.docs.length && <p className="muted" style={{ fontSize: 13 }}>Rien encore. Les agents et les résumés de session alimentent cette mémoire.</p>}
    </div>
  );
}

function ContextTab({ sessionId, draft }: { sessionId: string | null; draft: string }) {
  const [q, setQ] = useState('');
  const [pack, setPack] = useState<{ text: string; stats: string } | null>(null);
  useEffect(() => {
    if (!sessionId) return;
    const t = setTimeout(() => api(`/sessions/${sessionId}/context?q=${encodeURIComponent(q || draft)}`).then(setPack).catch(() => {}), 250);
    return () => clearTimeout(t);
  }, [sessionId, q, draft]);
  if (!sessionId) return <div className="panel-body"><p className="muted">Ouvre une session.</p></div>;
  return (
    <div className="panel-body">
      <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>Ce que reçoit un agent au démarrage d'une session : brief, état git, mémoire, docs, sessions récentes.</p>
      <input className="input" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Simuler pour une demande…" />
      {pack && <div className="stat">{pack.stats.split(', ').map((s) => <span key={s} className="tag">{s}</span>)}</div>}
      <pre className="ctx">{pack?.text ?? '…'}</pre>
    </div>
  );
}
