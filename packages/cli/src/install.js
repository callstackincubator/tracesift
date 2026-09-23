import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';
import { ensureHome, getHome } from './config.js';
import { acquireLock } from './process.js';

const REPOSITORY = 'https://github.com/callstackincubator/tracesift';
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const REVISION = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const TARGETS = new Set(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']);

function invalidRelease() {
  throw new Error('Invalid release metadata. Reinstall the CLI.');
}

function validArtifact(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !SHA256.test(value.sha256) ||
      !Number.isSafeInteger(value.size) || value.size < 1 || typeof value.url !== 'string') return false;
  let url;
  try { url = new URL(value.url); } catch { return false; }
  if (url.username || url.password || url.hash) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
}

export function validateRelease(value) {
  if (!value || value.schemaVersion !== 1 || value.repository !== REPOSITORY || !VERSION.test(value.version) ||
      !REVISION.test(value.revision) || value.tag !== `tracesift-v${value.version}` ||
      !value.artifacts || typeof value.artifacts !== 'object' || Array.isArray(value.artifacts)) invalidRelease();
  const entries = Object.entries(value.artifacts);
  if (!entries.length || entries.some(([target, artifact]) => !TARGETS.has(target) || !validArtifact(artifact))) invalidRelease();
  return value;
}

export async function readRelease() {
  try { return validateRelease(JSON.parse(await readFile(new URL('../release.json', import.meta.url), 'utf8'))); }
  catch (error) {
    if (error instanceof Error && error.message === 'Invalid release metadata. Reinstall the CLI.') throw error;
    throw new Error('This CLI has no valid release metadata. Use a published package or the local release harness.');
  }
}

export function prerequisites() {
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Use macOS, Linux, or WSL.');
  if (!['x64', 'arm64'].includes(process.arch)) throw new Error('Use an x64 or arm64 machine.');
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 19)) throw new Error('Node.js 22.19.0 or newer is required.');
}

export async function installation(home = getHome()) {
  try { return JSON.parse(await readFile(join(home, 'app', '.tracesift-install.json'), 'utf8')); }
  catch { return null; }
}

async function readArtifactManifest(app) {
  try { return JSON.parse(await readFile(join(app, 'tracesift-artifact.json'), 'utf8')); }
  catch { return null; }
}

const REQUIRED_FILES = [
  'server.js', '.next/BUILD_ID',
  'node_modules/@callstack/tracesift/src/bootstrap.js',
  'node_modules/@callstack/tracesift/src/runtime.js',
  'node_modules/@earendil-works/pi-coding-agent/package.json',
  'node_modules/agent-react-devtools/package.json',
  'node_modules/agent-react-devtools/dist/profile-offline.js',
  'node_modules/agent-react-devtools/dist/profile-offline-LICENSE.txt',
];
const REQUIRED_DIRECTORIES = ['.next/static', 'public'];

async function validateRuntimeFiles(app, message) {
  for (const path of REQUIRED_FILES) {
    if (!(await lstat(join(app, path)).catch(() => null))?.isFile()) throw new Error(message);
  }
  for (const path of REQUIRED_DIRECTORIES) {
    if (!(await lstat(join(app, path)).catch(() => null))?.isDirectory()) throw new Error(message);
  }
}

export async function verifyInstallation(home, release) {
  const target = `${process.platform}-${process.arch}`;
  const artifact = release.artifacts[target];
  if (!artifact) throw new Error(`This TraceSift release does not support ${target}.`);
  const record = await installation(home);
  if (!record?.complete || record.schemaVersion !== 1 || record.version !== release.version || record.revision !== release.revision ||
      record.platform !== process.platform || record.arch !== process.arch || record.sha256 !== artifact.sha256) {
    throw new Error('Run tracesift init to install the app matching this CLI release.');
  }
  const app = join(home, 'app');
  await validateRuntimeFiles(app, 'The installation is incomplete. Run tracesift init again.');
  const manifest = await readArtifactManifest(app);
  if (manifest?.schemaVersion !== 1 || manifest.version !== release.version || manifest.revision !== release.revision ||
      manifest.platform !== process.platform || manifest.arch !== process.arch || typeof manifest.buildId !== 'string' || !manifest.buildId) {
    throw new Error('The installation is incomplete. Run tracesift init again.');
  }
}

