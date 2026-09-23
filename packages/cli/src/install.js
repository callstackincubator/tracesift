import { readFile, mkdtemp, rename, rm, access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ensureHome, getHome } from './config.js';
import { acquireLock, run } from './process.js';

export async function readRelease() {
  let release;
  try { release = JSON.parse(await readFile(new URL('../release.json', import.meta.url), 'utf8')); }
  catch { throw new Error('This CLI has no release metadata. Use a published package, or npm pack from a clean committed checkout.'); }
  if (release.repository !== 'https://github.com/callstackincubator/perf-ai.git' || !/^[a-f0-9]{40}$/.test(release.revision)) throw new Error('Invalid release metadata. Reinstall the CLI.');
  return release;
}
export function prerequisites() {
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Use macOS, Linux, or WSL.');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 19)) throw new Error('Node.js 22.19.0 or newer is required.');
  for (const command of ['git', 'npm']) {
    try { execFileSync(command, ['--version'], { stdio: 'ignore' }); }
    catch { throw new Error(`Install ${command} and make it available on PATH.`); }
  }
}
export async function installation(home = getHome()) {
  try { return JSON.parse(await readFile(join(home, 'app', '.perf-ai-install.json'), 'utf8')); }
  catch { return null; }
}
export async function verifyInstallation(home, release) {
  const record = await installation(home);
  if (!record?.complete || record.revision !== release.revision) throw new Error('Run perf-ai init to install the app matching this CLI release.');
  try { await access(join(home, 'app', '.next', 'BUILD_ID')); await access(join(home, 'app', 'node_modules', 'next', 'dist', 'bin', 'next')); }
  catch { throw new Error('The installation is incomplete. Run perf-ai init again.'); }
}
export async function install({ home = getHome(), release, execute = run } = {}) {
  release ??= await readRelease();
  await ensureHome(home);
  const unlock = await acquireLock(home);
  const executeTracked = (command, args, options = {}) => execute(command, args, { ...options, onSpawn: unlock.trackChild });
  let stage;
  try {
    try { await verifyInstallation(home, release); console.log('This release is already installed.'); return; } catch { /* build missing or another revision */ }
    stage = await mkdtemp(join(home, '.install-'));
    const checkout = join(stage, 'app');
    console.log('Cloning the pinned perf-ai revision…');
    await executeTracked('git', ['clone', '--no-checkout', '--', release.repository, checkout]);
    await executeTracked('git', ['checkout', '--detach', release.revision], { cwd: checkout });
    console.log('Installing dependencies…');
    await executeTracked('npm', ['ci', '--include=dev'], { cwd: checkout });
    console.log('Building the web app…');
    await executeTracked('npm', ['run', 'build'], { cwd: checkout });
    await access(join(checkout, '.next', 'BUILD_ID'));
    await writeFile(join(checkout, '.perf-ai-install.json'), JSON.stringify({ complete: true, revision: release.revision }) + '\n');
    const app = join(home, 'app');
    const previous = join(stage, 'previous');
    let hadPrevious = false;
    try { await rename(app, previous); hadPrevious = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await rename(checkout, app); }
    catch (error) { if (hadPrevious) await rename(previous, app); throw error; }
    console.log('Installed. Run perf-ai start, then choose a model in Analysis settings.');
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true });
    await unlock();
  }
}
