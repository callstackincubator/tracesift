import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { cpuProfileToTraceEvents, runRnRecording } from '../src/record-rn-session.js';
import { TRACE_CATEGORIES } from '../src/record-session.js';
import { readRecordState } from '../src/record-state.js';

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'tracesift-rn-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const TARGET = { id: 'page-1', title: 'Hermes React Native', appId: 'com.example.app', deviceName: 'iPhone 17 Pro', vm: 'Hermes' };

/**
 * A Metro that serves /json/list, plus a stand-in for the global WebSocket that
 * speaks the CDP message protocol. `script(message, socket)` plays the app.
 */
async function fakeApp(t, script) {
  const server = createServer((request, response) => {
    const port = server.address().port;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify([{ ...TARGET, webSocketDebuggerUrl: `ws://127.0.0.1:${port}/inspector/debug?device=a` }]));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));

  const received = [];
  const constructed = [];
  const original = globalThis.WebSocket;

  class FakeSocket extends EventTarget {
    constructor(url, options) {
      super();
      this.url = url;
      this.readyState = 0;
      constructed.push({ url, options });
      setImmediate(() => {
        this.readyState = 1;
        this.dispatchEvent(new Event('open'));
      });
    }

    send(data) {
      const message = JSON.parse(data);
      received.push(message);
      setImmediate(() => script(message, this));
    }

    close() {
      if (this.readyState > 1) return;
      this.readyState = 3;
      this.dispatchEvent(Object.assign(new Event('close'), { code: 1000, reason: '' }));
    }

    reply(message, result = {}) {
      this.push({ id: message.id, result });
    }

    fail(message, text, code) {
      this.push({ id: message.id, error: { code, message: text } });
    }

    notify(method, params) {
      this.push({ method, params });
    }

    push(payload) {
      if (this.readyState !== 1) return;
      this.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify(payload) }));
    }
  }

  globalThis.WebSocket = FakeSocket;
  t.after(() => { globalThis.WebSocket = original; });

  return {
    metro: `http://127.0.0.1:${server.address().port}`,
    received,
    constructed,
    methods: () => received.map((message) => message.method),
  };
}

async function record(t, app, home, overrides = {}) {
  return runRnRecording({ home, metro: app.metro, sink: 'local', sourceMaps: false, duration: 50, ...overrides });
}

async function readExport(path) {
  return JSON.parse(gunzipSync(await readFile(path)).toString('utf8'));
}

const SAMPLE_EVENTS = [
  { name: 'RunTask', cat: 'disabled-by-default-devtools.timeline', ph: 'X', pid: 7, tid: 11, ts: 1000, dur: 40 },
  { name: 'FunctionCall', cat: 'devtools.timeline', ph: 'X', pid: 7, tid: 11, ts: 1010, dur: 20 },
];

/** An app that traces successfully and flushes `SAMPLE_EVENTS` on Tracing.end. */
function tracingApp(message, socket) {
  if (message.method === 'Tracing.start') return socket.reply(message);
  if (message.method === 'Tracing.end') {
    socket.reply(message);
    socket.notify('Tracing.dataCollected', { value: [SAMPLE_EVENTS[0]] });
    socket.notify('Tracing.dataCollected', { value: [SAMPLE_EVENTS[1]] });
    socket.notify('Tracing.tracingComplete', {});
    return undefined;
  }
  return socket.reply(message);
}

test('a React Native recording is exported in the enhanced-trace envelope', async (t) => {
  const home = await temporaryDirectory(t);
  const app = await fakeApp(t, tracingApp);
  const result = await record(t, app, home);

  const document = await readExport(result.path);
  assert.equal(document.metadata.enhancedTraceVersion, 1);
  const { target } = document.metadata.traceSift;
  assert.equal(target.platform, 'react-native');
  assert.equal(target.targetId, TARGET.id);
  assert.equal(target.appId, TARGET.appId);
  assert.equal(target.deviceName, TARGET.deviceName);

  const names = document.traceEvents.map((event) => event.name);
  assert.deepEqual(names.filter((name) => SAMPLE_EVENTS.some((event) => event.name === name)), SAMPLE_EVENTS.map((event) => event.name));
  for (const sent of SAMPLE_EVENTS) {
    assert.ok(document.traceEvents.some((event) => event.name === sent.name && event.ts === sent.ts), `${sent.name} is exported`);
  }
  assert.ok(!names.includes('TracingStartedInBrowser'));

  const start = app.received.find((message) => message.method === 'Tracing.start');
  assert.equal(start.params.categories, TRACE_CATEGORIES);
  assert.equal((await readRecordState(home)).state, 'captured');
});

test('a React Native recording never enables the domains React Native rejects or addresses a session', async (t) => {
  const home = await temporaryDirectory(t);
  const app = await fakeApp(t, tracingApp);
  await record(t, app, home);

  const methods = app.methods();
  assert.ok(methods.includes('Tracing.start'));
  assert.ok(methods.includes('Tracing.end'));
  for (const forbidden of ['Debugger.enable', 'Page.enable', 'Target.setAutoAttach']) {
    assert.ok(!methods.includes(forbidden), `${forbidden} was never sent`);
  }
  assert.ok(app.received.every((message) => !('sessionId' in message)));
});

