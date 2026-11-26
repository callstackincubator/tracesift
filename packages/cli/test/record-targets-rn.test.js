import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';

import { recordTargets } from '../src/record.js';
import { discoverProfilerApps } from '../src/rn-profiler-link.js';

let nextPort = 19_300;
function freePort() {
  nextPort += 1;
  return nextPort;
}

/** A Metro that serves /json/list, with whatever targets the test wants. */
async function fakeMetro(t, targets) {
  const server = createServer((request, response) => {
    const { port } = server.address();
    if (!request.url.startsWith('/json/list')) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(targets.map((target) => ({
      id: target.id,
      title: target.title,
      appId: target.appId,
      deviceName: target.deviceName,
      vm: 'Hermes',
      webSocketDebuggerUrl: `ws://127.0.0.1:${port}/inspector/debug?device=1&page=${target.id}`,
      reactNative: { logicalDeviceId: target.id },
    }))));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

/** A release build that dials the profiler port and introduces itself. */
function fakeReleaseApp(t, port, hello) {
  let socket;
  const timer = setInterval(() => {
    if (socket && !socket.destroyed) return;
    socket = connect(port, '127.0.0.1');
    socket.on('error', () => undefined);
    socket.on('connect', () => socket.write(`${JSON.stringify(hello ?? {
      type: 'hello', app: 'com.example.spike', platform: 'android', bundle: 'index.android.bundle', device: 'Pixel 10 Pro',
    })}\n`));
  }, 150);
  timer.unref?.();
  t.after(() => { clearInterval(timer); socket?.destroy(); });
}

/** Run recordTargets with console.log captured. */
async function listing(options) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    await recordTargets({
      listDeviceHints: async () => ({ hints: [], reachable: [] }),
      // Never dial a real phone from a test.
      discoverApps: (found) => discoverProfilerApps({ ...found, usb: false, windowMs: 1_200 }),
      ...options,
    });
  } finally {
    console.log = original;
  }
  return lines.join('\n');
}

async function listingJson(options) {
  return JSON.parse(await listing({ ...options, json: true }));
}

test('a debug build on Metro is listed without waiting on the profiler port', async (t) => {
  const metro = await fakeMetro(t, [{ id: 'page-1', title: 'Spike', appId: 'com.example.spike', deviceName: 'Pixel' }]);
  const started = Date.now();

  const payload = await listingJson({ platform: 'rn', metro, profilerPort: freePort() });

  assert.equal(payload.targets.length, 1);
  assert.equal(payload.targets[0].transport, 'metro');
  assert.equal(payload.targets[0].recommended, true);
  assert.ok(Date.now() - started < 3000, 'Metro answering means no release probe window is paid');
});

test('a release build is listed when Metro has nothing', async (t) => {
  const metro = await fakeMetro(t, []);
  const port = freePort();
  fakeReleaseApp(t, port);

  const payload = await listingJson({ platform: 'rn', metro, profilerPort: port });

  assert.equal(payload.targets.length, 1);
  const [target] = payload.targets;
  assert.equal(target.id, 'release:android');
  assert.equal(target.transport, 'release');
  assert.equal(target.appId, 'com.example.spike');
  assert.equal(target.deviceName, 'Pixel 10 Pro');
  assert.equal(target.recommended, true, 'it is the only thing to record');
  assert.equal(payload.profilerPort, port);
  assert.match(target.title, /com\.example\.spike \(Android, release\)/);
});

test('every profiling build that answers is its own target, named by device', async (t) => {
  const port = freePort();
  fakeReleaseApp(t, port, { type: 'hello', app: 'com.example.spike', platform: 'ios', bundle: 'main.jsbundle', device: 'Sim One' });
  fakeReleaseApp(t, port, { type: 'hello', app: 'com.example.spike', platform: 'android', bundle: 'index.android.bundle', device: 'Pixel 10 Pro' });

  const payload = await listingJson({ platform: 'rn', metro: `http://127.0.0.1:${freePort()}`, profilerPort: port });

  assert.equal(payload.targets.length, 2);
  assert.deepEqual(payload.targets.map((target) => target.id).sort(), ['release:android', 'release:ios']);
  assert.ok(payload.targets.every((target) => target.recommended === false), 'nothing is recommended when there is a choice');
  assert.deepEqual(payload.targets.map((target) => target.deviceName).sort(), ['Pixel 10 Pro', 'Sim One']);
});

test('a release build is listed when Metro is not running at all', async (t) => {
  const port = freePort();
  fakeReleaseApp(t, port);

  const payload = await listingJson({ platform: 'rn', metro: `http://127.0.0.1:${freePort()}`, profilerPort: port });

  assert.equal(payload.targets.length, 1);
  assert.equal(payload.targets[0].transport, 'release');
  assert.equal(payload.error, undefined, 'a dead Metro is not an error when a release build answered');
});

