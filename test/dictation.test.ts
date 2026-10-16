import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Dictation, type DictationState, type SpeechRecognizer } from '../web/src/dictation.ts';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture(options: { server?: boolean; pendingMicrophone?: Promise<MediaStream>; pendingText?: Promise<string>; configError?: boolean; startError?: boolean; noRecorder?: boolean; finalBytes?: number } = {}) {
  const states: DictationState[] = [], texts: string[] = [], notices: { text: string; error: boolean }[] = [];
  const streams: { stream: MediaStream; stops: number }[] = [], recorders: Recorder[] = [], recognizers: Recognition[] = [];
  const requests: { audio: Blob; language: string; signal: AbortSignal }[] = [];
  let microphoneCalls = 0;
  const makeStream = () => {
    const value = { stops: 0, stream: null as unknown as MediaStream };
    value.stream = { getTracks: () => [{ stop: () => value.stops++ }] } as unknown as MediaStream;
    streams.push(value); return value;
  };
  class Recorder {
    static isTypeSupported(type: string) { return type === 'audio/webm'; }
    state: RecordingState = 'inactive'; mimeType = 'audio/webm'; stops = 0;
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null; onerror: (() => void) | null = null;
    constructor(_stream: MediaStream, settings: MediaRecorderOptions) { assert.equal(settings.audioBitsPerSecond, 64_000); recorders.push(this); }
    start() { if (options.startError) throw new Error('Enregistreur indisponible'); this.state = 'recording'; }
    emit(bytes = 8) { this.ondataavailable?.({ data: new Blob([new Uint8Array(bytes)]) }); }
    stop() { this.stops++; this.state = 'inactive'; queueMicrotask(() => { if (options.finalBytes) this.emit(options.finalBytes); this.onstop?.(); }); }
  }
  class Recognition implements SpeechRecognizer {
    lang = ''; interimResults = false; continuous = false; stops = 0; aborts = 0;
    onresult: SpeechRecognizer['onresult'] = null; onerror: SpeechRecognizer['onerror'] = null; onend: SpeechRecognizer['onend'] = null;
    constructor() { recognizers.push(this); }
    start() { if (options.startError) throw new Error('Reconnaissance indisponible'); }
    stop() { this.stops++; queueMicrotask(() => this.onend?.()); }
    abort() { this.aborts++; }
  }
  const controller = new Dictation({
    configured: async () => { if (options.configError) throw new Error('Configuration indisponible'); return options.server ?? true; },
    microphone: async () => { microphoneCalls++; return options.pendingMicrophone ?? makeStream().stream; },
    recorder: options.noRecorder ? undefined : Recorder as unknown as typeof MediaRecorder,
    recognition: Recognition,
    transcribe: async (audio, language, signal) => { requests.push({ audio, language, signal }); return options.pendingText ?? 'Bonjour.'; },
    state: (state) => states.push(state), text: (text) => texts.push(text), notify: (text, error = false) => notices.push({ text, error }),
  });
  return { controller, states, texts, notices, streams, recorders, recognizers, requests, makeStream, microphoneCalls: () => microphoneCalls, state: () => states.at(-1)! };
}

test('dictée web: moteur configuré prioritaire même si Web Speech est disponible', async () => {
  const f = fixture();
  await f.controller.start('fr-FR');
  assert.equal(f.state().phase, 'recording'); assert.equal(f.recognizers.length, 0);
  f.recorders[0].emit(); f.controller.stop(); await tick();
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].language, 'fr-FR'); assert.equal(f.requests[0].audio.type, 'audio/webm');
  assert.deepEqual(f.texts, ['Bonjour.']); assert.equal(f.state().phase, 'idle'); assert.equal(f.streams[0].stops, 1);
  assert.equal(f.state().audio?.size, 8, 'audio disponible au téléchargement');
  f.controller.dispose();
});

test('dictée web: repli navigateur annoncé uniquement sans moteur configuré, texte cumulatif sans doublon', async () => {
  const f = fixture({ server: false });
  await f.controller.start('en-US');
  assert.equal(f.recorders.length, 0); assert.equal(f.recognizers[0].lang, 'en-US');
  assert.match(f.notices[0].text, /navigateur.*fournisseur/);
  f.recognizers[0].onresult?.({ results: [{ isFinal: false, 0: { transcript: 'Hello' } }] });
  f.recognizers[0].onresult?.({ results: [{ isFinal: true, 0: { transcript: 'Hello ' } }, { isFinal: false, 0: { transcript: 'world' } }] });
  assert.deepEqual(f.texts, ['Hello', 'Hello world']);
  f.controller.stop(); await tick();
  assert.equal(f.state().phase, 'idle'); assert.equal(f.requests.length, 0); assert.equal(f.streams[0].stops, 1);
  f.controller.dispose();
});

test('dictée web: erreurs navigateur et démarrage défaillant sont visibles et libèrent le micro', async () => {
  const f = fixture({ server: false }); await f.controller.start('fr-FR');
  const staleResult = f.recognizers[0].onresult;
  f.recognizers[0].onerror?.({ error: 'network' });
  assert.equal(f.state().phase, 'idle'); assert.equal(f.streams[0].stops, 1); assert.ok(f.notices.at(-1)?.error);
  assert.match(f.notices.at(-1)!.text, /indisponible/); assert.equal(f.requests.length, 0);
  staleResult?.({ results: [{ isFinal: true, 0: { transcript: 'stale' } }] });
  assert.deepEqual(f.texts, []);
  for (const server of [true, false]) {
    const broken = fixture({ server, startError: true }); await broken.controller.start('fr-FR');
    assert.equal(broken.state().phase, 'idle'); assert.equal(broken.streams[0].stops, 1); assert.ok(broken.notices.at(-1)?.error);
    broken.controller.dispose();
  }
  f.controller.dispose();
});

