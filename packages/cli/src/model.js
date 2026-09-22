import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { getHome, isAsciiApiKey, providers, readConfig, writeConfig } from './config.js';
import { getCatalog } from './models.js';

export class Cancelled extends Error {}
export function terminalPrompts() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Model selection requires an interactive terminal.');
  let muted = false;
  const output = new Writable({ write(chunk, _encoding, callback) { if (!muted) process.stdout.write(chunk); callback(); } });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  const controller = new AbortController();
  rl.on('SIGINT', () => controller.abort());
  rl.on('close', () => controller.abort());
  return {
    async ask(question, { secret = false } = {}) {
      try {
        if (secret) { process.stdout.write(question); muted = true; }
        return (await rl.question(secret ? '' : question, { signal: controller.signal })).trim();
      } catch { throw new Cancelled('Model selection cancelled.'); }
      finally { if (secret) { muted = false; process.stdout.write('\n'); } }
    },
    close() { rl.close(); },
  };
}
export async function selectModel({ home = getHome(), prompt, catalog } = {}) {
  prompt ??= terminalPrompts();
  try {
    let previous;
    try { previous = await readConfig(home); }
    catch (error) {
      console.log(error.message);
      if ((await prompt.ask('Replace invalid configuration? [y/N] ')).toLowerCase() !== 'y') throw new Cancelled();
    }
    catalog ??= await getCatalog();
    const ids = Object.keys(providers);
    console.log(ids.map((id, i) => `${i + 1}. ${providers[id]}`).join('\n'));
    let provider;
    while (!provider) provider = ids[Number(await prompt.ask('Provider number (Ctrl+C cancels): ')) - 1];
    const models = catalog.filter(model => model.provider === provider);
    let model;
    while (!model) {
      const search = (await prompt.ask('Search model name or ID (Enter lists all): ')).toLowerCase();
      const matches = models.filter(model => `${model.name} ${model.id}`.toLowerCase().includes(search));
      if (!matches.length) { console.log('No matching models.'); continue; }
      console.log(matches.map((model, i) => `${i + 1}. ${model.name} (${model.id})`).join('\n'));
      model = matches[Number(await prompt.ask('Model number (Enter searches again): ')) - 1];
    }
    let key = previous?.keys[provider];
    if (key && !isAsciiApiKey(key)) key = undefined;
    if (key && (await prompt.ask('Reuse saved API key? [Y/n] ')).toLowerCase() === 'n') key = undefined;
    while (!key) {
      key = await prompt.ask('API key (hidden): ', { secret: true });
      if (key && !isAsciiApiKey(key)) {
        console.log('That key contains non-ASCII characters (often a dash copied from rich text). Paste it again from the provider dashboard.');
        key = undefined;
      }
    }
    await writeConfig({ version: 1, provider, model: model.id, keys: { ...previous?.keys, [provider]: key } }, home);
    console.log(`Selected ${providers[provider]} / ${model.name}. Restart the server to apply changes; restarting clears analysis results.`);
  } finally { prompt.close(); }
}
