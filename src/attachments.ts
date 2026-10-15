import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HOME } from './config.ts';
import { db, one, run } from './store.ts';

db.exec(`CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
const directory = join(HOME, 'attachments');
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
export function decodeUpload(base64: unknown, limit = 5 << 20) {
  if (typeof base64 !== 'string' || base64.length > Math.ceil(limit / 3) * 4 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw fail(400, 'Fichier base64 invalide ou trop volumineux');
  const data = Buffer.from(base64, 'base64');
  if (data.toString('base64') !== base64) throw fail(400, 'Encodage base64 invalide');
  if (!data.length || data.length > limit) throw fail(413, 'Fichier vide ou supérieur à 5 Mio');
  return data;
}
export async function addAttachment(sessionId: string, input: { name: string; mime: string; base64: string }) {
  if (!one('SELECT 1 FROM sessions WHERE id = ?', sessionId)) throw fail(404, 'Session inconnue');
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 200 || /[\x00-\x1f\/\\]/.test(input.name)) throw fail(400, 'Nom de fichier invalide');
  if (typeof input.mime !== 'string' || !/^[\w.+-]+\/[\w.+-]+$/.test(input.mime)) throw fail(400, 'Type de fichier invalide');
  const data = decodeUpload(input.base64), id = randomUUID();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, id), data, { mode: 0o600, flag: 'wx' });
  try { run('INSERT INTO attachments (id,session_id,name,mime,size) VALUES (?,?,?,?,?)', id, sessionId, input.name, input.mime, data.length); }
  catch (e) { await rm(join(directory, id), { force: true }); throw e; }
  return { id, name: input.name, mime: input.mime, size: data.length };
}
export async function readAttachment(id: string) {
  const row = one('SELECT * FROM attachments WHERE id = ?', id);
  if (!row || !/^[\w-]+$/.test(id)) throw fail(404, 'Pièce jointe inconnue');
  return { id, session_id: String(row.session_id), name: String(row.name), mime: String(row.mime), size: Number(row.size), data: await readFile(join(directory, id)) };
}
export async function attachmentContent(sessionId: string, ids: unknown) {
  if (ids == null) return [];
  if (!Array.isArray(ids) || ids.length > 8 || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw fail(400, 'Sélection de pièces jointes invalide (8 maximum)');
  const blocks = [];
  for (const id of ids) {
    const row = await readAttachment(id);
    if (row.session_id !== sessionId) throw fail(403, 'Pièce jointe appartenant à une autre session');
    if (/^image\/(png|jpeg|webp|gif)$/.test(row.mime)) blocks.push({ type: 'image', mimeType: row.mime, data: row.data.toString('base64') });
    else if (/^audio\/(wav|mpeg|ogg|webm|mp4)$/.test(row.mime)) blocks.push({ type: 'audio', mimeType: row.mime, data: row.data.toString('base64') });
    else if (row.mime.startsWith('text/') || row.mime === 'application/json') blocks.push({ type: 'resource', resource: { uri: `attachment://${id}/${encodeURIComponent(row.name)}`, mimeType: row.mime, text: row.data.toString('utf8') } });
    else blocks.push({ type: 'resource', resource: { uri: `attachment://${id}/${encodeURIComponent(row.name)}`, mimeType: row.mime, blob: row.data.toString('base64') } });
  }
  return blocks;
}
