// Scripted ACP agent for tests: streams text, makes an edit that needs permission, emits a plan.
// The plan echoes the prompt's numbered lines; a parallel sub-task (« ## Ta tâche ») writes each `write:<file>` it names.
import { createInterface } from 'node:readline';
import { writeFileSync, existsSync } from 'node:fs';

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
      if (process.env.FAKE_INIT_FAIL) process.exit(4);
      return reply({ protocolVersion: 1, agentCapabilities: { loadSession: false }, authMethods: [] });
    case 'session/new':
      return reply({ sessionId: 'fake-1', modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan' }] } });
    case 'session/set_mode':
      mode = m.params.modeId;
      up({ sessionUpdate: 'current_mode_update', currentModeId: mode });
      return reply({});
    case 'session/prompt': {
      const text = m.params.prompt.map((b) => b.text).join('\n');
      if (text.includes('Tu es relecteur senior')) {
        const result = text.includes('review-fail') ? { approved: false, findings: [{ path: 'a.txt:1', message: 'Corriger la valeur review-fail' }] } : { approved: true, findings: [] };
        up({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(result) } });
        return reply({ stopReason: 'end_turn' });
      }
      if (text.includes('<transcript>')) { // AvityOne's memory module: answer with a summary that names the session
        up({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '{"title": "Titre automatique", "summary": "Résumé.", "memories": []}' } });
        return reply({ stopReason: 'end_turn' });
      }
      const ask = m.params.prompt.findLast((b) => b.type === 'text').text;
      if (ask.includes('retry-once') && !existsSync('.fake-attempt')) { writeFileSync('.fake-attempt', '1'); process.exit(3); }
      if (ask.includes('stall-forever')) return;
      if (ask.includes('slow-task')) await new Promise((r) => setTimeout(r, 250));
      if (ask.includes('crash')) process.exit(3); // « crash »: the agent dies mid-turn
      up({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `mode=${mode} ` } });
      up({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `ctx=${text.includes('<avity-context>')}` } });
      const images = m.params.prompt.filter((b) => b.type === 'image').length;
      if (images) up({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ` images=${images}` } });
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
