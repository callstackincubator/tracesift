import { spawn } from 'node:child_process';
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
export async function acquireLock(home) {
  const path = join(home, 'process.json');
  const token = randomUUID();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await writeFile(path, JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600 });
      const unlock = async () => {
        const record = await readFile(path, 'utf8').then(JSON.parse).catch(() => null);
        if (record?.token === token) await rm(path, { force: true });
      };
      unlock.trackChild = async childPid => {
        const record = JSON.parse(await readFile(path, 'utf8'));
        if (record.token !== token) throw new Error('Lost perf-ai operation lock.');
        const temporary = join(home, `.process-${token}`);
        try {
          await writeFile(temporary, JSON.stringify({ pid: process.pid, token, childPid }), { mode: 0o600 });
          await rename(temporary, path);
        } finally { await rm(temporary, { force: true }); }
      };
      return unlock;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let record;
      try { record = JSON.parse(await readFile(path, 'utf8')); }
      catch { throw new Error('Cannot read process.json. Stop any perf-ai processes before removing this lock.'); }
      if (alive(record.pid) || alive(record.childPid)) throw new Error('Another perf-ai operation or server is running. Stop it first.');
      // Serialize stale recovery with an exclusive recovery lock.
      const recovery = `${path}.recovery`;
      try { await writeFile(recovery, '', { flag: 'wx', mode: 0o600 }); }
      catch { throw new Error('Another perf-ai operation is recovering its lock. Retry shortly.'); }
      try {
        const current = JSON.parse(await readFile(path, 'utf8'));
        if (current.token === record.token && !alive(current.pid) && !alive(current.childPid)) await rm(path);
      } finally { await rm(recovery, { force: true }); }
    }
  }
  throw new Error('Could not acquire the perf-ai operation lock. Retry shortly.');
}

export function launch(command, args, options = {}) {
  const child = spawn(command, args, { stdio: 'inherit', detached: true, ...options });
  let finished = false;
  const done = new Promise((resolve, reject) => {
    child.once('error', error => { finished = true; reject(error); });
    child.once('exit', (code, signal) => { finished = true; resolve({ code, signal }); });
  });
  // Attach immediately so launch errors during readiness cannot become unhandled rejections.
  done.catch(() => {});
  const kill = signal => { try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH' && child.pid) throw error; } };
  return { child, done, get finished() { return finished; }, async stop(signal = 'SIGTERM') {
    if (!child.pid) return;
    kill(signal);
    await Promise.race([done.catch(() => {}), delay(3000, undefined, { ref: false })]);
    // Kill descendants too, even when the group leader exited first.
    kill('SIGKILL');
  } };
}
export async function run(command, args, options = {}) {
  const { onSpawn, ...spawnOptions } = options;
  const proc = launch(command, args, spawnOptions);
  let interrupted = false;
  const handlers = new Map(['SIGINT', 'SIGTERM'].map(signal => [signal, () => { interrupted = true; void proc.stop(signal); }]));
  for (const [signal, handler] of handlers) process.on(signal, handler);
  try {
    await onSpawn?.(proc.child.pid);
    const result = await proc.done;
    if (interrupted || result.code !== 0) throw new Error(`${command} failed (${result.signal || result.code}).`);
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    await proc.stop();
    await onSpawn?.(undefined);
  }
}
