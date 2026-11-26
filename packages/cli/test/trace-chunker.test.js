import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { createTraceEventWriter } from '../src/trace-chunker.js';
import { copyTraceEvents, writeTraceExport } from '../src/trace-export.js';

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'tracesift-chunker-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** A sink that behaves like the local one: appends every chunk to a spool. */
async function fileSink(directory) {
  const spool = join(directory, 'trace.spool');
  await writeFile(spool, '');
  const sizes = [];
  return { spool, sizes, async chunk(bytes) { sizes.push(bytes.byteLength); await appendFile(spool, bytes); } };
}

async function copied(spool) {
  const parts = [];
  const output = { write(chunk) { parts.push(Buffer.from(chunk)); return true; }, once() {} };
  const eventCount = await copyTraceEvents(spool, output);
  return { eventCount, events: JSON.parse(`[${Buffer.concat(parts).toString('utf8')}]`) };
}

async function roundTrip(t, events, options, batchSize = events.length || 1) {
  const directory = await temporaryDirectory(t);
  const sink = await fileSink(directory);
  const writer = createTraceEventWriter(sink, options);
  for (let index = 0; index < events.length; index += batchSize) await writer.write(events.slice(index, index + batchSize));
  await writer.end();
  return { writer, sink, ...(await copied(sink.spool)) };
}

test('events round-trip through copyTraceEvents and the counts agree', async (t) => {
  const input = [
    { name: 'RunTask', ph: 'X', pid: 1, tid: 2, ts: 10, dur: 5 },
    { name: 'FunctionCall', ph: 'X', pid: 1, tid: 2, ts: 20, args: { data: { url: 'a.js', line: 3 } } },
    { name: 'Unicode', ph: 'I', ts: 30, args: { s: 'héllo ☃ 日本' } },
  ];
  const { writer, events, eventCount } = await roundTrip(t, input, undefined, 2);
  assert.deepEqual(events, input);
  assert.equal(eventCount, input.length);
  assert.equal(writer.eventCount, eventCount);
});

test('JSON punctuation, quotes and backslashes inside strings survive the scanner', async (t) => {
  const input = [
    { name: 'X', args: { s: 'a{b}c[d]e"f\\g' } },
    { name: 'Y', args: { s: '}]}]"\\"\\\\' } },
  ];
  // A tiny budget also splits chunks inside these strings.
  const { writer, events, eventCount } = await roundTrip(t, input, { maxBytes: 8 });
  assert.deepEqual(events, input);
  assert.equal(eventCount, 2);
  assert.equal(writer.eventCount, 2);
});

test('a single event larger than maxBytes still round-trips', async (t) => {
  const input = [{ name: 'Big', args: { s: 'x{"\\'.repeat(500) } }, { name: 'After' }];
  const { events, eventCount, sink } = await roundTrip(t, input, { maxBytes: 64 });
  assert.deepEqual(events, input);
  assert.equal(eventCount, 2);
  assert.ok(sink.sizes.length > 1);
});

test('an empty trace is still a valid document with no events', async (t) => {
  const directory = await temporaryDirectory(t);
  const sink = await fileSink(directory);
  const writer = createTraceEventWriter(sink);
  await writer.end();
  assert.equal(await readFile(sink.spool, 'utf8'), '{"traceEvents":[]}');
  const { events, eventCount } = await copied(sink.spool);
  assert.deepEqual(events, []);
  assert.equal(eventCount, 0);
  assert.equal(writer.eventCount, 0);
});

test('a small maxBytes forces many chunks without changing the result', async (t) => {
  const input = Array.from({ length: 200 }, (_, index) => ({ name: `Event${index}`, ph: 'X', ts: index, args: { payload: 'p'.repeat(20) } }));
  const { events, eventCount, sink, writer } = await roundTrip(t, input, { maxBytes: 100 }, 7);
  assert.ok(sink.sizes.length > 10, `expected many chunks, got ${sink.sizes.length}`);
  assert.deepEqual(events, input);
  assert.equal(eventCount, 200);
  assert.equal(writer.eventCount, 200);
});

test('the writer awaits each sink.chunk before producing the next', async () => {
  let active = 0;
  let overlapped = false;
  let calls = 0;
  const sink = {
    async chunk() {
      calls += 1;
      active += 1;
      if (active > 1) overlapped = true;
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
    },
  };
  const writer = createTraceEventWriter(sink, { maxBytes: 32 });
  await writer.write(Array.from({ length: 50 }, (_, index) => ({ name: `E${index}`, ts: index })));
  assert.equal(active, 0, 'write() resolved while a chunk was still in flight');
  await writer.end();
  assert.equal(active, 0);
  assert.equal(overlapped, false);
  assert.ok(calls > 5);
});

test('React Native shaped events export through writeTraceExport intact', async (t) => {
  const directory = await temporaryDirectory(t);
  const sink = await fileSink(directory);
  const input = [
    { name: 'TracingStartedInPage', cat: 'disabled-by-default-devtools.timeline', ph: 'I', pid: 1, tid: 1, ts: 1, args: { data: { frames: [{ frame: 'F1', url: 'app://rn' }] } } },
    { name: 'Profile', cat: 'disabled-by-default-v8.cpu_profiler', ph: 'P', id: '0x1', pid: 1, tid: 2, ts: 2, args: { data: { startTime: 2 } } },
    { name: 'ProfileChunk', cat: 'disabled-by-default-v8.cpu_profiler', ph: 'P', id: '0x1', pid: 1, tid: 2, ts: 3, args: { data: {
      cpuProfile: { nodes: [{ id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: -1, columnNumber: -1 } }], samples: [1] },
      timeDeltas: [1],
    } } },
  ];
  const writer = createTraceEventWriter(sink, { maxBytes: 128 });
  await writer.write(input);
  await writer.end();

  const destination = join(directory, 'Trace.json.gz');
  const metadata = { enhancedTraceVersion: 1, traceSift: { captureId: 'abc' } };
  const written = await writeTraceExport({ spool: sink.spool, destination, metadata });
  const document = JSON.parse(gunzipSync(await readFile(destination)).toString('utf8'));

  assert.deepEqual(document.traceEvents, input);
  assert.deepEqual(document.metadata, metadata);
  assert.equal(written.eventCount, writer.eventCount);
});
