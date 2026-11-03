import { spawn } from 'node:child_process';
import { open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { connectCdp } from './cdp.js';
import { findChrome, launchChrome } from './chrome.js';
import { ensureHome, getHome } from './config.js';
import { defaultMetroOrigin, describeMetroTarget, metroTargets, parseMetroOrigin, selectMetroTarget } from './metro.js';
import {
  activeRecordState, clearBrowserState, liveBrowserState, processAlive, readBrowserState, readRecordState, writeBrowserState,
} from './record-state.js';

const RUNNER = fileURLToPath(new URL('./record-runner.js', import.meta.url));
const READY_TIMEOUT_MS = 45_000;
const FLUSH_TIMEOUT_MS = 180_000;
const POLL_MS = 150;
const CLOSE_TIMEOUT_MS = 10_000;

// Which options each `record` subcommand understands. `launch` only shapes the
// browser; everything about the trace itself belongs to `start`.
const RECORD_OPTIONS = {
  start: ['url', 'chrome', 'user-data-dir', 'out', 'duration', 'headless', 'sink',
    'platform', 'metro', 'app', 'device', 'target-id', 'no-source-maps'],
  // `launch` and `close` take --platform only so that naming rn there gets the
  // reason it makes no sense rather than a flag-not-supported error.
  launch: ['url', 'chrome', 'user-data-dir', 'headless', 'platform'],
  targets: ['platform', 'metro', 'json'],
  stop: [],
  status: ['json'],
  close: ['platform'],
};
export const RECORD_SUBCOMMANDS = Object.keys(RECORD_OPTIONS);

// Flags that only mean something for one platform. Naming them against the
// wrong one is a mistake worth failing on: it would otherwise look like the
// recording honoured a setting it silently dropped.
const CHROME_ONLY = ['url', 'chrome', 'user-data-dir', 'headless'];
const RN_ONLY = ['metro', 'app', 'device', 'target-id', 'no-source-maps'];

/** Normalise `--platform`, which defaults to Chrome. */
export function parsePlatform(value) {
  if (value === undefined) return 'chrome';
  if (value === 'chrome') return 'chrome';
  if (value === 'rn' || value === 'react-native') return 'rn';
  throw new Error('Platform must be chrome or rn.');
}

/**
 * Reject an option the chosen command would silently ignore, so a typo such as
 * `record stop --out x` fails instead of looking like it worked.
 *
 * @param {string} command top-level command
 * @param {string | undefined} subcommand the `record` verb, when there is one
 * @param {Record<string, unknown>} values parsed options
 */
export function assertRecordOptions(command, subcommand, values) {
  const given = [...new Set(Object.values(RECORD_OPTIONS).flat())].filter((option) => values[option]);
  if (given.length === 0) return;
  if (command !== 'record') throw new Error('This option is only supported by tracesift record. Run tracesift --help.');
  const allowed = RECORD_OPTIONS[subcommand] ?? [];
  const rejected = given.find((option) => !allowed.includes(option));
  if (rejected) throw new Error(`--${rejected} is not supported by tracesift record ${subcommand}. Run tracesift --help.`);

  const platform = parsePlatform(values.platform);
  if (platform === 'rn' && (subcommand === 'launch' || subcommand === 'close')) {
    throw new Error('There is nothing to launch for React Native: the app is already running in a simulator, emulator or device. Run tracesift record start --platform rn.');
  }
  const chromeOnly = given.find((option) => CHROME_ONLY.includes(option));
  if (platform === 'rn' && chromeOnly) {
    throw new Error(`--${chromeOnly} applies to Chrome. tracesift record start --platform rn attaches to an app that is already running.`);
  }
  const rnOnly = given.find((option) => RN_ONLY.includes(option));
  if (platform !== 'rn' && rnOnly) {
    throw new Error(`--${rnOnly} applies to tracesift record start --platform rn.`);
  }
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

function describeBrowser(browser) {
  return `Chrome launched by \`tracesift record launch\` is open (pid ${browser.pid}${browser.url ? `, ${browser.url}` : ''}).`;
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
    if (mine && !processAlive(mine.pid) && mine.state !== 'captured') {
      throw new Error(mine.error || 'The recorder stopped before it finished.');
    }
    if (Date.now() > deadline) throw new Error(onTimeout);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/**
 * List the apps connected to Metro, so a recording can name one — and so a
 * harness can find out what is there without starting anything.
 */
export async function recordTargets(options = {}) {
  const platform = options.platform ?? 'chrome';
  if (platform !== 'rn') {
    throw new Error('tracesift record targets lists React Native apps. Run it with --platform rn.');
  }
  const origin = parseMetroOrigin(options.metro || defaultMetroOrigin());
  const label = origin.href.replace(/\/$/, '');
  let targets;
  try {
    targets = await metroTargets(origin);
  } catch (error) {
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
      targets: targets.map((target) => ({
        id: target.id,
        title: target.title,
        ...(target.appId ? { appId: target.appId } : {}),
        ...(target.deviceName ? { deviceName: target.deviceName } : {}),
        ...(target.deviceId ? { deviceId: target.deviceId } : {}),
        ...(target.vm ? { vm: target.vm } : {}),
        supportsMultipleDebuggers: target.supportsMultipleDebuggers,
        recommended: target.id === recommended?.id,
      })),
    }));
    return targets;
  }

  if (targets.length === 0) {
    console.log(`Metro on ${label} has no app connected to it.`);
    console.log('Launch the app in a simulator, emulator or device and wait for the bundle to finish loading.');
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

/**
 * Launch Chrome under the DevTools Protocol and begin recording in a detached
 * process, so a harness gets its shell back while the trace keeps running.
 */
export async function recordStart(options = {}) {
  const home = getHome();
  const platform = options.platform ?? 'chrome';
  await ensureHome(home);
  const running = await activeRecordState(home);
  if (running) throw new Error(`A recording is already running (${running.targetLabel || running.url || 'Chrome'}). Stop it with \`tracesift record stop\`.`);

  const browser = platform === 'rn' ? null : await liveBrowserState(home);
  // Those options choose how to launch a Chrome, and none is being launched.
  if (browser && (options.chrome || options.userDataDir || options.headless)) {
    throw new Error('--chrome, --user-data-dir and --headless apply to a new Chrome, but a browser from `tracesift record launch` is open. Close it with `tracesift record close` or drop them.');
  }

  const payload = JSON.stringify(platform === 'rn' ? {
    home,
    platform,
    metro: options.metro,
    app: options.app,
    device: options.device,
    targetId: options.targetId,
    sourceMaps: options.sourceMaps !== false,
    out: options.out,
    duration: options.duration,
    sink: options.sink ?? 'auto',
  } : {
    home,
    url: options.url,
    chrome: options.chrome,
    userDataDir: options.userDataDir,
    out: options.out,
    duration: options.duration,
    headless: Boolean(options.headless),
    sink: options.sink ?? 'auto',
  });
  const log = await open(`${home}/record.log`, 'a', 0o600);
  const child = spawn(process.execPath, [RUNNER, payload], {
    detached: true,
    stdio: ['ignore', log.fd, log.fd],
  });
  child.unref();
  await log.close();

  const state = await waitFor(home, (value) => value.state === 'recording' || value.state === 'captured',
    READY_TIMEOUT_MS, `${platform === 'rn' ? 'The app' : 'Chrome'} did not start recording in time. See record.log in the TraceSift home directory.`,
    child.pid);
  const sink = state.mode === 'ingest' ? `streaming into ${state.baseUrl}` : `writing to ${state.directory}`;
  console.log(`Recording ${state.targetLabel || state.url || 'Chrome'}${browser ? ' in the launched browser' : ''}, ${sink}.`);
  console.log(options.duration
    ? `Stops automatically in ${Math.round(options.duration / 1000)}s, or run \`tracesift record stop\`.`
    : 'Run `tracesift record stop` when the interaction is done.');
  return state;
}

/** Signal the detached recorder, then wait for Chrome to flush the trace. */
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
  const browser = await liveBrowserState(home);
  if (browser) console.log(describeBrowser(browser));
  return state;
}

/**
 * Start Chrome and walk away from it. Recordings attach to it by endpoint, so
 * the user can sign in or navigate by hand first and profile several times
 * from one session.
 */
export async function recordLaunch(options = {}) {
  const home = getHome();
  await ensureHome(home);
  const existing = await liveBrowserState(home);
  if (existing) throw new Error(`${describeBrowser(existing)} Close it with \`tracesift record close\` first.`);

  // A Chrome that was quit by hand leaves its profile behind with nobody to
  // `record close` it.
  const stale = await readBrowserState(home);
  if (stale?.ownsProfile) await rm(stale.userDataDir, { recursive: true, force: true });

  const executablePath = await findChrome(options.chrome || process.env.CHROME_PATH);
  const ownsProfile = !options.userDataDir;
  const userDataDir = options.userDataDir || join(home, 'chrome-profiles', `browser-${process.pid}`);
  const launched = await launchChrome({
    executablePath, userDataDir, url: options.url, headless: options.headless, detached: true,
  });
  const state = {
    apiVersion: 1,
    pid: launched.child.pid,
    webSocketDebuggerUrl: launched.webSocketDebuggerUrl,
    port: launched.port,
    userDataDir,
    ownsProfile,
    url: options.url ?? '',
    startedAt: Date.now(),
  };
  await writeBrowserState(home, state);
  console.log(`Launched Chrome (pid ${state.pid}) on debugging port ${state.port}.`);
  console.log('Sign in or navigate there, then run `tracesift record start`. `tracesift record close` quits it.');
  return state;
}

/** Quit the Chrome `record launch` started and remove what it created. */
export async function recordClose() {
  const home = getHome();
  const running = await activeRecordState(home);
  if (running) throw new Error(`A recording is still running (${running.targetLabel || running.url || 'Chrome'}). Stop it with \`tracesift record stop\` before closing the browser.`);
  const state = await readBrowserState(home);
  if (!state) throw new Error('No browser was launched with `tracesift record launch`.');

  if (processAlive(state.pid)) {
    // Browser.close lets Chrome flush its profile; the signal is for a Chrome
    // that no longer answers on its endpoint.
    try {
      const cdp = await connectCdp(state.webSocketDebuggerUrl);
      await cdp.send('Browser.close').catch(() => undefined);
      cdp.close();
    } catch { /* fall through to the signal */ }
    if (!(await exited(state.pid, CLOSE_TIMEOUT_MS))) {
      try { process.kill(state.pid, 'SIGTERM'); }
      catch (error) { if (error?.code !== 'ESRCH') throw error; }
      if (!(await exited(state.pid, CLOSE_TIMEOUT_MS))) throw new Error(`Chrome (pid ${state.pid}) did not quit. Close it by hand, then run \`tracesift record close\` again.`);
    }
  }
  // Only a profile TraceSift created is TraceSift's to delete.
  if (state.ownsProfile) await rm(state.userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await clearBrowserState(home);
  console.log('Closed the launched browser.');
  return state;
}

async function exited(pid, timeout) {
  const deadline = Date.now() + timeout;
  while (processAlive(pid)) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return true;
}
