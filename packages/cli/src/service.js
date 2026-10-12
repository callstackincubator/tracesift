import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const SERVICE_DESCRIPTOR = 'service.json';

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
