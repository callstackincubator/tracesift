import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const SERVICE_DESCRIPTOR = 'service.json';

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

/** Read and authenticate the loopback service advertised by `tracesift start`. */
export async function readActiveService(home, fetchImpl = fetch) {
  const path = join(home, SERVICE_DESCRIPTOR);
  let descriptor;
  try {
    const metadata = await stat(path);
    if ((metadata.mode & 0o077) !== 0) throw new Error('TraceSift service.json permissions are unsafe. Restart TraceSift.');
    descriptor = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('TraceSift is not running. Start it with `tracesift start --no-open` and retry.');
    if (error instanceof SyntaxError) throw new Error('TraceSift service.json is invalid. Restart TraceSift.');
    throw error;
  }
  if (descriptor?.apiVersion !== 1 || typeof descriptor.instance !== 'string' ||
      typeof descriptor.token !== 'string' || descriptor.token.length < 16 ||
      typeof descriptor.baseUrl !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+$/.test(descriptor.baseUrl) ||
      (!processAlive(descriptor.pid) && !processAlive(descriptor.childPid))) {
    throw new Error('TraceSift service.json is stale or invalid. Restart TraceSift.');
  }
  let response;
  try {
    response = await fetchImpl(`${descriptor.baseUrl}/api/integration/v1/health`, {
      headers: { Authorization: `Bearer ${descriptor.token}` },
      cache: 'no-store', signal: AbortSignal.timeout(1500),
    });
  } catch { throw new Error('TraceSift is not responding. Restart TraceSift.'); }
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.apiVersion !== 1 || body?.instance !== descriptor.instance) {
    throw new Error('TraceSift service.json does not match the running service. Restart TraceSift.');
  }
  return descriptor;
}

export async function writeServiceDescriptor(home, descriptor) {
  const destination = join(home, SERVICE_DESCRIPTOR);
  const temporary = join(home, `.service-${randomUUID()}`);
  try {
    await writeFile(temporary, `${JSON.stringify(descriptor, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Remove only the service this process published, never a later replacement. */
export async function removeServiceDescriptor(home, instance) {
  const destination = join(home, SERVICE_DESCRIPTOR);
  if (instance) {
    const current = await readFile(destination, 'utf8').then(JSON.parse).catch(() => null);
    if (current?.instance !== instance) return;
  }
  await rm(destination, { force: true });
}
