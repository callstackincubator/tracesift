import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { rename, rm, stat } from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

const MAX_TRACE_PREFIX_BYTES = 1024 * 1024;
const MAX_INSPECTED_EVENT_BYTES = 512 * 1024;

/** @typedef {{ id: string, url: string, name: string }} MainFrame */
/** @typedef {{ pid: number, tid: number, ts: number }} TraceMarkerLocation */

async function writeWithBackpressure(stream, chunk) {
  if (!stream.write(chunk)) await new Promise((resolveDrain) => stream.once('drain', resolveDrain));
}

/**
 * Locate the opening bracket of the trace-event array in a spooled prefix.
 *
 * The stream can be either a bare trace-event array or Chrome's usual
 * {"traceEvents":[...]} object.
 */
function traceEventsOpening(text) {
  const first = text.search(/\S/);
  if (first >= 0 && text[first] === '[') return first;
  const marker = text.indexOf('"traceEvents"');
  return marker >= 0 ? text.indexOf('[', marker + 13) : -1;
}

/**
 * Copy only the traceEvents array body from Chrome's JSON trace stream.
 *
 * ReturnAsStream still produces one valid JSON document. We never parse or
 * retain its events: this small byte-level state machine locates the array and
 * streams its contents into the enhanced-trace wrapper. JSON punctuation is
 * ASCII, so scanning bytes remains correct across UTF-8 and input boundaries.
 *
 * @param {string} spool
 * @param {NodeJS.WritableStream} output
 * @returns {Promise<number>} the number of events copied
 */
export async function copyTraceEvents(spool, output) {
  let prefix = Buffer.alloc(0);
  let started = false;
  let ended = false;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let objectDepth = 0;
  let eventCount = 0;

  const copyArrayBytes = async (bytes) => {
    const sliceStart = 0;
    for (let index = 0; index < bytes.length; index += 1) {
      const byte = bytes[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (byte === 0x5c) escaped = true;
        else if (byte === 0x22) inString = false;
        continue;
      }
      if (byte === 0x22) inString = true;
      else if (byte === 0x5b) depth += 1;
      else if (byte === 0x7b) {
        if (depth === 1 && objectDepth === 0) eventCount += 1;
        objectDepth += 1;
      }
      else if (byte === 0x7d) objectDepth -= 1;
      else if (byte === 0x5d) {
        depth -= 1;
        if (depth === 0) {
          if (index > sliceStart) await writeWithBackpressure(output, bytes.subarray(sliceStart, index));
          ended = true;
          return;
        }
      }
    }
    if (bytes.length > sliceStart) await writeWithBackpressure(output, bytes.subarray(sliceStart));
  };

  for await (const value of createReadStream(spool)) {
    if (ended) break;
    let chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (!started) {
      prefix = Buffer.concat([prefix, chunk]);
      if (prefix.byteLength > MAX_TRACE_PREFIX_BYTES) throw new Error('Chrome trace is missing a traceEvents array near its start.');
      const text = prefix.toString('utf8');
      const opening = traceEventsOpening(text);
      if (opening < 0) continue;
      chunk = prefix.subarray(Buffer.byteLength(text.slice(0, opening + 1), 'utf8'));
      prefix = Buffer.alloc(0);
      started = true;
      depth = 1;
    }
    await copyArrayBytes(chunk);
  }
  if (!started || !ended || inString || depth !== 0 || objectDepth !== 0) throw new Error('Chrome returned an incomplete trace stream.');
  return eventCount;
}

/**
 * Does this event actually identify the frames the trace belongs to?
 *
 * The name alone is not enough. Tracing started on the browser target before
 * any navigation emits a TracingStartedInBrowser whose args are empty, and
 * treating that as metadata would suppress the rebuilt record and leave the
 * export with no frame information at all.
 */
function describesFrames(event) {
  const name = String(event.name);
  if (name === 'CpuProfile' || name === 'TracingStartedInPage') return true;
  if (name !== 'TracingStartedInBrowser') return false;
  const frames = event.args?.data?.frames;
  return Array.isArray(frames) && frames.length > 0;
}

/**
 * Scan the spooled trace for inspector metadata and the renderer-main marker.
 *
 * @param {string} spool
 * @param {string} traceMarker
 * @returns {Promise<{ hasInspectorMetadata: boolean, marker?: TraceMarkerLocation }>}
 */
