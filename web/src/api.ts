// Thin client for the AvityOne HTTP API + SSE stream.

export type Item = { id: number; type: string; [k: string]: any };
export type Agent = { id: string; name: string; strengths: string; installed: boolean };
export type Project = { id: number; name: string; path: string };
export type SessionRow = {
  id: string; title: string | null; agent: string | null; mode: string; turns: number; summary: string | null; parent_id?: string | null;
  forked_from?: string | null; pinned: number; archived: number; draft?: string | null; updated_at: string;
  busy?: boolean; waiting?: boolean;
};
/** One session matching a history search; `snippet` marks matches with \u0002 … \u0003. */
export type SearchHit = { session_id: string; title: string | null; agent: string | null; archived: number; parent_id: string | null; updated_at: string; item_id: number; snippet: string; hits: number };
export type ConfigOption = { id: string; name: string; type: string; category?: string; currentValue: any; options: any[] };
export type LiveState = {
  busy: boolean; waiting?: boolean; agent: string | null; mode: 'agent' | 'plan'; autoApprove: boolean; connected: boolean;
  isolated?: boolean; worktree?: string | null; modeId: string | null; modes: { id: string; name: string }[]; configOptions: ConfigOption[];
};
export type Snapshot = { session: SessionRow & { project_id: number }; state: LiveState; items: Item[] };
export type Memory = { id: number; kind: string; text: string; created_at?: string };
/** A live session working or waiting for the user (`/api/state`'s `activity`). */
export type LiveActivity = { sessionId: string; projectId: number; busy: boolean; waiting: boolean };

/** What the UI knows of any session's activity, open or not: live state, plus a finished turn not seen yet. */
export type Act = { projectId: number; busy?: boolean; waiting?: boolean; unread?: 'done' | 'error' };
export type Signal = 'waiting' | 'busy' | 'error' | 'done';
export const SIGNAL_RANK: Record<Signal, number> = { waiting: 4, busy: 3, error: 2, done: 1 };
export const SIGNAL_TITLE: Record<Signal, string> = { waiting: 'attend ta validation', busy: 'en cours', error: 'échec pas encore vu', done: 'terminé, pas encore vu' };
export const signalOf = (a?: Act): Signal | null => (!a ? null : a.waiting ? 'waiting' : a.busy ? 'busy' : a.unread ?? null);

export class ApiError extends Error { status = 0; }

export async function api<T = any>(path: string, body?: unknown, method?: string, signal?: AbortSignal): Promise<T> {
  const m = method ?? (body === undefined ? 'GET' : 'POST');
  const r = await fetch('/api' + path, {
    method: m,
    headers: m === 'GET' ? {} : { 'content-type': 'application/json' },
    body: m === 'GET' ? undefined : JSON.stringify(body ?? {}),
    signal,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new ApiError(data.error ?? r.statusText);
    e.status = r.status;
    if (r.status === 401 && path !== '/login') window.dispatchEvent(new Event('avity:logout'));
    throw e;
  }
  return data as T;
}

export type Link = 'ok' | 'lost';

/**
 * Subscribes to the server event stream. The server pings every 25 s, so 70 s of silence means a dead link (a sleeping
 * laptop, a dropped proxy) even when the browser hasn't noticed; a stream the browser gave up on is reopened with
 * backoff. `status` reports each change of the link, `reconnect` fires once it is back so callers can resync.
 */
export function subscribe(onEvent: (ev: any) => void, on: { status: (s: Link) => void; reconnect: () => void }): () => void {
  let es: EventSource | null = null, lost = false, closed = false, retry = 0, timer = 0, heard = Date.now();
  const down = () => { if (!lost) { lost = true; on.status('lost'); } };
  const reopen = (delay: number) => {
    es?.close();
    clearTimeout(timer);
    timer = window.setTimeout(() => { if (!closed) open(); }, delay);
  };
  const open = () => {
    const s = (es = new EventSource('/api/events'));
    s.onopen = () => { heard = Date.now(); retry = 0; if (lost) { lost = false; on.status('ok'); on.reconnect(); } };
    s.onmessage = (e) => { heard = Date.now(); onEvent(JSON.parse(e.data)); };
    s.addEventListener('ping', () => { heard = Date.now(); });
    s.onerror = () => {
      down();
      // The browser retries by itself, unless it gave up on an HTTP error: then we retry, and probe the API so that
      // an expired login (401) logs out instead of retrying forever.
      if (s.readyState === EventSource.CLOSED) { api('/state').catch(() => {}); reopen(Math.min(30_000, 1000 * 2 ** retry++)); }
    };
  };
  const watchdog = window.setInterval(() => { if (Date.now() - heard > 70_000) { heard = Date.now(); down(); reopen(0); } }, 10_000);
  const online = () => { if (lost) { retry = 0; reopen(0); } };
  window.addEventListener('online', online);
  window.addEventListener('offline', down);
  open();
  return () => {
    closed = true;
    es?.close();
    clearTimeout(timer);
    clearInterval(watchdog);
    window.removeEventListener('online', online);
    window.removeEventListener('offline', down);
  };
}

export const rel = (ts: string) => {
  const s = (Date.now() - new Date(ts.replace(' ', 'T') + 'Z').getTime()) / 1000;
  return s < 60 ? 'maintenant' : s < 3600 ? `${Math.floor(s / 60)} min` : s < 86400 ? `${Math.floor(s / 3600)} h` : `${Math.floor(s / 86400)} j`;
};
export const hoursSince = (ts: string) => (Date.now() - new Date(ts.replace(' ', 'T') + 'Z').getTime()) / 3_600_000;
