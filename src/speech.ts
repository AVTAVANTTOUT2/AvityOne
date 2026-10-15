import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.ts';
import { decodeUpload } from './attachments.ts';

export async function transcribe(input: { base64: string; mime: string; language: string }) {
  const settings = (config as typeof config & { transcription?: { command: string; args: string[] } }).transcription;
  const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
  if (!settings?.command) throw fail(503, 'Configure un moteur de transcription dans Administration pour ce navigateur');
  if (!/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(input.language)) throw fail(400, 'Langue invalide');
  const extension = ({ 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/wav': 'wav' } as Record<string, string>)[input.mime?.split(';')[0]];
  if (!extension) throw fail(415, 'Format audio non pris en charge');
  const data = decodeUpload(input.base64), dir = await mkdtemp(join(tmpdir(), 'avity-speech-'));
  try {
    const file = join(dir, `recording.${extension}`);
    await writeFile(file, data, { mode: 0o600 });
    const args = settings.args.map(arg => arg.replaceAll('{file}', file).replaceAll('{language}', input.language));
    const { stdout } = await promisify(execFile)(settings.command, args, { timeout: 120_000, maxBuffer: 1 << 20, cwd: dir })
      .catch(() => { throw fail(502, 'Le moteur de transcription a échoué ou dépassé son délai. Vérifie sa configuration et le format audio.'); });
    if (!stdout.trim()) throw fail(422, 'Aucune parole reconnue');
    return { text: stdout.trim() };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
