import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('production React endpoint resolves the patched CLI and reaches the model boundary', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'perf-ai-react-production-'));
  const probe = createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const child = spawn(process.execPath, ['--import', '@callstack/perf-ai/bootstrap', 'node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', String(port)], {
    cwd: process.cwd(), env: { ...process.env, PERF_AI_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise(resolve => child.once('exit', resolve));
  let logs = '';
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Startup timeout: ${logs}`)), 20000);
      child.stdout.on('data', data => { logs += data; if (/Ready in/.test(logs)) { clearTimeout(timer); resolve(); } });
      child.stderr.on('data', data => { logs += data; });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error(`Early exit: ${logs}`)); });
    });
    const profile = await readFile('test-fixtures/react/react-native-v5.synthetic.json');
    for (const [body, threshold, expected] of [[profile, '1000', 200], [profile, null, 503], ['null', null, 400]]) {
      const form = new FormData();
      form.set('profile', new File([body], 'react-profile.json'));
      if (threshold !== null) { form.set('minAvgDurationMs', threshold); form.set('frameBudgetMs', '100'); }
      const response = await fetch(`http://127.0.0.1:${port}/api/analyze/react`, { method: 'POST', body: form, signal: AbortSignal.timeout(15000) });
      const result = await response.json();
      assert.equal(response.status, expected, JSON.stringify(result) + logs);
      if (expected === 200) { assert.equal(result.components, undefined); assert.deepEqual(result.issues, []); assert.equal(result.noIssue, true); assert.equal(result.usage.totalTokens, 0); }
      if (expected === 503) assert.match(result.error, /Analysis settings/);
    }
  } finally {
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    await exited;
    clearTimeout(timer);
    await rm(home, { recursive: true, force: true });
  }
});
