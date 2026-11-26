// The link to a release build carrying @callstack/tracesift-rn-profiler.
import { createServer } from 'node:net';

import { connectTunnel, holdTunnel, listBootedSimulators, listTunnelDevices } from './ios-devices.js';

export const DEFAULT_PROFILER_PORT = 8089;

// A connecting app announces itself before anything else happens, and an app
// that connects without saying anything is not ours.
const HELLO_TIMEOUT_MS = 10_000;
// Base64 of a multi-megabyte profile, split so no single line is unbounded.
const MAX_LINE_BYTES = 8 * 1024 * 1024;

/** Wrap a socket as a line-delimited JSON channel. */
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

// devicectl takes about a second per listing, so poll gently.
const USB_POLL_MS = 3_000;

/** Wait for a profiling-enabled app and return the channel once it has introduced itself. */
export function awaitProfilerApp({ port = DEFAULT_PROFILER_PORT, signal, accept, usb = { list: () => listTunnelDevices(), connect: connectTunnel }, usbPollMs = USB_POLL_MS } = {}) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    let settled = false;
    let poller = null;
    const busy = new Set();
    // The app binds its listener to the tunnel address, and can only do so while a tunnel exists.
    const holds = new Map();
    const done = (fn) => (value) => {
      if (settled) return;
      settled = true;
      if (poller) clearInterval(poller);
      for (const unhold of holds.values()) unhold();
      holds.clear();
      fn(value);
    };
    const fail = done((error) => { server.close(); reject(error); });

    server.on('error', (error) => {
      fail(error.code === 'EADDRINUSE'
        ? new Error(`Port ${port} is already in use, so there is nowhere for the app to connect. Stop whatever is on it, or pass --profiler-port.`)
        : error);
    });

    /** Take a connected socket, from either route, and wait for its hello. */
    const adopt = (socket, reportFailure = true, origin = { route: 'loopback' }) => {
      socket.setNoDelay?.(true);
      const channel = jsonChannel(socket);
      // A device tunnel socket arrives paused so nothing is read before this listener exists.
      socket.resume();
      const timer = setTimeout(() => {
        channel.close();
        if (reportFailure) fail(new Error('Something connected to the profiler port but did not identify itself as a React Native app.'));
      }, HELLO_TIMEOUT_MS);
      timer.unref?.();
      channel.next().then((hello) => {
        clearTimeout(timer);
        if (settled) { channel.close(); return; }
        if (hello?.type !== 'hello') {
          channel.close();
          if (reportFailure) fail(new Error('Something connected to the profiler port but did not identify itself as a React Native app.'));
          return;
        }
        if (accept && !accept(hello, origin)) { channel.close(); return; }
        // One app at a time: a second connection would race for the same
        // process-global Hermes sampler.
        server.close();
        done(resolve)({ channel, hello, origin, close: () => { channel.close(); server.close(); } });
      }).catch((error) => { clearTimeout(timer); if (reportFailure) fail(error); });
    };

    server.on('connection', (socket) => adopt(socket));

    // A device whose app is not up yet refuses the tunnel; that is the normal
    // state and the next poll is the whole recovery. Failures here are never
    // fatal: with no device, no tunnel or no app, the loopback route carries on.
    if (usb) {
      const pollUsb = async () => {
        const devices = await usb.list().catch(() => []);
        for (const device of devices) {
          if (settled) continue;
          if (!holds.has(device.udid)) holds.set(device.udid, holdTunnel(device.udid));
          if (busy.has(device.udid)) continue;
          busy.add(device.udid);
          usb.connect(device.tunnelAddress, port).then(
            (socket) => {
              if (settled) { socket.destroy(); busy.delete(device.udid); return; }
              socket.once('close', () => busy.delete(device.udid));
              adopt(socket, false, { route: 'tunnel', udid: device.udid });
            },
            () => { busy.delete(device.udid); },
          );
        }
      };
      poller = setInterval(() => { void pollUsb(); }, usbPollMs);
      poller.unref?.();
      void pollUsb();
    }

    signal?.addEventListener('abort', () => fail(signal.reason ?? new Error('Aborted')), { once: true });
    server.listen(port, '127.0.0.1');
  });
}

/** Look for a release build without recording one. */
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

