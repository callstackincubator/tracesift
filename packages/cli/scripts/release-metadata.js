export const REPOSITORY = 'https://github.com/callstackincubator/tracesift';
export const TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'];

const SHA256 = /^[a-f0-9]{64}$/;
const REVISION = /^[a-f0-9]{40}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function assertReleaseMetadata(release, { version, revision }) {
  if (!release || release.schemaVersion !== 1 || release.repository !== REPOSITORY ||
      release.version !== version || !VERSION.test(version) || release.revision !== revision || !REVISION.test(revision) ||
      release.tag !== `tracesift-v${version}` || !release.artifacts || typeof release.artifacts !== 'object' ||
      Array.isArray(release.artifacts) ||
      JSON.stringify(Object.keys(release.artifacts).sort()) !== JSON.stringify([...TARGETS].sort())) {
    throw new Error('Generated artifact release metadata does not match this package and commit.');
  }
  for (const target of TARGETS) {
    const artifact = release.artifacts[target];
    const expected = `${REPOSITORY}/releases/download/${release.tag}/tracesift-app-v${version}-${target}.tar.gz`;
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact) || artifact.url !== expected ||
        !SHA256.test(artifact.sha256) || !Number.isSafeInteger(artifact.size) || artifact.size < 1) {
      throw new Error(`Invalid ${target} artifact in release metadata.`);
    }
  }
  return release;
}
