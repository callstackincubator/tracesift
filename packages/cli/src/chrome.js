import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, readFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

const PORT_FILE = 'DevToolsActivePort';
const PORT_FILE_TIMEOUT_MS = 30_000;
const PORT_FILE_POLL_MS = 100;

const MACOS_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

const LINUX_COMMANDS = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'];

/**
 * Flags are deliberately few. Anything that disables GPU, networking or
 * background work changes the very timings this capture exists to measure, so
 * only first-run interstitials that would steal the recording are suppressed.
 */
const LAUNCH_FLAGS = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-search-engine-choice-screen',
  '--homepage=about:blank',
];

async function executable(path) {
  try { await access(path, constants.X_OK); return true; }
  catch { return false; }
}

async function fromPath(command) {
  for (const directory of (process.env.PATH || '').split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, command);
    if (await executable(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolve the Chrome binary to launch.
 *
 * @param {string} [preferred] an explicit path from `--chrome` or CHROME_PATH
 */
export async function findChrome(preferred) {
  if (preferred) {
    if (!(await executable(preferred))) throw new Error(`${preferred} is not an executable Chrome binary.`);
    return preferred;
  }
  if (process.platform === 'darwin') {
    for (const candidate of MACOS_CANDIDATES) if (await executable(candidate)) return candidate;
  }
  for (const command of LINUX_COMMANDS) {
    const found = await fromPath(command);
    if (found) return found;
  }
  throw new Error('Could not find Chrome. Pass --chrome <path> or set CHROME_PATH.');
}

async function readDebuggerUrl(userDataDir, child, startedAt) {
  for (;;) {
    let raw;
    try { raw = await readFile(join(userDataDir, PORT_FILE), 'utf8'); }
    catch { raw = ''; }
    const [port, path] = raw.split('\n');
    if (port && path && path.startsWith('/devtools/browser/')) {
      return { port: Number(port), webSocketDebuggerUrl: `ws://127.0.0.1:${port}${path.trim()}` };
    }
    if (child.exitCode !== null) {
      // A second Chrome started against a profile that is already open simply
      // hands the URL to the running instance and exits, leaving the existing
      // process in charge of a debugging port we never asked it to open.
      throw new Error('Chrome exited before opening a debugging port. If --user-data-dir names a profile Chrome already has open, quit that window or let TraceSift use its own profile.');
    }
    if (Date.now() - startedAt > PORT_FILE_TIMEOUT_MS) throw new Error('Chrome did not open a debugging port in time.');
    await new Promise((resolve) => setTimeout(resolve, PORT_FILE_POLL_MS));
  }
}

/**
 * Launch Chrome with a debugging port it chooses itself.
 *
 * Port 0 lets Chrome pick a free port and publish it in DevToolsActivePort, so
 * concurrent captures never collide on a fixed 9222.
 *
 * With `detached`, Chrome gets its own process group and the CLI lets go of
 * it. CDP is only a websocket, so nothing has to stay alive to keep the
 * browser open between one `tracesift` invocation and the next.
 *
 * @param {{ executablePath: string, userDataDir: string, url?: string, args?: string[], headless?: boolean, detached?: boolean }} options
 * @returns {Promise<{ child: import('node:child_process').ChildProcess, port: number, webSocketDebuggerUrl: string }>}
 */
export async function launchChrome(options) {
  const { executablePath, userDataDir, url, args = [], headless = false, detached = false } = options;
  await mkdir(userDataDir, { recursive: true, mode: 0o700 });
  const argv = [
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-port=0',
    ...LAUNCH_FLAGS,
    ...(headless ? ['--headless=new'] : []),
    ...args,
    // Always give Chrome a page to open. Headless Chrome started with no URL
    // exposes no page target at all, and the recorder needs one to attach to
    // before tracing begins.
    url || 'about:blank',
  ];
  const child = spawn(executablePath, argv, { stdio: 'ignore', detached });
  const startedAt = Date.now();
  child.on('error', () => undefined);
  try {
    const endpoint = await readDebuggerUrl(userDataDir, child, startedAt);
    if (detached) child.unref();
    return { child, ...endpoint };
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  }
}
