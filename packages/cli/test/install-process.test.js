import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { downloadArtifact, install, validateRelease, verifyInstallation } from '../src/install.js';
import { acquireLock, launch, alive, run } from '../src/process.js';
import { parsePort, assertPortAvailable, waitForReady, openBrowser } from '../src/start.js';

async function home(t) { const dir = await mkdtemp(join(tmpdir(), 'tracesift-test-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
const bytes = Buffer.from('fake artifact');
const target = `${process.platform}-${process.arch}`;
const release = {
  schemaVersion: 1, repository: 'https://github.com/callstackincubator/tracesift', version: '0.1.0',
  revision: 'a'.repeat(40), tag: 'tracesift-v0.1.0', artifacts: {
    [target]: { url: 'https://github.com/example/artifact.tar.gz', sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length },
  },
};
const fetchArtifact = async () => new Response(bytes);
async function fakeExtract(_archive, app, metadata = release) {
  await mkdir(join(app, '.next'), { recursive: true });
  await mkdir(join(app, '.next/static'), { recursive: true });
  await mkdir(join(app, 'public'), { recursive: true });
  await mkdir(join(app, 'node_modules/@callstack/tracesift/src'), { recursive: true });
  await mkdir(join(app, 'node_modules/@earendil-works/pi-coding-agent'), { recursive: true });
  await mkdir(join(app, 'node_modules/agent-react-devtools/dist'), { recursive: true });
  await writeFile(join(app, 'server.js'), '');
  await writeFile(join(app, '.next/BUILD_ID'), 'test');
  await writeFile(join(app, 'node_modules/@callstack/tracesift/src/bootstrap.js'), '');
  await writeFile(join(app, 'node_modules/@callstack/tracesift/src/runtime.js'), '');
  await writeFile(join(app, 'node_modules/@earendil-works/pi-coding-agent/package.json'), '{}');
  await writeFile(join(app, 'node_modules/agent-react-devtools/package.json'), '{}');
  await writeFile(join(app, 'node_modules/agent-react-devtools/dist/profile-offline.js'), '');
  await writeFile(join(app, 'node_modules/agent-react-devtools/dist/profile-offline-LICENSE.txt'), '');
  await writeFile(join(app, 'tracesift-artifact.json'), JSON.stringify({
    schemaVersion: 1, version: metadata.version, revision: metadata.revision,
    platform: process.platform, arch: process.arch, buildId: 'test',
  }));
}
test('staging install is repeatable and failures preserve installation and config', async t => {
  const dir = await home(t);
  await writeFile(join(dir, 'config.json'), 'preserved');
  await install({ home: dir, release, fetchImpl: fetchArtifact, extract: fakeExtract });
  await verifyInstallation(dir, release);
  await install({ home: dir, release, fetchImpl: async () => { assert.fail('already installed'); } });
  const next = { ...release, revision: 'b'.repeat(40), artifacts: {
    [target]: { ...release.artifacts[target], sha256: 'b'.repeat(64) },
  } };
  await assert.rejects(verifyInstallation(dir, next), /init/);
  const failures = [
    { fetchImpl: async () => { throw new Error('simulated failure'); } },
    { fetchImpl: fetchArtifact, extract: async () => { throw new Error('simulated failure'); } },
  ];
  for (const failure of failures) {
    await assert.rejects(install({ home: dir, release: { ...next, artifacts: { [target]: release.artifacts[target] } }, ...failure }), /simulated failure/);
    await verifyInstallation(dir, release);
    assert.equal(await readFile(join(dir, 'config.json'), 'utf8'), 'preserved');
    assert.deepEqual((await readdir(dir)).sort(), ['app', 'config.json']);
  }
});

test('release metadata rejects unsafe or unsupported artifact sources', () => {
  assert.equal(validateRelease(release), release);
  assert.throws(() => validateRelease({ ...release, repository: 'https://example.com/wrong' }), /Invalid release/);
  assert.throws(() => validateRelease({ ...release, artifacts: { [target]: { ...release.artifacts[target], url: 'http://example.com/app.tar.gz' } } }), /Invalid release/);
  assert.doesNotThrow(() => validateRelease({ ...release, artifacts: { [target]: { ...release.artifacts[target], url: 'http://127.0.0.1:1234/app.tar.gz' } } }));
});

test('artifact download enforces the declared size and SHA-256', async t => {
  const dir = await home(t);
  const artifact = release.artifacts[target];
  await downloadArtifact(artifact, join(dir, 'valid.tar.gz'), fetchArtifact);
  await assert.rejects(downloadArtifact({ ...artifact, size: artifact.size - 1 }, join(dir, 'large.tar.gz'), fetchArtifact), /larger/);
  await assert.rejects(downloadArtifact({ ...artifact, sha256: 'c'.repeat(64) }, join(dir, 'wrong.tar.gz'), fetchArtifact), /SHA-256/);
  assert.deepEqual((await readdir(dir)).sort(), ['valid.tar.gz']);
});

test('lock excludes parallel operations and recovers stale ownership', async t => {
  const dir = await home(t);
  const unlock = await acquireLock(dir);
  await assert.rejects(acquireLock(dir), /running/);
  await unlock();
  await writeFile(join(dir, 'process.json'), JSON.stringify({ pid: 2147483647, token: 'dead' }));
  const orphan = launch(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  try {
    await writeFile(join(dir, 'process.json'), JSON.stringify({ pid: 2147483647, childPid: orphan.child.pid, token: 'orphan' }));
    await assert.rejects(acquireLock(dir), /running/);
  } finally { await orphan.stop(); }
  await (await acquireLock(dir))();
  assert.deepEqual(await readdir(dir), []);
});

test('process supervisor stops child group and reports command errors', async () => {
  const proc = launch(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  assert(alive(proc.child.pid));
  await proc.stop();
  await proc.done;
  assert.equal(alive(proc.child.pid), false);
  const missing = launch('/does-not-exist-tracesift', [], { stdio: 'ignore' });
  await assert.rejects(missing.done, /ENOENT/);
});

test('post-exit EPERM cleanup preserves command results and clears child tracking', async t => {
  const originalKill = process.kill;
  let childPid;
  let denied = 0;
  t.mock.method(process, 'kill', (pid, signal) => {
    if (pid === -childPid) {
      denied++;
      throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
    }
    return originalKill.call(process, pid, signal);
  });
  const tracked = [];
  const options = { stdio: 'ignore', onSpawn(pid) { tracked.push(pid); if (pid) childPid = pid; } };
  await run(process.execPath, ['-e', ''], options);
  assert.equal(tracked.at(-1), undefined);
  await assert.rejects(run(process.execPath, ['-e', 'process.exit(7)'], options), /failed \(7\)/);
  assert.equal(tracked.at(-1), undefined);
  assert(denied > 0, 'exercises permission-denied cleanup');
});

test('permission errors stopping a running child are still reported', async t => {
  const proc = launch(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const originalKill = process.kill;
  const mock = t.mock.method(process, 'kill', (pid, signal) => {
    if (pid === -proc.child.pid) throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
    return originalKill.call(process, pid, signal);
  });
  try {
    await assert.rejects(proc.stop(), { code: 'EPERM' });
    assert.equal(proc.finished, false);
  } finally {
    mock.mock.restore();
    await proc.stop();
  }
});

test('readiness checks instance identity, occupied port, early exits and timeout', async t => {
  const server = createServer((_req, res) => { res.setHeader('x-tracesift-instance', 'owned'); res.end('{}'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}`;
  await assert.rejects(assertPortAvailable(port), /occupied/);
  await waitForReady({ finished: false }, url, 'owned', 500);
  await assert.rejects(waitForReady({ finished: false }, url, 'unrelated', 100), /ready/);
  await assert.rejects(waitForReady({ finished: true }, url, 'owned', 100), /exited/);
  assert.equal(parsePort(), 3000);
  for (const invalid of ['0', '-1', '65536', 'abc', '1.5']) assert.throws(() => parsePort(invalid));
});

test('SIGTERM reaches the supervised child and the runner exits nonzero', async t => {
  const dir = await home(t);
  const marker = join(dir, 'ready');
  const childScript = `require('fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(()=>{},1000)`;
  const script = `import {run} from ${JSON.stringify(new URL('../src/process.js', import.meta.url).href)}; try { await run(process.execPath,['-e',${JSON.stringify(childScript)}], {stdio:'ignore'}); } catch { process.exitCode=1; }`;
  const runner = launch(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore' });
  t.after(() => runner.stop());
  let pid;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { pid = Number(await readFile(marker, 'utf8')); break; } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  assert(pid, 'child reports readiness');
  runner.child.kill('SIGTERM');
  const result = await runner.done;
  assert.equal(result.code, 1);
  assert.equal(alive(pid), false);
});


test('browser launch detaches and handles opening failures without stopping the server', () => {
  const browser = new EventEmitter();
  let detached = false;
  browser.unref = () => { detached = true; };
  openBrowser('http://127.0.0.1:3000', (_command, args, options) => {
    assert.deepEqual(args, ['http://127.0.0.1:3000']);
    assert.equal(options.detached, true);
    return browser;
  });
  assert(detached);
  assert.doesNotThrow(() => browser.emit('error', new Error('missing opener')));
});
