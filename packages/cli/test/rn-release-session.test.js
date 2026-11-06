import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect, createServer } from 'node:net';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { loadReleaseSourceMap, runRnReleaseRecording } from '../src/rn-release-session.js';
import { awaitProfilerApp } from '../src/rn-profiler-link.js';
import { readRecordState } from '../src/record-state.js';

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'tracesift-rn-release-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** An unlikely-to-collide loopback port per test, since each opens a listener. */
let nextPort = 18_900;
function freePort() {
  nextPort += 1;
  return nextPort;
}

const PROFILE = {
  traceEvents: [],
  samples: [
    { cpu: '-1', name: '', ts: '500000', pid: 42, tid: '3', weight: '1', sf: 3 },
    { cpu: '-1', name: '', ts: '500250', pid: 42, tid: '3', weight: '1', sf: 3 },
    { cpu: '-1', name: '', ts: '500500', pid: 42, tid: '3', weight: '1', sf: 2 },
  ],
  stackFrames: {
    1: { name: '[root]', category: 'root' },
    2: { name: 'App', category: 'JavaScript', parent: 1, funcVirtAddr: '512', offset: '4' },
    3: { name: 'fibonacci', category: 'JavaScript', parent: 2, funcVirtAddr: '1024', offset: '8' },
  },
};

/**
 * A release build carrying the profiler package: dials in, says hello, and
 * answers `stop` with a chunked base64 Tracery dump.
 *
 * @param {{ port: number, chunks?: number, hello?: object, onStop?: (send: Function) => void }} options
 */
function fakeApp(t, { port, chunks = 1, hello, onStop }) {
  const received = [];
  const socket = connect(port, '127.0.0.1');
  t.after(() => socket.destroy());
  socket.setEncoding('utf8');
  const send = (message) => socket.write(`${JSON.stringify(message)}\n`);

  socket.on('connect', () => send(hello ?? {
    type: 'hello', app: 'com.example.spike', platform: 'android', bundle: 'index.android.bundle', device: 'Pixel_10_Pro',
  }));

  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) {
        const message = JSON.parse(line);
        received.push(message);
        if (message.type === 'stop') {
          if (onStop) onStop(send, message);
          else {
            const base64 = Buffer.from(JSON.stringify(PROFILE), 'utf8').toString('base64');
            const size = Math.ceil(base64.length / chunks);
            for (let seq = 0; seq < chunks; seq += 1) {
              send({
                type: 'profile', id: message.id, seq,
                data: base64.slice(seq * size, (seq + 1) * size),
                last: seq === chunks - 1,
              });
            }
          }
        }
      }
      index = buffer.indexOf('\n');
    }
  });
  socket.on('error', () => undefined);
  return { received };
}

async function readExport(path) {
  return JSON.parse(gunzipSync(await readFile(path)).toString('utf8'));
}

async function record(t, home, overrides = {}) {
  const port = overrides.profilerPort ?? freePort();
  const pending = runRnReleaseRecording({
    home, sink: 'local', sourceMaps: false, duration: 50, profilerPort: port, ...overrides,
  });
  // Nothing is listening until the recorder binds, which it does immediately;
  // the app's own retry loop is what covers this in the real world.
  await new Promise((resolve) => setTimeout(resolve, 150));
  const app = fakeApp(t, { port, ...overrides });
  return { result: await pending, app, port };
}

test('a release recording is exported in the enhanced-trace envelope', async (t) => {
  const home = await temporaryDirectory(t);
  const { result, app } = await record(t, home);

  const document = await readExport(result.path);
  assert.equal(document.metadata.enhancedTraceVersion, 1);
  const { target } = document.metadata.traceSift;
  assert.equal(target.platform, 'react-native');
  assert.equal(target.appId, 'com.example.spike');
  assert.equal(target.deviceName, 'Pixel_10_Pro');
  assert.match(target.title, /com\.example\.spike \(Android, release\)/);

  const chunk = document.traceEvents.find((event) => event.name === 'ProfileChunk');
  assert.ok(document.traceEvents.some((event) => event.name === 'Profile'));
  assert.deepEqual(chunk.args.data.cpuProfile.samples, [3, 3, 2]);
  assert.deepEqual(chunk.args.data.timeDeltas, [0, 250, 250]);
  const fib = chunk.args.data.cpuProfile.nodes.find((node) => node.callFrame.functionName === 'fibonacci');
  assert.equal(fib.callFrame.url, 'index.android.bundle');
  assert.equal(fib.callFrame.columnNumber, 1024 + 8);

  assert.equal(app.received.filter((message) => message.type === 'start').length, 1);
  assert.equal(app.received.find((message) => message.type === 'start').hz, 1000);
  assert.equal((await readRecordState(home)).state, 'captured');
});

