import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { connectCdp, readProtocolStream } from './cdp.js';
import { findChrome, launchChrome } from './chrome.js';
import { createIngestSink, createLocalSink } from './record-sink.js';
import { liveBrowserState, writeRecordState } from './record-state.js';
import { readActiveService } from './service.js';

const SAFE_BUFFER_LIMIT = 0.9;
// Keep each upload well under the ingest route's 1 MB cap even when every
// code unit Chrome returns expands to four UTF-8 bytes.
const MAX_UPLOAD_BYTES = 192 * 1024;
const MAX_SOURCE_MAP_BYTES = 8 * 1024 * 1024;
const MAX_ALL_SOURCE_MAP_BYTES = 16 * 1024 * 1024;
const STOP_POLL_MS = 1000;

const TRACE_CATEGORIES = [
  '-*',
  'blink.console',
  'blink.user_timing',
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'disabled-by-default-devtools.timeline.stack',
  'disabled-by-default-v8.cpu_profiler',
  'disabled-by-default-v8.cpu_profiler.hires',
  'disabled-by-default-v8.source_rundown',
  'disabled-by-default-v8.source_rundown_sources',
  'latencyInfo',
  'loading',
  'toplevel',
  'v8.execute',
].join(',');

function errorText(error) {
  return error instanceof Error ? error.message : String(error || 'Unknown recording error.');
}

function sourceMapBasename(value) {
  const clean = (value || '').split(/[?#]/)[0];
  return clean.slice(clean.lastIndexOf('/') + 1);
}

// A bundled module's own `//# sourceMappingURL` comment can survive
// concatenation, and Chrome reports the last comment it finds in a script. Such
// a name points at a file the bundler never emitted, so failing to load it says
// nothing about whether the bundle itself has a retrievable map.
function sourceMapBelongsToScript(scriptUrl, sourceMapUrl) {
  const script = sourceMapBasename(scriptUrl);
  const map = sourceMapBasename(sourceMapUrl).replace(/\.map$/, '');
  if (!script || !map) return true;
  return script.startsWith(map) || map.startsWith(script);
}

function decodeDataUrl(url) {
  const comma = url.indexOf(',');
  if (comma < 0) throw new Error('Malformed source-map data URL.');
  const header = url.slice(0, comma);
  const payload = url.slice(comma + 1);
  return header.includes(';base64') ? Buffer.from(payload, 'base64').toString('utf8') : decodeURIComponent(payload);
}

function resolveSourceMapUrl(script) {
  return new URL(script.sourceMapURL, script.url || undefined).href;
}

function sourceMapLoadFailure(resource, sourceMapUrl) {
  const details = [];
  if (Number.isInteger(resource?.httpStatusCode)) details.push(`HTTP ${resource.httpStatusCode}`);
  if (resource?.netErrorName) details.push(resource.netErrorName);
  return new Error(details.length > 0 ? `${sourceMapUrl} returned ${details.join('; ')}` : `Could not load ${sourceMapUrl}`);
}

/**
 * Keep renderer page metadata active and follow every child execution context.
 * Failures are tolerated: a target can detach between attach and configuration.
 */
async function configureSession(cdp, sessionId) {
  await cdp.send('Page.enable', {}, sessionId).catch(() => undefined);
  await cdp.send('Debugger.enable', {}, sessionId).catch(() => undefined);
  await cdp.send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
    filter: [
      { type: 'iframe', exclude: false },
      { type: 'worker', exclude: false },
      { type: 'shared_worker', exclude: false },
      { type: 'service_worker', exclude: false },
    ],
  }, sessionId).catch(() => undefined);
}

async function mainFrameOf(cdp, sessionId) {
  try {
    const result = await cdp.send('Page.getFrameTree', {}, sessionId);
    const frame = result.frameTree?.frame;
    if (!frame || typeof frame.id !== 'string') return undefined;
    return { id: frame.id, url: frame.url || '', name: frame.name || '' };
  } catch { return undefined; }
}

/** Wait for Chrome to report a page target it is willing to let us attach to. */
async function pageTarget(cdp) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const { targetInfos = [] } = await cdp.send('Target.getTargets');
    const page = targetInfos.find((target) => target.type === 'page' && !/^(chrome|chrome-extension|devtools):/.test(target.url || ''));
    if (page) return page;
    if (Date.now() > deadline) throw new Error('Chrome did not open a page to record.');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Retain source maps for the scripts Chrome reported, mirroring what DevTools
 * embeds in an enhanced trace so authored names survive an offline import.
 */
