// App shell: auth, data loading, live event stream, and the three-column layout.
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { MetalFx, MetalText } from 'metal-fx';
import { BorderBeam } from 'border-beam';
import { api, subscribe, type Agent, type Item, type LiveState, type Project, type SessionRow, type Snapshot } from './api';
import { AgentAvatar, LogoMark } from './brand';
import { Icon } from './icons';
import { Sidebar } from './Sidebar';
import { Feed, activity, type FeedActions } from './Feed';
import { Dock, type DockActions } from './Composer';
import { Panel } from './Panel';
import { SessionMenu, TitleInput, type SessionActions } from './SessionMenu';
import { MetalSafe, Toaster, guard, toast } from './ui';

const Hero = lazy(() => import('./Hero'));
const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

export function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const was = useRef(false);
  useEffect(() => {
    api('/state').then(() => { was.current = true; setAuthed(true); }).catch(() => setAuthed(false));
    // Switching screens reloads the page: metal-fx's shared WebGL context does not come back after its last
    // instance unmounts, and a fresh page also resets every live subscription.
    const out = () => { if (was.current) location.reload(); };
    window.addEventListener('avity:logout', out);
    return () => window.removeEventListener('avity:logout', out);
  }, []);
  return (
    <>
      {authed === false && <Login onDone={() => location.reload()} />}
      {authed && <Workspace />}
      <Toaster />
    </>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [token, setToken] = useState('');
  const [err, setErr] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try { await api('/login', { token }); onDone(); } catch (x) { setErr((x as Error).message); }
  };
  return (
    <div className="login">
      <div className="card login-card">
        <div className="stage login-hero"><Suspense fallback={null}><Hero seed="avityone" auto count={4} /></Suspense></div>
        <form className="login-form" onSubmit={submit}>
          <h1><LogoMark size={24} /><MetalSafe fallback="AvityOne"><MetalText font="500 22px/1 Inter, sans-serif" color="#ededed">AvityOne</MetalText></MetalSafe></h1>
          <p>Ton orchestrateur Claude Code · Codex · Cursor · OpenCode.</p>
          <div className="login-row">
            <BorderBeam size="md" colorVariant="colorful" theme="dark" strength={0.7} style={{ flex: 1 }}>
              <input className="input" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Token d'accès"
                autoComplete="current-password" autoFocus required />
            </BorderBeam>
            {(() => {
              const go = <button className="metal-cta" style={{ height: 38 }}>Entrer <Icon name="arrowRight" size={14} /></button>;
              return <MetalSafe fallback={go}><MetalFx variant="button" preset="chromatic" theme="dark">{go}</MetalFx></MetalSafe>;
            })()}
          </div>
          <div className="err">{err}</div>
        </form>
      </div>
    </div>
  );
}

