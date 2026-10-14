import { config } from './config.ts';

export type Mode = 'agent' | 'plan';
export type Route = { agent: string; mode: Mode; prompt: string; reason: string };
export type Forced = { agent?: string; mode?: string };

// ponytail: regex rules only. Add an LLM classifier when the rules misroute often enough to matter.
export function route(text: string, available: string[], forced: Forced = {}, current?: string | null, currentMode?: Mode): Route {
  let prompt = text.trim();
  let mode: Mode | undefined = forced.mode === 'plan' || forced.mode === 'agent' ? forced.mode : undefined;
  if (/^\/plan\b/i.test(prompt)) { mode = 'plan'; prompt = prompt.replace(/^\/plan\s*/i, ''); }

  let agent: string | undefined;
  let reason = '';
  if (forced.agent && forced.agent !== 'auto') {
    if (!available.includes(forced.agent)) throw new Error(`agent "${forced.agent}" non installé`);
    agent = forced.agent; reason = 'choix manuel';
  }
  const at = prompt.match(/(?:^|\s)@(\w+)\b/);
  if (!agent && at && available.includes(at[1].toLowerCase())) {
    agent = at[1].toLowerCase(); prompt = prompt.replace(at[0], ' ').trim(); reason = `mention @${agent}`;
  }
  // A running conversation stays with its agent unless told otherwise.
  if (!agent && current && available.includes(current)) { agent = current; reason = 'continuité'; mode ??= currentMode; }
  if (!agent) {
    for (const r of config.routes) {
      if (available.includes(r.agent) && new RegExp(r.match, 'i').test(prompt)) {
        agent = r.agent; mode ??= r.mode; reason = `règle /${r.match}/`; break;
      }
    }
  }
  if (!agent) { agent = available.includes(config.defaultAgent) ? config.defaultAgent : available[0]; reason = 'agent par défaut'; }
  if (!agent) throw new Error('aucun agent installé (voir deploy/provision.sh)');
  return { agent, mode: mode ?? 'agent', prompt, reason };
}
