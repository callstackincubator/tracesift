// Recording a release build, which has no Metro and no inspector target.
//
// The debug path attaches to the Metro inspector proxy and drives CDP
// `Tracing.*`. A release build registers no target there, so there is nothing
// to attach to — and making one appear means rebuilding React Native from
// source, which on Android is not reachable at all from the published AAR.
//
// Instead the app carries @callstack/tracesift-rn-profiler, which drives
// Hermes' process-global sampling profiler and dials us. Everything after the
// profile arrives is shared with the Metro path: the same trace-event writer,
// the same sink, the same export envelope.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { parseTraceryProfile, traceryToCpuProfile } from './hermes-profile.js';
import { errorText, resolveSink } from './record-session.js';
import { cpuProfileToTraceEvents } from './record-rn-session.js';
import { writeRecordState } from './record-state.js';
import { awaitProfilerApp, DEFAULT_PROFILER_PORT, describeProfilerApp } from './rn-profiler-link.js';
import { createTraceEventWriter } from './trace-chunker.js';

const MAX_UPLOAD_BYTES = 192 * 1024;
const STOP_POLL_MS = 1000;
const FLUSH_TIMEOUT_MS = 120_000;
const SAMPLING_HZ = 1000;
// Without its `sourcesContent` a Metro map is a few MB; with it, a copy of the
// whole app. The debug path applies the same limit after stripping.
const MAX_SOURCE_MAP_BYTES = 48 * 1024 * 1024;

/**
 * Where the React Native Gradle plugin puts a release bundle's source map.
 * It is derived from the variant name, so the common ones are tried in turn.
 */
const GRADLE_SOURCE_MAP_PATHS = [
  'android/app/build/generated/sourcemaps/react/release/index.android.bundle.map',
  'android/app/build/generated/sourcemaps/react/profiling/index.android.bundle.map',
];

/**
 * Load the source map for the bundle the app reported.
 *
 * There is no Metro to fetch it from, so it comes off disk: the path the user
 * gave, or the deterministic one the Gradle plugin writes. It is registered
 * under the same url the converter stamps onto frames, because symbolication
 * matches the two by exact string equality.
 *
 * @param {{ bundleUrl: string, sourceMapPath?: string, cwd?: string }} options
 * @returns {Promise<{ retained: object[], warnings: string[] }>}
 */
export async function loadReleaseSourceMap({ bundleUrl, sourceMapPath, cwd = process.cwd() }) {
  const warnings = [];
  const candidates = sourceMapPath ? [resolve(cwd, sourceMapPath)] : GRADLE_SOURCE_MAP_PATHS.map((path) => resolve(cwd, path));

  for (const path of candidates) {
    let raw;
    try {
      raw = await readFile(path, 'utf8');
    } catch (error) {
      // Only an explicit --source-map is worth complaining about; the Gradle
      // guesses are guesses, and the catch-all below covers them.
      if (sourceMapPath) warnings.push(`Could not read the source map ${path}: ${errorText(error)}`);
      continue;
    }
    try {
      const sourceMap = JSON.parse(raw);
      if (!sourceMap || typeof sourceMap !== 'object' || Array.isArray(sourceMap)) throw new Error('not a JSON object');
      delete sourceMap.sourcesContent;
      const size = JSON.stringify(sourceMap).length;
      if (size > MAX_SOURCE_MAP_BYTES) throw new Error(`is ${Math.round(size / 1048576)} MB without its sources, past the retention limit`);
      return { retained: [{ url: bundleUrl, sourceMapUrl: path, sourceMap }], warnings };
    } catch (error) {
      warnings.push(`Could not retain the source map ${path}: ${errorText(error)}`);
    }
  }

  warnings.push(`React Native frames are reported at bundle positions in ${bundleUrl}; no source map was found. Pass --source-map to symbolicate them.`);
  return { retained: [], warnings };
}

/** The record.json shape both the starting and recording states share. */
function recordState(home, sink, target, state, extra = {}) {
  return writeRecordState(home, {
    apiVersion: 1,
    pid: process.pid,
    mode: sink.mode,
    state,
    startedAt: Date.now(),
    url: target.url,
    targetLabel: target.title,
    captureId: sink.captureId,
    ...(sink.baseUrl ? { baseUrl: sink.baseUrl } : {}),
    ...(sink.directory ? { directory: sink.directory } : {}),
    ...extra,
  });
}

/**
 * Read `profile` messages until the app marks one last, and reassemble them.
 *
 * Hermes hands the whole dump over at once and it is megabytes, so it arrives
 * base64 in ordered pieces. The sequence numbers are checked rather than
 * trusted: a silently dropped chunk would become a truncated profile, which
 * parses into a plausible-looking lie.
 *
 * @param {{ next(): Promise<Record<string, unknown>> }} channel
 */
async function readProfile(channel, requestId) {
  const pieces = [];
  for (;;) {
    const message = await channel.next();
    if (message.type === 'error') {
      throw new Error(`The app could not produce a profile: ${message.message ?? 'no reason given'}`);
    }
    if (message.type !== 'profile' || message.id !== requestId) continue;
    const sequence = Number(message.seq);
    if (sequence !== pieces.length) {
      throw new Error(`The app sent profile chunk ${sequence} where ${pieces.length} was expected, so the profile is incomplete.`);
    }
    pieces.push(typeof message.data === 'string' ? message.data : '');
    if (message.last === true) break;
  }
  return Buffer.from(pieces.join(''), 'base64').toString('utf8');
}