function Workspace() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [session, setSession] = useState<Snapshot['session'] | null>(null);
  const [live, setLive] = useState<LiveState | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [draft, setDraft] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [side, setSide] = useState(false);
  const [panel, setPanel] = useState(() => store.get('avity.panel') === '1' && innerWidth > 1100);
  const sid = useRef<string | null>(null);
  const pid = useRef<number | null>(null);
  const feed = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const focusItem = useRef<number | null>(null);

  // Drafts belong to their session and live on the server (they follow you from phone to desktop). Saves are
  // debounced and always go to the session the text was typed in, even if you switch sessions meanwhile.
  const unsaved = useRef<{ id: string; text: string } | null>(null);
  const saveTimer = useRef(0);
  const flushDraft = useCallback(() => {
    clearTimeout(saveTimer.current);
    const d = unsaved.current;
    unsaved.current = null;
    if (!d) return;
    const body = JSON.stringify({ text: d.text });
    // keepalive lets the save outlive a closing tab (the browser caps such bodies at 64 KB).
    fetch(`/api/sessions/${d.id}/draft`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body, keepalive: body.length < 60_000 }).catch(() => {});
  }, []);
  const editDraft = useCallback((text: string) => {
    setDraft(text);
    if (!sid.current) return;
    unsaved.current = { id: sid.current, text };
    clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(flushDraft, 600);
  }, [flushDraft]);
  useEffect(() => {
    const hidden = () => { if (document.visibilityState === 'hidden') flushDraft(); };
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', flushDraft);
    return () => { document.removeEventListener('visibilitychange', hidden); window.removeEventListener('pagehide', flushDraft); };
  }, [flushDraft]);

  const loadSessions = useCallback(async (projectId: number) => {
    const rows = await api<SessionRow[]>(`/projects/${projectId}/sessions`);
    if (pid.current === projectId) setSessions(rows);
    return rows;
  }, []);

  /** Opens a session; with `itemId`, scrolls to that message (history search) instead of the bottom. */
  const openSession = useCallback(async (id: string, itemId?: number) => {
    flushDraft();
    const snap = await api<Snapshot>(`/sessions/${id}`);
    // Reopening the same session (stream reconnect) keeps what is being typed.
    if (id !== sid.current) { setDraft(snap.session.draft ?? ''); setRenaming(false); }
    sid.current = id;
    setSession(snap.session); setLive(snap.state); setItems(snap.items);
    focusItem.current = itemId ?? null;
    stick.current = itemId == null;
    history.replaceState(null, '', `#/p/${snap.session.project_id}/s/${id}`);
    setSide(false);
  }, [flushDraft]);

  const closeSession = useCallback((projectId: number) => {
    flushDraft();
    sid.current = null; setSession(null); setLive(null); setItems([]); setDraft('');
    history.replaceState(null, '', `#/p/${projectId}`);
  }, [flushDraft]);

  const openProject = useCallback(async (id: number, sessionId?: string) => {
    pid.current = id;
    setProject((await api<{ projects: Project[] }>('/state')).projects.find((p) => p.id === id) ?? null);
    store.set('avity.project', String(id));
    const rows = await loadSessions(id);
    const target = sessionId ?? rows.find((r) => !r.archived)?.id;
    if (target) await openSession(target);
    else closeSession(id);
  }, [loadSessions, openSession, closeSession]);

  // boot
  useEffect(() => {
    api<{ agents: Agent[]; projects: Project[] }>('/state').then((st) => {
      setAgents(st.agents); setProjects(st.projects);
      const [, p, s] = location.hash.match(/^#\/p\/(\d+)(?:\/s\/([\w-]+))?/) ?? [];
      const first = st.projects.find((x) => String(x.id) === (p ?? store.get('avity.project'))) ?? st.projects[0];
      if (first) openProject(first.id, s).catch(() => openProject(first.id));
    }).catch((e) => toast(e.message, true));
  }, [openProject]);

  // live events, batched per animation frame
  const queue = useRef(new Map<number, Item>());
  const frame = useRef(0);
  useEffect(() => subscribe((ev) => {
    if (ev.type === 'sessions') { if (ev.projectId === pid.current) loadSessions(ev.projectId); return; }
    if (ev.sessionId !== sid.current) return;
    if (ev.type === 'state') { setLive(ev.state); return; }
    if (ev.type !== 'item') return;
    queue.current.set(ev.item.id, ev.item);
    frame.current ||= requestAnimationFrame(() => {
      frame.current = 0;
      const q = [...queue.current.values()];
      queue.current.clear();
      setItems((prev) => {
        const next = prev.slice();
        for (const it of q) {
          let i = next.length - 1;
          while (i >= 0 && next[i].id !== it.id) i--;
          if (i >= 0) next[i] = it; else next.push(it);
        }
        return next;
      });
    });
  }, () => { if (sid.current) openSession(sid.current); }), [loadSessions, openSession]);

  useLayoutEffect(() => {
    const el = feed.current;
    if (!el) return;
    const target = focusItem.current != null && el.querySelector<HTMLElement>(`[data-item="${focusItem.current}"]`);
    focusItem.current = null;
    if (target) {
      target.scrollIntoView({ block: 'center' });
      target.classList.remove('flash');
      void target.offsetWidth; // restart the highlight when jumping to the same message twice
      target.classList.add('flash');
      return;
    }
    el.scrollTop = items.length && stick.current ? el.scrollHeight : items.length ? el.scrollTop : 0;
  }, [items]);

  const S = () => sid.current!;
  const feedAct: FeedActions = useMemo(() => ({
    permission: guard((permId: number, optionId: string) => api(`/sessions/${S()}/permission`, { permId, optionId })),
    openSession: (id: string) => { openSession(id).catch((e) => toast(e.message, true)); },
    merge: guard(() => api(`/sessions/${S()}/merge`, {})),
    useText: editDraft,
  }), [openSession, editDraft]);
  const dockAct: DockActions = useMemo(() => ({
    send: async (text, agent, mode) => {
      try { await api(`/sessions/${S()}/prompt`, { text, agent, mode: mode || undefined }); stick.current = true; return true; }
      catch (e) { toast((e as Error).message, true); return false; }
    },
    stop: guard(() => api(`/sessions/${S()}/cancel`, {})),
    execute: guard((agent: string) => api(`/sessions/${S()}/execute`, { agent })),
    parallel: guard(() => api(`/sessions/${S()}/parallel`, {})),
    review: guard(() => api(`/sessions/${S()}/review`, {})),
    summarize: guard(async () => {
      toast('Résumé en cours…');
      const r = await api(`/sessions/${S()}/summarize`, {});
      toast(r.skipped ? 'Rien à résumer.' : `Résumé : ${r.added ?? 0} connaissance(s) ajoutée(s).`);
    }),
    merge: guard(() => api(`/sessions/${S()}/merge`, {})),
    autoApprove: guard((on: boolean) => api(`/sessions/${S()}/auto-approve`, { on }).then(setLive)),
    isolated: guard((on: boolean) => api(`/sessions/${S()}/isolated`, { on }).then(setLive)),
  }), []);

  const patch = async (b: { title?: string; pinned?: boolean; archived?: boolean }, id = S()) => {
    const row = await api<SessionRow & { project_id: number }>(`/sessions/${id}`, b, 'PATCH');
    setSession((s) => (s?.id === row.id ? row : s));
    await loadSessions(row.project_id);
  };
  const sessionAct: SessionActions = {
    rename: () => setRenaming(true),
    pin: guard((on: boolean) => patch({ pinned: on })),
    archive: guard(async (on: boolean) => { await patch({ archived: on }); toast(on ? 'Session archivée : retrouve-la en bas de la liste.' : 'Session désarchivée.'); }),
    exportMd: guard(async () => {
      const { filename, markdown } = await api<{ filename: string; markdown: string }>(`/sessions/${S()}/export`);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
      a.download = filename;
      document.body.append(a); // some browsers only download from an attached link
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    }),
    remove: guard(async () => {
      const projectId = session!.project_id;
      if (unsaved.current?.id === S()) unsaved.current = null;
      await api(`/sessions/${S()}`, {}, 'DELETE');
      const next = (await loadSessions(projectId)).find((r) => !r.archived);
      if (next) await openSession(next.id); else closeSession(projectId);
      toast('Session supprimée.');
    }),
  };

  const newSession = guard(async () => {
    if (!project) return;
    const s = await api<SessionRow>(`/projects/${project.id}/sessions`, {});
    await loadSessions(project.id);
    await openSession(s.id);
  });

  const busyInfo = activity(items, live);
  const last = items.at(-1);
  const planReady = !!session && !!live && !live.busy && live.mode === 'plan' && last?.type === 'end';
  const row = sessions.find((s) => s.id === session?.id) ?? session; // the list is refreshed live (summaries, renames)
  const title = row?.title ?? 'Nouvelle session';
  const configs = (live?.configOptions ?? []).filter((o) => o.type === 'select' && o.category !== 'mode');
  const flat = (opts: any[]): any[] => opts.flatMap((x) => (x.options ? flat(x.options) : [x]));

  return (
    <div className="app">
      <Sidebar open={side} projects={projects} project={project} sessions={sessions} sessionId={session?.id ?? null} live={live} agents={agents}
        onProject={(id) => openProject(id).catch((e) => toast(e.message, true))} onNewSession={newSession}
        onSession={(id, itemId) => openSession(id, itemId).catch((e) => toast(e.message, true))}
        onCreated={(p) => { setProjects((ps) => [...ps, p].sort((a, b) => a.name.localeCompare(b.name))); openProject(p.id); }} onClose={() => setSide(false)} />

      <main className="main">
        <header className="head">
          <button className="chip icon only-mobile" onClick={() => setSide(true)} aria-label="Menu"><Icon name="menu" size={16} /></button>
          <div className="title">
            {session && renaming ? <TitleInput value={title} onClose={() => setRenaming(false)} onSave={guard((t: string) => patch({ title: t }, session.id))} />
              : <b className="ellipsis" onDoubleClick={() => session && setRenaming(true)}>{session ? title : project?.name ?? 'AvityOne'}</b>}
            {session && (
              <div className="meta">
                {!!row?.archived && <span className="tag"><Icon name="archive" size={11} />archivée</span>}
                {live?.agent ? <><AgentAvatar id={live.agent} size={16} paused />{agents.find((a) => a.id === live.agent)?.name}</> : <span>aucun agent encore</span>}
                {live?.mode === 'plan' && <span className="tag plan">plan</span>}
                {live?.modeId && <span className="hide-mobile">· {live.modeId}</span>}
                {live?.worktree && <span className="tag"><Icon name="tree" size={11} />worktree</span>}
                {live?.connected && <span className="hide-mobile">· connecté</span>}
              </div>
            )}
          </div>
          <div className="row hide-mobile">
            {configs.map((o) => (
              <select key={o.id} className="select" value={o.currentValue} title={o.name} aria-label={o.name}
                onChange={guard((e) => api(`/sessions/${S()}/config`, { configId: o.id, value: e.target.value }).then(setLive))}>
                {flat(o.options).map((x) => <option key={x.value} value={x.value}>{x.name}</option>)}
              </select>
            ))}
          </div>
          {live?.worktree && <button className="chip" onClick={dockAct.merge} disabled={live.busy}><Icon name="merge" size={14} /><span className="hide-mobile">Merger</span></button>}
          {row && <SessionMenu session={row} busy={!!live?.busy} act={sessionAct} />}
          <button className={`chip icon ${panel ? 'on' : ''}`} title="Mémoire & contexte" aria-label="Mémoire et contexte" aria-pressed={panel}
            onClick={() => { setPanel(!panel); store.set('avity.panel', panel ? '0' : '1'); }}><Icon name="panel" size={16} /></button>
        </header>

        <div className="feed" ref={feed} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 140; }}>
          <Feed items={items} live={live} project={project} agents={agents} act={feedAct} onSuggest={editDraft} />
        </div>

        <Dock live={live} agents={agents} hasSession={!!session} planReady={planReady} activity={busyInfo} draft={draft} setDraft={editDraft} act={dockAct} />
      </main>

      {panel && project && <Panel project={project} sessionId={session?.id ?? null} draft={draft} onClose={() => { setPanel(false); store.set('avity.panel', '0'); }} />}
    </div>
  );
}
