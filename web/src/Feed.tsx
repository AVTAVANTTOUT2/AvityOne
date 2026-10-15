// The conversation: messages, tool timeline, plans, permissions, reviews and parallel runs.
import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { BorderBeam } from 'border-beam';
import { ThinkingOrb, type OrbState } from 'thinking-orbs';
import { Liquid } from 'liquid-gooey';
import type { Agent, Item, LiveState, Project } from './api';
import { AgentAvatar, Cover, ORB_FOR_KIND, LOOKS } from './brand';
import { Icon, KIND_ICON } from './icons';
import { Diff, Markdown, Popover } from './ui';

export type FeedActions = {
  /** Resolves false when the answer did not reach the agent, so the buttons can be used again. */
  permission: (permId: number, optionId: string) => Promise<boolean>;
  openSession: (id: string) => void;
  merge: () => void;
  useText: (text: string) => void;
  copy: (text: string) => void;
  /** Resolves to true once sent, so the editor can close. */
  edit: (itemId: number, text: string, fork: boolean) => Promise<boolean>;
  regenerate: (agent?: string) => void;
  /** Forks the session before message `before` (the whole conversation without it). */
  fork: (before?: number) => void;
};

type Turn = { copy: string; before?: number };

const STATUS: Record<string, [string, string]> = {
  pending: ['en attente', 'run'], in_progress: ['en cours', 'run'], running: ['en cours', 'run'], waiting: ['validation requise', 'plan'],
  completed: ['terminé', 'ok'], done: ['terminé', 'ok'], merged: ['mergé', 'ok'], failed: ['échec', 'bad'], error: ['erreur', 'bad'], conflict: ['conflit', 'bad'],
  interrupted: ['interrompu', ''],
};
const Status = ({ s }: { s: string }) => { const [label, cls] = STATUS[s] ?? [s, '']; return <span className={`tag ${cls}`}>{label}</span>; };

function verb(it: Item): string {
  const t = it.title ? ` ${it.title}` : '';
  return ({ read: `lit${t}`, search: `cherche${t}`, edit: `modifie${t}`, delete: `supprime${t}`, move: `déplace${t}`, execute: `exécute${t}`, fetch: `consulte${t}`, think: 'réfléchit' } as Record<string, string>)[it.kind] ?? `utilise${t}`;
}

/** What the agent is doing right now, from the tail of the feed. */
export function activity(items: Item[], live: LiveState | null): { orb: OrbState; label: string } | null {
  if (!live?.busy) return null;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.type === 'user') return { orb: 'connecting', label: 'charge le contexte' };
    if (it.type === 'permission' && !it.resolved) return { orb: 'breathing', label: 'attend ta validation' };
    if (it.type === 'tool' && (it.status === 'pending' || it.status === 'in_progress')) return { orb: ORB_FOR_KIND[it.kind] ?? 'working', label: verb(it) };
    if (it.type === 'assistant') return { orb: 'composing', label: 'rédige' };
    if (it.type === 'thought') return { orb: 'solving', label: 'réfléchit' };
    if (it.type === 'plan') return { orb: 'weaving', label: 'planifie' };
    if (it.type === 'tool') return { orb: 'working', label: 'enchaîne' };
  }
  return { orb: 'connecting', label: 'démarre' };
}

/** What the agent itself produces during a turn: the turn's agent header goes above the first of them. */
const AGENT_ITEMS = new Set(['thought', 'tool', 'plan', 'assistant', 'permission']);

