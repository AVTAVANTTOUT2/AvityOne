// App shell: auth, data loading, live event stream, and the three-column layout.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { MetalFx, MetalText } from 'metal-fx';
import { BorderBeam } from 'border-beam';
import { api, subscribe, type Agent, type Item, type LiveState, type Project, type SessionRow, type Snapshot } from './api';
import { AgentAvatar, Cover, LogoMark } from './brand';
import { Icon } from './icons';
import { Sidebar } from './Sidebar';
import { Feed, activity, type FeedActions } from './Feed';
import { Dock, type DockActions } from './Composer';
import { Panel } from './Panel';
import { Boundary, MetalSafe, Popover, Toaster, guard, toast } from './ui';

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
      <Boundary fallback={<Crashed />}>
        {authed === false && <Login onDone={() => location.reload()} />}
        {authed && <Workspace />}
      </Boundary>
      <Toaster />
    </>
  );
}

function Crashed() {
  return (
    <div className="login">
      <div className="card dialog crashed" role="alert">
        <h3><Icon name="alert" size={18} />L'interface a rencontré une erreur</h3>
        <p className="muted">Tes sessions continuent de tourner sur le serveur : recharger ne perd rien.</p>
        <button className="btn primary" onClick={() => location.reload()}><Icon name="refresh" size={14} />Recharger</button>
      </div>
    </div>
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
        <div className="stage login-hero"><Cover seed="avityone" auto count={4} /></div>
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
  const [side, setSide] = useState(false);
  const [panel, setPanel] = useState(() => store.get('avity.panel') === '1' && innerWidth > 1100);
  const [away, setAway] = useState(false); // scrolled up, away from the latest output
  const sid = useRef<string | null>(null);
  const pid = useRef<number | null>(null);
  const known = useRef<Project[]>([]);
  const opening = useRef(0);
  const feed = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);
  const queue = useRef(new Map<number, Item>());
  const frame = useRef(0);

  const loadSessions = useCallback(async (projectId: number) => {
    const rows = await api<SessionRow[]>(`/projects/${projectId}/sessions`);
    if (pid.current === projectId) setSessions(rows);
    return rows;
  }, []);

  const openSession = useCallback(async (id: string) => {
    const n = ++opening.current;
    const snap = await api<Snapshot>(`/sessions/${id}`);
    if (n !== opening.current) return; // a later click won the race
    sid.current = id;
    queue.current.clear();
    setSession(snap.session); setLive(snap.state); setItems(snap.items);
    stick.current = true; setAway(false);
    history.replaceState(null, '', `#/p/${snap.session.project_id}/s/${id}`);
    setSide(false);
  }, []);

  const openProject = useCallback(async (id: number, sessionId?: string) => {
    pid.current = id;
    setProject(known.current.find((p) => p.id === id) ?? null);
    store.set('avity.project', String(id));
    const rows = await loadSessions(id);
    const target = sessionId ?? rows[0]?.id;
    if (target) await openSession(target);
    else {
      opening.current++;
      sid.current = null; setSession(null); setLive(null); setItems([]);
      history.replaceState(null, '', `#/p/${id}`);
    }
  }, [loadSessions, openSession]);

  // boot
  useEffect(() => {
    api<{ agents: Agent[]; projects: Project[] }>('/state').then((st) => {
      known.current = st.projects;
      setAgents(st.agents); setProjects(st.projects);
      const [, p, s] = location.hash.match(/^#\/p\/(\d+)(?:\/s\/([\w-]+))?/) ?? [];
      const first = st.projects.find((x) => String(x.id) === (p ?? store.get('avity.project'))) ?? st.projects[0];
      if (first) openProject(first.id, s).catch(() => openProject(first.id));
    }).catch((e) => toast(e.message, true));
  }, [openProject]);

  // live events, batched per animation frame
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

  useLayoutEffect(() => { if (feed.current) feed.current.scrollTop = items.length && stick.current ? feed.current.scrollHeight : items.length ? feed.current.scrollTop : 0; }, [items]);

  // the mobile drawer closes like any sheet: Escape or a tap outside
  useEffect(() => {
    if (!side) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setSide(false); };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [side]);

  /** Puts text in the composer and hands it the caret, ready to edit or send. */
  const compose = useCallback((t: string) => {
    setDraft(t);
    requestAnimationFrame(() => { const el = input.current; if (el && !el.disabled) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } });
  }, []);

  const S = () => sid.current!;
  const feedAct: FeedActions = useMemo(() => ({
    permission: async (permId: number, optionId: string) => {
      try { await api(`/sessions/${S()}/permission`, { permId, optionId }); return true; } catch (e) { toast((e as Error).message, true); return false; }
    },
    openSession: (id: string) => { openSession(id).catch((e) => toast(e.message, true)); },
    merge: guard(() => api(`/sessions/${S()}/merge`, {})),
    useText: compose,
  }), [openSession, compose]);
  const dockAct: DockActions = useMemo(() => ({
    send: async (text, agent, mode) => {
      try {
        // A project without sessions is still ready to talk to: its first message opens one.
        if (!sid.current && pid.current != null) await openSession((await api<SessionRow>(`/projects/${pid.current}/sessions`, {})).id);
        await api(`/sessions/${S()}/prompt`, { text, agent, mode: mode || undefined });
        stick.current = true; setAway(false);
        return true;
      } catch (e) { toast((e as Error).message, true); return false; }
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
  }), [openSession]);

  const newSession = guard(async () => {
    if (!project) return;
    const s = await api<SessionRow>(`/projects/${project.id}/sessions`, {});
    await loadSessions(project.id);
    await openSession(s.id);
    requestAnimationFrame(() => input.current?.focus());
  });

  const busyInfo = activity(items, live);
  const last = items.at(-1);
  const planReady = !!session && !!live && !live.busy && live.mode === 'plan' && last?.type === 'end';
  const title = sessions.find((s) => s.id === session?.id)?.title ?? session?.title ?? 'Nouvelle session';
  const configs = (live?.configOptions ?? []).filter((o) => o.type === 'select' && o.category !== 'mode');
  const flat = (opts: any[]): any[] => opts.flatMap((x) => (x.options ? flat(x.options) : [x]));
  const configSelect = (o: (typeof configs)[number]) => (
    <select className="select" value={o.currentValue} title={o.name} aria-label={o.name}
      onChange={guard((e) => api(`/sessions/${S()}/config`, { configId: o.id, value: e.target.value }).then(setLive))}>
      {flat(o.options).map((x) => <option key={x.value} value={x.value}>{x.name}</option>)}
    </select>
  );

  return (
    <div className="app">
      <Sidebar open={side} projects={projects} project={project} sessions={sessions} sessionId={session?.id ?? null} live={live} agents={agents}
        onProject={(id) => openProject(id).catch((e) => toast(e.message, true))} onSession={(id) => feedAct.openSession(id)} onNewSession={newSession}
        onCreated={(p) => {
          known.current = [...known.current, p].sort((a, b) => a.name.localeCompare(b.name));
          setProjects(known.current);
          openProject(p.id).catch((e) => toast(e.message, true));
        }} onClose={() => setSide(false)} />
      {side && <div className="side-scrim" onClick={() => setSide(false)} aria-hidden="true" />}

      <main className="main">
        <header className="head">
          <button className="chip icon only-mobile" onClick={() => setSide(true)} aria-label="Menu" aria-expanded={side}><Icon name="menu" size={16} /></button>
          <div className="title">
            <b className="ellipsis">{session ? title : project?.name ?? 'AvityOne'}</b>
            {session && (
              <div className="meta">
                {live?.agent ? <><AgentAvatar id={live.agent} size={16} paused /><span className="ellipsis">{agents.find((a) => a.id === live.agent)?.name}</span></> : <span>aucun agent encore</span>}
                {live?.mode === 'plan' && <span className="tag plan">plan</span>}
                {live?.modeId && <span className="hide-mobile">· {live.modeId}</span>}
                {live?.worktree && <span className="tag"><Icon name="tree" size={11} />worktree</span>}
                {live?.connected && <span className="hide-mobile">· connecté</span>}
              </div>
            )}
          </div>
          {configs.length > 0 && <div className="row hide-mobile">{configs.map((o) => <span key={o.id}>{configSelect(o)}</span>)}</div>}
          {configs.length > 0 && (
            <span className="only-mobile">
              <Popover down trigger={(toggle, open) => (
                <button className={`chip icon ${open ? 'on' : ''}`} onClick={toggle} aria-haspopup="true" aria-expanded={open} aria-label="Réglages de l'agent" title="Réglages de l'agent">
                  <Icon name="sliders" size={16} />
                </button>
              )}>
                {() => <div className="menu-form">{configs.map((o) => <label key={o.id}><span>{o.name}</span>{configSelect(o)}</label>)}</div>}
              </Popover>
            </span>
          )}
          {live?.worktree && <button className="chip" onClick={dockAct.merge} disabled={live.busy} title="Merger le worktree"><Icon name="merge" size={14} /><span className="hide-mobile">Merger</span></button>}
          <button className={`chip icon ${panel ? 'on' : ''}`} title="Mémoire & contexte" aria-label="Mémoire et contexte" aria-pressed={panel}
            onClick={() => { setPanel(!panel); store.set('avity.panel', panel ? '0' : '1'); }}><Icon name="panel" size={16} /></button>
        </header>

        <div className="feed-wrap">
          <div className="feed" ref={feed} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 140; setAway(!stick.current); }}>
            <Feed items={items} live={live} project={project} agents={agents} act={feedAct} onSuggest={compose} />
          </div>
          {away && items.length > 0 && (
            <button className="chip icon to-latest" aria-label="Aller au dernier message" title="Aller au dernier message"
              onClick={() => feed.current?.scrollTo({ top: feed.current.scrollHeight, behavior: 'smooth' })}><Icon name="chevron" size={16} /></button>
          )}
        </div>

        <Dock live={live} agents={agents} hasSession={!!session} ready={!!project} planReady={planReady} activity={busyInfo} draft={draft} setDraft={setDraft} inputRef={input} act={dockAct} />
      </main>

      {panel && project && <Panel project={project} sessionId={session?.id ?? null} draft={draft} onClose={() => { setPanel(false); store.set('avity.panel', '0'); }} />}
    </div>
  );
}
