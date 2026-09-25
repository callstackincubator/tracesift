import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as tar from 'tar';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, process.env.TRACESIFT_ARTIFACT_OUTPUT_DIR || 'dist');
const source = join(root, '.next', 'standalone');
const platform = process.platform;
const arch = process.arch;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function assertFile(path) {
  assert((await stat(path).catch(() => null))?.isFile(), `Required runtime file is missing: ${relative(root, path)}`);
}

async function assertDirectory(path) {
  assert((await stat(path).catch(() => null))?.isDirectory(), `Required runtime directory is missing: ${relative(root, path)}`);
}

async function archiveEntries(directory, prefix = '') {
  const entries = [];
  for (const name of (await readdir(join(directory, prefix))).sort()) {
    const path = prefix ? `${prefix}/${name}` : name;
    const info = await lstat(join(directory, path));
    assert(info.isFile() || info.isDirectory() || info.isSymbolicLink(), `Unsupported artifact entry: ${path}`);
    if (info.isSymbolicLink()) {
      const target = await stat(join(directory, path)).catch(() => null);
      assert(target, `Broken artifact symlink: ${path}`);
      const resolved = resolve(dirname(join(directory, path)), await readlink(join(directory, path)));
      assert(resolved.startsWith(directory + sep), `Artifact symlink escapes archive: ${path}`);
    }
    entries.push(path);
    if (info.isDirectory()) entries.push(...await archiveEntries(directory, path));
  }
  return entries;
}

async function sha256(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}

async function main() {
  assert(['darwin', 'linux'].includes(platform) && ['arm64', 'x64'].includes(arch), `Unsupported artifact target: ${platform}-${arch}`);
  const app = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const cli = JSON.parse(await readFile(join(root, 'packages/cli/package.json'), 'utf8'));
  assert(app.dependencies?.[cli.name] === cli.version, 'The app and CLI versions must match before packaging.');
  assert(app.version === cli.version, 'The application and CLI package versions must match before packaging.');
  assert(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(app.version), 'Invalid application version.');
  const revision = process.env.TRACESIFT_RELEASE_REVISION || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  assert(/^[a-f0-9]{40}$/.test(revision), 'Artifact revision must be a full Git commit SHA.');
  await assertFile(join(source, 'server.js'));
  await assertFile(join(source, '.next/BUILD_ID'));
  await assertDirectory(join(root, '.next/static'));
  await assertDirectory(join(root, 'public'));
  await assertFile(join(source, 'node_modules/@earendil-works/pi-coding-agent/package.json'));
  await assertFile(join(source, 'node_modules/agent-react-devtools/package.json'));
  await assertFile(join(source, 'node_modules/agent-react-devtools/dist/profile-offline.js'));
  await assertFile(join(source, 'node_modules/agent-react-devtools/dist/profile-offline-LICENSE.txt'));

  const stage = await mkdtemp(join(tmpdir(), 'tracesift-artifact-'));
  const name = `tracesift-app-v${app.version}-${platform}-${arch}`;
  const archive = join(output, `${name}.tar.gz`);
  const temporaryArchive = join(output, `.${name}-${process.pid}.tar.gz`);
  try {
    await cp(source, stage, { recursive: true, force: true, verbatimSymlinks: true });
    await mkdir(join(stage, '.next'), { recursive: true });
    await cp(join(root, '.next/static'), join(stage, '.next/static'), { recursive: true });
    await cp(join(root, 'public'), join(stage, 'public'), { recursive: true });
    const cliDestination = join(stage, 'node_modules', '@callstack', 'tracesift');
    await mkdir(cliDestination, { recursive: true });
    await cp(join(root, 'packages/cli/src'), join(cliDestination, 'src'), { recursive: true });
    await cp(join(root, 'packages/cli/package.json'), join(cliDestination, 'package.json'));

    for (const file of [
      'server.js', '.next/BUILD_ID', 'node_modules/@callstack/tracesift/package.json',
      'node_modules/@callstack/tracesift/src/bootstrap.js',
      'node_modules/@callstack/tracesift/src/runtime.js',
      'node_modules/@earendil-works/pi-coding-agent/package.json',
      'node_modules/agent-react-devtools/dist/profile-offline.js',
    ]) await assertFile(join(stage, file));

    const buildId = (await readFile(join(stage, '.next/BUILD_ID'), 'utf8')).trim();
    assert(buildId, 'The standalone build ID is empty.');
    const manifest = { schemaVersion: 1, version: app.version, revision, platform, arch, buildId };
    await writeFile(join(stage, 'tracesift-artifact.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await mkdir(output, { recursive: true });
    const entries = await archiveEntries(stage);
    await tar.create({ file: temporaryArchive, cwd: stage, gzip: { mtime: 0 }, portable: true, mtime: new Date(0), noDirRecurse: true }, entries);
    await rename(temporaryArchive, archive);
    const metadata = {
      schemaVersion: 1,
      version: app.version,
      revision,
      platform,
      arch,
      sha256: await sha256(archive),
      size: (await stat(archive)).size,
      filename: basename(archive),
    };
    await writeFile(join(output, `${name}.json`), `${JSON.stringify(metadata, null, 2)}\n`);
    console.log(JSON.stringify({ archive, metadata: join(output, `${name}.json`), ...metadata }, null, 2));
  } finally {
    await rm(stage, { recursive: true, force: true });
    await rm(temporaryArchive, { force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
