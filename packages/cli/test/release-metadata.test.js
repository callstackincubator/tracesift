import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateRelease } from '../scripts/generate-release.js';
import { assertReleaseMetadata, REPOSITORY, TARGETS } from '../scripts/release-metadata.js';

const version = '1.2.3';
const revision = 'a'.repeat(40);

async function fixtures(t) {
  const artifactDir = await mkdtemp(join(tmpdir(), 'tracesift-release-'));
  t.after(() => rm(artifactDir, { recursive: true, force: true }));
  for (const target of TARGETS) {
    const [platform, arch] = target.split('-');
    const filename = `tracesift-app-v${version}-${target}.tar.gz`;
    const archive = Buffer.from(`archive for ${target}`);
    await writeFile(join(artifactDir, filename), archive);
    await writeFile(join(artifactDir, filename.replace(/\.tar\.gz$/, '.json')), JSON.stringify({
      schemaVersion: 1, version, revision, platform, arch, filename,
      sha256: createHash('sha256').update(archive).digest('hex'), size: archive.length,
    }));
  }
  return artifactDir;
}

test('aggregates four verified native archives into canonical release metadata', async t => {
  const artifactDir = await fixtures(t);
  const release = await generateRelease({ artifactDir, version, revision });
  assert.deepEqual(Object.keys(release.artifacts), TARGETS);
  assert.equal(release.tag, `tracesift-v${version}`);
  for (const target of TARGETS) {
    assert.equal(release.artifacts[target].url, `${REPOSITORY}/releases/download/${release.tag}/tracesift-app-v${version}-${target}.tar.gz`);
  }
  assert.equal(assertReleaseMetadata(release, { version, revision }), release);
});

test('rejects incomplete, foreign, and modified release artifacts', async t => {
  const artifactDir = await fixtures(t);
  const file = join(artifactDir, `tracesift-app-v${version}-linux-x64.tar.gz`);
  await writeFile(file, 'tampered archive');
  await assert.rejects(generateRelease({ artifactDir, version, revision }), /size or SHA-256 mismatch/);

  const sidecar = join(artifactDir, `tracesift-app-v${version}-linux-x64.json`);
  const metadata = JSON.parse(await readFile(sidecar, 'utf8'));
  metadata.revision = 'b'.repeat(40);
  await writeFile(sidecar, JSON.stringify(metadata));
  await assert.rejects(generateRelease({ artifactDir, version, revision }), /Invalid artifact sidecar/);

  await rm(sidecar);
  await assert.rejects(generateRelease({ artifactDir, version, revision }), /exactly four artifact sidecars/);
});

test('prepack metadata validation requires all four canonical immutable assets', async t => {
  const artifactDir = await fixtures(t);
  const release = await generateRelease({ artifactDir, version, revision });
  for (const change of [
    value => { delete value.artifacts['darwin-x64']; },
    value => { value.artifacts['linux-arm64'].url = 'https://example.com/app.tar.gz'; },
    value => { value.artifacts['linux-x64'].sha256 = 'invalid'; },
    value => { value.revision = 'b'.repeat(40); },
  ]) {
    const invalid = structuredClone(release);
    change(invalid);
    assert.throws(() => assertReleaseMetadata(invalid, { version, revision }));
  }
});
