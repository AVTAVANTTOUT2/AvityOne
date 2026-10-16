import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const mode = process.argv[2] ?? 'valid';
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
if (mode === 'hang-child') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  writeFileSync(process.argv[3], String(child.pid));
}
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (mode.startsWith('hang')) return;
  if (message.id === 1) return send({ id: 1, result: { userAgent: 'fixture' } });
  if (message.method !== 'account/rateLimits/read') return;
  if (mode === 'error') return send({ id: 2, error: { message: 'synthetic-secret-must-not-leak' } });
  if (mode === 'oversized') return send({ id: 2, result: 'x'.repeat(70_000) });
  if (mode === 'malformed') return process.stdout.write('invalid json\n');
  send({ id: 2, result: { rateLimitsByLimitId: { codex: { primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: Math.ceil(Date.now() / 1000) + 3600 }, secondary: { usedPercent: 80, windowDurationMins: 10080, resetsAt: Math.ceil(Date.now() / 1000) + 86400 } } } } });
});
