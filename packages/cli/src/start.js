import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { getHome, ensureHome } from './config.js';
import { readRelease, verifyInstallation } from './install.js';
import { acquireLock, launch } from './process.js';

export function parsePort(value = '3000') {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Error('--port must be an integer between 1 and 65535.');
  return Number(value);
}
export async function assertPortAvailable(port) {
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', () => reject(new Error(`Port ${port} is occupied. Choose another with --port.`)));
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}
export async function waitForReady(proc, url, instance, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (proc.finished) throw new Error('The web server exited before becoming ready. See the server logs above.');
    try {
      const response = await fetch(`${url}/api/model`, { signal: AbortSignal.timeout(1000), cache: 'no-store' });
      if (response.ok && response.headers.get('x-perf-ai-instance') === instance && !proc.finished) return;
    } catch { /* Next.js is still starting */ }
    await delay(200);
  }
  throw new Error('The web server did not become ready within 60 seconds. See the server logs above.');
}
export function openBrowser(url, spawnProcess = spawn) {
  // Browser lifetime is independent of the terminal and server process group.
  const failed = () => console.log(`Could not open a browser. Open ${url} manually.`);
  try {
    const browser = spawnProcess(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true });
    browser.once('error', failed);
    browser.once('exit', code => { if (code !== 0 && code !== null) failed(); });
    browser.unref();
  } catch { failed(); }
}
export async function start({ home = getHome(), port = 3000, open = true } = {}) {
  const release = await readRelease();
  await ensureHome(home);
  const unlock = await acquireLock(home);
  let proc;
  const handlers = new Map();
  let stopping = false;
  try {
    await verifyInstallation(home, release);
    await assertPortAvailable(port);
    const instance = randomUUID();
    const url = `http://127.0.0.1:${port}`;
    const app = join(home, 'app');
    proc = launch(process.execPath, ['--import', '@callstack/perf-ai/bootstrap', join(app, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: app, env: { ...process.env, PERF_AI_HOME: home, PERF_AI_INSTANCE: instance } });
    for (const signal of ['SIGINT', 'SIGTERM']) {
      const handler = () => { stopping = true; void proc.stop(signal); };
      handlers.set(signal, handler); process.on(signal, handler);
    }
    await unlock.trackChild(proc.child.pid);
    await waitForReady(proc, url, instance);
    console.log(`perf-ai is ready at ${url}\nPress Ctrl+C to stop. Restarting clears analysis results.`);
    if (open && !stopping) openBrowser(url);
    const result = await proc.done;
    if (!stopping && result.code !== 0) throw new Error(`The web server exited (${result.signal || result.code}).`);
  } catch (error) { if (!stopping) throw error; }
  finally {
    if (proc) await proc.stop();
    for (const [signal, handler] of handlers) process.off(signal, handler);
    await unlock();
  }
}
