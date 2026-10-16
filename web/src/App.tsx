// App shell: auth, data loading, live event stream, and the three-column layout.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { MetalFx, MetalText } from 'metal-fx';
import { BorderBeam } from 'border-beam';
import { api, subscribe, type Act, type Agent, type Item, type Link, type LiveActivity, type LiveState, type Project, type SessionRow, type Snapshot } from './api';
import { AgentAvatar, Cover, LogoMark } from './brand';
import { Icon } from './icons';
import { Sidebar } from './Sidebar';
import { Feed, activity, type FeedActions } from './Feed';
import { Dock, type DockActions } from './Composer';
import { Panel } from './Panel';
import { SessionMenu, TitleInput, type SessionActions } from './SessionMenu';
import { Boundary, MetalSafe, Popover, Toaster, copyText, guard, toast } from './ui';
import { canNotify, notifyOn, setNotify, systemNotify } from './notify';
import { Workbench } from './Workbench';
import { encodeFile } from './uploads';
import { Administration } from './Administration';
import { sessionDirection } from './shortcuts';

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
  const draftVersion = useRef(0), submissions = useRef(new Set<string>());
  const [sendingTargets, setSendingTargets] = useState<string[]>([]);
  const [renaming, setRenaming] = useState(false);
  const [side, setSide] = useState(false);
  const [workbench, setWorkbench] = useState(false);
  const [administration, setAdministration] = useState(false);
  const [panel, setPanel] = useState(() => store.get('avity.panel') === '1' && innerWidth > 1100);
  const [acts, setActs] = useState<Record<string, Act>>({});
  const [link, setLink] = useState<Link>('ok');
  const [notif, setNotif] = useState(notifyOn);
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible');
  const agentsRef = useRef<Agent[]>([]);
  agentsRef.current = agents;
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
  const focusItem = useRef<number | null>(null);
  const fromHistory = useRef(false); // browser back/forward: follow the URL without stacking a new entry

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
    draftVersion.current++;
    setDraft(text);
    if (!sid.current) return;
    unsaved.current = { id: sid.current, text };
    clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(flushDraft, 600);
  }, [flushDraft]);
  useEffect(() => {
    const vis = () => {
      const shown = document.visibilityState === 'visible';
      setVisible(shown);
      if (!shown) flushDraft();
      else if (sid.current) markSeen(sid.current); // what finished while the tab was hidden is now in view
    };
    document.addEventListener('visibilitychange', vis);
    window.addEventListener('pagehide', flushDraft);
    return () => { document.removeEventListener('visibilitychange', vis); window.removeEventListener('pagehide', flushDraft); };
  }, [flushDraft]);

  // Activity of every session, open or not: live state from `state` events, plus finished turns not seen yet.
  const track = useCallback((id: string, projectId: number, patch: Partial<Act>) => setActs((a) => ({ ...a, [id]: { ...a[id], projectId, ...patch } })), []);
  const markSeen = (id: string) => setActs((a) => (a[id]?.unread ? { ...a, [id]: { ...a[id], unread: undefined } } : a));
  const seed = useCallback((list: LiveActivity[]) => setActs((a) => {
    const now = new Map(list.map((x) => [x.sessionId, x]));
    const next: Record<string, Act> = {};
    for (const [id, v] of Object.entries(a)) {
      const x = now.get(id);
      // Was working, isn't any more: it finished while we weren't listening.
      const missed = v.busy && !x?.busy && id !== sid.current;
      next[id] = { ...v, busy: !!x?.busy, waiting: !!x?.waiting, unread: missed ? v.unread ?? 'done' : v.unread };
    }
    for (const x of list) next[x.sessionId] ??= { projectId: x.projectId, busy: x.busy, waiting: x.waiting };
    return next;
  }), []);

  const loadSessions = useCallback(async (projectId: number) => {
    const rows = await api<SessionRow[]>(`/projects/${projectId}/sessions`);
    if (pid.current === projectId) setSessions(rows);
    setActs((a) => {
      const next: Record<string, Act> = {};
      // Deleted sessions (and their sub-sessions) drop out, so an unseen result can't linger in the tab title.
      for (const [id, v] of Object.entries(a)) if (v.projectId !== projectId) next[id] = v;
      // Rows only seed what live `state` events haven't told us yet: a list fetched while a turn ran can land after
      // its end and would otherwise leave the session « busy ».
      for (const r of rows) next[r.id] = a[r.id] ? { ...a[r.id], projectId } : { projectId, busy: !!r.busy, waiting: !!r.waiting };
      return next;
    });
    return rows;
  }, []);

  /** Opens a session; with `itemId`, scrolls to that message (history search) instead of the bottom. */
  const openSession = useCallback(async (id: string, itemId?: number) => {
    flushDraft();
    const n = ++opening.current;
    const snap = await api<Snapshot>(`/sessions/${id}`);
    if (n !== opening.current) return; // a later click won the race
    const prev = sid.current;
    // Reopening the same session (stream reconnect) keeps what is being typed. So does opening one from no session
    // (« + » or a project's first message): the composer is live meanwhile, and that text is for this session.
    if (id !== prev) {
      const fromNone = prev === null;
      setDraft((typed) => snap.session.draft ?? (fromNone ? typed : ''));
      setRenaming(false);
    }
    sid.current = id;
    markSeen(id);
    queue.current.clear();
    setSession(snap.session); setLive(snap.state); setItems(snap.items);
    focusItem.current = itemId ?? null;
    stick.current = itemId == null; setAway(itemId != null);
    // Each session switch is a history entry: back/forward (and Android's back button) walk the visited sessions.
    const url = `#/p/${snap.session.project_id}/s/${id}`;
    if (location.hash !== url) history[prev && prev !== id && !fromHistory.current ? 'pushState' : 'replaceState'](null, '', url);
    setSide(false);
  }, [flushDraft]);

  const closeSession = useCallback((projectId: number) => {
    flushDraft();
    const had = sid.current;
    opening.current++; // an open still in flight must not land after this
    sid.current = null; setSession(null); setLive(null); setItems([]); setDraft('');
    history[had && !fromHistory.current ? 'pushState' : 'replaceState'](null, '', `#/p/${projectId}`);
  }, [flushDraft]);

  const openProject = useCallback(async (id: number, sessionId?: string) => {
    pid.current = id;
    let selected = known.current.find((p) => p.id === id);
    if (!selected) { selected = await api<Project>(`/projects/${id}`); if (pid.current !== id) return; known.current = [...known.current, selected]; }
    setProject(selected);
    store.set('avity.project', String(id));
    const rows = await loadSessions(id);
    if (pid.current !== id) return;
    const target = sessionId ?? rows.find((r) => !r.archived)?.id;
    if (target) await openSession(target);
    else closeSession(id);
  }, [loadSessions, openSession, closeSession]);

  // boot
  useEffect(() => {
    api<{ agents: Agent[]; projects: Project[]; activity: LiveActivity[] }>('/state').then((st) => {
      known.current = st.projects;
      setAgents(st.agents); setProjects(st.projects); seed(st.activity);
      const [, p, s] = location.hash.match(/^#\/p\/(\d+)(?:\/s\/([\w-]+))?/) ?? [];
      const first = st.projects.find((x) => String(x.id) === (p ?? store.get('avity.project'))) ?? st.projects[0];
      if (first) openProject(first.id, s).catch(() => openProject(first.id));
    }).catch((e) => toast(e.message, true));
  }, [openProject, seed]);

  useEffect(() => {
    const pop = () => {
      const [, p, s] = location.hash.match(/^#\/p\/(\d+)(?:\/s\/([\w-]+))?/) ?? [];
      if (!p) return;
      fromHistory.current = true;
      const go = Number(p) !== pid.current ? openProject(Number(p), s) : s ? openSession(s) : Promise.resolve(closeSession(Number(p)));
      go.catch((e) => toast(e.message, true)).finally(() => { fromHistory.current = false; });
    };
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, [openProject, openSession, closeSession]);

  // live events, batched per animation frame
  /** A turn ended or failed, or an agent waits: a toast when the page is in view, else a system notification. */
  const announce = useCallback((ev: { sessionId: string; projectId: number; kind: 'done' | 'error' | 'waiting'; title: string | null; agent: string | null; text: string }) => {
    const shown = document.visibilityState === 'visible';
    if (ev.sessionId === sid.current && shown) return; // already in front of the user
    if (ev.kind !== 'waiting') track(ev.sessionId, ev.projectId, { unread: ev.kind }); // waiting shows from live state
    const who = agentsRef.current.find((a) => a.id === ev.agent)?.name ?? 'L\'agent';
    const head = { done: `${who} a terminé`, error: 'Échec', waiting: `${who} attend ta validation` }[ev.kind];
    const title = `${head} · « ${ev.title ?? 'Nouvelle session'} »`;
    const open = () => {
      window.focus();
      (ev.projectId === pid.current ? openSession(ev.sessionId) : openProject(ev.projectId, ev.sessionId)).catch((e) => toast(e.message, true));
    };
    if (shown) toast(title, ev.kind === 'error', { label: 'Ouvrir', onClick: open });
    else systemNotify(title, ev.text, ev.sessionId, open);
  }, [track, openSession, openProject]);

  const resync = useCallback(async () => {
    try {
      seed((await api<{ activity: LiveActivity[] }>('/state')).activity);
      if (pid.current) await loadSessions(pid.current);
      if (sid.current) await openSession(sid.current);
    } catch { /* the next reconnect tries again */ }
  }, [seed, loadSessions, openSession]);

  useEffect(() => subscribe((ev) => {
    if (ev.type === 'sessions') { if (ev.projectId === pid.current) loadSessions(ev.projectId); return; }
    if (ev.type === 'state') track(ev.sessionId, ev.projectId, { busy: ev.state.busy, waiting: !!ev.state.waiting });
    if (ev.type === 'activity') { announce(ev); return; }
    if (ev.sessionId !== sid.current) return;
    if (ev.type === 'state') { setLive(ev.state); return; }
    if (ev.type === 'reset') {
      // The conversation was cut at `fromId` (edit, regenerate): drop those items, including any still queued.
      for (const id of queue.current.keys()) if (id >= ev.fromId) queue.current.delete(id);
      setItems((prev) => prev.filter((it) => it.id < ev.fromId));
      return;
    }
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
  }, {
    status: (s) => { setLink(s); if (s === 'ok') toast('Reconnecté au serveur.'); },
    reconnect: resync,
  }), [loadSessions, track, announce, resync]);

  // Tab title: how many sessions wait for you or finished unseen, e.g. « (2) AvityOne ».
  const pending = Object.entries(acts).filter(([id, a]) => (a.waiting || a.unread) && !(id === session?.id && visible)).length;
  useEffect(() => { document.title = pending ? `(${pending}) AvityOne` : 'AvityOne'; }, [pending]);

  const toggleNotify = guard(async () => {
    if (!canNotify()) {
      toast('Notifications système indisponibles ici : il faut HTTPS (ou localhost). Les alertes restent dans la page et le titre de l\'onglet.', true);
      return;
    }
    const on = await setNotify(!notif);
    setNotif(on);
    toast(on ? 'Notifications activées : fin, échec ou validation requise, quand l\'onglet est en arrière-plan.'
      : Notification.permission === 'denied' ? 'Notifications bloquées par le navigateur pour ce site.' : 'Notifications désactivées.', !on && Notification.permission === 'denied');
  });

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

  // the mobile drawer closes like any sheet: Escape or a tap outside
  useEffect(() => {
    if (!side) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setSide(false); };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [side]);

  /** Puts text in the composer and hands it the caret, ready to edit or send. */
  const compose = useCallback((t: string) => {
    editDraft(t);
    requestAnimationFrame(() => { const el = input.current; if (el && !el.disabled) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } });
  }, [editDraft]);

  const S = () => sid.current!;
  const feedAct: FeedActions = useMemo(() => ({
    permission: async (permId: number, optionId: string) => {
      try { await api(`/sessions/${S()}/permission`, { permId, optionId }); return true; } catch (e) { toast((e as Error).message, true); return false; }
    },
    openSession: (id: string) => { openSession(id).catch((e) => toast(e.message, true)); },
    merge: guard(() => api(`/sessions/${S()}/merge`, {})),
    useText: compose,
    copy: (text: string) => { copyText(text).then(() => toast('Copié dans le presse-papiers.'), (e) => toast(e.message, true)); },
    edit: async (itemId, text, fork) => {
      try {
        const r = await api<{ sessionId: string }>(`/sessions/${S()}/edit`, { itemId, text, fork });
        stick.current = true; setAway(false);
        if (r.sessionId !== sid.current) { await openSession(r.sessionId); toast('Bifurcation créée : la conversation d\'origine reste intacte.'); }
        return true;
      } catch (e) { toast((e as Error).message, true); return false; }
    },
    regenerate: guard(async (agent?: string) => { await api(`/sessions/${S()}/regenerate`, { agent }); stick.current = true; setAway(false); }),
    fork: guard(async (before?: number) => {
      const s = await api<SessionRow>(`/sessions/${S()}/fork`, { before });
      await openSession(s.id);
      toast(before == null ? 'Session dupliquée.' : 'Bifurcation créée : la suite part d\'ici, l\'original reste intact.');
    }),
  }), [openSession, compose]);
  const dockAct: DockActions = useMemo(() => ({
    send: async (text, agent, mode, files = []) => {
      const initialKey = sid.current ?? `project:${pid.current}`, version = draftVersion.current;
      if (submissions.current.has(initialKey)) return false;
      submissions.current.add(initialKey); setSendingTargets([...submissions.current]);
      let target = sid.current;
      try {
        // A project without sessions is still ready to talk to: its first message opens one.
        const projectId = pid.current;
        if (!target && projectId != null) {
          target = (await api<SessionRow>(`/projects/${projectId}/sessions`, {})).id;
          submissions.current.add(target); setSendingTargets([...submissions.current]);
          if (pid.current === projectId && !sid.current) await openSession(target);
        }
        if (!target) throw new Error('Aucune session sélectionnée');
        const attachments = [];
        for (const file of files) attachments.push((await api(`/sessions/${target}/attachments`, { name: file.name, mime: file.type || 'application/octet-stream', base64: await encodeFile(file) })).id);
        await api(`/sessions/${target}/prompt`, { text, agent, mode: mode || undefined, attachments });
        if (sid.current === target) {
          stick.current = true; setAway(false);
          if (draftVersion.current === version) editDraft('');
        }
        return true;
      } catch (e) { toast((e as Error).message, true); return false; }
      finally { submissions.current.delete(initialKey); if (target) submissions.current.delete(target); setSendingTargets([...submissions.current]); }
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
  }), [openSession, editDraft]);

  const patch = async (b: { title?: string; pinned?: boolean; archived?: boolean }, id = S()) => {
    const row = await api<SessionRow & { project_id: number }>(`/sessions/${id}`, b, 'PATCH');
    setSession((s) => (s?.id === row.id ? row : s));
    await loadSessions(row.project_id);
  };
  const sessionAct: SessionActions = {
    rename: () => setRenaming(true),
    pin: guard((on: boolean) => patch({ pinned: on })),
    duplicate: () => feedAct.fork(),
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
    requestAnimationFrame(() => input.current?.focus());
  });

  // Previous / next session, in the sidebar's order (pinned, recent, archived). Alt+↑ / Alt+↓ as in Slack.
  const at = sessions.findIndex((s) => s.id === session?.id);
  const step = useCallback((d: -1 | 1) => {
    const i = sessions.findIndex((s) => s.id === sid.current);
    const next = sessions[i < 0 ? 0 : i + d];
    if (next) openSession(next.id).catch((e) => toast(e.message, true));
  }, [sessions, openSession]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const direction = sessionDirection(e, !!document.querySelector('dialog[open]'));
      if (!direction) return;
      e.preventDefault();
      step(direction);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [step]);

  const busyInfo = activity(items, live);
  const last = items.at(-1);
  const planReady = !!session && !!live && !live.busy && live.mode === 'plan' && last?.type === 'end';
  const row = sessions.find((s) => s.id === session?.id) ?? session; // the list is refreshed live (summaries, renames)
  const title = row?.title ?? 'Nouvelle session';
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
      <Sidebar open={side} projects={projects} project={project} sessions={sessions} sessionId={session?.id ?? null} live={live} agents={agents} acts={acts}
        onProject={(id) => openProject(id).catch((e) => toast(e.message, true))} onNewSession={newSession}
        onSession={(id, itemId) => openSession(id, itemId).catch((e) => toast(e.message, true))}
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
            {session && renaming ? <TitleInput value={title} onClose={() => setRenaming(false)} onSave={guard((t: string) => patch({ title: t }, session.id))} />
              : <b className="ellipsis" onDoubleClick={() => session && setRenaming(true)}>{session ? title : project?.name ?? 'AvityOne'}</b>}
            {session && (
              <div className="meta">
                {!!row?.archived && <span className="tag"><Icon name="archive" size={11} />archivée</span>}
                {row?.forked_from && (
                  <button className="tag link" onClick={() => openSession(row.forked_from!).catch((e) => toast(e.message, true))} title="Ouvrir la session d'origine">
                    <Icon name="branch" size={11} />bifurcation
                  </button>
                )}
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
          <span className="row hide-mobile" style={{ gap: 2 }}>
            <button className="chip icon" onClick={() => step(-1)} disabled={at <= 0} aria-label="Session précédente" title="Session précédente (Alt+↑)"><Icon name="chevronUp" size={15} /></button>
            <button className="chip icon" onClick={() => step(1)} disabled={at < 0 ? !sessions.length : at >= sessions.length - 1} aria-label="Session suivante" title="Session suivante (Alt+↓)"><Icon name="chevron" size={15} /></button>
          </span>
          {live?.worktree && <button className="chip" onClick={dockAct.merge} disabled={live.busy} title="Merger le worktree"><Icon name="merge" size={14} /><span className="hide-mobile">Merger</span></button>}
          {row && <SessionMenu session={row} busy={!!live?.busy} act={sessionAct} />}
          <button className="chip icon" disabled={!project} title="Atelier : fichiers, plans, Git et terminal" aria-label="Ouvrir l’atelier" onClick={() => setWorkbench(true)}><Icon name="folder" size={16} /></button>
          <button className="chip icon" title="Administration" aria-label="Administration" onClick={() => setAdministration(true)}><Icon name="sliders" size={16} /></button>
          <button className={`chip icon hide-mobile ${notif ? 'on' : ''}`} onClick={toggleNotify} aria-pressed={notif} aria-label="Notifications"
            title={notif ? 'Notifications activées' : 'Être prévenu quand un agent termine, échoue ou attend ta validation'}><Icon name="bell" size={16} /></button>
          <button className={`chip icon ${panel ? 'on' : ''}`} title="Mémoire & contexte" aria-label="Mémoire et contexte" aria-pressed={panel}
            onClick={() => { setPanel(!panel); store.set('avity.panel', panel ? '0' : '1'); }}><Icon name="panel" size={16} /></button>
        </header>

        {link === 'lost' && <div className="conn-banner" role="status"><Icon name="alert" size={14} />Connexion au serveur perdue, reconnexion…</div>}

        <div className="feed-wrap">
          <div className="feed" ref={feed} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 140; setAway(!stick.current); }}>
            <Feed items={items} live={live} project={project} agents={agents} act={feedAct} onSuggest={compose} />
          </div>
          {away && items.length > 0 && (
            <button className="chip icon to-latest" aria-label="Aller au dernier message" title="Aller au dernier message"
              onClick={() => feed.current?.scrollTo({ top: feed.current.scrollHeight, behavior: 'smooth' })}><Icon name="chevron" size={16} /></button>
          )}
        </div>

        <Dock key={session?.id ?? project?.id} live={live} agents={agents} hasSession={!!session} ready={!!project} planReady={planReady} activity={busyInfo} draft={draft} setDraft={editDraft} pending={sendingTargets.includes(session?.id ?? `project:${project?.id}`)} inputRef={input} act={dockAct} />
      </main>

      {panel && project && <Panel project={project} sessionId={session?.id ?? null} draft={draft} onClose={() => { setPanel(false); store.set('avity.panel', '0'); }} />}
      {workbench && project && <Workbench project={project} sessionId={session?.id ?? null} onClose={() => setWorkbench(false)} />}
      {administration && <Administration onClose={() => setAdministration(false)} />}
    </div>
  );
}