export async function inspectTraceMetadata(spool, traceMarker) {
  let prefix = Buffer.alloc(0);
  let started = false;
  let depth = 0;
  let objectDepth = 0;
  let inString = false;
  let escaped = false;
  let eventParts = [];
  let eventBytes = 0;
  let eventOverflow = false;
  let capturingEvent = false;
  let hasInspectorMetadata = false;

  const inspectEvent = () => {
    if (eventOverflow) return undefined;
    try {
      const event = JSON.parse(Buffer.concat(eventParts, eventBytes).toString('utf8'));
      if (describesFrames(event)) hasInspectorMetadata = true;
      if (event.name === traceMarker && typeof event.pid === 'number' && typeof event.tid === 'number' && typeof event.ts === 'number' && Number.isFinite(event.pid) && Number.isFinite(event.tid) && Number.isFinite(event.ts)) {
        return { pid: Number(event.pid), tid: Number(event.tid), ts: Number(event.ts) };
      }
    } catch { /* A malformed event is rejected later by the full stream copier. */ }
    return undefined;
  };

  for await (const value of createReadStream(spool)) {
    let chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (!started) {
      prefix = Buffer.concat([prefix, chunk]);
      if (prefix.byteLength > MAX_TRACE_PREFIX_BYTES) break;
      const text = prefix.toString('utf8');
      const opening = traceEventsOpening(text);
      if (opening < 0) continue;
      chunk = prefix.subarray(Buffer.byteLength(text.slice(0, opening + 1), 'utf8'));
      prefix = Buffer.alloc(0);
      started = true;
      depth = 1;
    }

    let eventStart = capturingEvent ? 0 : -1;
    for (let index = 0; index < chunk.length; index += 1) {
      const byte = chunk[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (byte === 0x5c) escaped = true;
        else if (byte === 0x22) inString = false;
      } else if (byte === 0x22) inString = true;
      else if (byte === 0x5b) depth += 1;
      else if (byte === 0x5d) depth -= 1;
      else if (byte === 0x7b) {
        if (depth === 1 && objectDepth === 0) {
          eventStart = index;
          eventParts = [];
          eventBytes = 0;
          eventOverflow = false;
          capturingEvent = true;
        }
        objectDepth += 1;
      } else if (byte === 0x7d) {
        objectDepth -= 1;
        if (depth === 1 && objectDepth === 0 && eventStart >= 0) {
          const part = chunk.subarray(eventStart, index + 1);
          eventBytes += part.byteLength;
          if (eventBytes <= MAX_INSPECTED_EVENT_BYTES) eventParts.push(part);
          else eventOverflow = true;
          const marker = inspectEvent();
          if (marker) return { hasInspectorMetadata, marker };
          eventStart = -1;
          capturingEvent = false;
        }
      }
    }
    if (eventStart >= 0) {
      const part = chunk.subarray(eventStart);
      eventBytes += part.byteLength;
      if (eventBytes <= MAX_INSPECTED_EVENT_BYTES) eventParts.push(part);
      else eventOverflow = true;
    }
  }
  return { hasInspectorMetadata };
}

/**
 * Chrome 156+ intentionally removes browser-process metadata from traces
 * started over the debugger protocol. When the trace carries no inspector
 * metadata of its own, rebuild the equivalent frame metadata from the
 * renderer-main marker the recorder left behind.
 */
function syntheticFrameMetadata(traceMetadata, mainFrame, fallbackUrl) {
  if (traceMetadata.hasInspectorMetadata || !traceMetadata.marker || !mainFrame) return undefined;
  return {
    name: 'TracingStartedInBrowser',
    cat: 'disabled-by-default-devtools.timeline',
    ph: 'I',
    s: 't',
    pid: traceMetadata.marker.pid,
    tid: traceMetadata.marker.tid,
    ts: traceMetadata.marker.ts,
    args: { data: { persistentIds: true, frames: [{
      frame: mainFrame.id,
      url: mainFrame.url || fallbackUrl || '',
      name: mainFrame.name,
      processId: traceMetadata.marker.pid,
      isOutermostMainFrame: true,
      isInPrimaryMainFrame: true,
    }] } },
  };
}

/**
 * Write a spooled Chrome trace out as a gzipped enhanced-trace document.
 *
 * @param {{
 *   spool: string,
 *   destination: string,
 *   metadata: Record<string, unknown>,
 *   mainFrame?: MainFrame,
 *   fallbackUrl?: string,
 *   traceMarker?: string,
 * }} options
 * @returns {Promise<{ sizeBytes: number, eventCount: number }>}
 */
export async function writeTraceExport(options) {
  const { spool, destination, metadata, mainFrame, fallbackUrl, traceMarker } = options;
  const temporary = `${destination}.${randomUUID()}.tmp`;
  const output = createWriteStream(temporary, { flags: 'wx', mode: 0o600 });
  const gzip = createGzip({ level: 6 });
  gzip.pipe(output);
  const traceMetadata = traceMarker ? await inspectTraceMetadata(spool, traceMarker) : { hasInspectorMetadata: false };
  const synthetic = syntheticFrameMetadata(traceMetadata, mainFrame, fallbackUrl);
  try {
    gzip.write(`{"metadata":${JSON.stringify(metadata)},"traceEvents":[`);
    if (synthetic) gzip.write(`${JSON.stringify(synthetic)},`);
    const eventCount = await copyTraceEvents(spool, gzip);
    gzip.end(']}');
    await finished(output);
    await rename(temporary, destination);
    const info = await stat(destination);
    return { sizeBytes: info.size, eventCount: eventCount + (synthetic ? 1 : 0) };
  } finally {
    await rm(temporary, { force: true });
  }
}
