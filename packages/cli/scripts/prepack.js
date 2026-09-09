import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
if (git('status', '--porcelain', '--untracked-files=normal')) throw new Error('Release packaging requires a clean, committed checkout.');
const app = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'));
const cli = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
if (app.dependencies['@earendil-works/pi-coding-agent'] !== cli.dependencies['@earendil-works/pi-coding-agent'] || app.dependencies[cli.name] !== cli.version) {
  throw new Error('Align the CLI version and agent SDK versions in both workspace manifests before packing.');
}
const revision = git('rev-parse', 'HEAD');
if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Invalid source revision');
writeFileSync(new URL('../release.json', import.meta.url), JSON.stringify({ repository: 'https://github.com/callstackincubator/perf-ai.git', revision }, null, 2) + '\n');
