export type DictationState = { phase: 'idle' | 'starting' | 'recording' | 'transcribing'; stream: MediaStream | null; audio: Blob | null };
type RecognitionResult = { isFinal: boolean; 0: { transcript: string } };
export type SpeechRecognizer = {
  lang: string; interimResults: boolean; continuous: boolean;
  onresult: ((event: { results: ArrayLike<RecognitionResult> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void; stop(): void; abort?(): void;
};
type Dependencies = {
  configured(signal: AbortSignal): Promise<boolean>;
  microphone(): Promise<MediaStream>;
  recorder?: typeof MediaRecorder;
  recognition?: new () => SpeechRecognizer;
  transcribe(audio: Blob, language: string, signal: AbortSignal): Promise<string>;
  state(value: DictationState): void;
  text(value: string): void;
  notify(message: string, error?: boolean): void;
};
const MAX_BYTES = 5 * 1024 * 1024, STOP_BYTES = 4 * 1024 * 1024;

/** Own one capture at a time, including the pending permission request and transcription. */
export class Dictation {
  private deps: Dependencies;
  private value: DictationState = { phase: 'idle', stream: null, audio: null };
  private turn = 0;
  private disposed = false;
  private abort: AbortController | null = null;
  private recording: MediaRecorder | null = null;
  private recognition: SpeechRecognizer | null = null;

  constructor(deps: Dependencies) { this.deps = deps; }
  private update(patch: Partial<DictationState>) {
    this.value = { ...this.value, ...patch };
    if (!this.disposed) this.deps.state(this.value);
  }
  private releaseStream() {
    this.value.stream?.getTracks().forEach((track) => track.stop());
    this.update({ stream: null });
  }
  private clearCapture() {
    if (this.recording) {
      const recording = this.recording; this.recording = null;
      recording.ondataavailable = null; recording.onstop = null; recording.onerror = null;
      if (recording.state !== 'inactive') { try { recording.stop(); } catch {} }
    }
    if (this.recognition) {
      const recognition = this.recognition; this.recognition = null;
      recognition.onresult = null; recognition.onend = null; recognition.onerror = null;
      try { if (recognition.abort) recognition.abort(); else recognition.stop(); } catch {}
    }
    this.releaseStream();
  }
  private fail(error: unknown, turn: number) {
    if (this.disposed || turn !== this.turn) return;
    this.turn++; this.abort?.abort();
    this.clearCapture(); this.update({ phase: 'idle' });
    const name = (error as Error)?.name;
    this.deps.notify(name === 'NotAllowedError' || name === 'SecurityError' ? 'Micro refusé. Autorise le microphone dans les permissions du navigateur.' : name === 'NotFoundError' ? 'Aucun microphone disponible.' : (error as Error)?.message || 'La dictée a échoué.', true);
  }
  async start(language: string) {
    if (this.disposed || this.value.phase !== 'idle') return;
    const turn = ++this.turn, abort = new AbortController(); this.abort = abort;
    const current = () => !this.disposed && turn === this.turn;
    this.update({ phase: 'starting', audio: null });
    try {
      const server = await this.deps.configured(abort.signal);
      if (!current()) return;
      if (server && !this.deps.recorder) throw new Error('Enregistrement audio indisponible dans ce navigateur.');
      if (!server && !this.deps.recognition) throw new Error('Configure un moteur de transcription dans Administration pour ce navigateur.');
      if (!server) this.deps.notify('Moteur local non configuré : reconnaissance du navigateur, qui peut envoyer l’audio à son fournisseur.');
      const stream = await this.deps.microphone();
      if (!current()) { stream.getTracks().forEach((track) => track.stop()); return; }
      this.update({ stream });
      if (server) {
        const Recorder = this.deps.recorder!;
        const type = ['audio/webm', 'audio/mp4', 'audio/ogg'].find((mime) => Recorder.isTypeSupported(mime));
        const recording = new Recorder(stream, { ...(type ? { mimeType: type } : {}), audioBitsPerSecond: 64_000 });
        this.recording = recording;
        const chunks: Blob[] = []; let bytes = 0;
        recording.ondataavailable = (event) => {
          if (!current() || !event.data.size) return;
          chunks.push(event.data); bytes += event.data.size;
          if (bytes >= STOP_BYTES && this.value.phase === 'recording') { this.deps.notify('Enregistrement arrêté avant la limite de 5 Mio. Transcription en cours…'); this.stop(); }
        };
        recording.onerror = () => { if (current()) this.update({ audio: bytes ? new Blob(chunks, { type: recording.mimeType }) : null }); this.fail(new Error('Échec de l’enregistrement audio.'), turn); };
        recording.onstop = async () => {
          if (!current()) return;
          this.recording = null; this.releaseStream();
          const audio = new Blob(chunks, { type: recording.mimeType });
          this.update({ phase: 'transcribing', audio: audio.size ? audio : null });
          try {
            if (!audio.size) throw new Error('Aucun son enregistré. Recommence la dictée.');
            if (audio.size > MAX_BYTES) throw new Error('Enregistrement supérieur à 5 Mio. Télécharge-le pour le conserver, puis dicte un passage plus court.');
            const text = await this.deps.transcribe(audio, language, abort.signal);
            if (typeof text !== 'string' || !text.trim()) throw new Error('Aucune parole reconnue. Tu peux télécharger l’enregistrement avant de réessayer.');
            if (current()) { this.deps.text(text); this.update({ phase: 'idle' }); }
          } catch (error) { this.fail(error, turn); }
        };
        recording.start(1000); this.update({ phase: 'recording' });
        this.deps.notify('Enregistrement en cours : arrête le micro pour lancer le moteur de transcription configuré.');
      } else {
        const recognition = new this.deps.recognition!(); this.recognition = recognition;
        recognition.lang = language; recognition.interimResults = true; recognition.continuous = true;
        let heard = false;
        recognition.onresult = (event) => { if (current()) { const text = Array.from(event.results, (result) => result[0].transcript).join(''); heard ||= !!text.trim(); this.deps.text(text); } };
        recognition.onerror = (event) => this.fail(new Error(event.error === 'not-allowed' || event.error === 'service-not-allowed' ? 'Reconnaissance vocale refusée par le navigateur. Vérifie ses permissions ou configure le moteur local.' : event.error === 'no-speech' ? 'Aucune parole reconnue. Recommence la dictée.' : 'Reconnaissance vocale du navigateur indisponible. Vérifie le réseau ou configure le moteur local.'), turn);
        recognition.onend = () => { if (current()) { this.clearCapture(); this.update({ phase: 'idle' }); if (!heard) this.deps.notify('Aucune parole reconnue. Recommence la dictée.', true); } };
        recognition.start(); this.update({ phase: 'recording' });
      }
    } catch (error) { this.fail(error, turn); }
  }
  stop() {
    if (this.value.phase !== 'recording') return this.cancel();
    this.update({ phase: 'transcribing' });
    try {
      if (this.recording) { this.recording.stop(); this.releaseStream(); }
      else this.recognition?.stop();
    } catch (error) { this.fail(error, this.turn); }
  }
  cancel() {
    this.turn++; this.abort?.abort(); this.clearCapture(); this.update({ phase: 'idle' });
  }
  dispose() { this.disposed = true; this.cancel(); }
}
