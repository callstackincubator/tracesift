import { spawn } from 'node:child_process';
import { open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { connectCdp } from './cdp.js';
import { findChrome, launchChrome } from './chrome.js';
import { ensureHome, getHome } from './config.js';
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
  start: ['url', 'chrome', 'user-data-dir', 'out', 'duration', 'headless', 'sink'],
  launch: ['url', 'chrome', 'user-data-dir', 'headless'],
  stop: [],
  status: [],
  close: [],
};
export const RECORD_SUBCOMMANDS = Object.keys(RECORD_OPTIONS);

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
  return `Recording ${state.url || 'Chrome'} (${state.state}).`;
}

function describeBrowser(browser) {
  return `Chrome launched by \`tracesift record launch\` is open (pid ${browser.pid}${browser.url ? `, ${browser.url}` : ''}).`;
}

async function waitFor(home, predicate, timeout, onTimeout) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const state = await readRecordState(home);
    if (state && predicate(state)) return state;
    if (state && !processAlive(state.pid) && state.state !== 'captured') {
      throw new Error(state.error || 'The recorder stopped before it finished.');
    }
    if (Date.now() > deadline) throw new Error(onTimeout);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/**
 * Launch Chrome under the DevTools Protocol and begin recording in a detached
 * process, so a harness gets its shell back while the trace keeps running.
 */
export async function recordStart(options = {}) {
  const home = getHome();
  await ensureHome(home);
  const running = await activeRecordState(home);
  if (running) throw new Error(`A recording is already running (${running.url || 'Chrome'}). Stop it with \`tracesift record stop\`.`);

  const browser = await liveBrowserState(home);
  // Those options choose how to launch a Chrome, and none is being launched.
  if (browser && (options.chrome || options.userDataDir || options.headless)) {
    throw new Error('--chrome, --user-data-dir and --headless apply to a new Chrome, but a browser from `tracesift record launch` is open. Close it with `tracesift record close` or drop them.');
  }

  const payload = JSON.stringify({
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
    READY_TIMEOUT_MS, 'Chrome did not start recording in time. See record.log in the TraceSift home directory.');
  const sink = state.mode === 'ingest' ? `streaming into ${state.baseUrl}` : `writing to ${state.directory}`;
  console.log(`Recording ${state.url || 'Chrome'}${browser ? ' in the launched browser' : ''}, ${sink}.`);
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
    FLUSH_TIMEOUT_MS, 'Chrome did not finish flushing the trace in time.');
  if (finished.state === 'failed') throw new Error(finished.error || 'Recording failed.');
  console.log(describe(finished));
  for (const warning of finished.warnings ?? []) console.log(`  warning: ${warning}`);
  return finished;
}

export async function recordStatus() {
  const home = getHome();
  const state = await readRecordState(home);
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
  if (running) throw new Error(`A recording is still running (${running.url || 'Chrome'}). Stop it with \`tracesift record stop\` before closing the browser.`);
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
