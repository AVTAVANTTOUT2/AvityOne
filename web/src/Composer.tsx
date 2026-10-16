// Dock: live status pill, plan-ready bar and the composer (voice glow, liquid controls, liquid-metal send).
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { VoiceBeam, getAudioContext, type VoiceBeamMotion } from 'voice-glow';
import { MetalFx, useMetalBend } from 'metal-fx';
import { BorderBeam } from 'border-beam';
import { ThinkingOrb, type OrbState } from 'thinking-orbs';
import { api, type Agent, type LiveState } from './api';
import { encodeFile } from './uploads';
import { Dictation, type DictationState, type SpeechRecognizer } from './dictation';
import { AgentAvatar } from './brand';
import { Icon } from './icons';
import { MetalSafe, PlusMenu, Popover, Segmented, toast } from './ui';

export type Mode = '' | 'agent' | 'plan';
export type DockActions = {
  send: (text: string, agent: string, mode: Mode, files?: File[]) => Promise<boolean>;
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

function useDictation(append: (t: string) => void, language: string) {
  const [state, setState] = useState<DictationState>({ phase: 'idle', stream: null, audio: null });
  const controller = useRef<Dictation | null>(null), latest = useRef(append); latest.current = append;
  const [download, setDownload] = useState('');
  useEffect(() => {
    let mounted = true;
    const browser = window as Window & { SpeechRecognition?: new () => SpeechRecognizer; webkitSpeechRecognition?: new () => SpeechRecognizer };
    const instance = new Dictation({
      configured: async (signal) => {
        const value = await api('/config', undefined, undefined, signal);
        if (typeof value.transcription?.command !== 'string') throw new Error('Configuration du moteur de dictée indisponible.');
        return !!value.transcription.command.trim();
      },
      microphone: async () => {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('Micro indisponible dans ce navigateur (HTTPS requis).');
        return navigator.mediaDevices.getUserMedia({ audio: true });
      },
      recorder: window.MediaRecorder,
      recognition: browser.SpeechRecognition ?? browser.webkitSpeechRecognition,
      transcribe: async (audio, selectedLanguage, signal) => {
        const base64 = await encodeFile(audio);
        signal.throwIfAborted();
        return (await api('/transcribe', { base64, mime: audio.type, language: selectedLanguage }, undefined, signal)).text;
      },
      state: (value) => { if (mounted) setState(value); }, text: (text) => latest.current(text), notify: toast,
    });
    controller.current = instance;
    return () => { mounted = false; instance.dispose(); controller.current = null; };
  }, []);
  useEffect(() => {
    if (!state.audio) { setDownload(''); return; }
    const url = URL.createObjectURL(state.audio); setDownload(url);
    return () => URL.revokeObjectURL(url);
  }, [state.audio]);
  const start = () => { try { getAudioContext(); } catch {} void controller.current?.start(language); };
  return { ...state, live: state.phase === 'recording', starting: state.phase === 'starting', transcribing: state.phase === 'transcribing', download, start, stop: () => controller.current?.stop() };
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

export function Dock({ live, agents, hasSession, ready, planReady, activity, draft, setDraft, pending, inputRef, act }: {
  live: LiveState | null; agents: Agent[]; hasSession: boolean; ready: boolean; planReady: boolean;
  activity: { orb: OrbState; label: string } | null; draft: string; setDraft: (t: string) => void; pending: boolean;
  inputRef: RefObject<HTMLTextAreaElement | null>; act: DockActions;
}) {
  const [agent, setAgent] = useState('auto');
  const [mode, setMode] = useState<Mode>('');
  const [execAgent, setExecAgent] = useState<string | null>(null);
  const [files, setFiles] = useState<File[]>([]), [commands, setCommands] = useState<any[]>([]), [language, setLanguage] = useState('fr-FR');
  const fileInput = useRef<HTMLInputElement>(null);
  const busy = !!live?.busy;
  const sending = useRef(false), [uploading, setUploading] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const installed = agents.filter((a) => a.installed);
  const area = inputRef;
  const sendRef = useRef<HTMLButtonElement>(null);
  const agentRef = useRef<HTMLButtonElement>(null);
  const micRef = useRef<HTMLButtonElement>(null);
  useMetalBend(sendRef);
  const elapsed = useElapsed(busy);
  const sweep = useProcessingSweep(busy);
  const base = useRef('');
  const dictation = useDictation(useCallback((t: string) => setDraft(base.current + t), [setDraft]), language);
  const commandAgent = agent === 'auto' ? live?.agent : agent;
  useEffect(() => { if (!draft.startsWith('/') || !commandAgent) { setCommands([]); return; } let current = true; api(`/agents/${encodeURIComponent(commandAgent)}/commands`).then(r => current && setCommands(r.commands ?? []), () => current && setCommands([])); return () => { current = false; }; }, [draft.startsWith('/'), commandAgent]);
  const addFiles = (added: File[]) => { if (files.length + added.length > 8 || added.some(f => f.size > 5 * 1024 * 1024)) return toast('Huit fichiers maximum, 5 Mio chacun.', true); setFiles([...files, ...added]); };

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [draft, area]);
  useEffect(() => { if (!busy && ready && finePointer()) area.current?.focus(); }, [busy, ready, area]);

  const send = async () => {
    const text = draft.trim() || (files.length ? 'Analyse les pièces jointes.' : '');
    if (!text || busy || !ready || dictation.starting || dictation.transcribing || sending.current || pending) return;
    if (dictation.live) { dictation.stop(); return; }
    sending.current = true; setUploading(true);
    try { if (await act.send(text, agent, mode, files) && mounted.current) setFiles([]); }
    finally { sending.current = false; if (mounted.current) setUploading(false); }
  };
  const toggleMic = () => {
    if (dictation.phase !== 'idle') return dictation.stop();
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
              <button className="chip" onClick={act.parallel} title="Une sous-session par tâche, chacune dans son worktree git"><Icon name="parallel" size={14} />En parallèle</button>
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
          <div className="composer" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); addFiles(Array.from(e.dataTransfer.files)); }}>
            {!!files.length && <div className="attachments">{files.map((f, i) => <button className="chip" key={`${f.name}-${i}`} onClick={() => setFiles(files.filter((_, n) => n !== i))} title="Retirer la pièce jointe">{f.name} ×</button>)}</div>}
            {draft.startsWith('/') && !draft.includes(' ') && commands.length > 0 && <div className="attachments" aria-label="Commandes natives">{commands.filter(c => ('/' + c.name).startsWith(draft)).slice(0, 8).map(c => <button key={c.name} className="chip" title={c.description} onClick={() => setDraft('/' + c.name + ' ')}>/{c.name}</button>)}</div>}
            <textarea ref={area} rows={1} value={draft} disabled={!ready || dictation.phase !== 'idle' || uploading || pending} aria-label="Message" enterKeyHint="send"
              placeholder={!ready ? 'Choisis ou crée un projet' : hasSession ? 'Demande quelque chose… (@agent pour forcer, /plan pour planifier)' : 'Demande quelque chose : une session s\'ouvre à l\'envoi'}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
                if (e.key === 'Escape' && busy) act.stop();
              }} />
            <div className="toolbar">
              <input ref={fileInput} type="file" multiple hidden onChange={e => { addFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
              <button className="chip icon" title="Joindre des fichiers ou images" aria-label="Joindre des fichiers" disabled={!ready} onClick={() => fileInput.current?.click()}><Icon name="file" size={16} /></button>
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
              <button ref={micRef} className={`chip icon mic ${dictation.live ? 'live' : ''}`} onClick={toggleMic} disabled={!ready || uploading || pending}
                title={dictation.live ? 'Arrêter la dictée' : dictation.starting ? 'Annuler l’activation du micro' : dictation.transcribing ? 'Annuler la transcription' : 'Dicter'} aria-label="Dictée vocale" aria-pressed={dictation.phase !== 'idle'}><Icon name="mic" size={16} /></button>
              <select className="select" style={{ maxWidth: 72 }} aria-label="Langue de dictée" value={language} disabled={dictation.phase !== 'idle'} onChange={e => setLanguage(e.target.value)}><option value="fr-FR">FR</option><option value="en-US">EN</option><option value="es-ES">ES</option><option value="de-DE">DE</option><option value="it-IT">IT</option><option value="pt-PT">PT</option></select>
              {(() => {
                const btn = (
                  <button ref={sendRef} className="send" onClick={busy ? act.stop : send} disabled={!ready || dictation.starting || dictation.transcribing || uploading || pending || (!busy && !draft.trim() && !files.length)}
                    aria-label={busy ? 'Arrêter' : 'Envoyer'} title={busy ? 'Arrêter (Échap)' : 'Envoyer (Entrée)'}>
                    <Icon name={busy ? 'stop' : 'send'} size={17} strokeWidth={2.2} />
                  </button>
                );
                return <MetalSafe fallback={btn}><MetalFx variant="circle" preset="chromatic" theme="dark" reflectionTargets={[agentRef, micRef]}>{btn}</MetalFx></MetalSafe>;
              })()}
            </div>
          </div>
        </VoiceBeam>
        {dictation.transcribing && <p role="status">Transcription en cours…</p>}
        {dictation.starting && <p role="status">Activation du microphone…</p>}
        {dictation.download && <a className="chip" href={dictation.download} download={`dictee.${dictation.audio?.type.includes('mp4') ? 'm4a' : dictation.audio?.type.includes('ogg') ? 'ogg' : dictation.audio?.type.includes('wav') ? 'wav' : 'webm'}`}>Télécharger l’enregistrement</a>}
        <div className="hint hide-mobile"><span><span className="kbd">↵</span> envoyer</span><span><span className="kbd">⇧↵</span> nouvelle ligne</span><span><span className="kbd">@codex</span> forcer un agent</span><span><span className="kbd">/plan</span> planifier</span></div>
      </div>
    </div>
  );
}