/**
 * Record a Hermes CPU profile from a release build carrying the profiler
 * package.
 *
 * @param {{
 *   home: string,
 *   profilerPort?: number,
 *   sourceMapPath?: string,
 *   sourceMaps?: boolean,
 *   out?: string,
 *   duration?: number,
 *   sink?: 'auto' | 'ingest' | 'local',
 *   link?: { channel: object, hello: Record<string, unknown>, close(): void },
 *   onReady?: (info: { captureId: string, mode: string }) => void,
 * }} options
 */
export async function runRnReleaseRecording(options) {
  const { home } = options;
  const port = options.profilerPort ?? DEFAULT_PROFILER_PORT;
  let link = options.link ?? null;
  let sink;
  let target = { platform: 'react-native', title: 'React Native app', url: `http://127.0.0.1:${port}` };
  let stopReason = 'manual';
  const warnings = [];
  let releaseStopWatchers = () => {};

  try {
    link ??= await awaitProfilerApp({ port });
    const { channel, hello } = link;
    const bundleUrl = typeof hello.bundle === 'string' && hello.bundle ? hello.bundle : 'index.android.bundle';

    target = {
      platform: 'react-native',
      title: describeProfilerApp(hello),
      url: `http://127.0.0.1:${port}`,
      ...(typeof hello.app === 'string' ? { appId: hello.app } : {}),
      ...(typeof hello.device === 'string' ? { deviceName: hello.device } : {}),
    };

    sink = await resolveSink(home, target, target.title, options);
    await recordState(home, sink, target, 'starting');
    await sink.status({ state: 'attaching' }).catch(() => undefined);

    const writer = createTraceEventWriter(sink, { maxBytes: MAX_UPLOAD_BYTES });
    const requestId = 1;
    channel.send({ type: 'start', id: requestId, hz: SAMPLING_HZ });

    await recordState(home, sink, target, 'recording');
    await sink.status({ state: 'recording' }).catch(() => undefined);
    options.onReady?.({ captureId: sink.captureId, mode: sink.mode });

    let stop;
    const stopped = new Promise((resolve_) => { stop = (reason) => { stopReason = reason; resolve_(reason); }; });
    const onSignal = () => stop('manual');
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    const durationTimer = options.duration ? setTimeout(() => stop('manual'), options.duration) : null;
    const poller = setInterval(() => {
      void sink.stopRequested().then((requested) => { if (requested) stop('manual'); }).catch(() => undefined);
    }, STOP_POLL_MS);
    releaseStopWatchers = () => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      if (durationTimer) clearTimeout(durationTimer);
      clearInterval(poller);
    };

    await stopped;
    await sink.status({ state: 'flushing', stopReason }).catch(() => undefined);

    let text;
    try {
      channel.send({ type: 'stop', id: requestId });
      let flushTimer;
      const flushDeadline = new Promise((_resolve, reject) => {
        flushTimer = setTimeout(() => reject(new Error('The app did not finish sending the profile in time.')), FLUSH_TIMEOUT_MS);
        flushTimer.unref?.();
      });
      flushDeadline.catch(() => undefined);
      try {
        text = await Promise.race([readProfile(channel, requestId), flushDeadline]);
      } finally {
        clearTimeout(flushTimer);
      }
    } finally {
      releaseStopWatchers();
    }

    const profile = traceryToCpuProfile(parseTraceryProfile(text), { bundleUrl });
    await writer.write(cpuProfileToTraceEvents(profile));
    await writer.end();

    await sink.status({ state: 'enriching' }).catch(() => undefined);
    const collected = options.sourceMaps === false
      ? { retained: [], warnings: [] }
      : await loadReleaseSourceMap({ bundleUrl, sourceMapPath: options.sourceMapPath });
    warnings.push(...collected.warnings);

    // The Hermes sampler reports nothing about tasks or frames, so unlike the
    // Metro path there is no TracingStartedInPage for the exporter to lean on.
    const result = await sink.finalize({
      dataLoss: false,
      stopReason,
      scripts: [],
      sourceMaps: collected.retained,
      warnings,
    });

    await recordState(home, sink, target, 'captured', {
      export: { path: result.path ?? '', sizeBytes: result.sizeBytes, eventCount: result.eventCount },
      warnings: result.warnings ?? warnings,
    });
    return { ...result, mode: sink.mode, captureId: sink.captureId, baseUrl: sink.baseUrl };
  } catch (error) {
    const message = errorText(error);
    await sink?.fail(message).catch(() => undefined);
    await writeRecordState(home, {
      apiVersion: 1,
      pid: process.pid,
      mode: sink?.mode ?? 'local',
      state: 'failed',
      startedAt: Date.now(),
      url: target.url,
      targetLabel: target.title,
      ...(sink?.captureId ? { captureId: sink.captureId } : {}),
      error: message,
    }).catch(() => undefined);
    throw error;
  } finally {
    releaseStopWatchers();
    link?.close();
  }
}
