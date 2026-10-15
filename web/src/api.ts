// Thin client for the AvityOne HTTP API + SSE stream.

export type Item = { id: number; type: string; [k: string]: any };
export type Agent = { id: string; name: string; strengths: string; installed: boolean };
export type Project = { id: number; name: string; path: string };
export type SessionRow = {
  id: string; title: string | null; agent: string | null; mode: string; turns: number; summary: string | null; parent_id?: string | null;
  forked_from?: string | null; pinned: number; archived: number; draft?: string | null; updated_at: string;
};
/** One session matching a history search; `snippet` marks matches with \u0002 … \u0003. */
export type SearchHit = { session_id: string; title: string | null; agent: string | null; archived: number; parent_id: string | null; updated_at: string; item_id: number; snippet: string; hits: number };
export type ConfigOption = { id: string; name: string; type: string; category?: string; currentValue: any; options: any[] };
export type LiveState = {
  busy: boolean; agent: string | null; mode: 'agent' | 'plan'; autoApprove: boolean; connected: boolean;
  isolated?: boolean; worktree?: string | null; modeId: string | null; modes: { id: string; name: string }[]; configOptions: ConfigOption[];
};
export type Snapshot = { session: SessionRow & { project_id: number }; state: LiveState; items: Item[] };
export type Memory = { id: number; kind: string; text: string; created_at?: string };

export class ApiError extends Error { status = 0; }

export async function api<T = any>(path: string, body?: unknown, method?: string): Promise<T> {
  const m = method ?? (body === undefined ? 'GET' : 'POST');
  const r = await fetch('/api' + path, {
    method: m,
    headers: m === 'GET' ? {} : { 'content-type': 'application/json' },
    body: m === 'GET' ? undefined : JSON.stringify(body ?? {}),
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

/** Subscribes to the server event stream; `onReconnect` fires after a drop so callers can resync. */
export function subscribe(onEvent: (ev: any) => void, onReconnect: () => void): () => void {
  const es = new EventSource('/api/events');
  let broken = false;
  es.onerror = () => { broken = true; };
  es.onopen = () => { if (broken) onReconnect(); broken = false; };
  es.onmessage = (e) => onEvent(JSON.parse(e.data));
  return () => es.close();
}

export const rel = (ts: string) => {
  const s = (Date.now() - new Date(ts.replace(' ', 'T') + 'Z').getTime()) / 1000;
  return s < 60 ? 'maintenant' : s < 3600 ? `${Math.floor(s / 60)} min` : s < 86400 ? `${Math.floor(s / 3600)} h` : `${Math.floor(s / 86400)} j`;
};
export const hoursSince = (ts: string) => (Date.now() - new Date(ts.replace(' ', 'T') + 'Z').getTime()) / 3_600_000;
