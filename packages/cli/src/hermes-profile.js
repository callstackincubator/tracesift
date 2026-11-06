// Hermes "Tracery" sampling profiles, converted to the CDP profile shape the
// rest of the pipeline already speaks.
//
// `HermesRuntime::dumpSampledTraceToFile` and `dumpSampledTraceToStream` are
// the only sampling-profiler entry points reachable without a jsi::Runtime
// reference, which is what lets a release build be profiled from a plain
// native hook with no JS and no TurboModule. They write Hermes' own Tracery
// format rather than a CDP profile:
//
//   { traceEvents: [...metadata only...],
//     samples: [{ cpu, name, ts, pid, tid, weight, sf }],
//     stackFrames: { "<id>": { name, category, parent?, ... } } }
//
// Hermes' other serializer does emit a CDP profile, but only from
// `IHermes::sampledTraceToStreamInDevToolsFormat`, which is per-runtime. The
// conversion is cheap and lives here, in JS, where it is testable against a
// fixture and fixable without rebuilding anybody's app.

// Hermes' id generator starts at 1 and the first node it allocates is the
// root, which is also the only node emitted without a `parent`.
const ROOT_FRAME_ID = 1;

/** `funcName(file:line:column)`, the name Hermes builds when debug info exists. */
const NAMED_LOCATION = /^(.*)\((.+):(\d+):(\d+)\)$/;

/** Hermes spells the root `[root]`; the analyzer's idle/root handling wants `(root)`. */
const ROOT_FUNCTION_NAME = '(root)';

/**
 * Parse the bytes a Hermes dump produced.
 *
 * An empty body is not corruption: `dumpTraceryTraceGlobal` writes nothing at
 * all when no runtime has a profiler registered, so say what that means.
 *
 * @param {string} text
 */
