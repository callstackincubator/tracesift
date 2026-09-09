#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { prerequisites, install } from './install.js';
import { selectModel, Cancelled } from './model.js';
import { start, parsePort } from './start.js';

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { help: { type: 'boolean', short: 'h' }, 'skip-model': { type: 'boolean' }, port: { type: 'string' }, 'no-open': { type: 'boolean' } } });
  const [command, ...extra] = positionals;
  if (values.help || !command) {
    console.log('Usage:\n  perf-ai init [--skip-model]\n  perf-ai model\n  perf-ai start [--port 3000] [--no-open]\n\nRequires Node.js >=22.19, npm and Git on macOS or Linux (WSL supported).');
  } else {
    if (extra.length || !['init', 'model', 'start'].includes(command)) throw new Error('Unknown command. Run perf-ai --help.');
    if ((values['skip-model'] && command !== 'init') || ((values.port || values['no-open']) && command !== 'start')) throw new Error('This option is not supported for this command. Run perf-ai --help.');
    prerequisites();
    if (command === 'init') {
      await install();
      if (!values['skip-model']) await selectModel();
    } else if (command === 'model') await selectModel();
    else await start({ port: parsePort(values.port), open: !values['no-open'] });
  }
} catch (error) {
  if (error instanceof Cancelled) { console.log('Model selection cancelled; configuration is unchanged.'); process.exitCode = 130; }
  else { console.error(`perf-ai: ${error.message}`); process.exitCode = 1; }
}