function sourceMapCollector(cdp) {
  const entries = new Map();
  const warnings = [];
  let queue = Promise.resolve();
  let bytes = 0;
  let limitReached = false;

  async function load(script, sourceMapUrl) {
    if (!script.url || !script.sourceMapURL || script.url.startsWith('chrome-extension:')) return null;
    let raw;
    if (sourceMapUrl.startsWith('data:')) {
      raw = decodeDataUrl(sourceMapUrl);
    } else {
      const result = await cdp.send('Network.loadNetworkResource', {
        ...(script.frameId ? { frameId: script.frameId } : {}),
        url: sourceMapUrl,
        options: { disableCache: false, includeCredentials: true },
      }, script.sessionId);
      if (!result.resource?.success || !result.resource.stream) throw sourceMapLoadFailure(result.resource, sourceMapUrl);
      raw = await readProtocolStream(cdp, result.resource.stream, { sessionId: script.sessionId, limitBytes: MAX_SOURCE_MAP_BYTES });
    }
    if (raw.length > MAX_SOURCE_MAP_BYTES) throw new Error('Source map exceeds the 8 MB retention limit.');
    const sourceMap = JSON.parse(raw);
    if (!sourceMap || typeof sourceMap !== 'object' || Array.isArray(sourceMap)) throw new Error('Source map is not a JSON object.');
    return { url: script.url, sourceMapUrl, sourceMap, bytes: raw.length };
  }

  async function retain(entry) {
    if (entry.retained || limitReached) return;
    try {
      const loaded = await load(entry.script, entry.sourceMapUrl);
      if (!loaded) return;
      if (bytes + loaded.bytes > MAX_ALL_SOURCE_MAP_BYTES) {
        limitReached = true;
        warnings.push('Stopped retaining source maps after the 16 MB safety limit.');
        return;
      }
      bytes += loaded.bytes;
      entry.retained = { url: loaded.url, sourceMapUrl: loaded.sourceMapUrl, sourceMap: loaded.sourceMap };
      entry.error = null;
    } catch (error) {
      entry.error = errorText(error);
    }
  }

  return {
    queue(script) {
      if (!script.url || !script.sourceMapURL || script.url.startsWith('chrome-extension:')) return;
      let sourceMapUrl;
      try { sourceMapUrl = resolveSourceMapUrl(script); }
      catch {
        warnings.push(`Ignored an invalid source-map URL for ${script.url || 'an anonymous script'}.`);
        return;
      }
      // DevTools does not duplicate data-URL maps in metadata: source-rundown
      // events already carry their contents in the trace.
      if (sourceMapUrl.startsWith('data:')) return;
      const key = `${script.url}\n${sourceMapUrl}`;
      if (entries.has(key)) return;
      const entry = { script, sourceMapUrl, retained: null, error: null };
      entries.set(key, entry);
      // Serialize reads so eager retention never holds an unbounded number of
      // large maps while still enforcing the aggregate byte limit.
      queue = queue.then(() => retain(entry));
    },
    async collect() {
      await queue;
      // A development server can still be compiling when scriptParsed arrives.
      // Retry eager failures once at finalization, matching DevTools' fallback.
      for (const entry of entries.values()) {
        if (!entry.retained && entry.error && !limitReached) await retain(entry);
      }
      const all = [...warnings];
      for (const entry of entries.values()) {
        if (!entry.retained && entry.error) {
          const script = entry.script.url || 'an anonymous script';
          all.push(sourceMapBelongsToScript(entry.script.url, entry.sourceMapUrl)
            ? `Could not retain source map ${entry.sourceMapUrl} for ${script}: ${entry.error}`
            : `Ignored ${entry.sourceMapUrl}, a stale source-map comment a bundled module left inside ${script}: ${entry.error}`);
        }
      }
      return {
        retained: [...entries.values()].flatMap((entry) => entry.retained ? [entry.retained] : []),
        warnings: [...new Set(all)],
      };
    },
  };
}

