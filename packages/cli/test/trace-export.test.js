import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { copyTraceEvents, inspectTraceMetadata, writeTraceExport } from '../src/trace-export.js';

const MARKER = '__tracesift_main_test';

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'tracesift-export-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function spoolFile(directory, trace) {
  const path = join(directory, 'trace.spool');
  await writeFile(path, typeof trace === 'string' ? trace : JSON.stringify(trace));
  return path;
}

function markerEvent(overrides = {}) {
  return { name: MARKER, cat: 'blink.user_timing', ph: 'R', pid: 7, tid: 11, ts: 1234, ...overrides };
}

async function exported(directory, spool, options = {}) {
  const destination = join(directory, 'Trace.json.gz');
  const written = await writeTraceExport({ spool, destination, metadata: { enhancedTraceVersion: 1 }, ...options });
  return { written, document: JSON.parse(gunzipSync(await readFile(destination)).toString('utf8')) };
}

test('a spooled trace is rewritten as a gzipped enhanced trace', async (t) => {
  const directory = await temporaryDirectory(t);
  const spool = await spoolFile(directory, { traceEvents: [markerEvent(), { name: 'RunTask', ph: 'X', pid: 7, tid: 11, ts: 2000, dur: 5 }] });
  const { written, document } = await exported(directory, spool);

  assert.equal(written.eventCount, 2);
  assert.ok(written.sizeBytes > 0);
  assert.equal(document.metadata.enhancedTraceVersion, 1);
  assert.equal(document.traceEvents.length, 2);
  assert.equal(document.traceEvents[1].name, 'RunTask');
});

test('a bare trace-event array is accepted as well as Chrome’s wrapper object', async (t) => {
  const directory = await temporaryDirectory(t);
  const spool = await spoolFile(directory, [markerEvent()]);
  const { document } = await exported(directory, spool);
  assert.equal(document.traceEvents.length, 1);
});

test('frame metadata is rebuilt only when Chrome withheld its own', async (t) => {
  const directory = await temporaryDirectory(t);
  const mainFrame = { id: 'FRAME-1', url: '', name: 'main' };

  const withoutSpool = await spoolFile(directory, { traceEvents: [markerEvent()] });
  const rebuilt = await exported(directory, withoutSpool, { mainFrame, traceMarker: MARKER, fallbackUrl: 'https://example.com/app' });
  const synthetic = rebuilt.document.traceEvents[0];
  assert.equal(synthetic.name, 'TracingStartedInBrowser');
  assert.equal(synthetic.pid, 7);
  assert.equal(synthetic.ts, 1234);
  // The frame reported no URL of its own, so the recorded target stands in.
  assert.equal(synthetic.args.data.frames[0].url, 'https://example.com/app');
  assert.equal(rebuilt.written.eventCount, 2, 'the injected event is counted');

  await rm(join(directory, 'Trace.json.gz'));
  const withSpool = await spoolFile(join(directory), { traceEvents: [
    { name: 'TracingStartedInBrowser', ph: 'I', pid: 7, tid: 11, ts: 1, args: { data: { persistentIds: true, frames: [{ frame: 'FRAME-0', url: 'https://example.com/' }] } } },
    markerEvent(),
  ] });
  const untouched = await exported(directory, withSpool, { mainFrame, traceMarker: MARKER });
  assert.equal(untouched.document.traceEvents.length, 2);
  assert.equal(untouched.document.traceEvents[0].name, 'TracingStartedInBrowser');
  assert.equal(untouched.document.traceEvents[0].ts, 1, 'Chrome’s own metadata is preserved');
});

test('a TracingStartedInBrowser that names no frames does not suppress the rebuilt one', async (t) => {
  const directory = await temporaryDirectory(t);
  // Tracing started before any navigation emits this empty marker. Trusting
  // its name alone would leave the export with no frame information at all.
  const spool = await spoolFile(directory, { traceEvents: [
    { name: 'TracingStartedInBrowser', cat: 'disabled-by-default-devtools.timeline', ph: 'I', args: {}, pid: 1, tid: 2, ts: 5 },
    markerEvent(),
  ] });
  const { document } = await exported(directory, spool, {
    mainFrame: { id: 'FRAME-1', url: 'https://example.com/', name: '' },
    traceMarker: MARKER,
  });
  const rebuilt = document.traceEvents[0];
  assert.deepEqual(rebuilt.args.data.frames[0].frame, 'FRAME-1');
  assert.equal(rebuilt.ts, 1234, 'the rebuilt event sits at the renderer-main marker');
});

test('JSON punctuation inside strings does not confuse the event scanner', async (t) => {
  const directory = await temporaryDirectory(t);
  const spool = await spoolFile(directory, { traceEvents: [
    { name: 'A', args: { text: 'a ] } [ { \\" brace' } },
    { name: 'B', args: { text: '}]' } },
  ] });
  const { written, document } = await exported(directory, spool);
  assert.equal(written.eventCount, 2);
  assert.equal(document.traceEvents[0].args.text, 'a ] } [ { \\" brace');
  assert.equal(document.traceEvents[1].name, 'B');
});

test('a truncated trace stream is rejected rather than silently exported', async (t) => {
  const directory = await temporaryDirectory(t);
  const spool = await spoolFile(directory, '{"traceEvents":[{"name":"A"}');
  await assert.rejects(exported(directory, spool), /incomplete trace stream/);
});

test('a stream without a traceEvents array is rejected', async (t) => {
  const directory = await temporaryDirectory(t);
  const spool = await spoolFile(directory, '{"metadata":{}}');
  await assert.rejects(exported(directory, spool), /incomplete trace stream/);
});

test('the marker scan reports inspector metadata and the marker location', async (t) => {
  const directory = await temporaryDirectory(t);
  const spool = await spoolFile(directory, { traceEvents: [markerEvent({ pid: 3, tid: 4, ts: 99 })] });
  const result = await inspectTraceMetadata(spool, MARKER);
  assert.equal(result.hasInspectorMetadata, false);
  assert.deepEqual(result.marker, { pid: 3, tid: 4, ts: 99 });
});

test('events split across read boundaries are still copied intact', async (t) => {
  const directory = await temporaryDirectory(t);
  // Comfortably larger than one 64 KB read, so the scanner must carry state.
  const events = Array.from({ length: 2000 }, (_, index) => ({ name: `Event${index}`, ph: 'X', pid: 7, tid: 11, ts: index, args: { payload: 'x'.repeat(64) } }));
  const spool = await spoolFile(directory, { traceEvents: events });
  const { written, document } = await exported(directory, spool);
  assert.equal(written.eventCount, 2000);
  assert.equal(document.traceEvents.length, 2000);
  assert.equal(document.traceEvents.at(-1).name, 'Event1999');
});

test('copyTraceEvents streams into any writable without buffering the document', async (t) => {
  const directory = await temporaryDirectory(t);
  const spool = await spoolFile(directory, { traceEvents: [{ name: 'A' }, { name: 'B' }] });
  const chunks = [];
  const sink = { write(chunk) { chunks.push(Buffer.from(chunk)); return true; }, once() {} };
  const count = await copyTraceEvents(spool, sink);
  assert.equal(count, 2);
  assert.deepEqual(JSON.parse(`[${Buffer.concat(chunks).toString('utf8')}]`), [{ name: 'A' }, { name: 'B' }]);
});
