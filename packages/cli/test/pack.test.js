import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, cp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

test('packed artifact contains executable and shared exports, runnable outside repository', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'tracesift-pack-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const source = fileURLToPath(new URL('../', import.meta.url));
  const repositoryReadme = fileURLToPath(new URL('../../../README.md', import.meta.url));
  const repositoryLicense = fileURLToPath(new URL('../../../LICENSE', import.meta.url));
  const copy = join(temp, 'source');
  await mkdir(copy);
  for (const entry of ['src', 'package.json']) await cp(join(source, entry), join(copy, entry), { recursive: true });
  await cp(repositoryReadme, join(copy, 'README.md'));
  await cp(repositoryLicense, join(copy, 'LICENSE'));
  // This is packaging-layout coverage, not a publishable release: real prepack requires clean Git state.
  await writeFile(join(copy, 'release.json'), JSON.stringify({
    schemaVersion: 1,
    repository: 'https://github.com/callstackincubator/tracesift',
    version: '0.1.0',
    revision: 'a'.repeat(40),
    tag: 'tracesift-v0.1.0',
    artifacts: Object.fromEntries(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'].map(target => [target, {
      url: `https://github.com/callstackincubator/tracesift/releases/download/tracesift-v0.1.0/tracesift-app-v0.1.0-${target}.tar.gz`,
      sha256: 'b'.repeat(64), size: 1,
    }])),
  }));
  const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--cache', join(temp, 'cache')], { cwd: copy, encoding: 'utf8' }))[0];
  assert(packed.files.some(file => file.path === 'release.json'));
  assert(packed.files.some(file => file.path === 'README.md'));
  assert(packed.files.some(file => file.path === 'LICENSE'));
  assert(packed.files.some(file => file.path === 'src/cli.js' && (file.mode & 0o111)));
  assert(!packed.files.some(file => file.path.startsWith('test/')));
  const modules = join(temp, 'node_modules');
  await mkdir(join(modules, '@callstack/tracesift'), { recursive: true });
  execFileSync('tar', ['-xzf', join(copy, packed.filename), '-C', join(modules, '@callstack/tracesift'), '--strip-components=1']);
  await symlink(fileURLToPath(new URL('../../../node_modules/@earendil-works', import.meta.url)), join(modules, '@earendil-works'));
  await symlink(fileURLToPath(new URL('../../../node_modules/tar', import.meta.url)), join(modules, 'tar'));
  const pkg = JSON.parse(await readFile(join(modules, '@callstack/tracesift/package.json'), 'utf8'));
  assert.equal(await readFile(join(modules, '@callstack/tracesift/README.md'), 'utf8'), await readFile(repositoryReadme, 'utf8'));
  assert.equal(await readFile(join(modules, '@callstack/tracesift/LICENSE'), 'utf8'), await readFile(repositoryLicense, 'utf8'));
  assert.equal(pkg.license, 'MIT');
  assert.deepEqual(Object.keys(pkg.exports).sort(), ['./bootstrap', './config', './models', './oauth', './runtime']);
  const output = execFileSync(process.execPath, [join(modules, '@callstack/tracesift/src/cli.js'), '--help'], { cwd: temp, encoding: 'utf8' });
  assert.match(output, /tracesift init/);
  execFileSync(process.execPath, ['--input-type=module', '-e', "import '@callstack/tracesift/config'; import '@callstack/tracesift/models'; import '@callstack/tracesift/runtime';"], { cwd: temp });
});