export function Feed({ items, live, project, agents, act, onSuggest }: {
  items: Item[]; live: LiveState | null; project: Project | null; agents: Agent[]; act: FeedActions; onSuggest: (text: string) => void;
}) {
  const lastUser = useMemo(() => { for (let i = items.length - 1; i >= 0; i--) if (items[i].type === 'user') return i; return -1; }, [items]);
  // Per finished turn: its answer (to copy) and the next user message, where a fork from that turn stops.
  // A turn that failed (no `end`, an error last) can be retried.
  const { turns, retry } = useMemo(() => {
    const turns = new Map<number, Turn>();
    let texts: string[] = [], open: Turn[] = [], answered = true;
    for (const it of items) {
      if (it.type === 'user') { for (const t of open) t.before = it.id; open = []; texts = []; answered = false; }
      else if (it.type === 'assistant') texts.push(it.text);
      else if (it.type === 'end') { const t: Turn = { copy: texts.join('\n\n').trim() }; turns.set(it.id, t); open.push(t); answered = true; }
    }
    const last = items.at(-1);
    return { turns, retry: !answered && last?.type === 'error' ? last.id : null };
  }, [items]);
  if (!items.length) return <Empty project={project} agents={agents} onSuggest={onSuggest} />;
  const busy = !!live?.busy;
  let headShown = false;
  let turnAgent: string | undefined;
  return (
    <div className="feed-inner">
      {items.map((it, i) => {
        if (it.type === 'user') { headShown = false; turnAgent = it.agent; }
        const latest = i > lastUser;
        const working = latest && busy;
        const head = AGENT_ITEMS.has(it.type) && !headShown;
        if (head) headShown = true;
        const t = it.type === 'end' ? turns.get(it.id) : undefined;
        // Only rows with actions get `busy`, so a turn starting or ending doesn't re-render the whole feed.
        const actionable = it.type === 'user' || it.type === 'end' || it.id === retry;
        return (
          <Fragment key={it.id}>
            {head && <AgentHead id={it.agent ?? turnAgent} agents={agents} working={working} latest={latest} />}
            {/* data-item lets a history-search hit scroll to its message. */}
            <div className="feed-item" data-item={it.id}>
              <Row it={it} live={working} latest={latest} agents={agents} act={act}
                busy={actionable ? busy : undefined} copy={t?.copy} before={t?.before} retry={it.id === retry} />
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}

const agentName = (agents: Agent[], id?: string) => agents.find((a) => a.id === id)?.name ?? id ?? 'Agent';

function AgentHead({ id, agents, working, latest }: { id?: string; agents: Agent[]; working: boolean; latest: boolean }) {
  return (
    <div className="agent-head">
      <AgentAvatar id={id} size={32} state={working ? 'working' : 'default'} paused={!latest} />
      <span className="who">{agentName(agents, id)}</span>
    </div>
  );
}

const Row = memo(function Row({ it, live, latest, agents, act, busy = false, copy, before, retry }: {
  it: Item; live: boolean; latest: boolean; agents: Agent[]; act: FeedActions;
  busy?: boolean; copy?: string; before?: number; retry?: boolean;
}) {
  switch (it.type) {
    case 'user':
      return <UserMessage it={it} agents={agents} busy={busy} act={act} />;
    case 'assistant':
      return <div className="msg-agent"><Markdown text={it.text ?? ''} />{it.content?.length > 0 && <Media blocks={it.content} />}</div>;
    case 'thought':
      return (
        <details className="thought">
          <summary>{live ? <ThinkingOrb state="solving" size={20} /> : <Icon name="bulb" size={14} />}Réflexion</summary>
          <div className="body">{it.text}</div>
        </details>
      );
    case 'tool': {
      const open = it.status === 'pending' || it.status === 'in_progress';
      const running = live && open;
      const body = it.command || it.paths?.length || it.diffs?.length || it.output;
      return (
        <details className="tool">
          <summary>
            <span className="glyph">{running ? <ThinkingOrb state={ORB_FOR_KIND[it.kind] ?? 'working'} size={20} /> : <Icon name={KIND_ICON[it.kind] ?? 'plug'} size={15} />}</span>
            <span className="t grow ellipsis">{it.title}</span>
            {it.diffs?.length ? <span className="muted mono" style={{ fontSize: 11 }}>{it.diffs.length} fichier{it.diffs.length > 1 ? 's' : ''}</span> : null}
            {it.status !== 'completed' && <Status s={open && !running ? 'interrupted' : it.status} />}
            {body ? <Icon className="chev" name="chevronRight" size={14} /> : null}
          </summary>
          {body ? (
            <div className="body">
              {it.command && <pre>$ {it.command}</pre>}
              {it.paths?.length ? <div className="paths">{it.paths.map((p: string) => <span key={p} className="tag mono">{p}</span>)}</div> : null}
              {it.diffs?.map((d: any) => <Diff key={d.path} path={d.path} oldText={d.old} newText={d.new} />)}
              {it.output && <pre>{it.output}</pre>}
            </div>
          ) : null}
        </details>
      );
    }
    case 'plan':
      return (
        <div className="card fcard">
          <div className="fcard-head">{live ? <ThinkingOrb state="weaving" size={20} /> : <span className="icon-tile"><Icon name="layers" size={15} /></span>}Plan
            <span className="muted">{it.entries.filter((e: any) => e.status === 'completed').length}/{it.entries.length}</span></div>
          <div className="stage">
            <ul className="plan-list">
              {it.entries.map((e: any, k: number) => (
                <li key={k} className={e.status}><span className="box">{e.status === 'completed' && <Icon name="check" size={12} strokeWidth={2.6} />}</span>{e.content}</li>
              ))}
            </ul>
          </div>
        </div>
      );
    case 'permission':
      return <Permission it={it} act={act} />;
    case 'review': {
      const running = it.status === 'running';
      const card = (
        <div className="card fcard">
          <div className="fcard-head">
            <AgentAvatar id={it.agent} size={26} state={running ? 'working' : 'default'} paused={!latest} />
            Revue croisée <span className="muted">par {agentName(agents, it.agent)}</span>
            <span className="grow" />
            {running ? <ThinkingOrb state="solving" size={20} /> : <Status s={it.status} />}
          </div>
          <div className="stage"><Markdown text={it.text || '…'} /></div>
          {it.status === 'done' && (
            <div className="fcard-actions">
              <button className="btn" onClick={() => act.useText(`Applique les corrections pertinentes de cette revue (ignore les faux positifs, justifie) :\n\n${it.text}`)}>
                <Icon name="edit" size={14} />Appliquer les corrections
              </button>
            </div>
          )}
        </div>
      );
      return running ? <BorderBeam size="md" colorVariant="mono" theme="dark" strength={0.8}>{card}</BorderBeam> : card;
    }
    case 'parallel':
      return <Parallel it={it} agents={agents} act={act} />;
    case 'info':
      return it.level === 'warn'
        ? <div className="info-line warn" role="status"><Icon name="alert" size={15} /><span>{it.text.replace(/^⚠️\s*/, '')}</span></div>
        : <div className="info-line"><AgentAvatar id="avity" size={16} paused /><span>{it.text}</span></div>;
    case 'error':
      return (
        <div className="error-line">
          {it.text}
          {retry && <div className="error-actions"><button className="chip sm" disabled={busy} onClick={() => act.regenerate()}><Icon name="refresh" size={13} />Réessayer</button></div>}
        </div>
      );
    case 'end':
      return <TurnEnd it={it} copy={copy ?? ''} before={before} busy={busy} agents={agents} act={act} />;
    default:
      return null;
  }
});

function UserMessage({ it, agents, busy, act }: { it: Item; agents: Agent[]; busy: boolean; act: FeedActions }) {
  const [editing, setEditing] = useState(false);
  if (editing) return <EditBox it={it} busy={busy} act={act} onClose={() => setEditing(false)} />;
  return (
    <div className="msg-user">
      <div className="bubble">{it.text}</div>
      {it.attachments?.length > 0 && <div className="attachments">{it.attachments.map((a: any) => <a key={a.id ?? a} className="chip" href={`/api/attachments/${encodeURIComponent(a.id ?? a)}`} download>{a.name ?? 'Pièce jointe'}</a>)}</div>}
      <div className="meta">
        <span className="msg-actions">
          <button className="chip xs icon" onClick={() => act.copy(it.text)} title="Copier le message" aria-label="Copier le message"><Icon name="copy" size={13} /></button>
          <button className="chip xs icon" onClick={() => setEditing(true)} disabled={busy} title="Modifier et renvoyer" aria-label="Modifier le message"><Icon name="edit" size={13} /></button>
        </span>
        <AgentAvatar id={it.agent} size={16} paused />
        <span>{agentName(agents, it.agent)}</span>
        {it.mode === 'plan' && <span className="tag plan">plan</span>}
        <span className="ellipsis" title={it.reason}>· {it.reason?.startsWith('règle /') ? 'règle de routage' : it.reason}</span>
        {it.edited && <span>· modifié</span>}
        {it.regenerated && <span>· régénéré</span>}
      </div>
    </div>
  );
}

/** In-place editor of a sent message: resend here (what followed is replaced) or in a fork of the session. */
function EditBox({ it, busy, act, onClose }: { it: Item; busy: boolean; act: FeedActions; onClose: () => void }) {
  const [text, setText] = useState<string>(it.text);
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; }
  }, [text]);
  useEffect(() => { const el = ref.current; el?.focus(); el?.setSelectionRange(el.value.length, el.value.length); }, []);
  const off = busy || sending || !text.trim();
  const send = async (fork: boolean) => {
    if (off) return;
    setSending(true);
    if (await act.edit(it.id, text, fork)) onClose(); else setSending(false);
  };
  return (
    <div className="msg-user editing">
      <div className="edit-box">
        <textarea ref={ref} rows={1} value={text} aria-label="Modifier le message" onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(false); }
            if (e.key === 'Escape') onClose();
          }} />
        <div className="edit-foot">
          <span className="muted grow">Renvoyer remplace la suite de la conversation. Les fichiers déjà modifiés restent tels quels.</span>
          <button className="btn ghost" onClick={onClose}>Annuler</button>
          <button className="btn" onClick={() => send(true)} disabled={off} title="Garde cette conversation et repart de ce message dans une nouvelle session">
            <Icon name="branch" size={14} />Dans une bifurcation
          </button>
          <button className="btn primary" onClick={() => send(false)} disabled={off}>Renvoyer</button>
        </div>
      </div>
    </div>
  );
}

