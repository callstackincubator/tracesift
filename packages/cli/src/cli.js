#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { prerequisites, install } from './install.js';
import { start, parsePort } from './start.js';

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { help: { type: 'boolean', short: 'h' }, port: { type: 'string' }, 'no-open': { type: 'boolean' } } });
  const [command, ...extra] = positionals;
  if (values.help || !command) {
    console.log('Usage:\n  perf-ai init\n  perf-ai start [--port 3000] [--no-open]\n\nChoose the model and enter its API key in Analysis settings.\nRequires Node.js >=22.19, npm and Git on macOS or Linux (WSL supported).');
  } else {
    if (extra.length || !['init', 'start'].includes(command)) throw new Error('Unknown command. Run perf-ai --help.');
    if ((values.port || values['no-open']) && command !== 'start') throw new Error('This option is not supported for this command. Run perf-ai --help.');
    prerequisites();
    if (command === 'init') await install();
    else await start({ port: parsePort(values.port), open: !values['no-open'] });
  }
} catch (error) {
  console.error(`perf-ai: ${error.message}`); process.exitCode = 1;
}
