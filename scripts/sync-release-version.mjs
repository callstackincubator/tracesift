import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const appPath = fileURLToPath(new URL('../package.json', import.meta.url));
const cliPath = fileURLToPath(new URL('../packages/cli/package.json', import.meta.url));
const explorePath = fileURLToPath(new URL('../packages/explore/package.json', import.meta.url));
const app = JSON.parse(await readFile(appPath, 'utf8'));
const cli = JSON.parse(await readFile(cliPath, 'utf8'));
const explore = JSON.parse(await readFile(explorePath, 'utf8'));

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(cli.version)) {
  throw new Error('Changesets produced an invalid CLI version.');
}
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(explore.version)) {
  throw new Error('Changesets produced an invalid Explore version.');
}
// The app ships as the CLI's runtime, so the two release as one version. The
// workspace dependencies need no attention: `workspace:*` always resolves to
// this checkout, whatever version the packages carry.
if (app.version !== cli.version) {
  app.version = cli.version;
  await writeFile(appPath, `${JSON.stringify(app, null, 2)}\n`);
}