test('the inspector socket is opened with the Metro origin as its Origin header', async (t) => {
  const home = await temporaryDirectory(t);
  const app = await fakeApp(t, tracingApp);
  await record(t, app, home);

  assert.equal(app.constructed.length, 1);
  assert.match(app.constructed[0].url, new RegExp(`^ws://127\\.0\\.0\\.1:${new URL(app.metro).port}/`));
  assert.deepEqual(app.constructed[0].options, { headers: { Origin: app.metro } });
});

for (const [label, text, expected] of [
  [
    'an attached debugger',
    'Debugger domain is expected to be disabled before starting Tracing',
    'A debugger is attached to that app. Close React Native DevTools, then run this again.',
  ],
  [
    'a trace already in progress',
    'Tracing has already been started',
    'That app is already being profiled. Hermes has one sampler, so stop the recording in React Native DevTools (or close that window) and run this again.',
  ],
  [
    'more than one React Native host',
    'Cannot trace: multiple React Native hosts are registered',
    'The app has more than one React Native host registered, and React Native will not trace it. Reload the app, then run this again.',
  ],
]) {
  test(`a Tracing.start rejection for ${label} is explained to the developer`, async (t) => {
    const home = await temporaryDirectory(t);
    const app = await fakeApp(t, (message, socket) => {
      if (message.method === 'Tracing.start') return socket.fail(message, text, -32000);
      return socket.reply(message);
    });
    await assert.rejects(record(t, app, home), { message: expected });
    const state = await readRecordState(home);
    assert.equal(state.state, 'failed');
    assert.equal(state.error, expected);
  });
}

test('a runtime without Tracing falls back to the Profiler domain', async (t) => {
  const home = await temporaryDirectory(t);
  const nodes = [
    { id: 1, callFrame: { functionName: '(root)', scriptId: '0', url: '', lineNumber: 0, columnNumber: 0 }, children: [2] },
    { id: 2, callFrame: { functionName: 'work', scriptId: '1', url: '', lineNumber: 1, columnNumber: 2 } },
  ];
  const profile = { nodes, startTime: 5000, samples: [2, 2, 1], timeDeltas: [10, 10, 10] };
  const app = await fakeApp(t, (message, socket) => {
    if (message.method === 'Tracing.start') return socket.fail(message, 'Tracing.start is not found', -32601);
    if (message.method === 'Profiler.stop') return socket.reply(message, { profile });
    return socket.reply(message);
  });
  const result = await record(t, app, home);

  assert.ok(app.methods().includes('Profiler.start'));
  const document = await readExport(result.path);
  assert.ok(document.traceEvents.some((event) => event.name === 'Profile'));
  const chunks = document.traceEvents.filter((event) => event.name === 'ProfileChunk');
  assert.ok(chunks.length >= 1);
  assert.deepEqual(chunks[0].args.data.cpuProfile.nodes, nodes);
  assert.ok(result.warnings.some((warning) => /older Profiler domain/.test(warning)));
});

test('a runtime with neither Tracing nor Profiler says it has no CPU profiler', async (t) => {
  const home = await temporaryDirectory(t);
  const app = await fakeApp(t, (message, socket) => {
    if (message.method === 'Tracing.start' || message.method === 'Profiler.start') {
      return socket.fail(message, `${message.method} is not found`, -32601);
    }
    return socket.reply(message);
  });
  await assert.rejects(record(t, app, home), /does not expose a CPU profiler/);
  assert.match((await readRecordState(home)).error, /does not expose a CPU profiler/);
});

test('an app that disconnects mid-recording fails the recording and records why', async (t) => {
  const home = await temporaryDirectory(t);
  const app = await fakeApp(t, (message, socket) => {
    socket.reply(message);
    if (message.method === 'Tracing.start') setImmediate(() => socket.close());
  });
  const expected = 'The app disconnected from Metro before the recording finished. Nothing was captured — reload the app and record again.';
  await assert.rejects(record(t, app, home, { duration: 0 }), { message: expected });

  const state = await readRecordState(home);
  assert.equal(state.state, 'failed');
  assert.equal(state.error, expected);
});

test('a long CPU profile is split into chunks that carry the node table once', () => {
  const total = 25_000;
  const nodes = [{ id: 1, callFrame: { functionName: '(root)', url: '' } }];
  const samples = Array.from({ length: total }, (_, index) => (index % 3) + 1);
  const timeDeltas = Array.from({ length: total }, (_, index) => index);
  const events = cpuProfileToTraceEvents({ nodes, startTime: 4242, samples, timeDeltas });

  const [profile, ...chunks] = events;
  assert.equal(profile.name, 'Profile');
  assert.equal(profile.args.data.startTime, 4242);
  assert.equal(chunks.length, 3);
  assert.ok(chunks.every((chunk) => chunk.name === 'ProfileChunk'));
  assert.deepEqual(chunks.map((chunk) => 'nodes' in chunk.args.data.cpuProfile), [true, false, false]);
  assert.deepEqual(chunks[0].args.data.cpuProfile.nodes, nodes);
  assert.deepEqual(chunks.map((chunk) => chunk.args.data.cpuProfile.samples.length), [10_000, 10_000, 5_000]);
  assert.deepEqual(chunks.map((chunk) => chunk.args.data.timeDeltas.length), [10_000, 10_000, 5_000]);
  assert.deepEqual(chunks[1].args.data.cpuProfile.samples, samples.slice(10_000, 20_000));
  assert.deepEqual(chunks[2].args.data.timeDeltas, timeDeltas.slice(20_000));
});