/** End of a turn: copy its answer, regenerate it (last turn only), or fork the conversation from here. */
function TurnEnd({ it, copy, before, busy, agents, act }: { it: Item; copy: string; before?: number; busy: boolean; agents: Agent[]; act: FeedActions }) {
  const last = before === undefined;
  const others = agents.filter((a) => a.installed && a.id !== it.agent);
  return (
    <div className="turn-end">
      {it.stopReason !== 'end_turn' && <div className="cut">Tour interrompu : {it.stopReason}</div>}
      <div className={`turn-actions ${last ? 'last' : ''}`}>
        {copy && <button className="chip xs" onClick={() => act.copy(copy)} title="Copier la réponse de l'agent"><Icon name="copy" size={13} />Copier</button>}
        {last && (
          <Popover trigger={(toggle, open) => (
            <button className={`chip xs ${open ? 'on' : ''}`} onClick={toggle} disabled={busy} aria-haspopup="menu" aria-expanded={open}
              title="Remplace cette réponse : ta dernière demande est renvoyée"><Icon name="refresh" size={13} />Régénérer<Icon name="chevron" size={12} /></button>
          )}>
            {(close) => (
              <>
                <button role="menuitem" onClick={() => { close(); act.regenerate(); }}>
                  <AgentAvatar id={it.agent} size={24} paused />
                  <span className="grow">Même agent<span className="desc">{agentName(agents, it.agent)}</span></span>
                </button>
                {others.map((a) => (
                  <button key={a.id} role="menuitem" onClick={() => { close(); act.regenerate(a.id); }}>
                    <AgentAvatar id={a.id} size={24} paused />
                    <span className="grow">Avec {a.name}<span className="desc">{a.strengths}</span></span>
                  </button>
                ))}
              </>
            )}
          </Popover>
        )}
        <button className="chip xs" onClick={() => act.fork(before)} disabled={busy} title="Nouvelle session qui reprend la conversation jusqu'ici ; celle-ci reste intacte">
          <Icon name="branch" size={13} />Bifurquer ici
        </button>
      </div>
    </div>
  );
}

