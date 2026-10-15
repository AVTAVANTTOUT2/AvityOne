// Scripted ACP agent for tests: streams text, makes an edit that needs permission, emits a plan.
// The plan echoes the prompt's numbered lines; a parallel sub-task (« ## Ta tâche ») writes each `write:<file>` it names.
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';

const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
const up = (update) => send({ method: 'session/update', params: { sessionId: 'fake-1', update } });
const waiting = new Map();
let mode = 'default';
let nextId = 1000;

createInterface({ input: process.stdin }).on('line', async (line) => {
  const m = JSON.parse(line);
  if (m.id != null && !m.method) return waiting.get(m.id)?.(m.result);
  const reply = (result) => send({ id: m.id, result });
  switch (m.method) {
    case 'initialize':
      return reply({ protocolVersion: 1, agentCapabilities: { loadSession: false }, authMethods: [] });
    case 'session/new':
      return reply({ sessionId: 'fake-1', modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan' }] } });
    case 'session/set_mode':
      mode = m.params.modeId;
      up({ sessionUpdate: 'current_mode_update', currentModeId: mode });
      return reply({});
    case 'session/prompt': {
      const text = m.params.prompt.map((b) => b.text).join('\n');
      if (text.includes('<transcript>')) { // AvityOne's memory module: answer with a summary that names the session
        up({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '{"title": "Titre automatique", "summary": "Résumé.", "memories": []}' } });
        return reply({ stopReason: 'end_turn' });
      }
      up({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `mode=${mode} ` } });
      up({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `ctx=${text.includes('<avity-context>')}` } });
      const ask = m.params.prompt.at(-1).text;
      if (ask.includes('bloc de code')) up({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '\n\n```js\nconsole.log("avity");\n```' } });
      const kind = ask.includes('exitplan') ? 'switch_mode' : 'edit'; // « exitplan »: leave plan mode like Claude's ExitPlanMode
      up({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Edit a.txt', kind, status: 'pending' });
      const id = nextId++;
      send({ id, method: 'session/request_permission', params: { sessionId: 'fake-1', toolCall: { toolCallId: 't1', kind, title: 'Edit a.txt' },
        options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }] } });
      const res = await new Promise((r) => waiting.set(id, r));
      const ok = res.outcome.optionId === 'yes';
      if (ok) for (const [, f] of (text.split('## Ta tâche')[1] ?? '').matchAll(/write:(\S+)/g)) writeFileSync(f, `${f} par ${process.pid}\n`);
      up({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: ok ? 'completed' : 'failed', content: ok ? [{ type: 'diff', path: 'a.txt', oldText: 'a', newText: 'b' }] : [] });
      const steps = [...text.matchAll(/^\d+\. (.+)$/gm)].map((x) => x[1]);
      up({ sessionUpdate: 'plan', entries: (steps.length ? steps : ['step']).map((content) => ({ content, priority: 'high', status: 'completed' })) });
      return reply({ stopReason: 'end_turn' });
    }
    default:
      return send({ id: m.id, error: { code: -32601, message: `unsupported ${m.method}` } });
  }
});
