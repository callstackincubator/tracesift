import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { writeConfig } from '../src/config.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const initial = { version: 1, provider: 'apex', model: 'callstack/Apex', keys: { apex: 'production-smoke-secret' } };
for (const mode of ['configured', 'missing', 'malformed']) {
  test(`production startup freezes ${mode} configuration before first request`, async () => {
    const home = await mkdtemp(join(tmpdir(), 'perf-ai-production-'));
    const probe = createServer();
    await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    if (mode === 'configured') await writeConfig(initial, home);
    if (mode === 'malformed') await writeFile(join(home, 'config.json'), 'invalid');
    const child = spawn(process.execPath, ['--import', '@callstack/perf-ai/bootstrap', 'node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', String(port)], { cwd: root, env: { ...process.env, PERF_AI_HOME: home, PERF_AI_INSTANCE: 'production-smoke' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = new Promise(resolve => child.on('exit', resolve));
    let logs = '';
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Startup timeout: ${logs}`)), 20000);
        child.stdout.on('data', data => { logs += data; if (/Ready in/.test(logs)) { clearTimeout(timer); resolve(); } });
        child.stderr.on('data', data => logs += data);
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('exit', () => { clearTimeout(timer); reject(new Error(`Early exit: ${logs}`)); });
      });
      await writeConfig({ ...initial, model: 'changed-before-first-request' }, home);
      const response = await fetch(`http://127.0.0.1:${port}/api/model`, { signal: AbortSignal.timeout(10000) });
      assert.equal(response.headers.get('x-perf-ai-instance'), 'production-smoke');
      const status = await response.json();
      assert.equal(status.configured, mode === 'configured');
      if (mode === 'configured') assert.equal(status.model, 'Apex');
      if (mode === 'missing') assert.match(status.error, /Run perf-ai model/);
      if (mode === 'malformed') assert.match(status.error, /Invalid model configuration/);
      assert(!JSON.stringify(status).includes('production-smoke-secret'));
    } finally {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      await exited;
      clearTimeout(timer);
      await rm(home, { recursive: true, force: true });
    }
  });
}
