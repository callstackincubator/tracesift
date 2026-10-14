#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { prerequisites, install } from './install.js';
import { start, parsePort } from './start.js';
import { explore } from './explore.js';

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, port: { type: 'string' }, 'no-open': { type: 'boolean' },
    task: { type: 'string' }, commit: { type: 'string' }, focus: { type: 'string' },
  } });
  const [command, ...extra] = positionals;
  if (values.help || !command) {
    console.log('Usage:\n  tracesift init\n  tracesift start [--port 3000] [--no-open]\n  tracesift explore <analysis-path> [--task 0] [--focus node-id]\n  tracesift explore <analysis-path> --commit 1.2\n\nChoose the model and enter its API key in Analysis settings.\nRequires Node.js >=22.19 on x64 or arm64 macOS/Linux (WSL supported).');
  } else {
    if (!['init', 'start', 'explore'].includes(command)) throw new Error('Unknown command. Run tracesift --help.');
    if (command !== 'explore' && extra.length) throw new Error('Unknown command. Run tracesift --help.');
    if (command === 'explore' && extra.length !== 1) throw new Error('Explore requires one analysis path. Run tracesift --help.');
    if ((values.port || values['no-open']) && command !== 'start') throw new Error('This option is not supported for this command. Run tracesift --help.');
    if ((values.task || values.commit || values.focus) && command !== 'explore') throw new Error('This option is not supported for this command. Run tracesift --help.');
    prerequisites();
    if (command === 'init') await install();
    else if (command === 'start') await start({ port: parsePort(values.port), open: !values['no-open'] });
    else await explore(extra[0], { task: values.task, commit: values.commit, focus: values.focus });
  }
} catch (error) {
  console.error(`tracesift: ${error.message}`); process.exitCode = 1;
}
