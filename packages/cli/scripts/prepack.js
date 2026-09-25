import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assertReleaseMetadata } from './release-metadata.js';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
if (git('status', '--porcelain', '--untracked-files=normal')) throw new Error('Release packaging requires a clean, committed checkout.');
const app = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
const cli = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
if (app.dependencies['@earendil-works/pi-coding-agent'] !== cli.dependencies['@earendil-works/pi-coding-agent'] || app.dependencies[cli.name] !== cli.version) {
  throw new Error('Align the CLI version and agent SDK versions in both workspace manifests before packing.');
}
if (app.version !== cli.version) throw new Error('Align the application and CLI versions before packing.');
const metadataPath = process.env.TRACE_SIFT_RELEASE_METADATA;
if (!metadataPath) throw new Error('Set TRACE_SIFT_RELEASE_METADATA to the generated artifact release metadata before packing.');
const release = JSON.parse(readFileSync(metadataPath, 'utf8'));
const revision = git('rev-parse', 'HEAD');
assertReleaseMetadata(release, { version: cli.version, revision });
writeFileSync(new URL('../release.json', import.meta.url), JSON.stringify(release, null, 2) + '\n');
