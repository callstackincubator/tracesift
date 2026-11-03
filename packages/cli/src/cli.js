#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { prerequisites, install } from './install.js';
import { start, parsePort } from './start.js';
import { explore } from './explore.js';
import {
  RECORD_SUBCOMMANDS, assertRecordOptions, parseDuration, parsePlatform,
  recordClose, recordLaunch, recordStart, recordStatus, recordStop, recordTargets,
} from './record.js';

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, port: { type: 'string' }, 'no-open': { type: 'boolean' },
    task: { type: 'string' }, commit: { type: 'string' }, focus: { type: 'string' },
    url: { type: 'string' }, chrome: { type: 'string' }, 'user-data-dir': { type: 'string' },
    out: { type: 'string' }, duration: { type: 'string' }, headless: { type: 'boolean' },
    sink: { type: 'string' }, platform: { type: 'string' }, metro: { type: 'string' },
    app: { type: 'string' }, device: { type: 'string' }, 'target-id': { type: 'string' },
    'no-source-maps': { type: 'boolean' }, json: { type: 'boolean' },
  } });
  const [command, ...extra] = positionals;
  if (values.help || !command) {
    console.log('Usage:\n  tracesift init\n  tracesift start [--port 3000] [--no-open]\n  tracesift explore <analysis-path> [--task 0] [--focus node-id]\n  tracesift explore <analysis-path> --commit 1.2\n  tracesift record start [--url https://example.com] [--duration 30s] [--headless] [--out trace.json.gz]\n  tracesift record stop\n  tracesift record status [--json]\n  tracesift record targets --platform rn [--metro http://127.0.0.1:8081] [--json]\n  tracesift record start --platform rn [--metro URL] [--app id] [--device name] [--target-id id]\n  tracesift record launch [--url https://example.com] [--headless] [--chrome path] [--user-data-dir path]\n  tracesift record close\n\nRecording drives Chrome over the DevTools Protocol, so it needs no browser\nextension. It streams into a running TraceSift when there is one and writes a\n.json.gz otherwise; --sink ingest|local forces either.\n\nWith no browser open, record start launches its own Chrome and traces the page\nload. To profile a state you reached by hand, record launch a browser, sign in\nor navigate, then record start: it attaches without navigating, and the\nbrowser stays open after record stop until record close.\n\n--platform rn records a Hermes CPU profile from a React Native app that is\nalready running in a simulator, emulator or device, over the Metro inspector.\nNothing is launched and no window opens: `record targets --platform rn` lists\nthe connected apps, and `record start --platform rn` attaches to the one that\nis running. Metro must be up; release builds are not supported yet.\n\nChoose the model and enter its API key in Analysis settings.\nRequires Node.js >=22.19 on x64 or arm64 macOS/Linux (WSL supported).');
  } else {
    if (!['init', 'start', 'explore', 'record'].includes(command)) throw new Error('Unknown command. Run tracesift --help.');
    if (!['explore', 'record'].includes(command) && extra.length) throw new Error('Unknown command. Run tracesift --help.');
    if (command === 'explore' && extra.length !== 1) throw new Error('Explore requires one analysis path. Run tracesift --help.');
    if (command === 'record' && (extra.length !== 1 || !RECORD_SUBCOMMANDS.includes(extra[0]))) {
      throw new Error('Record requires one of start, stop, status, targets, launch or close. Run tracesift --help.');
    }
    if ((values.port || values['no-open']) && command !== 'start') throw new Error('This option is not supported for this command. Run tracesift --help.');
    if ((values.task || values.commit || values.focus) && command !== 'explore') throw new Error('This option is not supported for this command. Run tracesift --help.');
    assertRecordOptions(command, extra[0], values);
    if (values.sink && !['auto', 'ingest', 'local'].includes(values.sink)) throw new Error('Sink must be auto, ingest or local.');
    prerequisites();
    if (command === 'init') await install();
    else if (command === 'start') await start({ port: parsePort(values.port), open: !values['no-open'] });
    else if (command === 'explore') await explore(extra[0], { task: values.task, commit: values.commit, focus: values.focus });
    else if (extra[0] === 'targets') await recordTargets({
      platform: parsePlatform(values.platform), metro: values.metro, json: values.json,
    });
    else if (extra[0] === 'start') await recordStart({
      platform: parsePlatform(values.platform),
      url: values.url, chrome: values.chrome, userDataDir: values['user-data-dir'],
      metro: values.metro, app: values.app, device: values.device, targetId: values['target-id'],
      sourceMaps: !values['no-source-maps'],
      out: values.out, duration: parseDuration(values.duration), headless: values.headless, sink: values.sink,
    });
    else if (extra[0] === 'launch') await recordLaunch({
      url: values.url, chrome: values.chrome, userDataDir: values['user-data-dir'], headless: values.headless,
    });
    else if (extra[0] === 'close') await recordClose();
    else if (extra[0] === 'stop') await recordStop();
    else await recordStatus({ json: values.json });
  }
} catch (error) {
  console.error(`tracesift: ${error.message}`); process.exitCode = 1;
}
