import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const mode = process.argv[2];
if (mode.startsWith('hang-marker=')) {
  const marker = mode.slice(12);
  writeFileSync(marker, process.env.HOME);
  spawn(process.execPath, ['-e', 'setTimeout(() => require("node:fs").writeFileSync(process.argv[1], "not killed"), 400)', `${marker}-late`], { stdio: 'ignore' });
  setInterval(() => {}, 1000);
} else if (mode === 'hang') setInterval(() => {}, 1000);
else if (mode === 'oversized') { process.stdout.write('x'.repeat(70 * 1024)); setInterval(() => {}, 1000); }
else {
  const privateHome = process.env.HOME;
  const catalog = JSON.parse(readFileSync(join(process.env.XDG_CACHE_HOME, 'opencode/models.json'), 'utf8'));
  const models = Object.fromEntries(Object.entries(catalog.opencode.models).map(([id, model]) => [id, { ...model, cost: { input: model.cost.input, output: model.cost.output, cache: { read: model.cost.cache_read ?? 0, write: model.cost.cache_write ?? 0 } } }]));
  if (process.env.OPENCODE_DISABLE_AUTOUPDATE !== 'true' || process.env.OPENCODE_DISABLE_MODELS_FETCH !== 'true' || !privateHome.includes('avity-opencode-quota-') || existsSync(join(privateHome, '.real-home'))) process.exit(3);
  if (mode.startsWith('marker=')) writeFileSync(mode.slice(7), privateHome);
  const server = createServer((req, res) => {
    if (mode === 'redirect') { res.writeHead(302, { location: 'https://example.invalid/do-not-fetch' }); return res.end(); }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/global/health' ? { healthy: true, version: '1.19.0' } : {
      connected: mode === 'connected' ? ['opencode', 'other'] : ['opencode'],
      default: { opencode: 'big-pickle' },
      all: [{ id: 'opencode', models }],
    }));
  });
  server.listen(0, '127.0.0.1', () => process.stdout.write(`opencode server listening on http://127.0.0.1:${server.address().port}\n`));
}
