import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { createServer } from 'node:http';

import { RELEASE_TARGET_ID, recordTargets } from '../src/record.js';

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
    await recordTargets(options);
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
  assert.equal(target.id, RELEASE_TARGET_ID);
  assert.equal(target.transport, 'release');
  assert.equal(target.appId, 'com.example.spike');
  assert.equal(target.deviceName, 'Pixel 10 Pro');
  assert.equal(target.recommended, true, 'it is the only thing to record');
  assert.equal(payload.profilerPort, port);
  assert.match(target.title, /com\.example\.spike \(Android, release\)/);
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

  assert.match(text, new RegExp(`Release build on port ${port}`));
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
