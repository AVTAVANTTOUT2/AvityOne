// Dock: live status pill, plan-ready bar and the composer (voice glow, liquid controls, liquid-metal send).
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { VoiceBeam, useMicrophone, type VoiceBeamMotion } from 'voice-glow';
import { MetalFx, useMetalBend } from 'metal-fx';
import { BorderBeam } from 'border-beam';
import { ThinkingOrb, type OrbState } from 'thinking-orbs';
import type { Agent, LiveState } from './api';
import { AgentAvatar } from './brand';
import { Icon } from './icons';
import { MetalSafe, PlusMenu, Popover, Segmented, toast } from './ui';

export type Mode = '' | 'agent' | 'plan';
export type DockActions = {
  send: (text: string, agent: string, mode: Mode) => Promise<boolean>;
  stop: () => void;
  execute: (agent: string) => void;
  parallel: () => void;
  review: () => void;
  summarize: () => void;
  merge: () => void;
  autoApprove: (on: boolean) => void;
  isolated: (on: boolean) => void;
};

const MODES: { value: Mode; label: string; title: string }[] = [
  { value: '', label: 'Auto', title: 'Le routeur choisit l\'agent et le mode' },
  { value: 'agent', label: 'Agent', title: 'Exécution avec outils' },
  { value: 'plan', label: 'Plan', title: 'Lecture seule : analyse et plan, sans rien modifier' },
];

/**
 * The « Processing » sweep (a Libraries Pro preset) rebuilt on voice-glow's public `motion` API:
 * the lobes gather into one beam that glides edge to edge, easing into each turn, stretching while it moves.
 */
function useProcessingSweep(active: boolean) {
  const on = useRef(active);
  on.current = active;
  const t0 = useRef(performance.now());
  return useCallback((): VoiceBeamMotion | null => {
    if (!on.current) return null;
    const t = (performance.now() - t0.current) / 1000, w = Math.PI / 2.2;
    const p = (Math.sin(t * w) + 1) / 2, eased = p * p * (3 - 2 * p);
    return { gather: 1, offset: (eased * 2 - 1) * 0.85, stretch: 0.4 * Math.abs(Math.cos(t * w)), heldLevel: 0.55, cornerFollow: 0.6 };
  }, []);
}

/** Dictation: voice-glow listens to the mic for the glow, the Web Speech API (where available) writes the words. */
function useDictation(append: (t: string) => void) {
  const mic = useMicrophone();
  const rec = useRef<any>(null);
  const stop = useCallback(() => { rec.current?.stop(); rec.current = null; mic.stop(); }, [mic]);
  const start = useCallback(async () => {
    const stream = await mic.start();
    if (!stream) return toast(mic.state === 'denied' ? 'Micro refusé par le navigateur.' : 'Micro indisponible (HTTPS requis).', true);
    const SR = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
    if (!SR) return toast('Dictée non supportée par ce navigateur : seule la lueur réagit.');
    const r = new SR();
    r.lang = 'fr-FR'; r.interimResults = true; r.continuous = true;
    let committed = '';
    r.onresult = (e: any) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) committed += e.results[i][0].transcript; else interim += e.results[i][0].transcript;
      }
      append(committed + interim);
    };
    r.onend = () => { if (rec.current === r) stop(); };
    r.start();
    rec.current = r;
  }, [mic, append, stop]);
  return { live: mic.state === 'live', stream: mic.stream, start, stop };
}