export async function downloadArtifact(artifact, destination, fetchImpl = fetch) {
  let response;
  try { response = await fetchImpl(artifact.url, { redirect: 'follow', signal: AbortSignal.timeout(300_000) }); }
  catch (error) { throw new Error(`Could not download the TraceSift app: ${error.message}`); }
  if (!response.ok || !response.body) throw new Error(`Could not download the TraceSift app (HTTP ${response.status}).`);
  const digest = createHash('sha256');
  let size = 0;
  const verify = new Transform({ transform(chunk, _encoding, callback) {
    size += chunk.length;
    if (size > artifact.size) { callback(new Error('Downloaded artifact is larger than its release metadata.')); return; }
    digest.update(chunk);
    callback(null, chunk);
  } });
  try {
    await pipeline(Readable.fromWeb(response.body), verify, createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
  } catch (error) {
    await rm(destination, { force: true });
    throw error;
  }
  if (size !== artifact.size || digest.digest('hex') !== artifact.sha256) {
    await rm(destination, { force: true });
    throw new Error('Downloaded artifact failed size or SHA-256 verification.');
  }
}

function safeArchiveEntry(name, linkpath) {
  if (!name || name.includes('\\') || name.includes('\0') || posix.isAbsolute(name) || posix.normalize(name).startsWith('../')) {
    throw new Error(`Unsafe path in TraceSift artifact: ${name || '(empty)'}`);
  }
  if (linkpath && (linkpath.includes('\\') || linkpath.includes('\0') || posix.isAbsolute(linkpath) ||
      posix.normalize(posix.join(dirname(name), linkpath)).startsWith('../'))) {
    throw new Error(`Unsafe link in TraceSift artifact: ${name}`);
  }
  return true;
}

export async function extractArtifact(archive, destination) {
  await tar.list({ file: archive, strict: true, onentry: entry => safeArchiveEntry(entry.path, entry.linkpath) });
  await tar.extract({ file: archive, cwd: destination, strict: true, preservePaths: false,
    filter: (_path, entry) => safeArchiveEntry(entry.path, entry.linkpath) });
}

async function validateExtractedArtifact(app, release) {
  const manifest = await readArtifactManifest(app);
  if (manifest?.schemaVersion !== 1 || manifest.version !== release.version || manifest.revision !== release.revision ||
      manifest.platform !== process.platform || manifest.arch !== process.arch || typeof manifest.buildId !== 'string' || !manifest.buildId) {
    throw new Error('The downloaded artifact does not match this CLI release or platform.');
  }
  await validateRuntimeFiles(app, 'The downloaded TraceSift installation is incomplete.');
  const buildId = (await readFile(join(app, '.next', 'BUILD_ID'), 'utf8')).trim();
  if (buildId !== manifest.buildId) throw new Error('The downloaded TraceSift build identifier is invalid.');
}

export async function install({ home = getHome(), release, fetchImpl = fetch, extract = extractArtifact } = {}) {
  release = validateRelease(release ?? await readRelease());
  prerequisites();
  await ensureHome(home);
  const unlock = await acquireLock(home);
  let stage;
  try {
    try { await verifyInstallation(home, release); console.log('This release is already installed.'); return; } catch { /* replace missing or mismatched installation */ }
    const target = `${process.platform}-${process.arch}`;
    const artifact = release.artifacts[target];
    if (!artifact) throw new Error(`This TraceSift release does not support ${target}.`);
    stage = await mkdtemp(join(home, '.install-'));
    const archive = join(stage, 'app.tar.gz');
    const app = join(stage, 'app');
    await mkdir(app);
    console.log(`Downloading the TraceSift app for ${target}…`);
    await downloadArtifact(artifact, archive, fetchImpl);
    console.log('Verifying and unpacking the TraceSift app…');
    await extract(archive, app);
    await validateExtractedArtifact(app, release);
    await writeFile(join(app, '.tracesift-install.json'), JSON.stringify({
      schemaVersion: 1, complete: true, version: release.version, revision: release.revision,
      platform: process.platform, arch: process.arch, sha256: artifact.sha256,
    }) + '\n');
    const destination = join(home, 'app');
    const previous = join(stage, 'previous');
    let hadPrevious = false;
    try { await rename(destination, previous); hadPrevious = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await rename(app, destination); }
    catch (error) { if (hadPrevious) await rename(previous, destination); throw error; }
    console.log('Installed. Run tracesift start, then choose a model in Analysis settings.');
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true });
    await unlock();
  }
}
