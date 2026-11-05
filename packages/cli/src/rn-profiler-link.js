// The link to a release build carrying @callstack/tracesift-rn-profiler.
//
// The app dials us rather than the other way round. That is how React
// Native's own inspector works, and it means there is nothing to discover: no
// device list, no adb enumeration, no guessing which emulator is the one. On
// Android `adb reverse tcp:8089 tcp:8089` makes the device's localhost ours,
// and a simulator shares the host's already.
//
// The wire is newline-delimited JSON over a plain TCP socket. A websocket
// would need a server implementation this package does not ship, and buys
// nothing here: both ends are ours and the framing is one line per message.
import { createServer } from 'node:net';

export const DEFAULT_PROFILER_PORT = 8089;

// A connecting app announces itself before anything else happens, and an app
// that connects without saying anything is not ours.
const HELLO_TIMEOUT_MS = 10_000;
// Base64 of a multi-megabyte profile, split so no single line is unbounded.
const MAX_LINE_BYTES = 8 * 1024 * 1024;

/**
 * Wrap a socket as a line-delimited JSON channel.
 *
 * @param {import('node:net').Socket} socket
 */
function jsonChannel(socket) {
  let buffer = '';
  const waiting = [];
  const queued = [];
  let failure = null;

  const deliver = (message) => {
    const next = waiting.shift();
    if (next) next.resolve(message);
    else queued.push(message);
  };
  const fail = (error) => {
    failure ??= error;
    while (waiting.length) waiting.shift().reject(failure);
  };

  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    if (buffer.length > MAX_LINE_BYTES) {
      fail(new Error('The app sent an oversized message.'));
      socket.destroy();
      return;
    }
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line !== '') {
        try {
          deliver(JSON.parse(line));
        } catch {
          fail(new Error('The app sent a message that is not JSON.'));
          socket.destroy();
          return;
        }
      }
      index = buffer.indexOf('\n');
    }
  });
  socket.on('error', (error) => fail(error));
  socket.on('close', () => fail(new Error('The app disconnected before the recording finished. Nothing was captured — relaunch the app and record again.')));

  return {
    get closed() { return socket.destroyed || socket.readyState !== 'open'; },
    send(message) { socket.write(`${JSON.stringify(message)}\n`); },
    /** @returns {Promise<Record<string, unknown>>} */
    next() {
      if (queued.length) return Promise.resolve(queued.shift());
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    },
    close() { socket.destroy(); },
  };
}

/**
 * Listen on loopback for a profiling-enabled app to connect, and return the
 * channel once it has introduced itself.
 *
 * Loopback only, deliberately: this socket drives a profiler inside somebody's
 * application, and it has no business being reachable from the network.
 *
 * @param {{ port?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<{ channel: ReturnType<typeof jsonChannel>, hello: Record<string, unknown>, close(): void }>}
 */
export function awaitProfilerApp({ port = DEFAULT_PROFILER_PORT, signal } = {}) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    let settled = false;
    const done = (fn) => (value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const fail = done((error) => { server.close(); reject(error); });

    server.on('error', (error) => {
      fail(error.code === 'EADDRINUSE'
        ? new Error(`Port ${port} is already in use, so there is nowhere for the app to connect. Stop whatever is on it, or pass --profiler-port.`)
        : error);
    });

    server.on('connection', (socket) => {
      socket.setNoDelay(true);
      const channel = jsonChannel(socket);
      const timer = setTimeout(() => {
        channel.close();
        fail(new Error('Something connected to the profiler port but did not identify itself as a React Native app.'));
      }, HELLO_TIMEOUT_MS);
      timer.unref?.();
      channel.next().then((hello) => {
        clearTimeout(timer);
        if (hello?.type !== 'hello') {
          channel.close();
          fail(new Error('Something connected to the profiler port but did not identify itself as a React Native app.'));
          return;
        }
        // One app at a time: a second connection would race for the same
        // process-global Hermes sampler.
        server.close();
        done(resolve)({ channel, hello, close: () => { channel.close(); server.close(); } });
      }).catch((error) => { clearTimeout(timer); fail(error); });
    });

    signal?.addEventListener('abort', () => fail(signal.reason ?? new Error('Aborted')), { once: true });
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Look for a release build without recording one.
 *
 * `record targets` has to be able to see a profiling build, or a caller that
 * lists before it records — the panel does, and so does the agent's skill —
 * concludes there is nothing to record when there is. The app's dial loop
 * retries every couple of seconds, so a short window catches one that is
 * already running without making the listing feel like a wait.
 *
 * The connection is dropped as soon as the app has introduced itself. The app
 * reconnects on its next retry, which is what leaves the port free for the
 * `record start` that usually follows.
 *
 * @param {{ port?: number, timeoutMs?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<Record<string, unknown> | null>} the app's hello, or null
 */
export async function probeProfilerApp({ port = DEFAULT_PROFILER_PORT, timeoutMs = 6_000, signal } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort(new Error('Stopped looking for a release build.'));
  const timer = setTimeout(abort, timeoutMs);
  timer.unref?.();
  signal?.addEventListener('abort', abort, { once: true });

  try {
    const link = await awaitProfilerApp({ port, signal: controller.signal });
    link.close();
    return link.hello;
  } catch {
    // Nothing dialled in, the port is somebody else's, or the caller gave up.
    // All three mean the same thing to a listing: no release build to report.
    return null;
  } finally {
    clearTimeout(timer);
    abort();
  }
}

/** Why neither React Native route found an app, said once for both. */
export function noAppConnectedMessage(metroFailure, port = DEFAULT_PROFILER_PORT) {
  return 'No React Native app connected.\n'
    + `  Debug build over Metro: ${metroFailure}\n`
    + `  Release build on port ${port}: nothing dialled in. Install @callstack/tracesift-rn-profiler and build with \`tracesift profile build\`, which also runs \`adb reverse tcp:${port} tcp:${port}\`.`;
}

/** How the app describes itself, for the recording's label. */
export function describeProfilerApp(hello) {
  const app = typeof hello.app === 'string' && hello.app ? hello.app : 'React Native app';
  const platform = hello.platform === 'ios' ? 'iOS' : hello.platform === 'android' ? 'Android' : null;
  return platform ? `${app} (${platform}, release)` : `${app} (release)`;
}