function useElapsed(busy: boolean) {
  const [start, setStart] = useState(0);
  const [, tick] = useState(0);
  // Adjusted during render, not in an effect: the first busy frame already reads 0:00 instead of time since 1970.
  if (busy && !start) setStart(Date.now());
  if (!busy && start) setStart(0);
  useEffect(() => {
    if (!busy) return;
    const i = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(i);
  }, [busy]);
  const s = start ? Math.max(0, Math.floor((Date.now() - start) / 1000)) : 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Touch screens: focusing the composer on its own would pop the keyboard over the answer being read.
const finePointer = () => matchMedia('(pointer: fine)').matches;

export function Dock({ live, agents, hasSession, ready, planReady, activity, draft, setDraft, inputRef, act }: {
  live: LiveState | null; agents: Agent[]; hasSession: boolean; ready: boolean; planReady: boolean;
  activity: { orb: OrbState; label: string } | null; draft: string; setDraft: (t: string) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>; act: DockActions;
}) {
  const [agent, setAgent] = useState('auto');
  const [mode, setMode] = useState<Mode>('');
  const [execAgent, setExecAgent] = useState<string | null>(null);
  const busy = !!live?.busy;
  const installed = agents.filter((a) => a.installed);
  const area = inputRef;
  const sendRef = useRef<HTMLButtonElement>(null);
  const agentRef = useRef<HTMLButtonElement>(null);
  const micRef = useRef<HTMLButtonElement>(null);
  useMetalBend(sendRef);
  const elapsed = useElapsed(busy);
  const sweep = useProcessingSweep(busy);
  const base = useRef('');
  const dictation = useDictation(useCallback((t: string) => setDraft(base.current + t), [setDraft]));

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [draft, area]);
  useEffect(() => { if (!busy && ready && finePointer()) area.current?.focus(); }, [busy, ready, area]);

  const send = async () => {
    const text = draft.trim();
    if (!text || busy || !ready) return;
    if (dictation.live) dictation.stop();
    if (await act.send(text, agent, mode)) setDraft('');
  };
  const toggleMic = () => {
    if (dictation.live) return dictation.stop();
    base.current = draft ? draft.replace(/\s*$/, ' ') : '';
    dictation.start();
  };

  const current = agent === 'auto' ? null : agents.find((a) => a.id === agent);
  const runner = execAgent ?? live?.agent ?? installed[0]?.id ?? '';
  const agentName = (id?: string | null) => agents.find((a) => a.id === id)?.name ?? id ?? '';

  return (
    <div className="dock">
      <div className="dock-inner">
        {busy && activity && (
          <BorderBeam size="sm" colorVariant={live?.mode === 'plan' ? 'sunset' : 'colorful'} theme="dark" strength={0.85} style={{ justifySelf: 'center' }}>
            <div className="status-pill" role="status">
              <ThinkingOrb state={activity.orb} size={20} />
              <span className="ellipsis" style={{ maxWidth: 380 }}><b style={{ fontWeight: 500, color: 'var(--text)' }}>{agentName(live?.agent)}</b> {activity.label}</span>
              <span className="elapsed">{elapsed}</span>
              <button className="chip sm" onClick={act.stop}><Icon name="stop" size={14} />Stop</button>
            </div>
          </BorderBeam>
        )}

        {planReady && (
          <BorderBeam size="pulse-outside" colorVariant="ocean" theme="dark" strength={0.9}>
            <div className="planbar">
              <span className="icon-tile"><Icon name="layers" size={15} /></span>
              <span className="grow">Plan prêt. Qui l'exécute ?</span>
              <select className="select" value={runner} onChange={(e) => setExecAgent(e.target.value)} aria-label="Agent exécutant">
                {installed.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
              <button className="chip hide-mobile" onClick={act.parallel} title="Une sous-session par tâche, chacune dans son worktree git"><Icon name="parallel" size={14} />En parallèle</button>
              {(() => {
                const cta = <button className="metal-cta" onClick={() => { act.execute(runner); setExecAgent(null); }}><Icon name="play" size={13} />Exécuter le plan</button>;
                return <MetalSafe fallback={cta}><MetalFx variant="button" preset="gold" theme="dark">{cta}</MetalFx></MetalSafe>;
              })()}
            </div>
          </BorderBeam>
        )}

        <VoiceBeam
          stream={dictation.live ? dictation.stream : null}
          level={0}
          idle={0}
          motion={dictation.live ? null : sweep}
          colorVariant={dictation.live ? 'colorful' : live?.mode === 'plan' ? 'gold' : 'ocean'}
          theme="dark"
        >
          <div className="composer">
            <textarea ref={area} rows={1} value={draft} disabled={!ready} aria-label="Message" enterKeyHint="send"
              placeholder={!ready ? 'Choisis ou crée un projet' : hasSession ? 'Demande quelque chose… (@agent pour forcer, /plan pour planifier)' : 'Demande quelque chose : une session s\'ouvre à l\'envoi'}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
                if (e.key === 'Escape' && busy) act.stop();
              }} />
            <div className="toolbar">
              <PlusMenu actions={[
                { icon: 'tree', label: live?.worktree ? 'Worktree actif' : `Worktree isolé : ${live?.isolated ? 'activé' : 'désactivé'}`, on: !!live?.isolated, disabled: !hasSession || !!live?.worktree, onClick: () => act.isolated(!live?.isolated) },
                { icon: 'shield', label: `Auto-approbation : ${live?.autoApprove ?? true ? 'activée' : 'désactivée'}`, on: live?.autoApprove ?? true, disabled: !hasSession, onClick: () => act.autoApprove(!(live?.autoApprove ?? true)) },
                { icon: 'eye', label: 'Revue croisée du diff', disabled: !hasSession || busy, onClick: act.review },
                { icon: 'summary', label: 'Résumer et mémoriser', disabled: !hasSession, onClick: act.summarize },
                ...(live?.worktree ? [{ icon: 'merge' as const, label: 'Merger le worktree', disabled: busy, onClick: act.merge }] : []),
              ]} />
              <div className="grow">
                <Popover trigger={(toggle) => (
                  <button ref={agentRef} className="chip" onClick={toggle} aria-haspopup="menu" title="Agent">
                    <AgentAvatar id={current?.id ?? 'avity'} size={18} paused />
                    <span className="hide-mobile">{current?.name ?? 'Auto'}</span>
                    <Icon name="chevron" size={13} />
                  </button>
                )}>
                  {(close) => (
                    <>
                      <button className={agent === 'auto' ? 'on' : ''} onClick={() => { setAgent('auto'); close(); }}>
                        <AgentAvatar id="avity" size={28} paused />
                        <span className="grow">Auto<span className="desc">Le routeur choisit selon la demande et garde la continuité</span></span>
                      </button>
                      {agents.map((a) => (
                        <button key={a.id} className={agent === a.id ? 'on' : ''} disabled={!a.installed} onClick={() => { setAgent(a.id); close(); }}>
                          <AgentAvatar id={a.id} size={28} state={a.installed ? 'default' : 'sleeping'} paused={!a.installed} />
                          <span className="grow">{a.name}<span className="desc">{a.installed ? a.strengths : 'non installé'}</span></span>
                        </button>
                      ))}
                    </>
                  )}
                </Popover>
                <div className="seg-wrap"><Segmented label="Mode" value={mode} options={MODES} onChange={setMode} /></div>
              </div>
              <button ref={micRef} className={`chip icon mic ${dictation.live ? 'live' : ''}`} onClick={toggleMic} disabled={!ready}
                title={dictation.live ? 'Arrêter la dictée' : 'Dicter'} aria-label="Dictée vocale" aria-pressed={dictation.live}><Icon name="mic" size={16} /></button>
              {(() => {
                const btn = (
                  <button ref={sendRef} className="send" onClick={busy ? act.stop : send} disabled={!ready || (!busy && !draft.trim())}
                    aria-label={busy ? 'Arrêter' : 'Envoyer'} title={busy ? 'Arrêter (Échap)' : 'Envoyer (Entrée)'}>
                    <Icon name={busy ? 'stop' : 'send'} size={17} strokeWidth={2.2} />
                  </button>
                );
                return <MetalSafe fallback={btn}><MetalFx variant="circle" preset="chromatic" theme="dark" reflectionTargets={[agentRef, micRef]}>{btn}</MetalFx></MetalSafe>;
              })()}
            </div>
          </div>
        </VoiceBeam>
        <div className="hint hide-mobile"><span><span className="kbd">↵</span> envoyer</span><span><span className="kbd">⇧↵</span> nouvelle ligne</span><span><span className="kbd">@codex</span> forcer un agent</span><span><span className="kbd">/plan</span> planifier</span></div>
      </div>
    </div>
  );
}
