import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { assertRecordOptions, parseDuration, parsePlatform, recordTargets } from '../src/record.js';
import { createIngestSink, createLocalSink } from '../src/record-sink.js';
import {
  activeRecordState, clearRecordState, readRecordState, writeRecordState,
} from '../src/record-state.js';

const TARGET = { platform: 'react-native', title: 'Example', url: 'http://127.0.0.1:8081' };

async function temporaryHome(t) {
  const home = await mkdtemp(join(tmpdir(), 'tracesift-record-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

/** Stand in for the capture endpoints the web app serves on loopback. */
async function captureServer(t, { token = 'upload-token' } = {}) {
  const calls = [];
  let stopRequested = false;
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(request.url, 'http://127.0.0.1');
      calls.push({
        method: request.method,
        path: url.pathname,
        search: url.search,
        authorization: request.headers.authorization,
        contentType: request.headers['content-type'],
        body,
      });
      const json = (value, status = 200) => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(value));
      };
      if (url.pathname === '/api/captures' && request.method === 'POST') {
        return json({ capture: { id: 'CAPTURE-1', state: 'pending' }, uploadToken: token }, 201);
      }
      if (url.pathname === '/api/captures/CAPTURE-1' && request.method === 'GET') {
        return json({ capture: { id: 'CAPTURE-1', state: stopRequested ? 'stop_requested' : 'recording' } });
      }
      if (url.pathname.endsWith('/ingest/raw')) {
        if (request.headers.authorization !== `Bearer ${token}`) return json({ error: 'Capture authorization failed.' }, 401);
        return json({ capture: { id: 'CAPTURE-1' } });
      }
      if (url.pathname.endsWith('/ingest/finalize')) {
        return json({ capture: { id: 'CAPTURE-1', export: { fileName: 'Trace-X.json.gz', sizeBytes: 42 }, eventCount: 7, warnings: ['minified'] } });
      }
      if (url.pathname.endsWith('/ingest/status')) return json({ capture: { id: 'CAPTURE-1' } });
      return json({ error: 'Not found.' }, 404);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return {
    calls,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requestStop() { stopRequested = true; },
  };
}

test('durations accept the units a harness is likely to pass', () => {
  assert.equal(parseDuration(undefined), undefined);
  assert.equal(parseDuration('30'), 30_000);
  assert.equal(parseDuration('30s'), 30_000);
  assert.equal(parseDuration('500ms'), 500);
  assert.equal(parseDuration('2m'), 120_000);
  assert.equal(parseDuration(' 1.5s '), 1500);
  assert.throws(() => parseDuration('soon'), /30s, 500ms or 2m/);
  assert.throws(() => parseDuration('0s'), /between 1ms and 1h/);
  assert.throws(() => parseDuration('2h'), /30s, 500ms or 2m/);
  assert.throws(() => parseDuration('120m'), /between 1ms and 1h/);
});

test('record state survives a round trip and is scoped to its own recorder', async (t) => {
  const home = await temporaryHome(t);
  assert.equal(await readRecordState(home), null);

  await writeRecordState(home, { apiVersion: 1, pid: process.pid, mode: 'local', state: 'recording', startedAt: Date.now(), url: 'https://example.com/' });
  assert.equal((await activeRecordState(home)).state, 'recording');

  // Another recorder's state must not be removed by this process.
  await clearRecordState(home, process.pid + 1);
  assert.notEqual(await readRecordState(home), null);
  await clearRecordState(home, process.pid);
  assert.equal(await readRecordState(home), null);
});

test('a recorder that died leaves no active recording behind', async (t) => {
  const home = await temporaryHome(t);
  // PID 1 exists but is not ours; a PID that cannot exist stands in for a dead recorder.
  await writeRecordState(home, { apiVersion: 1, pid: 2 ** 31 - 1, mode: 'local', state: 'recording', startedAt: Date.now(), url: '' });
  assert.equal(await activeRecordState(home), null);
});

test('a finished recording is not treated as active', async (t) => {
  const home = await temporaryHome(t);
  await writeRecordState(home, { apiVersion: 1, pid: process.pid, mode: 'local', state: 'captured', startedAt: Date.now(), url: '' });
  assert.equal(await activeRecordState(home), null);
  assert.equal((await readRecordState(home)).state, 'captured');
});

test('state written by a future version is ignored rather than misread', async (t) => {
  const home = await temporaryHome(t);
  await writeRecordState(home, { apiVersion: 2, pid: process.pid, mode: 'local', state: 'recording', startedAt: 0, url: '' });
  assert.equal(await readRecordState(home), null);
});

test('the ingest sink speaks the capture protocol', async (t) => {
  const server = await captureServer(t);
  const sink = await createIngestSink({ baseUrl: server.baseUrl }, TARGET, 'Example');
  assert.equal(sink.mode, 'ingest');
  assert.equal(sink.captureId, 'CAPTURE-1');

  await sink.status({ state: 'recording' });
  await sink.chunk(Buffer.from('{"traceEvents":['));
  await sink.chunk(Buffer.from(']}'));
  const result = await sink.finalize({ stopReason: 'manual', scripts: [], sourceMaps: [] });

  assert.deepEqual(result, { fileName: 'Trace-X.json.gz', sizeBytes: 42, eventCount: 7, warnings: ['minified'] });

  const create = server.calls.find((call) => call.path === '/api/captures');
  assert.deepEqual(JSON.parse(create.body.toString('utf8')), { title: 'Example', target: TARGET });

  const raw = server.calls.filter((call) => call.path.endsWith('/ingest/raw'));
  assert.deepEqual(raw.map((call) => call.search), ['?sequence=0', '?sequence=1'], 'chunks are numbered in order');
  assert.equal(raw[0].contentType, 'application/octet-stream');
  assert.equal(raw[0].authorization, 'Bearer upload-token');
  assert.equal(Buffer.concat(raw.map((call) => call.body)).toString('utf8'), '{"traceEvents":[]}');
});

test('the ingest sink reports the web app’s Stop button', async (t) => {
  const server = await captureServer(t);
  const sink = await createIngestSink({ baseUrl: server.baseUrl }, TARGET, 'Example');
  assert.equal(await sink.stopRequested(), false);
  server.requestStop();
  assert.equal(await sink.stopRequested(), true);
});

test('an ingest failure surfaces the server’s own message', async (t) => {
  const server = createServer((request, response) => {
    response.writeHead(409, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: 'A capture is already active for “Example”.' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  await assert.rejects(createIngestSink({ baseUrl }, TARGET, 'Example'), /A capture is already active/);
});

test('the local sink writes a gzipped enhanced trace without a server', async (t) => {
  const home = await temporaryHome(t);
  const sink = await createLocalSink(home, TARGET);
  assert.equal(sink.mode, 'local');
  assert.ok(sink.directory.startsWith(join(home, 'recordings')));
  assert.equal(await sink.stopRequested(), false, 'nothing can request a stop through a file');

  await sink.chunk(Buffer.from('{"traceEvents":[{"name":"RunTask","ph":"X"}'));
  await sink.chunk(Buffer.from(']}'));
  const result = await sink.finalize({ scripts: [{ scriptId: '1', url: 'https://example.com/app.js' }], sourceMaps: [], warnings: ['minified'] });

  assert.equal(result.eventCount, 1);
  assert.deepEqual(result.warnings, ['minified']);
  const document = JSON.parse(gunzipSync(await readFile(result.path)).toString('utf8'));
  assert.equal(document.metadata.enhancedTraceVersion, 1);
  assert.equal(document.metadata.traceSift.captureId, sink.captureId);
  assert.deepEqual(document.metadata.traceSift.target, TARGET);
  assert.equal(document.metadata.traceSift.scripts[0].url, 'https://example.com/app.js');
  assert.equal(document.traceEvents[0].name, 'RunTask');
});

test('the local sink honours an explicit output path', async (t) => {
  const home = await temporaryHome(t);
  const destination = join(home, 'nested', 'my-trace.json.gz');
  const sink = await createLocalSink(home, TARGET, { out: destination });
  await sink.chunk(Buffer.from('{"traceEvents":[{"name":"A"}]}'));
  const result = await sink.finalize({});
  assert.equal(result.path, destination);
  assert.equal(result.fileName, 'my-trace.json.gz');
  assert.ok(gunzipSync(await readFile(destination)).length > 0);
});

test('record commands require an RN platform and reject unrelated options', () => {
  assert.equal(parsePlatform('rn'), 'rn');
  assert.equal(parsePlatform('react-native'), 'rn');
  assert.throws(() => parsePlatform(undefined), /--platform rn/);
  assert.throws(() => parsePlatform('chrome'), /--platform rn/);
  assert.doesNotThrow(() => assertRecordOptions('record', 'start', { platform: 'rn', duration: '5s', sink: 'local' }));
  assert.throws(() => assertRecordOptions('record', 'stop', { duration: '5s' }), /not supported/);
  assert.throws(() => assertRecordOptions('start', undefined, { sink: 'local' }), /only supported/);
});

test('targets requires a React Native platform', async () => {
  await assert.rejects(() => recordTargets({ platform: 'chrome' }), /lists React Native apps/);
});

test('a React Native capture target carries the app and device instead of a tab', async (t) => {
  const home = await temporaryHome(t);
  const target = {
    platform: 'react-native', title: 'AwesomeApp (Hermes) — iPhone 17 Pro', url: 'http://127.0.0.1:8081',
    targetId: 'device-1-page-1', appId: 'com.awesome.app', deviceName: 'iPhone 17 Pro',
  };
  const sink = await createLocalSink(home, target);
  await sink.chunk(Buffer.from('{"traceEvents":[{"name":"TracingStartedInPage","ph":"I","pid":1,"tid":1,"ts":1}]}'));
  const result = await sink.finalize({ scripts: [], sourceMaps: [] });

  const document = JSON.parse(gunzipSync(await readFile(result.path)).toString('utf8'));
  assert.equal(document.metadata.traceSift.target.platform, 'react-native');
  assert.equal(document.metadata.traceSift.target.appId, 'com.awesome.app');
  assert.equal(document.metadata.traceSift.target.deviceName, 'iPhone 17 Pro');
  assert.ok(!('tabId' in document.metadata.traceSift.target));
  // Nothing was rebuilt: React Native names its own frames.
  assert.ok(!document.traceEvents.some((event) => event.name === 'TracingStartedInBrowser'));
});