test('a profile split across chunks is reassembled', async (t) => {
  const home = await temporaryDirectory(t);
  const { result } = await record(t, home, { chunks: 7 });

  const document = await readExport(result.path);
  const chunk = document.traceEvents.find((event) => event.name === 'ProfileChunk');
  assert.deepEqual(chunk.args.data.cpuProfile.samples, [3, 3, 2]);
});

test('an out-of-order chunk fails the recording rather than truncating it', async (t) => {
  const home = await temporaryDirectory(t);
  await assert.rejects(
    record(t, home, {
      onStop: (send, message) => {
        send({ type: 'profile', id: message.id, seq: 0, data: 'eyJ=', last: false });
        send({ type: 'profile', id: message.id, seq: 4, data: 'eyJ=', last: true });
      },
    }),
    /chunk 4 where 1 was expected/,
  );
  const state = await readRecordState(home);
  assert.equal(state.state, 'failed');
});

test('an error from the app is reported with its reason', async (t) => {
  const home = await temporaryDirectory(t);
  await assert.rejects(
    record(t, home, {
      onStop: (send, message) => send({ type: 'error', id: message.id, message: 'sampling profiler unavailable' }),
    }),
    /sampling profiler unavailable/,
  );
});

test('an empty dump says what an empty dump means', async (t) => {
  const home = await temporaryDirectory(t);
  await assert.rejects(
    record(t, home, {
      onStop: (send, message) => send({ type: 'profile', id: message.id, seq: 0, data: '', last: true }),
    }),
    /no runtime has the sampling profiler registered/,
  );
});

test('a connection that does not introduce itself is turned away', async (t) => {
  const port = freePort();
  const link = awaitProfilerApp({ port });
  await new Promise((resolve) => setTimeout(resolve, 100));

  const socket = connect(port, '127.0.0.1');
  t.after(() => socket.destroy());
  socket.on('error', () => undefined);
  socket.on('connect', () => socket.write('{"type":"something-else"}\n'));

  await assert.rejects(link, /did not identify itself as a React Native app/);
});

test('a port somebody else holds is reported as such', async (t) => {
  const port = freePort();
  const held = await new Promise((resolve) => {
    const server = createServer();
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
  t.after(() => held.close());

  await assert.rejects(awaitProfilerApp({ port }), /already in use/);
});

test('the source map is registered under the same url the frames carry', async (t) => {
  const directory = await temporaryDirectory(t);
  const path = join(directory, 'index.android.bundle.map');
  await writeFile(path, JSON.stringify({ version: 3, sources: ['App.tsx'], names: [], mappings: '', sourcesContent: ['x'] }));

  const { retained, warnings } = await loadReleaseSourceMap({ bundleUrl: 'index.android.bundle', sourceMapPath: path });
  assert.equal(warnings.length, 0);
  assert.equal(retained[0].url, 'index.android.bundle', 'symbolication matches by exact string');
  assert.equal(retained[0].sourceMap.sourcesContent, undefined, 'the authored sources are dropped');
});

test('a missing source map warns instead of failing the capture', async (t) => {
  const directory = await temporaryDirectory(t);
  const { retained, warnings } = await loadReleaseSourceMap({
    bundleUrl: 'index.android.bundle', sourceMapPath: join(directory, 'nope.map'),
  });
  assert.deepEqual(retained, []);
  assert.ok(warnings.some((warning) => /Could not read the source map/.test(warning)));
  assert.ok(warnings.some((warning) => /no source map was found/.test(warning)));
});
