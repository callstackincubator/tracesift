import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { ensureHome, getHome } from './config.js';
import { defaultMetroOrigin, describeMetroTarget, metroTargets, parseMetroOrigin, selectMetroTarget } from './metro.js';
import {
  activeRecordState, processAlive, readRecordState,
} from './record-state.js';

const RUNNER = fileURLToPath(new URL('./record-runner.js', import.meta.url));
const READY_TIMEOUT_MS = 45_000;
const FLUSH_TIMEOUT_MS = 180_000;
const POLL_MS = 150;

const RECORD_OPTIONS = {
  start: ['out', 'duration', 'sink', 'platform', 'metro', 'app', 'device',
    'target-id', 'no-source-maps', 'profiler-port', 'source-map'],
  targets: ['platform', 'metro', 'json', 'profiler-port'],
  stop: [],
  status: ['json'],
};
export const RECORD_SUBCOMMANDS = Object.keys(RECORD_OPTIONS);

export function parsePlatform(value) {
  if (value === 'rn' || value === 'react-native') return 'rn';
  throw new Error('Use --platform rn to record a React Native app.');
}

export function assertRecordOptions(command, subcommand, values) {
  const given = [...new Set(Object.values(RECORD_OPTIONS).flat())].filter((option) => values[option]);
  if (given.length === 0) return;
  if (command !== 'record') throw new Error('This option is only supported by tracesift record. Run tracesift --help.');
  const allowed = RECORD_OPTIONS[subcommand] ?? [];
  const rejected = given.find((option) => !allowed.includes(option));
  if (rejected) throw new Error(`--${rejected} is not supported by tracesift record ${subcommand}. Run tracesift --help.`);
  parsePlatform(values.platform);
}

/** The loopback port a release build's profiler dials. */
export function parseProfilerPort(value) {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error('--profiler-port must be an integer between 1 and 65535.');
  }
  return Number(value);
}

/** Accept `30`, `30s`, `500ms` or `2m`; a bare number is seconds. */
export function parseDuration(value) {
  if (value === undefined) return undefined;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(value.trim());
  if (!match) throw new Error('Duration must look like 30s, 500ms or 2m.');
  const scale = { ms: 1, s: 1000, m: 60_000 }[match[2] || 's'];
  const milliseconds = Number(match[1]) * scale;
  if (!(milliseconds > 0) || milliseconds > 3_600_000) throw new Error('Duration must be between 1ms and 1h.');
  return milliseconds;
}

function describe(state) {
  if (!state) return 'No recording has been made yet.';
  if (state.state === 'failed') return `Recording failed: ${state.error || 'unknown error.'}`;
  if (state.state === 'captured') {
    const where = state.mode === 'ingest'
      ? `${state.baseUrl}/capture (capture ${state.captureId})`
      : state.export?.path || state.directory;
    const size = state.export?.sizeBytes ? ` · ${(state.export.sizeBytes / 1_048_576).toFixed(1)} MB` : '';
    const events = state.export?.eventCount ? ` · ${state.export.eventCount.toLocaleString()} events` : '';
    return `Recorded ${where}${size}${events}`;
  }
  return `Recording ${state.targetLabel || state.url || 'the app'} (${state.state}).`;
}

/**
 * Poll record.json until it says what the caller is waiting for.
 *
 * `pid` scopes the wait to one recorder. The file outlives the process that
 * wrote it, so a finished recording still sitting there answers `captured`
 * instantly — and a caller waiting for the recorder it just spawned would
 * take that as its own and report the previous capture's path.
 */