function Permission({ it, act }: { it: Item; act: FeedActions }) {
  const [sent, setSent] = useState(false);
  const planGate = it.kind === 'switch_mode';
  const card = (
    <div className="card fcard">
      <div className="fcard-head">
        {it.resolved ? <span className="icon-tile"><Icon name={planGate ? 'play' : 'shield'} size={15} /></span> : <ThinkingOrb state="breathing" size={20} />}
        {planGate ? 'Plan prêt — on l\'exécute ?' : 'Autorisation demandée'}
        <span className="muted grow ellipsis">{it.title}</span>
      </div>
      {it.text && <div className="stage perm-text"><Markdown text={it.text} /></div>}
      <div className="fcard-actions">
        {it.resolved ? <span className="muted" style={{ fontSize: 12 }}>→ {it.resolved}</span>
          : it.options.length ? it.options.map((o: any) => (
            <button key={o.id} className={`btn ${o.kind.startsWith('allow') ? 'primary' : 'ghost'}`} disabled={sent}
              onClick={() => { setSent(true); act.permission(it.id, o.id).then((ok) => { if (!ok) setSent(false); }); }}>{o.name}</button>
          )) : <span className="muted" style={{ fontSize: 12 }}>Utilise « Exécuter le plan » ci-dessous.</span>}
      </div>
    </div>
  );
  return it.resolved ? card : <BorderBeam size="pulse-inner" colorVariant={planGate ? 'ocean' : 'sunset'} theme="dark" duration={2.6}>{card}</BorderBeam>;
}