export function parseTraceryProfile(text) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (trimmed === '') {
    throw new Error('The app returned an empty profile. Hermes writes nothing when no runtime has the sampling profiler registered — reload the app and record again.');
  }
  let raw;
  try {
    raw = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`The app returned a profile that is not JSON: ${error.message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('The app returned a profile that is not a Hermes sampling profile.');
  }
  return raw;
}

/**
 * The thread that did the most sampling.
 *
 * Hermes folds every thread's stacks into one tree and tags only the samples
 * with a `tid`, so a profile can carry the JS thread and whatever else was
 * running. A CDP profile is one thread, and the busiest one is the JS thread
 * in every case we care about.
 *
 * @param {Array<Record<string, unknown>>} samples
 */
function busiestThread(samples) {
  const counts = new Map();
  for (const sample of samples) {
    const tid = String(sample.tid ?? '');
    counts.set(tid, (counts.get(tid) ?? 0) + 1);
  }
  let best = '';
  let bestCount = -1;
  for (const [tid, count] of counts) {
    if (count > bestCount) { best = tid; bestCount = count; }
  }
  return best;
}

/**
 * Build a CDP `callFrame` from one Tracery stack frame.
 *
 * A release bundle carries no debug info, so the common case is a JavaScript
 * frame with `funcVirtAddr` and `offset` and nothing else — no line, no
 * column, and no url, because Tracery never emits one. Hermes generates a
 * bundle's source map against the bytecode virtual offset expressed as a
 * column on line 1, so that is what the frame is given, converted to CDP's
 * zero-based line and column. The url is stamped by the caller, since only it
 * knows which bundle the app is running, and the source map is registered
 * under the same string: symbolication matches the two by exact equality.
 *
 * @param {Record<string, unknown>} frame
 * @param {string} bundleUrl
 */
function callFrameFor(frame, bundleUrl) {
  const name = typeof frame.name === 'string' ? frame.name : '';
  const category = typeof frame.category === 'string' ? frame.category : '';

  if (category === 'root') {
    return { functionName: ROOT_FUNCTION_NAME, scriptId: '0', url: '', lineNumber: -1, columnNumber: -1 };
  }

  if (category !== 'JavaScript') {
    // `[Native] fn`, `[HostFunction] fn`, `[<gc reason>]`, `[multiple]`. The
    // names are already bracketed the way the analyzer's frame naming expects,
    // so they are passed through whole.
    return { functionName: name, scriptId: '0', url: '', lineNumber: -1, columnNumber: -1 };
  }

  // Debug info present: Hermes bakes the location into the name and repeats it
  // in `line`/`column`, both as strings and both one-based.
  if (frame.line !== undefined && frame.column !== undefined) {
    const line = Number(frame.line);
    const column = Number(frame.column);
    const match = NAMED_LOCATION.exec(name);
    return {
      functionName: match ? match[1] : name,
      scriptId: '1',
      url: match ? match[2] : bundleUrl,
      lineNumber: Number.isFinite(line) ? Math.max(-1, line - 1) : -1,
      columnNumber: Number.isFinite(column) ? Math.max(-1, column - 1) : -1,
    };
  }

  const funcVirtAddr = Number(frame.funcVirtAddr);
  const offset = Number(frame.offset);
  const position = (Number.isFinite(funcVirtAddr) ? funcVirtAddr : 0) + (Number.isFinite(offset) ? offset : 0);
  return {
    functionName: name,
    scriptId: '1',
    url: bundleUrl,
    lineNumber: 0,
    columnNumber: position,
  };
}

/**
 * Convert a parsed Hermes Tracery profile into the CDP profile shape
 * `cpuProfileToTraceEvents` takes.
 *
 * Timestamps are microseconds on a steady clock — boot time on Android, the
 * mach origin on Darwin — so they are only meaningful relative to each other.
 * The first sample becomes the origin and the rest become deltas, which is
 * what the analyzer reads anyway; it recomputes `endTime` from their sum.
 *
 * @param {Record<string, unknown>} raw a parsed Tracery profile
 * @param {{ bundleUrl?: string }} [options]
 * @returns {{ nodes: object[], samples: number[], timeDeltas: number[], startTime: number }}
 */
export function traceryToCpuProfile(raw, { bundleUrl = '' } = {}) {
  const stackFrames = raw.stackFrames && typeof raw.stackFrames === 'object' ? raw.stackFrames : null;
  const rawSamples = Array.isArray(raw.samples) ? raw.samples : null;
  if (!stackFrames || !rawSamples) {
    throw new Error('The app returned a profile with no stackFrames or samples. This is not a Hermes sampling profile.');
  }
  if (rawSamples.length === 0) {
    throw new Error('The app returned a profile with no samples. The sampling profiler was enabled but nothing ran — record for longer, or make sure the app is in the foreground.');
  }

  // Every thread shares the frame tree, so the whole table is carried over and
  // the samples decide which of it is reachable. The root goes first, which is
  // what a CDP profile's consumers expect.
  const nodes = [];
  for (const [key, frame] of Object.entries(stackFrames)) {
    if (!frame || typeof frame !== 'object') continue;
    const id = Number(key);
    if (!Number.isFinite(id)) continue;
    const parent = typeof frame.parent === 'number' ? frame.parent : Number(frame.parent);
    nodes.push({
      id,
      callFrame: callFrameFor(frame, bundleUrl),
      ...(Number.isFinite(parent) ? { parent } : {}),
    });
  }
  if (nodes.length === 0) throw new Error('The app returned a profile with an empty stack frame table.');
  nodes.sort((a, b) => (a.id === ROOT_FRAME_ID ? -1 : b.id === ROOT_FRAME_ID ? 1 : a.id - b.id));

  const tid = busiestThread(rawSamples);
  const samples = [];
  const timestamps = [];
  for (const sample of rawSamples) {
    if (String(sample.tid ?? '') !== tid) continue;
    // `sf` is a number while the stackFrames keys are decimal strings; the
    // node ids above are numbers, so this needs no translation beyond Number.
    const sf = Number(sample.sf);
    const ts = Number(sample.ts);
    if (!Number.isFinite(sf) || !Number.isFinite(ts)) continue;
    samples.push(sf);
    timestamps.push(ts);
  }
  if (samples.length === 0) {
    throw new Error('The app returned a profile whose samples carry no usable stack frame ids.');
  }

  const startTime = timestamps[0];
  const timeDeltas = timestamps.map((ts, index) => (index === 0 ? 0 : Math.max(0, ts - timestamps[index - 1])));

  return { nodes, samples, timeDeltas, startTime };
}