async function waitFor(home, predicate, timeout, onTimeout, pid) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const state = await readRecordState(home);
    const mine = state && (pid === undefined || state.pid === pid) ? state : null;
    if (mine && predicate(mine)) return mine;
    // A recorder that has already recorded its own reason has nothing left to
    // say, and waiting out the deadline would replace that reason with a
    // generic timeout.
    if (mine?.state === 'failed') throw new Error(mine.error || 'The recorder stopped before it finished.');
    if (mine && !processAlive(mine.pid) && mine.state !== 'captured') {
      throw new Error(mine.error || 'The recorder stopped before it finished.');
    }
    if (Date.now() > deadline) throw new Error(onTimeout);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/**
 * List the React Native apps a recording could attach to, over either route.
 *
 * Both are reported because the two are not a preference but a property of
 * the build, and a caller that lists before it records — the panel does, and
 * so does the agent — would otherwise conclude there is nothing to record
 * whenever the app is a release build.
 *
 * Metro is awaited first. Only when it has nothing to show is the profiler
 * port given its window, so the ordinary debug listing stays immediate.
 */
export async function recordTargets(options = {}) {
  const platform = options.platform ?? 'rn';
  if (platform !== 'rn') {
    throw new Error('tracesift record targets lists React Native apps. Run it with --platform rn.');
  }
  const { noAppConnectedMessage, DEFAULT_PROFILER_PORT } =
    await import('./rn-profiler-link.js');
  const { describeReleaseApps, discoverProfilerApps } = await import('./rn-profiler-link.js');
  const { iosDeviceHints, listBootedSimulators, listTunnelDevices } = await import('./ios-devices.js');

  const origin = parseMetroOrigin(options.metro || defaultMetroOrigin());
  const label = origin.href.replace(/\/$/, '');
  const port = options.profilerPort ?? DEFAULT_PROFILER_PORT;

  let targets = [];
  let metroFailure = null;
  try {
    targets = await metroTargets(origin);
  } catch (error) {
    metroFailure = error.message;
  }

  // Every app that answers, not the first: a simulator and a phone can both
  // be running one, and each is its own target.
  const apps = targets.length === 0
    ? await (options.discoverApps ?? discoverProfilerApps)({ port })
    : [];
  const hello = apps[0]?.hello ?? null;
  const releases = apps.length
    ? describeReleaseApps(apps, await listBootedSimulators(), await listTunnelDevices().catch(() => []))
        .map((release) => ({ ...release, transport: 'release', port }))
    : [];

  // A phone that is plugged in but unreachable must not look like no phone.
  // Asked only when it matters, and never allowed to break the listing.
  const phone = await (options.listDeviceHints ?? iosDeviceHints)().catch(() => ({ hints: [], reachable: [] }));
  const deviceHints = [...phone.hints,
    ...(!hello && targets.length === 0 && phone.reachable.length
      ? phone.reachable.map((device) => `${device.name} is connected, but nothing is listening on its port ${port}. Open the profiling build on the phone and keep it unlocked and in the foreground, then refresh.`)
      : [])];

  if (targets.length === 0 && !hello) {
    const error = new Error(`${metroFailure
      ? noAppConnectedMessage(metroFailure, port)
      : noAppConnectedMessage(`Metro on ${label} has no app connected to it. Launch the app and wait for the bundle to finish loading.`, port)}${deviceHints.map((hint) => `\n  iPhone: ${hint}`).join('')}`);
    if (!options.json) throw error;
    console.log(JSON.stringify({ apiVersion: 1, error: error.message }));
    process.exitCode = 1;
    return null;
  }

  // `recommended` is what `record start` would pick on its own. Reporting it
  // keeps the two from disagreeing when a caller lists first and records after.
  let recommended;
  try { recommended = selectMetroTarget(targets, { origin }); }
  catch { recommended = undefined; }

  if (options.json) {
    console.log(JSON.stringify({
      apiVersion: 1,
      platform: 'rn',
      metro: label,
      profilerPort: port,
      ...(deviceHints.length ? { deviceHints } : {}),
      targets: [
        ...targets.map((target) => ({
          id: target.id,
          title: target.title,
          ...(target.appId ? { appId: target.appId } : {}),
          ...(target.deviceName ? { deviceName: target.deviceName } : {}),
          ...(target.deviceId ? { deviceId: target.deviceId } : {}),
          ...(target.vm ? { vm: target.vm } : {}),
          transport: 'metro',
          supportsMultipleDebuggers: target.supportsMultipleDebuggers,
          recommended: target.id === recommended?.id,
        })),
        // A release build is the only thing to record when it is the only
        // thing listed, which is the case whenever it is listed at all.
        ...releases.map((release, index) => ({ ...release, supportsMultipleDebuggers: false, recommended: releases.length === 1 && index === 0 })),
      ],
    }));
    return targets;
  }

  if (releases.length) {
    console.log(`Release builds on port ${port}\n`);
    for (const release of releases) {
      console.log(`  ${release.title}${release.deviceName ? ` on ${release.deviceName}` : ''}`);
      if (release.appId) console.log(`    app      ${release.appId}`);
      console.log(`    target   ${release.id}`);
    }
    console.log(releases.length > 1
      ? '\nRecord one with: tracesift record start --platform rn --target-id <id>'
      : '\nRecord it with: tracesift record start --platform rn');
    for (const hint of phone.hints) console.log(`\niPhone: ${hint}`);
    return targets;
  }

  console.log(`Metro on ${label}\n`);
  for (const target of targets) {
    console.log(`  ${describeMetroTarget(target)}${target.id === recommended?.id ? '  (default)' : ''}`);
    if (target.appId) console.log(`    app      ${target.appId}`);
    console.log(`    target   ${target.id}`);
  }
  console.log(targets.length > 1
    ? '\nRecord one with: tracesift record start --platform rn --target-id <id>'
    : '\nRecord it with: tracesift record start --platform rn');
  return targets;
}