/** Sub-sessions as liquid droplets: they split apart when the work fans out and flow back together once merged. */
function Parallel({ it, agents, act }: { it: Item; agents: Agent[]; act: FeedActions }) {
  const kids: any[] = it.children;
  const [split, setSplit] = useState(false);
  useEffect(() => { const t = setTimeout(() => setSplit(true), 350); return () => clearTimeout(t); }, []);
  const merged = kids.every((c) => c.status === 'merged');
  const gap = 54, w = Math.max(kids.length * gap, 60);
  return (
    <div className="card fcard">
      <div className="fcard-head"><span className="icon-tile"><Icon name="parallel" size={15} /></span>Exécution parallèle
        <span className="muted">{kids.length} sous-session{kids.length > 1 ? 's' : ''}, une par worktree</span></div>
      <div className="stage">
        <div className="goo-stage">
          <Liquid fill="#262626" blur={8} contrast={22} shadow="0 4px 12px rgba(0,0,0,.4)" style={{ position: 'relative', width: w, height: 48 }}>
            {kids.map((c, i) => (
              <Liquid.Item key={c.id} x={split && !merged ? (i - (kids.length - 1) / 2) * gap : 0} transition="bouncy" delay={i * 70} radius={22}
                style={{ position: 'absolute', left: w / 2 - 22, top: 2 }}>
                <div className="goo-avatar"><AgentAvatar id={c.agent} size={30} state={c.status === 'running' ? 'working' : 'default'} /></div>
              </Liquid.Item>
            ))}
          </Liquid>
        </div>
        <div className="kids">
          {kids.map((c) => (
            <button key={c.id} className="kid" onClick={() => act.openSession(c.id)} title="Ouvrir la sous-session">
              <AgentAvatar id={c.agent} size={20} paused />
              <span className="grow ellipsis">{c.task}</span>
              {c.conflicts?.length ? <span className="conf">conflit : {c.conflicts.join(', ')}</span> : null}
              <Status s={c.status} />
              <Icon name="chevronRight" size={14} className="muted" />
            </button>
          ))}
        </div>
      </div>
      {!merged && <div className="fcard-actions"><button className="btn primary" onClick={act.merge}><Icon name="merge" size={14} />Merger les branches</button>
        <span className="muted" style={{ fontSize: 12, alignSelf: 'center' }}>puis revue croisée automatique</span></div>}
      {merged && <div className="fcard-actions"><span className="tag ok"><Icon name="check" size={12} />Tout est mergé</span></div>}
    </div>
  );
}

const SUGGESTIONS = [
  '/plan Analyse ce projet et propose les 5 améliorations les plus utiles',
  '@codex écris les tests manquants pour le module le plus critique',
  'Explique-moi l\'architecture de ce projet',
  '@cursor améliore le style de la page d\'accueil',
];

function Empty({ project, agents, onSuggest }: { project: Project | null; agents: Agent[]; onSuggest: (t: string) => void }) {
  const crew = Object.keys(LOOKS).filter((id) => id !== 'avity' && agents.some((a) => a.id === id));
  return (
    <div className="feed-inner">
      <div className="empty">
        {project && (
          <div className="card empty-hero">
            <div className="stage"><Cover key={project.name} seed={project.name} /></div>
            <div className="hero-meta">
              <Icon name="folder" size={15} className="muted" />
              <span className="ellipsis" style={{ flex: 'none', maxWidth: '45%' }}>{project.name}</span>
              {/* rtl keeps the end of the path visible; the LRMs stop it from moving the leading « / » to the end */}
              <span className="muted mono ellipsis grow path" title={project.path}>{`\u200e${project.path}\u200e`}</span>
            </div>
          </div>
        )}
        <h2>Que construit-on aujourd'hui ?</h2>
        <p>Le contexte du projet (mémoire, docs, git, sessions passées) est injecté automatiquement.</p>
        <div className="crew">
          {crew.map((id) => {
            const a = agents.find((x) => x.id === id)!;
            return (
              <button key={id} onClick={() => onSuggest(`@${id} `)} title={a.strengths} disabled={!a.installed}>
                <AgentAvatar id={id} size={48} state={a.installed ? 'default' : 'sleeping'} interactive />
                {a.name}
              </button>
            );
          })}
        </div>
        <div className="suggestions">{SUGGESTIONS.map((s) => <button key={s} className="chip" onClick={() => onSuggest(s)}>{s}</button>)}</div>
      </div>
    </div>
  );
}
import { Media } from './Media';
