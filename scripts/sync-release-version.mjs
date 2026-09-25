import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const appPath = fileURLToPath(new URL('../package.json', import.meta.url));
const cliPath = fileURLToPath(new URL('../packages/cli/package.json', import.meta.url));
const app = JSON.parse(await readFile(appPath, 'utf8'));
const cli = JSON.parse(await readFile(cliPath, 'utf8'));

if (![app.version, cli.version].includes(app.dependencies?.[cli.name])) {
  throw new Error(`Expected the app's ${cli.name} dependency to match either the current app or CLI version.`);
}
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(cli.version)) {
  throw new Error('Changesets produced an invalid CLI version.');
}
if (app.version !== cli.version || app.dependencies[cli.name] !== cli.version) {
  app.version = cli.version;
  app.dependencies[cli.name] = cli.version;
  await writeFile(appPath, `${JSON.stringify(app, null, 2)}\n`);
}