/** Start a React Native recording in a detached process. */
export async function recordStart(options = {}) {
  const home = getHome();
  await ensureHome(home);
  const running = await activeRecordState(home);
  if (running) throw new Error(`A recording is already running (${running.targetLabel || 'the app'}). Stop it with \`tracesift record stop\`.`);
  const payload = JSON.stringify({
    home, platform: 'rn', metro: options.metro, app: options.app,
    device: options.device, targetId: options.targetId,
    profilerPort: options.profilerPort, sourceMapPath: options.sourceMapPath,
    sourceMaps: options.sourceMaps !== false, out: options.out,
    duration: options.duration, sink: options.sink ?? 'auto',
  });
  const log = await open(`${home}/record.log`, 'a', 0o600);
  const child = spawn(process.execPath, [RUNNER, payload], {
    detached: true, stdio: ['ignore', log.fd, log.fd],
  });
  child.unref();
  await log.close();
  const state = await waitFor(home, (value) => value.state === 'recording' || value.state === 'captured',
    READY_TIMEOUT_MS, 'The app did not start recording in time. See record.log in the TraceSift home directory.', child.pid);
  const sink = state.mode === 'ingest' ? `streaming into ${state.baseUrl}` : `writing to ${state.directory}`;
  console.log(`Recording ${state.targetLabel || 'the app'}, ${sink}.`);
  console.log(options.duration
    ? `Stops automatically in ${Math.round(options.duration / 1000)}s, or run \`tracesift record stop\`.`
    : 'Run `tracesift record stop` when the interaction is done.');
  return state;
}

/** Signal the detached recorder, then wait for the profile to flush. */
export async function recordStop() {
  const home = getHome();
  const state = await activeRecordState(home);
  if (!state) {
    const last = await readRecordState(home);
    throw new Error(last ? `No recording is running. ${describe(last)}` : 'No recording is running.');
  }
  try { process.kill(state.pid, 'SIGTERM'); }
  catch (error) { if (error?.code !== 'ESRCH') throw error; }

  const finished = await waitFor(home, (value) => ['captured', 'failed'].includes(value.state),
    FLUSH_TIMEOUT_MS, 'The trace was not flushed in time.', state.pid);
  if (finished.state === 'failed') throw new Error(finished.error || 'Recording failed.');
  console.log(describe(finished));
  for (const warning of finished.warnings ?? []) console.log(`  warning: ${warning}`);
  return finished;
}

export async function recordStatus(options = {}) {
  const home = getHome();
  const state = await readRecordState(home);
  if (options.json) {
    console.log(JSON.stringify({ apiVersion: 1, recording: state ?? null }));
    return state;
  }
  console.log(describe(state));
  return state;
}
