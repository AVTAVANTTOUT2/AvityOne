// ACP boundary fixture: readiness, native commands, routing, usage and denied authentication.
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
const sessionId = randomUUID();
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const update = (u) => send({ method: 'session/update', params: { sessionId, update: u } });
let cost = 0;
let servers = [];
createInterface({ input: process.stdin }).on('line', async (line) => {
  const m = JSON.parse(line), reply = (result) => send({ id: m.id, result });
  if (m.method === 'initialize') {
    if (process.env.STALL_INIT) return;
    return reply({ protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } }, authMethods: [{ id: 'login', name: 'Connexion' }] });
  }
  if (m.method === 'session/new') {
    servers = m.params.mcpServers;
    if (process.env.FAIL_AUTH) return send({ id: m.id, error: { code: -32000, message: 'Authentication required' } });
    update({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact', description: 'Résumer', input: { hint: 'instructions' } }] });
    return reply({ sessionId });
  }
  if (m.method === 'session/prompt') {
    const text = m.params.prompt.map((p) => p.text ?? '').join('\n');
    if (text.includes('WAIT')) await new Promise((resolve) => setTimeout(resolve, 150));
    const answer = text.startsWith('Choisis l\'agent') ? '{"agent":"fake2","mode":"plan"}' : text.includes('ECHO_MCP') ? JSON.stringify(servers) : 'résultat attendu';
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: answer } });
    cost += 0.02;
    update({ sessionUpdate: 'usage_update', used: 42, size: 1000, cost: { amount: cost, currency: 'USD' } });
    return reply({ stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } });
  }
  reply({});
});