/** Collect every profiling build that answers within a window, instead of the first. */
export function discoverProfilerApps({ port = DEFAULT_PROFILER_PORT, windowMs = 4_000, maxWindowMs = 15_000, usb = { list: () => listTunnelDevices(), connect: connectTunnel } } = {}) {
  return new Promise((resolve) => {
    const found = [];
    const seen = new Set();
    const sockets = new Set();
    const server = createServer();
    // A phone whose tunnel has gone to sleep is woken by `listTunnelDevices`, and `devicectl` takes
    // its time about it.
    const started = Date.now();
    let deadline = started + windowMs;
    let inFlight = 0;
    const hold = () => { inFlight += 1; };
    const release = (graceMs = 0) => {
      inFlight -= 1;
      deadline = Math.max(deadline, Math.min(Date.now() + graceMs, started + maxWindowMs));
    };
    const record = (socket, origin) => {
      sockets.add(socket);
      socket.setNoDelay?.(true);
      const channel = jsonChannel(socket);
      socket.resume();
      channel.next().then((hello) => {
        // The app redials after every drop, so the same one will say hello again.
        const key = `${origin.route}:${origin.udid ?? ''}:${hello?.app}:${hello?.platform}:${hello?.device}`;
        if (hello?.type === 'hello' && !seen.has(key)) { seen.add(key); found.push({ hello, origin }); }
      }).catch(() => undefined).finally(() => { channel.close(); sockets.delete(socket); });
    };
    let listening = true;
    server.on('error', () => { listening = false; });
    server.on('connection', (socket) => record(socket, { route: 'loopback' }));
    const dialled = new Set();
    const sighted = new Set();
    const holds = new Map();
    const pollUsb = async () => {
      if (!usb) return;
      hold();
      let devices = [];
      try { devices = await usb.list(); } catch { devices = []; }
      // A listing that took seconds leaves no time to dial inside the original window, so the
      // devices it found get one.
      const first = devices.some((device) => !sighted.has(device.udid));
      for (const device of devices) {
        sighted.add(device.udid);
        // Holding the tunnel is what lets the app bind at all; see holdTunnel.
        if (!holds.has(device.udid)) holds.set(device.udid, holdTunnel(device.udid));
      }
      // A phone seen for the first time may have had no tunnel a moment ago, so its app has not bound yet.
      release(first ? 6_000 : 0);
      for (const device of devices) {
        if (dialled.has(device.udid)) continue;
        dialled.add(device.udid);
        hold();
        usb.connect(device.tunnelAddress, port).then(
          (socket) => { release(1_500); record(socket, { route: 'tunnel', udid: device.udid }); },
          () => { dialled.delete(device.udid); release(0); },
        );
      }
    };
    const poller = setInterval(() => { void pollUsb(); }, USB_POLL_MS);
    poller.unref?.();
    void pollUsb();
    server.listen(port, '127.0.0.1');

    const finish = () => {
      const now = Date.now();
      if ((inFlight > 0 || now < deadline) && now < started + maxWindowMs) {
        setTimeout(finish, inFlight > 0 ? 100 : Math.min(250, Math.max(10, deadline - now))).unref?.();
        return;
      }
      clearInterval(poller);
      for (const unhold of holds.values()) unhold();
      holds.clear();
      if (listening) server.close();
      for (const socket of sockets) socket.destroy();
      resolve(found);
    };
    setTimeout(finish, windowMs).unref?.();
  });
}

/** Why neither React Native route found an app, said once for both. */
export function noAppConnectedMessage(metroFailure, port = DEFAULT_PROFILER_PORT) {
  return 'No React Native app connected.\n'
    + `  Debug build over Metro: ${metroFailure}\n`
    + `  Release build on port ${port}: nothing dialled in. Install @callstack/tracesift-rn-profiler and build with \`tracesift profile build\`, which also runs \`adb reverse tcp:${port} tcp:${port}\` on Android.`;
}

/** How the app describes itself, for the recording's label. */
export function describeProfilerApp(hello) {
  const app = typeof hello.app === 'string' && hello.app ? hello.app : 'React Native app';
  const platform = hello.platform === 'ios' ? 'iOS' : hello.platform === 'android' ? 'Android' : null;
  return platform ? `${app} (${platform}, release)` : `${app} (release)`;
}

/** Release targets are `release:<device>`; bare `release` means whichever answers first. */
export const RELEASE_TARGET_PREFIX = 'release:';

/** One listing row per profiling build that answered, named by the device it is on. */
export function describeReleaseApps(apps, simulators = [], phones = []) {
  const used = new Set();
  return apps.map(({ hello, origin }) => {
    const reportedName = typeof hello.device === 'string' ? hello.device : undefined;
    let deviceId; let deviceKind; let deviceName = reportedName;
    if (origin.route === 'tunnel') {
      deviceId = origin.udid; deviceKind = 'device';
      deviceName = phones.find((phone) => phone.udid === origin.udid)?.name ?? reportedName;
    } else if (hello.platform === 'ios') {
      const matches = simulators.filter((simulator) => simulator.name === reportedName);
      deviceKind = 'simulator';
      if (matches.length === 1) deviceId = matches[0].id;
    } else {
      deviceKind = 'emulator';
    }
    let id = `${RELEASE_TARGET_PREFIX}${deviceId ?? (hello.platform === 'ios' ? 'ios' : 'android')}`;
    for (let n = 2; used.has(id); n += 1) id = `${RELEASE_TARGET_PREFIX}${deviceId ?? hello.platform}-${n}`;
    used.add(id);
    return {
      id,
      title: describeProfilerApp(hello),
      ...(typeof hello.app === 'string' ? { appId: hello.app } : {}),
      ...(deviceName ? { deviceName } : {}),
      ...(deviceId ? { deviceId } : {}),
      deviceKind,
    };
  });
}

/** Turn a chosen release target id into the filters `awaitProfilerApp` takes, so a recording
 * attaches to the app that was picked and no other. */
export async function releaseSelection(targetId) {
  if (!targetId || !targetId.startsWith(RELEASE_TARGET_PREFIX)) return {};
  const key = targetId.slice(RELEASE_TARGET_PREFIX.length).replace(/-\d+$/, '');
  if (key === 'android') {
    return { usb: false, accept: (hello, origin) => origin.route === 'loopback' && hello.platform === 'android' };
  }
  if (key === 'ios') {
    return { usb: false, accept: (hello, origin) => origin.route === 'loopback' && hello.platform === 'ios' };
  }
  const phones = await listTunnelDevices().catch(() => []);
  if (phones.some((phone) => phone.udid === key)) {
    return {
      usb: { list: async () => (await listTunnelDevices()).filter((phone) => phone.udid === key), connect: connectTunnel },
      accept: (_hello, origin) => origin.route === 'tunnel' && origin.udid === key,
    };
  }
  const simulator = (await listBootedSimulators()).find((entry) => entry.id === key);
  if (simulator) {
    return { usb: false, accept: (hello, origin) => origin.route === 'loopback' && hello.platform === 'ios' && hello.device === simulator.name };
  }
  throw new Error(`${targetId} is not a booted simulator or connected device. Run tracesift record targets --platform rn to see what can be recorded.`);
}
