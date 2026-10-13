import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { totalmem } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { getHome, ensureHome } from './config.js';
import { readRelease, verifyInstallation } from './install.js';
import { acquireLock, launch } from './process.js';
import { removeServiceDescriptor, writeServiceDescriptor } from './service.js';

/**
 * Profiles are parsed whole in memory, so the stock ~4 GB heap is the practical
 * ceiling on profile size long before the upload limit is. Raising the cap costs
 * nothing until it is used — V8 grows the heap on demand — but it should still
 * stay well under physical memory so a runaway parse fails with a JavaScript
 * out-of-memory error rather than pushing the machine into swap.
 */
export function heapLimitMb(total = totalmem()) {
  const half = Math.round(total / 2 / 1024 / 1024);
  return Math.min(8192, Math.max(2048, half));
}
/** A heap size the user set themselves always wins over ours. */
export function serverNodeArgs(env = process.env) {
  if (/--max[-_]old[-_]space[-_]size/.test(env.NODE_OPTIONS ?? '')) return [];
  return [`--max-old-space-size=${heapLimitMb()}`];
}

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
      if (response.ok && response.headers.get('x-tracesift-instance') === instance && !proc.finished) return;
    } catch { /* Next.js is still starting */ }
    await delay(200);
  }
  throw new Error('The web server did not become ready within 60 seconds. See the server logs above.');
}
export function openBrowser(url, spawnProcess = spawn, launchTimeoutMs = 1000) {
  // Browser lifetime is independent of the terminal and server process group.
  const failed = () => console.log(`Could not open a browser. Open ${url} manually.`);
  try {
    const browser = spawnProcess(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true });
    return new Promise(resolve => {
      let settled = false;
      let timeout;
      const finish = opened => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        browser.unref();
        resolve(opened);
      };
      timeout = setTimeout(() => finish(true), launchTimeoutMs);
      browser.once('error', () => { failed(); finish(false); });
      browser.once('exit', code => {
        const opened = code === 0 || code === null;
        if (!opened) failed();
        finish(opened);
      });
    });
  } catch { failed(); return Promise.resolve(false); }
}
export async function start({ home = getHome(), port = 3000, open = true } = {}) {
  const release = await readRelease();
  await ensureHome(home);
  const unlock = await acquireLock(home);
  let proc;
  let instance;
  const handlers = new Map();
  let stopping = false;
  try {
    await verifyInstallation(home, release);
    await assertPortAvailable(port);
    instance = randomUUID();
    const integrationToken = randomBytes(32).toString('base64url');
    const url = `http://127.0.0.1:${port}`;
    const app = join(home, 'app');
    proc = launch(process.execPath, [...serverNodeArgs(), '--import', '@callstack/tracesift/bootstrap', join(app, 'server.js')], {
      cwd: app,
      env: {
        ...process.env,
        HOSTNAME: '127.0.0.1',
        PORT: String(port),
        TRACE_SIFT_HOME: home,
        TRACE_SIFT_INSTANCE: instance,
        TRACE_SIFT_VERSION: release.version,
        TRACE_SIFT_INTEGRATION_TOKEN: integrationToken,
      },
    });
    for (const signal of ['SIGINT', 'SIGTERM']) {
      const handler = () => { stopping = true; void proc.stop(signal); };
      handlers.set(signal, handler); process.on(signal, handler);
    }
    await unlock.trackChild(proc.child.pid);
    await waitForReady(proc, url, instance);
    await writeServiceDescriptor(home, {
      version: release.version,
      apiVersion: 1,
      pid: process.pid,
      childPid: proc.child.pid,
      instance,
      baseUrl: url,
      token: integrationToken,
      startedAt: Date.now(),
    });
    console.log(`TraceSift is ready at ${url}\nPress Ctrl+C to stop. Restarting clears analysis results unless saved.`);
    if (open && !stopping) openBrowser(url);
    const result = await proc.done;
    if (!stopping && result.code !== 0) throw new Error(`The web server exited (${result.signal || result.code}).`);
  } catch (error) { if (!stopping) throw error; }
  finally {
    if (proc) await proc.stop();
    await removeServiceDescriptor(home, instance);
    for (const [signal, handler] of handlers) process.off(signal, handler);
    await unlock();
  }
}
