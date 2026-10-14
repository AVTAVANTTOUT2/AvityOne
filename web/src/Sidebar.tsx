// Left rail: brand, projects (with generative covers), sessions, agent roster.
import { useState, type FormEvent } from 'react';
import { MetalBadge, MetalText } from 'metal-fx';
import { BorderBeam } from 'border-beam';
import { api, hoursSince, rel, type Agent, type LiveState, type Project, type SessionRow } from './api';
import { AgentAvatar, LogoMark, coverUrl } from './brand';
import { Icon } from './icons';
import { MetalSafe, guard } from './ui';

export function Sidebar({ open, projects, project, sessions, sessionId, live, agents, onProject, onSession, onNewSession, onCreated, onClose }: {
  open: boolean; projects: Project[]; project: Project | null; sessions: SessionRow[]; sessionId: string | null; live: LiveState | null; agents: Agent[];
  onProject: (id: number) => void; onSession: (id: string) => void; onNewSession: () => void; onCreated: (p: Project) => void; onClose: () => void;
}) {
  const [dialog, setDialog] = useState(false);
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
          </button>
        ))}
      </div>

      <div className="section"><span>Sessions</span><button className="chip icon sm" style={{ width: 24, height: 24 }} onClick={onNewSession} disabled={!project} aria-label="Nouvelle session" title="Nouvelle session"><Icon name="plus" size={14} /></button></div>
      <div className="list grow">
        {sessions.map((s) => {
          const on = s.id === sessionId;
          const working = on && !!live?.busy;
          const row = (
            <button className={`row-item ${on ? 'on' : ''} ${s.parent_id ? 'child' : ''}`} title={s.summary ?? ''} onClick={() => onSession(s.id)}>
              {s.parent_id && <Icon name="branch" size={13} className="muted" />}
              {s.agent ? <AgentAvatar id={s.agent} size={20} state={working ? 'working' : hoursSince(s.updated_at) > 24 ? 'sleeping' : 'default'} paused={!working} />
                : <span className="icon-tile" style={{ width: 20, height: 20, borderRadius: 7 }}><Icon name="chat" size={12} /></span>}
              <span className="grow ellipsis">{s.title ?? 'Nouvelle session'}</span>
              <span className="sub">{rel(s.updated_at)}</span>
            </button>
          );
          return working ? <BorderBeam key={s.id} size="line" colorVariant="ocean" theme="dark" strength={0.9}>{row}</BorderBeam> : <div key={s.id}>{row}</div>;
        })}
        {!sessions.length && project && <div className="muted" style={{ padding: '6px 10px', fontSize: 12 }}>Aucune session pour l'instant.</div>}
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

function ProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (p: Project) => void }) {
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = guard(async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true); setErr(f.get('git') ? 'Clonage en cours…' : '');
    try {
      onCreated(await api<Project>('/projects', { name: f.get('name'), path: f.get('path') || undefined, git: f.get('git') || undefined }));
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
