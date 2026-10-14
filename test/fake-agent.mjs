// Scripted ACP agent for tests: streams text, makes an edit that needs permission, emits a plan.
import { createInterface } from 'node:readline';

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
      up({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `mode=${mode} ` } });
      up({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `ctx=${text.includes('<avity-context>')}` } });
      up({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Edit a.txt', kind: 'edit', status: 'pending' });
      const id = nextId++;
      send({ id, method: 'session/request_permission', params: { sessionId: 'fake-1', toolCall: { toolCallId: 't1', kind: 'edit', title: 'Edit a.txt' },
        options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }] } });
      const res = await new Promise((r) => waiting.set(id, r));
      const ok = res.outcome.optionId === 'yes';
      up({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: ok ? 'completed' : 'failed', content: ok ? [{ type: 'diff', path: 'a.txt', oldText: 'a', newText: 'b' }] : [] });
      up({ sessionUpdate: 'plan', entries: [{ content: 'step', priority: 'high', status: 'completed' }] });
      return reply({ stopReason: 'end_turn' });
    }
    default:
      return send({ id: m.id, error: { code: -32601, message: `unsupported ${m.method}` } });
  }
});
