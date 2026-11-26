#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { prerequisites, install } from './install.js';
import { start, parsePort } from './start.js';
import { explore } from './explore.js';
import {
  RECORD_SUBCOMMANDS, assertRecordOptions, parseDuration, parsePlatform, parseProfilerPort,
  recordStart, recordStatus, recordStop, recordTargets,
} from './record.js';
import { PROFILE_SUBCOMMANDS, assertProfileOptions, profileBuild, profileDevices } from './profile-build.js';

/** Every flag the CLI knows, so a subcommand can refuse the ones it ignores. */
const KNOWN_OPTIONS = [
  'port', 'no-open', 'task', 'commit', 'focus', 'out',
  'duration', 'headless', 'sink', 'platform', 'metro', 'app', 'device', 'target-id',
  'no-source-maps', 'json', 'profiler-port', 'source-map', 'variant', 'no-install', 'no-launch', 'team',
];

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, port: { type: 'string' }, 'no-open': { type: 'boolean' },
    task: { type: 'string' }, commit: { type: 'string' }, focus: { type: 'string' },
    out: { type: 'string' }, duration: { type: 'string' }, headless: { type: 'boolean' },
    sink: { type: 'string' }, platform: { type: 'string' }, metro: { type: 'string' },
    app: { type: 'string' }, device: { type: 'string' }, 'target-id': { type: 'string' },
    'no-source-maps': { type: 'boolean' }, json: { type: 'boolean' },
    'profiler-port': { type: 'string' }, 'source-map': { type: 'string' },
    variant: { type: 'string' }, 'no-install': { type: 'boolean' }, 'no-launch': { type: 'boolean' },
    team: { type: 'string' },
  } });
  const [command, ...extra] = positionals;
  if (values.help || !command) {
    console.log(`Usage:
  tracesift init
  tracesift start [--port 3000] [--no-open]
  tracesift explore <analysis-path> [--task 0] [--focus node-id]
  tracesift explore <analysis-path> --commit 1.2
  tracesift record targets --platform rn [--metro http://127.0.0.1:8081] [--json]
  tracesift record start --platform rn [--app id] [--device name] [--target-id id]
                                      [--profiler-port 8089] [--source-map path]
  tracesift record stop
  tracesift record status [--json]
  tracesift profile build [--platform android|ios] [--variant release] [--device id]
                          [--profiler-port 8089] [--no-install] [--no-launch] [--team id]
  tracesift profile devices

Record a running React Native app through Metro or the release profiler. A recording
streams into a running TraceSift or writes a .json.gz file for later analysis.
Choose the model and enter its API key in Analysis settings.
Requires Node.js >=22.19 on x64 or arm64 macOS/Linux (WSL supported).`);
  } else {
    if (!['init', 'start', 'explore', 'record', 'profile'].includes(command)) throw new Error('Unknown command. Run tracesift --help.');
    if (!['explore', 'record', 'profile'].includes(command) && extra.length) throw new Error('Unknown command. Run tracesift --help.');
    if (command === 'explore' && extra.length !== 1) throw new Error('Explore requires one analysis path. Run tracesift --help.');
    if (command === 'record' && (extra.length !== 1 || !RECORD_SUBCOMMANDS.includes(extra[0]))) {
      throw new Error('Record requires one of start, stop, status or targets. Run tracesift --help.');
    }
    if (command === 'profile' && (extra.length !== 1 || !PROFILE_SUBCOMMANDS.includes(extra[0]))) {
      throw new Error('Profile requires one of build, devices. Run tracesift --help.');
    }
    if ((values.port || values['no-open']) && command !== 'start') throw new Error('This option is not supported for this command. Run tracesift --help.');
    if ((values.task || values.commit || values.focus) && command !== 'explore') throw new Error('This option is not supported for this command. Run tracesift --help.');
    if (command === 'profile') assertProfileOptions(extra[0], values, KNOWN_OPTIONS);
    else assertRecordOptions(command, extra[0], values);
    if (values.sink && !['auto', 'ingest', 'local'].includes(values.sink)) throw new Error('Sink must be auto, ingest or local.');
    prerequisites();
    if (command === 'init') await install();
    else if (command === 'start') await start({ port: parsePort(values.port), open: !values['no-open'] });
    else if (command === 'explore') await explore(extra[0], { task: values.task, commit: values.commit, focus: values.focus });
    else if (command === 'profile' && extra[0] === 'devices') await profileDevices();
    else if (command === 'profile') await profileBuild({
      platform: values.platform ?? 'android',
      variant: values.variant, device: values.device, team: values.team,
      profilerPort: parseProfilerPort(values['profiler-port']),
      install: !values['no-install'], launch: !values['no-launch'],
    });
    else if (extra[0] === 'targets') await recordTargets({
      platform: parsePlatform(values.platform), metro: values.metro, json: values.json,
      profilerPort: parseProfilerPort(values['profiler-port']),
    });
    else if (extra[0] === 'start') await recordStart({
      platform: parsePlatform(values.platform),
      metro: values.metro, app: values.app, device: values.device, targetId: values['target-id'],
      profilerPort: parseProfilerPort(values['profiler-port']), sourceMapPath: values['source-map'],
      sourceMaps: !values['no-source-maps'],
      out: values.out, duration: parseDuration(values.duration), sink: values.sink,
    });
    else if (extra[0] === 'stop') await recordStop();
    else await recordStatus({ json: values.json });
  }
} catch (error) {
  console.error(`tracesift: ${error.message}`); process.exitCode = 1;
}
