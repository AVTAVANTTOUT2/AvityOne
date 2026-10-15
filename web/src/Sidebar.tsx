// Left rail: brand, projects (with generative covers), sessions (pinned, archived, history search, activity), agent roster.
import { Fragment, useEffect, useState, type FormEvent } from 'react';
import { MetalBadge, MetalText } from 'metal-fx';
import { BorderBeam } from 'border-beam';
import { api, hoursSince, rel, signalOf, SIGNAL_RANK, SIGNAL_TITLE, type Act, type Agent, type LiveState, type Project, type SearchHit, type SessionRow, type Signal } from './api';
import { AgentAvatar, LogoMark, coverUrl } from './brand';
import { Icon } from './icons';
import { MetalSafe, guard, toast } from './ui';

/** Activity dot: waiting for you (amber), working (pulsing), failed or finished and not seen yet (red, green). */
const Dot = ({ s }: { s: Signal | null }) => (s ? <span className={`act ${s}`} title={SIGNAL_TITLE[s]} aria-label={SIGNAL_TITLE[s]} role="img" /> : null);

export function Sidebar({ open, projects, project, sessions, sessionId, live, agents, acts, onProject, onSession, onNewSession, onCreated, onClose }: {
  open: boolean; projects: Project[]; project: Project | null; sessions: SessionRow[]; sessionId: string | null; live: LiveState | null; agents: Agent[];
  acts: Record<string, Act>;
  onProject: (id: number) => void; onSession: (id: string, itemId?: number) => void; onNewSession: () => void; onCreated: (p: Project) => void; onClose: () => void;
}) {
  const [dialog, setDialog] = useState(false);
  const [searching, setSearching] = useState(false);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const query = q.trim();
  useEffect(() => {
    setHits(null);
    if (!project || !query) return;
    let current = true; // a slow answer to an older query must not replace newer results
    const t = setTimeout(() => api<SearchHit[]>(`/projects/${project.id}/search?q=${encodeURIComponent(query)}`)
      .then((h) => { if (current) setHits(h); }, () => { if (current) setHits([]); }), 220);
    return () => { current = false; clearTimeout(t); };
  }, [project, query]);
  useEffect(() => { setQ(''); }, [project?.id]);
  const closeSearch = () => { setSearching(false); setQ(''); };

  const active = sessions.filter((s) => !s.archived), archived = sessions.filter((s) => s.archived);
  // A project shows its most pressing session signal, so work in other projects isn't missed.
  const projectSignal = (id: number) => Object.entries(acts).reduce<Signal | null>((best, [sid, a]) => {
    const s = a.projectId === id && sid !== sessionId ? signalOf(a) : null;
    return s && (!best || SIGNAL_RANK[s] > SIGNAL_RANK[best]) ? s : best;
  }, null);
  const sessionRow = (s: SessionRow) => {
    const on = s.id === sessionId;
    const working = on && !!live?.busy;
    const row = (
      <button className={`row-item ${on ? 'on' : ''} ${s.parent_id ? 'child' : ''}`} title={s.summary ?? ''} onClick={() => onSession(s.id)}>
        {s.parent_id && <Icon name="branch" size={13} className="muted" />}
        {s.agent ? <AgentAvatar id={s.agent} size={20} state={working ? 'working' : hoursSince(s.updated_at) > 24 ? 'sleeping' : 'default'} paused={!working} />
          : <span className="icon-tile" style={{ width: 20, height: 20, borderRadius: 7 }}><Icon name="chat" size={12} /></span>}
        <span className="grow ellipsis">{s.title ?? 'Nouvelle session'}</span>
        {!!s.pinned && !s.archived && <Icon name="pin" size={12} className="muted" aria-label="épinglée" />}
        <Dot s={on ? (acts[s.id]?.waiting ? 'waiting' : null) : signalOf(acts[s.id])} />
        <span className="sub">{rel(s.updated_at)}</span>
      </button>
    );
    return working ? <BorderBeam key={s.id} size="line" colorVariant="ocean" theme="dark" strength={0.9}>{row}</BorderBeam> : <div key={s.id}>{row}</div>;
  };
  return (
    <aside className={`side ${open ? 'open' : ''}`} aria-label="Navigation">
      <div className="brand">
        <LogoMark size={22} />
        <div className="grow">
          <MetalSafe fallback={<b style={{ fontWeight: 600, fontSize: 17 }}>AvityOne</b>}><MetalText font="600 17px/1 Inter, sans-serif" color="#e9e9e9">AvityOne</MetalText></MetalSafe>
        </div>
        <MetalSafe fallback={<span className="tag">Beta</span>}><MetalBadge>Beta</MetalBadge></MetalSafe>
        <button className="chip icon only-mobile" onClick={onClose} aria-label="Fermer le menu"><Icon name="x" size={15} /></button>
      </div>

      <div className="section"><span>Projets</span><button className="chip icon sm" style={{ width: 24, height: 24 }} onClick={() => setDialog(true)} aria-label="Nouveau projet" title="Nouveau projet"><Icon name="plus" size={14} /></button></div>
      <div className="list" style={{ maxHeight: '30vh' }}>
        {projects.map((p) => (
          <button key={p.id} className={`row-item ${p.id === project?.id ? 'on' : ''}`} title={p.path} onClick={() => onProject(p.id)}>
            <img className="cover-thumb" src={coverUrl(p.name, 64)} alt="" />
            <span className="grow ellipsis">{p.name}</span>
            <Dot s={projectSignal(p.id)} />
          </button>
        ))}
      </div>

      <div className="section">
        <span>Sessions</span>
        <span className="row" style={{ gap: 4 }}>
          <button className={`chip icon sm ${searching ? 'on' : ''}`} style={{ width: 24, height: 24 }} onClick={() => (searching ? closeSearch() : setSearching(true))} disabled={!project}
            aria-label="Rechercher dans les conversations" aria-pressed={searching} title="Rechercher dans les conversations"><Icon name="search" size={13} /></button>
          <button className="chip icon sm" style={{ width: 24, height: 24 }} onClick={onNewSession} disabled={!project} aria-label="Nouvelle session" title="Nouvelle session"><Icon name="plus" size={14} /></button>
        </span>
      </div>
      {searching && (
        <input className="input side-search" type="search" value={q} autoFocus aria-label="Rechercher dans les conversations" placeholder="Rechercher dans les conversations…"
          onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') closeSearch(); }} />
      )}
      <div className="list grow">
        {query ? (
          hits === null ? <div className="muted list-note">Recherche…</div>
            : !hits.length ? <div className="muted list-note">Aucun message ne correspond.</div>
              : hits.map((h) => (
                <button key={h.session_id} className={`row-item hit ${h.session_id === sessionId ? 'on' : ''}`} onClick={() => onSession(h.session_id, h.item_id)}>
                  <span className="hit-head">
                    {h.parent_id && <Icon name="branch" size={13} className="muted" />}
                    <span className="grow ellipsis">{h.title ?? 'Nouvelle session'}</span>
                    {!!h.archived && <Icon name="archive" size={12} className="muted" aria-label="archivée" />}
                    <span className="sub">{h.hits > 1 ? `${h.hits} · ` : ''}{rel(h.updated_at)}</span>
                  </span>
                  <span className="hit-snippet"><Snippet text={h.snippet} /></span>
                </button>
              ))
        ) : (
          <>
            {active.map(sessionRow)}
            {!active.length && project && <div className="muted list-note">Aucune session pour l'instant.</div>}
            {archived.length > 0 && (
              <details className="archived" open={archived.some((s) => s.id === sessionId) || undefined}>
                <summary className="row-item"><Icon name="archive" size={14} /><span className="grow">Archivées</span><span className="sub">{archived.length}</span><Icon className="chev" name="chevronRight" size={13} /></summary>
                {archived.map(sessionRow)}
              </details>
            )}
          </>
        )}
      </div>

      <div className="roster" aria-label="Agents">
        {agents.map((a) => {
          const state = !a.installed ? 'sleeping' : live?.busy && live.agent === a.id ? 'working' : 'default';
          return (
            <div key={a.id} className="row-item" title={a.installed ? a.strengths : `${a.name} n'est pas installé sur le serveur`}>
              <AgentAvatar id={a.id} size={28} state={state} paused={!a.installed} />
              <span className="grow ellipsis">{a.name}</span>
              <span className={`dot ${a.installed ? 'ok' : ''}`} />
            </div>
          );
        })}
      </div>

      {dialog && <ProjectDialog onClose={() => setDialog(false)} onCreated={(p) => { setDialog(false); onCreated(p); }} />}
    </aside>
  );
}

/** A search snippet: the server wraps matches in \u0002 … \u0003, rendered as <mark> (never as HTML). */
function Snippet({ text }: { text: string }) {
  return <>{text.split('\u0002').map((part, i) => {
    if (!i) return part;
    const end = part.indexOf('\u0003');
    return end < 0 ? part : <Fragment key={i}><mark>{part.slice(0, end)}</mark>{part.slice(end + 1)}</Fragment>;
  })}</>;
}

function ProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (p: Project) => void }) {
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = guard(async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true); setErr(f.get('git') ? 'Clonage en cours…' : '');
    try {
      const p = await api<Project & { failed?: string[] }>('/projects', { name: f.get('name'), path: f.get('path') || undefined, git: f.get('git') || undefined });
      if (p.failed?.length) toast(`Projet créé. ${p.failed.length} document(s) illisible(s), non indexé(s) : ${p.failed.slice(0, 3).join(', ')}${p.failed.length > 3 ? '…' : ''}`, true);
      onCreated(p);
    } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  });
  return (
    <div className="scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="card dialog" role="dialog" aria-modal="true" aria-labelledby="pd-title">
        <form onSubmit={submit}>
          <h3 id="pd-title">Nouveau projet</h3>
          <input className="input" name="name" placeholder="Nom (ex. avity-site)" pattern="[\w.\-]{1,64}" required autoFocus />
          <input className="input" name="path" placeholder="Chemin absolu d'un dossier existant (optionnel)" />
          <input className="input" name="git" placeholder="Ou URL git à cloner (optionnel)" />
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>Sans chemin ni URL, un dossier vide est créé dans ~/projects. Parfait aussi pour un projet « vie » : notes, admin, idées.</p>
          <div className="err">{err}</div>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn ghost" onClick={onClose}>Annuler</button>
            <button className="btn primary" disabled={busy}>Créer</button>
          </div>
        </form>
      </div>
    </div>
  );
}