test('the human listing names the release route and the command that records it', async (t) => {
  const port = freePort();
  fakeReleaseApp(t, port);

  const text = await listing({ platform: 'rn', metro: `http://127.0.0.1:${freePort()}`, profilerPort: port });

  assert.match(text, new RegExp(`Release builds on port ${port}`));
  assert.match(text, /com\.example\.spike/);
  assert.match(text, /tracesift record start --platform rn/);
});

test('neither route answering names both, not just Metro', async (t) => {
  const metro = await fakeMetro(t, []);
  await assert.rejects(
    listing({ platform: 'rn', metro, profilerPort: freePort() }),
    (error) => {
      assert.match(error.message, /No React Native app connected/);
      assert.match(error.message, /Debug build over Metro:/);
      assert.match(error.message, /Release build on port/);
      assert.match(error.message, /tracesift profile build/);
      return true;
    },
  );
});

test('--json reports the same double failure as data, and exits non-zero', async (t) => {
  const previous = process.exitCode;
  t.after(() => { process.exitCode = previous; });
  const metro = await fakeMetro(t, []);

  const payload = await listingJson({ platform: 'rn', metro, profilerPort: freePort() });

  assert.match(payload.error, /Debug build over Metro:/);
  assert.match(payload.error, /Release build on port/);
  assert.equal(process.exitCode, 1);
});

test('listing still refuses a platform that is not React Native', async () => {
  await assert.rejects(recordTargets({ platform: 'chrome' }), /lists React Native apps/);
});

test('a plugged-in phone with no tunnel is reported, not silently skipped', async (t) => {
  const metro = await fakeMetro(t, []);
  const hints = ['Hur\'s iPhone is plugged in but has no CoreDevice tunnel, so TraceSift cannot reach an app on it. Unlock the phone.'];
  const listDeviceHints = async () => ({ hints, reachable: [] });

  await assert.rejects(
    () => recordTargets({ platform: 'rn', metro, profilerPort: freePort(), listDeviceHints }),
    /No React Native app connected[\s\S]*iPhone: .*no CoreDevice tunnel/);

  const previous = process.exitCode;
  const payload = await listingJson({ platform: 'rn', metro, profilerPort: freePort(), listDeviceHints });
  process.exitCode = previous;
  assert.match(payload.error, /iPhone: .*no CoreDevice tunnel/, 'the panel reads this JSON error, so the hint must be in it');
});

test('the phone hint rides along with a target that was found', async (t) => {
  const metro = await fakeMetro(t, []);
  const port = freePort();
  fakeReleaseApp(t, port);
  const payload = await listingJson({ platform: 'rn', metro, profilerPort: port, listDeviceHints: async () => ({ hints: ['phone: no tunnel'], reachable: [] }) });
  assert.deepEqual(payload.deviceHints, ['phone: no tunnel']);
  assert.equal(payload.targets.length, 1);
});

test('a phone whose tunnel takes longer than the window to list is still discovered', async (t) => {
  const port = freePort();
  // Stands in for the app listening on the phone's tunnel address.
  const phone = createNetServer((socket) => {
    socket.write(`${JSON.stringify({ type: 'hello', app: 'com.example.spike', platform: 'ios', device: "Hur's iPhone" })}\n`);
  });
  await new Promise((resolve) => phone.listen(0, '127.0.0.1', resolve));
  t.after(() => phone.close());

  const apps = await discoverProfilerApps({
    port,
    windowMs: 400,
    usb: {
      // `devicectl` waking a sleeping tunnel is slower than the window.
      list: async () => { await new Promise((resolve) => { setTimeout(resolve, 1_200); }); return [{ udid: 'PHONE-1', tunnelAddress: '127.0.0.1' }]; },
      connect: (_host, _port) => new Promise((resolve, reject) => {
        const socket = connect(phone.address().port, '127.0.0.1');
        socket.once('error', reject);
        socket.once('connect', () => { socket.pause(); resolve(socket); });
      }),
    },
  });

  assert.equal(apps.length, 1);
  assert.equal(apps[0].origin.udid, 'PHONE-1');
  assert.equal(apps[0].hello.device, "Hur's iPhone");
});

test('a phone that never answers does not hold the listing past the cap', async (t) => {
  const port = freePort();
  const started = Date.now();
  const apps = await discoverProfilerApps({
    port,
    windowMs: 200,
    maxWindowMs: 1_500,
    usb: {
      list: async () => [{ udid: 'PHONE-1', tunnelAddress: '127.0.0.1' }],
      // Nothing is listening on the phone, so the dial hangs.
      connect: () => new Promise(() => {}),
    },
  });
  assert.deepEqual(apps, []);
  assert.ok(Date.now() - started < 4_000, 'the cap bounds the wait');
  t.diagnostic(`took ${Date.now() - started}ms`);
});
