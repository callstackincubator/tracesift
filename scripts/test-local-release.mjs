#!/usr/bin/env node
// End-to-end test of the packaged CLI against a locally served release artifact.
import { createReadStream } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '..');
const keepOpen = process.argv.includes('--keep-open');
const unknown = process.argv.slice(2).filter(arg => arg !== '--keep-open');
if (unknown.length) {
  console.error('Usage: node scripts/test-local-release.mjs [--keep-open]');
  process.exit(1);
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    console.log(`$ ${command} ${args.join(' ')}`);
    const child = spawn(command, args, { cwd: root, stdio: ['inherit', 'pipe', 'pipe'], ...options });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', chunk => {
        output += chunk;
        (stream === child.stdout ? process.stdout : process.stderr).write(chunk);
      });
    }
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolveRun(output) : reject(new Error(`${command} exited with status ${code}`)));
  });
}

async function freePort() {
  const server = createTcpServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const port = server.address().port;
  await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  return port;
}

async function serveArtifact(file) {
  const route = `/${basename(file)}`;
  const server = createHttpServer((request, response) => {
    if (request.url !== route || !['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/gzip' });
    if (request.method === 'HEAD') response.end();
    else createReadStream(file).on('error', () => response.destroy()).pipe(response);
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  return { url: `http://127.0.0.1:${server.address().port}${route}`, close: () => new Promise(resolveClose => server.close(resolveClose)) };
}

async function waitForModel(url, child) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('tracesift start exited before the model endpoint became ready');
    try {
      const response = await fetch(`${url}/api/model`, { signal: AbortSignal.timeout(1500), cache: 'no-store' });
      if (response.ok && response.headers.get('x-tracesift-instance')) {
        await response.json();
        return;
      }
    } catch { /* Server is still starting. */ }
    await delay(250);
  }
  throw new Error('Timed out waiting for /api/model');
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise(resolveClose => child.once('close', resolveClose));
  child.kill('SIGINT');
  await Promise.race([closed, delay(5_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    await Promise.race([closed, delay(5_000)]);
  }
}

let temp;
let artifactServer;
let started;
try {
  await run('npm', ['run', 'build']);
  await run(process.execPath, ['scripts/package-standalone.mjs']);

  const packageInfo = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const name = `tracesift-app-v${packageInfo.version}-${process.platform}-${process.arch}`;
  const sidecar = JSON.parse(await readFile(join(root, 'dist', `${name}.json`), 'utf8'));
  const archive = join(root, 'dist', sidecar.filename);
  if (sidecar.schemaVersion !== 1 || sidecar.version !== packageInfo.version || sidecar.platform !== process.platform || sidecar.arch !== process.arch ||
      !/^[a-f0-9]{40}$/.test(sidecar.revision) || !/^[a-f0-9]{64}$/.test(sidecar.sha256) || !Number.isSafeInteger(sidecar.size) || sidecar.size < 1 ||
      sidecar.filename !== `${name}.tar.gz` || (await stat(archive)).size !== sidecar.size) {
    throw new Error('The current-platform artifact sidecar is invalid');
  }

  temp = await mkdtemp(join(tmpdir(), 'tracesift-local-release-'));
  artifactServer = await serveArtifact(archive);
  const cliSource = join(root, 'packages', 'cli');
  const cliCopy = join(temp, 'cli');
  await mkdir(cliCopy);
  await cp(join(cliSource, 'src'), join(cliCopy, 'src'), { recursive: true });
  await cp(join(root, 'README.md'), join(cliCopy, 'README.md'));
  await cp(join(root, 'LICENSE'), join(cliCopy, 'LICENSE'));
  const cliPackage = JSON.parse(await readFile(join(cliSource, 'package.json'), 'utf8'));
  delete cliPackage.scripts?.prepack;
  delete cliPackage.scripts?.postpack;
  await writeFile(join(cliCopy, 'package.json'), `${JSON.stringify(cliPackage, null, 2)}\n`);
  const release = {
    schemaVersion: 1,
    repository: 'https://github.com/callstackincubator/tracesift',
    version: sidecar.version,
    revision: sidecar.revision,
    tag: `tracesift-v${sidecar.version}`,
    artifacts: {
      [`${sidecar.platform}-${sidecar.arch}`]: {
        url: artifactServer.url,
        sha256: sidecar.sha256,
        size: sidecar.size,
      },
    },
  };
  await writeFile(join(cliCopy, 'release.json'), `${JSON.stringify(release, null, 2)}\n`);

  const packOutput = await run('npm', ['pack', '--ignore-scripts', '--pack-destination', temp, cliCopy], { cwd: temp });
  const tarballName = packOutput.split('\n').map(line => line.trim()).find(line => /^[^\s/]+\.tgz$/.test(line));
  if (!tarballName?.endsWith('.tgz')) throw new Error('npm pack did not produce a CLI tarball');
  const prefix = join(temp, 'prefix');
  await run('npm', ['install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', join(temp, tarballName)], { cwd: temp });

  const cli = join(prefix, 'node_modules', '@callstack', 'tracesift', 'src', 'cli.js');
  const home = join(temp, 'home');
  const env = { ...process.env, TRACE_SIFT_HOME: home };
  await run(process.execPath, [cli, 'init'], { cwd: temp, env });
  const installed = join(home, 'app', '.tracesift-install.json');
  const first = await stat(installed);
  await run(process.execPath, [cli, 'init'], { cwd: temp, env });
  const second = await stat(installed);
  if (first.mtimeMs !== second.mtimeMs) throw new Error('Repeating init replaced a complete installation');

  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  started = spawn(process.execPath, [cli, 'start', '--port', String(port), '--no-open'], { cwd: temp, env, stdio: 'inherit' });
  await waitForModel(url, started);
  console.log(`\nLocal release smoke test passed: ${url}/api/model`);
  if (keepOpen) {
    console.log(`Open ${url} to test analysis manually. Press Ctrl+C to stop.`);
    await Promise.race([
      new Promise(resolveSignal => process.once('SIGINT', resolveSignal)),
      new Promise((resolveClose, reject) => started.once('close', code => code === 0 ? resolveClose() : reject(new Error(`tracesift start exited with status ${code}`)))),
    ]);
  }
} catch (error) {
  console.error(`Local release test failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await stopChild(started);
  if (artifactServer) await artifactServer.close();
  if (temp) await rm(temp, { recursive: true, force: true });
}