test('dictée web: configuration illisible ou MediaRecorder absent ne déclenchent pas de repli externe', async () => {
  for (const options of [{ configError: true }, { noRecorder: true }]) {
    const f = fixture(options); await f.controller.start('fr-FR');
    assert.equal(f.recognizers.length, 0); assert.equal(f.microphoneCalls(), 0); assert.equal(f.state().phase, 'idle'); assert.ok(f.notices.at(-1)?.error);
    f.controller.dispose();
  }
});

test('dictée web: double démarrage et permission tardive après annulation ne laissent pas de micro actif', async () => {
  const pending = Promise.withResolvers<MediaStream>(), f = fixture({ pendingMicrophone: pending.promise });
  const start = f.controller.start('fr-FR'); await tick();
  await f.controller.start('fr-FR'); assert.equal(f.microphoneCalls(), 1);
  f.controller.stop();
  const granted = f.makeStream(); pending.resolve(granted.stream); await start;
  assert.equal(granted.stops, 1); assert.equal(f.recorders.length, 0); assert.equal(f.state().phase, 'idle');
  f.controller.dispose();
});

test('dictée web: refus de permission explicite et démontage pendant une autorisation', async () => {
  const denied = Promise.withResolvers<MediaStream>(), f = fixture({ pendingMicrophone: denied.promise });
  const start = f.controller.start('fr-FR'); await tick();
  denied.reject(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' })); await start;
  assert.match(f.notices.at(-1)!.text, /Micro refusé.*permissions/); assert.equal(f.state().phase, 'idle'); f.controller.dispose();
  const late = Promise.withResolvers<MediaStream>(), g = fixture({ pendingMicrophone: late.promise });
  const loading = g.controller.start('fr-FR'); await tick(); g.controller.dispose(); const count = g.states.length;
  const granted = g.makeStream(); late.resolve(granted.stream); await loading;
  assert.equal(granted.stops, 1); assert.equal(g.states.length, count); assert.equal(g.recorders.length, 0);
});

test('dictée web: annuler la transcription interdit tout résultat tardif dans une nouvelle dictée', async () => {
  const pending = Promise.withResolvers<string>(), f = fixture({ pendingText: pending.promise });
  await f.controller.start('fr-FR'); f.recorders[0].emit(); f.controller.stop(); await tick();
  assert.equal(f.state().phase, 'transcribing'); f.controller.stop();
  assert.equal(f.requests[0].signal.aborted, true); assert.equal(f.state().phase, 'idle'); assert.equal(f.state().audio?.size, 8);
  await f.controller.start('fr-FR'); pending.resolve('ancien résultat'); await tick();
  assert.deepEqual(f.texts, []); assert.equal(f.state().phase, 'recording'); assert.equal(f.streams[1].stops, 0);
  f.controller.dispose(); assert.equal(f.streams[1].stops, 1);
});

test('dictée web: échec serveur conserve l’audio et ne bascule pas vers Web Speech', async () => {
  const pending = Promise.withResolvers<string>(), f = fixture({ pendingText: pending.promise });
  await f.controller.start('fr-FR'); f.recorders[0].emit(); f.controller.stop(); await tick();
  pending.reject(new Error('Moteur indisponible')); await tick();
  assert.equal(f.state().phase, 'idle'); assert.equal(f.state().audio?.size, 8); assert.equal(f.recognizers.length, 0);
  assert.match(f.notices.at(-1)!.text, /Moteur indisponible/); assert.ok(f.notices.at(-1)?.error); f.controller.dispose();
});

test('dictée web: erreur d’enregistreur conserve les fragments et invalide une transcription déjà lancée', async () => {
  const pending = Promise.withResolvers<string>(), f = fixture({ pendingText: pending.promise });
  await f.controller.start('fr-FR'); f.recorders[0].emit(); const error = f.recorders[0].onerror;
  f.controller.stop(); await tick(); error?.(); pending.resolve('réponse tardive'); await tick();
  assert.equal(f.state().phase, 'idle'); assert.deepEqual(f.texts, []); assert.equal(f.state().audio?.size, 8);
  assert.equal(f.requests[0].signal.aborted, true); assert.match(f.notices.at(-1)!.text, /Échec de l’enregistrement/); f.controller.dispose();
});

test('dictée web: arrêt anticipé laisse de la place au dernier fragment et conserve les dépassements', async () => {
  const f = fixture({ finalBytes: 1024 }); await f.controller.start('fr-FR');
  f.recorders[0].emit(4 * 1024 * 1024); await tick();
  assert.equal(f.recorders[0].stops, 1); assert.equal(f.requests[0].audio.size, 4 * 1024 * 1024 + 1024);
  assert.equal(f.state().phase, 'idle'); assert.ok(f.notices.some((notice) => /limite de 5 Mio/.test(notice.text))); f.controller.dispose();
  const g = fixture(); await g.controller.start('fr-FR'); g.recorders[0].emit(5 * 1024 * 1024 + 1); await tick();
  assert.equal(g.requests.length, 0); assert.equal(g.state().audio?.size, 5 * 1024 * 1024 + 1);
  assert.match(g.notices.at(-1)!.text, /Télécharge-le/); assert.equal(g.state().phase, 'idle'); g.controller.dispose();
});
