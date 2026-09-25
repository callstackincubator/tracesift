#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertReleaseMetadata, REPOSITORY, TARGETS } from './release-metadata.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const SHA256 = /^[a-f0-9]{64}$/;
const REVISION = /^[a-f0-9]{40}$/;

async function hashFile(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}

export async function generateRelease({ artifactDir, version, revision }) {
  if (!artifactDir || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) || !REVISION.test(revision)) {
    throw new Error('A valid artifact directory, package version, and full commit revision are required.');
  }
  const tag = `tracesift-v${version}`;
  const expectedNames = TARGETS.map(target => `tracesift-app-v${version}-${target}.json`);
  const actualNames = (await readdir(artifactDir)).filter(name => /^tracesift-app-v.*\.json$/.test(name)).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames.sort())) {
    throw new Error(`Expected exactly four artifact sidecars: ${expectedNames.join(', ')}.`);
  }
  const artifacts = {};
  for (const target of TARGETS) {
    const [platform, arch] = target.split('-');
    const filename = `tracesift-app-v${version}-${target}.tar.gz`;
    const sidecarPath = join(artifactDir, `${filename.slice(0, -7)}.json`);
    let sidecar;
    try { sidecar = JSON.parse(await readFile(sidecarPath, 'utf8')); }
    catch { throw new Error(`Cannot read valid JSON sidecar for ${target}.`); }
    if (sidecar.schemaVersion !== 1 || sidecar.version !== version || sidecar.revision !== revision ||
        sidecar.platform !== platform || sidecar.arch !== arch || sidecar.filename !== filename ||
        !SHA256.test(sidecar.sha256) || !Number.isSafeInteger(sidecar.size) || sidecar.size < 1) {
      throw new Error(`Invalid artifact sidecar for ${target}.`);
    }
    const archive = join(artifactDir, filename);
    const info = await stat(archive).catch(() => null);
    if (!info?.isFile() || info.size !== sidecar.size || await hashFile(archive) !== sidecar.sha256) {
      throw new Error(`Archive size or SHA-256 mismatch for ${target}.`);
    }
    artifacts[target] = {
      url: `${REPOSITORY}/releases/download/${tag}/${filename}`,
      sha256: sidecar.sha256,
      size: sidecar.size,
    };
  }
  return assertReleaseMetadata({ schemaVersion: 1, repository: REPOSITORY, version, revision, tag, artifacts }, { version, revision });
}

async function main() {
  const [directory, output = join(root, 'packages/cli/release.json')] = process.argv.slice(2);
  if (!directory || process.argv.length > 4) throw new Error('Usage: node packages/cli/scripts/generate-release.js <artifact-dir> [output-file]');
  const app = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const cli = JSON.parse(await readFile(join(root, 'packages/cli/package.json'), 'utf8'));
  if (app.version !== cli.version || app.dependencies?.[cli.name] !== cli.version) throw new Error('Application and CLI versions must match.');
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const release = await generateRelease({ artifactDir: resolve(directory), version: cli.version, revision });
  await writeFile(resolve(output), `${JSON.stringify(release, null, 2)}\n`);
  console.log(`Verified ${TARGETS.length} artifacts and wrote ${basename(output)} for ${release.tag}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