/** Choose where the trace goes: a running TraceSift if there is one, else disk. */
async function resolveSink(home, target, title, options) {
  if (options.sink !== 'local') {
    try {
      const service = await readActiveService(home);
      return await createIngestSink(service, target, title);
    } catch (error) {
      if (options.sink === 'ingest') throw error;
    }
  }
  return createLocalSink(home, target, options);
}

/**
 * Record a Chrome performance trace over the DevTools Protocol.
 *
 * Unlike the extension, the trace is started on the page before it is
 * navigated, so page load is inside the recording and Chrome still emits its
 * own browser-process frame metadata.
 *
 * When `record launch` left a browser running the recording attaches to it
 * instead and leaves the page where it is: the point of that browser is to
 * profile a state that took signing in or clicking around to reach, and a
 * navigation would throw it away. Passing `url` still navigates. That browser
 * outlives the recording; only a Chrome started here is shut down here.
 *
 * @param {{
 *   home: string,
 *   url?: string,
 *   chrome?: string,
 *   userDataDir?: string,
 *   out?: string,
 *   duration?: number,
 *   headless?: boolean,
 *   sink?: 'auto' | 'ingest' | 'local',
 *   onReady?: (info: { captureId: string, mode: string }) => void,
 * }} options
 */
export async function runRecording(options) {
  const { home } = options;
  const existing = await liveBrowserState(home);
  const ownsProfile = !existing && !options.userDataDir;
  const userDataDir = options.userDataDir || join(home, 'chrome-profiles', `record-${process.pid}`);

  const launched = existing ? null : await launchChrome({
    executablePath: await findChrome(options.chrome || process.env.CHROME_PATH),
    userDataDir,
    headless: options.headless,
  });
  const webSocketDebuggerUrl = existing?.webSocketDebuggerUrl ?? launched.webSocketDebuggerUrl;
  let cdp;
  let sink;
  let stopReason = 'manual';
  const warnings = [];
  const scripts = new Map();
  const sourceMaps = sourceMapCollector({ send: (...args) => cdp.send(...args) });

  const cleanup = async () => {
    cdp?.close();
    if (!launched) return;
    launched.child.kill('SIGTERM');
    if (ownsProfile) await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
  };

  try {
    cdp = await connectCdp(webSocketDebuggerUrl);
    const page = await pageTarget(cdp);
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    await configureSession(cdp, sessionId);

    const target = { tabId: 0, title: page.title || options.url || 'Chrome performance capture', url: options.url || page.url || '' };
    sink = await resolveSink(home, target, target.title, options);
    const traceMarker = `__tracesift_main_${sink.captureId}`;
    let mainFrame = await mainFrameOf(cdp, sessionId);

    await writeRecordState(home, {
      apiVersion: 1,
      pid: process.pid,
      mode: sink.mode,
      state: 'starting',
      startedAt: Date.now(),
      url: target.url,
      captureId: sink.captureId,
      ...(sink.baseUrl ? { baseUrl: sink.baseUrl } : {}),
      ...(sink.directory ? { directory: sink.directory } : {}),
    });
    await sink.status({ state: 'attaching' }).catch(() => undefined);

    let stop;
    const stopped = new Promise((resolve) => { stop = (reason) => { stopReason = reason; resolve(reason); }; });

    cdp.on((method, params, source) => {
      if (method === 'Target.attachedToTarget') {
        void configureSession(cdp, params.sessionId);
        return;
      }
      if (method === 'Debugger.scriptParsed' && typeof params.scriptId === 'string') {
        if (scripts.size >= 50_000) return;
        const script = {
          scriptId: params.scriptId,
          url: params.url || '',
          ...(params.sourceMapURL ? { sourceMapURL: params.sourceMapURL } : {}),
          ...(typeof params.executionContextAuxData?.frameId === 'string' ? { frameId: params.executionContextAuxData.frameId } : {}),
          ...(source ? { sessionId: source } : {}),
        };
        scripts.set(`${source || 'root'}:${params.scriptId}`, script);
        sourceMaps.queue(script);
        return;
      }
      if (method === 'Tracing.bufferUsage') {
        const usage = Number(params.percentFull ?? params.value ?? 0);
        void sink.status({ bufferUsage: usage, eventCount: Number(params.eventCount || 0) }).catch(() => undefined);
        if (usage >= SAFE_BUFFER_LIMIT) stop('buffer_limit');
      }
    });

    // Tracing is scoped to the page session rather than the browser target.
    // A browser-target trace started before any navigation emits a
    // TracingStartedInBrowser with empty args, which claims to describe the
    // trace's frames and does not; the renderer scope keeps the one metadata
    // path the exporter already knows how to complete.
    await cdp.send('Tracing.start', {
      categories: TRACE_CATEGORIES,
      options: 'record-until-full',
      bufferUsageReportingInterval: 1000,
      transferMode: 'ReturnAsStream',
      streamFormat: 'json',
      streamCompression: 'none',
    }, sessionId);
    // Leave a renderer-main marker anyway: a Chrome that withholds browser
    // metadata still lets the exporter rebuild the equivalent frame record.
    await cdp.send('Runtime.evaluate', {
      expression: `performance.mark(${JSON.stringify(traceMarker)})`,
      returnByValue: true,
    }, sessionId).catch(() => undefined);

    if (options.url) {
      await cdp.send('Page.navigate', { url: options.url }, sessionId);
    }

    await writeRecordState(home, {
      apiVersion: 1,
      pid: process.pid,
      mode: sink.mode,
      state: 'recording',
      startedAt: Date.now(),
      url: target.url,
      captureId: sink.captureId,
      ...(sink.baseUrl ? { baseUrl: sink.baseUrl } : {}),
      ...(sink.directory ? { directory: sink.directory } : {}),
    });
    await sink.status({ state: 'recording' }).catch(() => undefined);
    options.onReady?.({ captureId: sink.captureId, mode: sink.mode });

    const onSignal = () => stop('manual');
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    const durationTimer = options.duration ? setTimeout(() => stop('manual'), options.duration) : null;
    // The web app's Stop button only sets a state; an ingesting recorder has to
    // notice it the same way the extension does.
    const poller = setInterval(() => {
      void sink.stopRequested().then((requested) => { if (requested) stop('manual'); }).catch(() => undefined);
    }, STOP_POLL_MS);

    await stopped;

    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    if (durationTimer) clearTimeout(durationTimer);
    clearInterval(poller);

    await sink.status({ state: 'flushing', stopReason }).catch(() => undefined);
    mainFrame = (await mainFrameOf(cdp, sessionId)) ?? mainFrame;

    const complete = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Chrome did not finish flushing the trace in time.')), 120_000);
      const off = cdp.on((method, params) => {
        if (method !== 'Tracing.tracingComplete') return;
        clearTimeout(timer);
        off();
        resolve(params);
      });
    });
    await cdp.send('Tracing.end', {}, sessionId);
    const finished = await complete;
    if (!finished.stream) throw new Error('Chrome completed tracing without returning a stream.');

    await readProtocolStream(cdp, finished.stream, { sessionId, size: MAX_UPLOAD_BYTES, onChunk: (bytes) => sink.chunk(bytes) });

    await sink.status({ state: 'enriching' }).catch(() => undefined);
    const collected = await sourceMaps.collect();
    warnings.push(...collected.warnings);

    const result = await sink.finalize({
      dataLoss: finished.dataLossOccurred === true,
      stopReason,
      scripts: [...scripts.values()],
      sourceMaps: collected.retained,
      warnings,
      mainFrame,
      traceMarker,
    });

    await writeRecordState(home, {
      apiVersion: 1,
      pid: process.pid,
      mode: sink.mode,
      state: 'captured',
      startedAt: Date.now(),
      url: target.url,
      captureId: sink.captureId,
      ...(sink.baseUrl ? { baseUrl: sink.baseUrl } : {}),
      ...(sink.directory ? { directory: sink.directory } : {}),
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
      url: options.url ?? '',
      ...(sink?.captureId ? { captureId: sink.captureId } : {}),
      error: message,
    }).catch(() => undefined);
    throw error;
  } finally {
    await cleanup();
  }
}

/** Entry point for the detached recorder `tracesift record start` spawns. */
export async function recorderMain(argv) {
  try {
    await runRecording(JSON.parse(argv[0]));
  } catch (error) {
    // The failure is already recorded in record.json for `record stop` and
    // `record status` to report; the log keeps the full text.
    console.error(`tracesift: ${errorText(error)}`);
    process.exitCode = 1;
  }
}
