import { connectCdp } from './cdp.js';
import { defaultMetroOrigin, describeMetroTarget, metroTargets, parseMetroOrigin, selectMetroTarget } from './metro.js';
import { errorText, resolveSink, TRACE_CATEGORIES } from './record-session.js';
import { writeRecordState } from './record-state.js';
import { createTraceEventWriter } from './trace-chunker.js';

const MAX_UPLOAD_BYTES = 192 * 1024;
// A Metro development bundle is one file for the whole app, and its map runs
// past Chrome's 8 MB per-script limit routinely — an Expo starter is already
// over 10 MB. The aggregate limit is what actually bounds the export, and
// there is normally one bundle to retain.
const MAX_SOURCE_MAP_BYTES = 48 * 1024 * 1024;
const MAX_ALL_SOURCE_MAP_BYTES = 64 * 1024 * 1024;
const STOP_POLL_MS = 1000;
const FLUSH_TIMEOUT_MS = 120_000;
const METHOD_NOT_FOUND = -32601;
// A Profiler.stop profile arrives whole. Chunking it keeps each ingest POST
// under the route's 1 MB cap the same way the streamed Chrome path does.
const SAMPLES_PER_CHUNK = 10_000;

/**
 * React Native refuses to trace for three specific reasons, each of which the
 * developer can act on — but only if they are told which one it was. The
 * protocol only gives us the text, so match on it.
 */
function tracingStartFailure(error) {
  const text = errorText(error);
  if (/Debugger domain is expected to be disabled/i.test(text)) {
    return 'A debugger is attached to that app. Close React Native DevTools, then run this again.';
  }
  if (/already been started|already started/i.test(text)) {
    return 'That app is already being profiled. Hermes has one sampler, so stop the recording in React Native DevTools (or close that window) and run this again.';
  }
  if (/host/i.test(text) && /multiple|more than one/i.test(text)) {
    return 'The app has more than one React Native host registered, and React Native will not trace it. Reload the app, then run this again.';
  }
  return null;
}

/**
 * Turn a `Profiler.stop` result into the trace events a `Tracing` recording
 * would have produced, so both routes hand the analyzer one format.
 *
 * @param {{ nodes: unknown[], startTime?: number, endTime?: number, samples?: number[], timeDeltas?: number[] }} profile
 */
export function cpuProfileToTraceEvents(profile, { pid = 1, tid = 1, profileId = '0x1' } = {}) {
  const samples = Array.isArray(profile.samples) ? profile.samples : [];
  const timeDeltas = Array.isArray(profile.timeDeltas) ? profile.timeDeltas : [];
  const startTime = Number(profile.startTime) || 0;
  const events = [{
    name: 'Profile',
    cat: 'disabled-by-default-v8.cpu_profiler',
    ph: 'P',
    pid,
    tid,
    ts: startTime,
    id: profileId,
    args: { data: { startTime } },
  }];
  // The first chunk carries the node table; the rest only extend the samples,
  // which is how V8 emits a long profile and what extractFromTrace expects.
  for (let offset = 0; offset < Math.max(samples.length, 1); offset += SAMPLES_PER_CHUNK) {
    events.push({
      name: 'ProfileChunk',
      cat: 'disabled-by-default-v8.cpu_profiler',
      ph: 'P',
      pid,
      tid,
      ts: startTime,
      id: profileId,
      args: {
        data: {
          cpuProfile: {
            ...(offset === 0 ? { nodes: profile.nodes ?? [] } : {}),
            samples: samples.slice(offset, offset + SAMPLES_PER_CHUNK),
          },
          timeDeltas: timeDeltas.slice(offset, offset + SAMPLES_PER_CHUNK),
        },
      },
    });
  }
  return events;
}

/**
 * Retain the Metro source maps for the bundles a profile's frames came from.
 *
 * Chrome harvests these over `Debugger.scriptParsed`, which React Native
 * cannot offer: enabling the Debugger domain makes `Tracing.start` fail
 * outright. Metro serves the map for a bundle at the same URL with a `.map`
 * extension, so the bundle URLs the profile already carries are enough.
 */
function metroSourceMaps(origin) {
  const seen = new Set();
  const retained = [];
  const warnings = [];
  let bytes = 0;

  // Metro writes a bundle's parameters inside the path rather than the query
  // (`/index.bundle//&platform=ios&dev=true`), and the map is served from the
  // same request with a `.map` extension. So the rewrite has to find `.bundle`
  // where it sits rather than assume it ends the path.
  const mapUrlFor = (bundleUrl) => {
    const url = new URL(bundleUrl);
    const mapped = url.pathname.replace(/\.(bundle|js)(?=$|[/?])/, '.map');
    if (mapped === url.pathname) return null;
    // Expo hands the device a LAN address for the same Metro that discovery
    // reached on loopback, so a frame's bundle URL is routinely
    // `http://192.168.1.5:8081/...` while `origin` is `127.0.0.1:8081`. The
    // port is what identifies the server; the map is then fetched from the
    // loopback origin we already validated rather than from the LAN one, so
    // this never reaches off the machine.
    if (url.port !== origin.port) return null;
    const target = new URL(origin.href);
    target.pathname = mapped;
    target.search = url.search;
    return target;
  };

  return {
    /** Note every bundle URL a batch of trace events mentions. */
    observe(events) {
      for (const event of events) {
        const nodes = event?.args?.data?.cpuProfile?.nodes;
        if (!Array.isArray(nodes)) continue;
        for (const node of nodes) {
          const url = node?.callFrame?.url;
          if (typeof url !== 'string' || !url.startsWith('http')) continue;
          if (seen.size >= 50) return;
          seen.add(url.split('#')[0]);
        }
      }
    },
    async collect() {
      const candidates = new Map();
      for (const bundleUrl of seen) {
        let mapUrl;
        try { mapUrl = mapUrlFor(bundleUrl); }
        catch { continue; }
        if (mapUrl && !candidates.has(mapUrl.href)) candidates.set(mapUrl.href, bundleUrl);
      }
      for (const [mapUrl, bundleUrl] of candidates) {
        if (bytes >= MAX_ALL_SOURCE_MAP_BYTES) {
          warnings.push(`Stopped retaining source maps after the ${MAX_ALL_SOURCE_MAP_BYTES / 1048576} MB safety limit.`);
          break;
        }
        try {
          const response = await fetch(mapUrl, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const raw = await response.text();
          if (raw.length > MAX_SOURCE_MAP_BYTES) throw new Error(`is ${Math.round(raw.length / 1048576)} MB, past the retention limit`);
          const sourceMap = JSON.parse(raw);
          if (!sourceMap || typeof sourceMap !== 'object' || Array.isArray(sourceMap)) throw new Error('not a JSON object');
          bytes += raw.length;
          retained.push({ url: bundleUrl, sourceMapUrl: mapUrl, sourceMap });
        } catch (error) {
          warnings.push(`Could not retain the Metro source map ${mapUrl}: ${errorText(error)}`);
        }
      }
      if (retained.length === 0) {
        warnings.push('React Native frames are reported at bundle positions; no Metro source map was retained.');
      }
      return { retained, warnings: [...new Set(warnings)] };
    },
  };
}

/**
 * Reject as soon as the inspector socket goes away.
 *
 * @param {{ closed: boolean }} cdp
 * @returns {{ promise: Promise<never>, stop(): void }}
 */
function watchDisconnect(cdp) {
  let timer;
  const promise = new Promise((_resolve, reject) => {
    timer = setInterval(() => {
      if (!cdp.closed) return;
      clearInterval(timer);
      reject(new Error('The app disconnected from Metro before the recording finished. Nothing was captured — reload the app and record again.'));
    }, STOP_POLL_MS);
    timer.unref?.();
  });
  // Nothing awaits this promise once the recording has moved on, and an
  // unobserved rejection would take the recorder down with it.
  promise.catch(() => undefined);
  return { promise, stop() { clearInterval(timer); } };
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
 * Record a Hermes CPU profile from an app already running on a simulator,
 * emulator or device, over React Native's Metro inspector proxy.
 *
 * Nothing is launched and no window opens: the app is where the developer put
 * it, so an agent can start and stop a recording without handing control back
 * to a person. The trace is written in the same enhanced-trace envelope the
 * Chrome path produces, because React Native emits the same Profile and
 * ProfileChunk events V8 does.
 *
 * @param {{
 *   home: string,
 *   metro?: string,
 *   app?: string,
 *   device?: string,
 *   targetId?: string,
 *   sourceMaps?: boolean,
 *   out?: string,
 *   duration?: number,
 *   sink?: 'auto' | 'ingest' | 'local',
 *   onReady?: (info: { captureId: string, mode: string }) => void,
 * }} options
 */
export async function runRnRecording(options) {
  const { home } = options;
  const origin = parseMetroOrigin(options.metro || defaultMetroOrigin());
  let cdp;
  let sink;
  let target = { platform: 'react-native', title: 'React Native app', url: origin.href.replace(/\/$/, '') };
  let stopReason = 'manual';
  const warnings = [];
  // Timers and signal handlers that keep the process alive. They are released
  // in the outer `finally`, because the recording can end by rejection at
  // several points between arming them and the ordinary stop.
  let releaseStopWatchers = () => {};

  try {
    const found = await metroTargets(origin);
    const selected = selectMetroTarget(found, {
      app: options.app, device: options.device, targetId: options.targetId, origin,
    });

    target = {
      platform: 'react-native',
      title: describeMetroTarget(selected),
      url: origin.href.replace(/\/$/, ''),
      targetId: selected.id,
      ...(selected.appId ? { appId: selected.appId } : {}),
      ...(selected.deviceName ? { deviceName: selected.deviceName } : {}),
    };

    // The inspector proxy only accepts a socket whose Origin is the Metro
    // server itself. Node's global WebSocket sends no Origin at all, and the
    // handshake is refused without one.
    cdp = await connectCdp(selected.webSocketDebuggerUrl, {
      label: 'The app',
      createSocket: (url) => new WebSocket(url, { headers: { Origin: origin.origin } }),
    });

    sink = await resolveSink(home, target, target.title, options);
    await recordState(home, sink, target, 'starting');
    await sink.status({ state: 'attaching' }).catch(() => undefined);

    const writer = createTraceEventWriter(sink, { maxBytes: MAX_UPLOAD_BYTES });
    const sourceMaps = options.sourceMaps === false ? null : metroSourceMaps(origin);

    let stop;
    const stopped = new Promise((resolve) => { stop = (reason) => { stopReason = reason; resolve(reason); }; });
    let collecting = Promise.resolve();
    let collectError = null;

    // React Native can send dataCollected throughout the recording, so the
    // listener goes on now. Its deadline does not: the flush has not been
    // asked for yet, and a timer started here would cap how long a recording
    // may run rather than how long it may take to finish.
    let completed;
    const complete = new Promise((resolve) => { completed = resolve; });
    cdp.on((method, params) => {
      if (method === 'Tracing.dataCollected') {
        const events = Array.isArray(params.value) ? params.value : [];
        if (events.length === 0) return;
        sourceMaps?.observe(events);
        // Serialize the writes so a burst of notifications cannot queue an
        // unbounded amount of trace data ahead of the sink.
        collecting = collecting.then(() => writer.write(events)).catch((error) => { collectError ??= error; });
        return;
      }
      if (method === 'Tracing.tracingComplete') completed(params);
    });

    // No Debugger.enable, no Page.enable, no Target.setAutoAttach: React
    // Native rejects Tracing.start outright while the Debugger domain is on,
    // and the proxy exposes one flat session, so nothing carries a sessionId.
    let useProfilerFallback = false;
    try {
      await cdp.send('Tracing.start', { categories: TRACE_CATEGORIES, options: 'record-until-full' });
    } catch (error) {
      const mapped = tracingStartFailure(error);
      if (mapped) throw new Error(mapped);
      if (error?.cdpCode !== METHOD_NOT_FOUND) throw error;
      useProfilerFallback = true;
    }
    if (useProfilerFallback) {
      try {
        await cdp.send('Profiler.enable').catch(() => undefined);
        await cdp.send('Profiler.start');
      } catch (error) {
        const mapped = tracingStartFailure(error);
        if (mapped) throw new Error(mapped);
        if (error?.cdpCode === METHOD_NOT_FOUND) {
          throw new Error('That app’s React Native version does not expose a CPU profiler over the Metro inspector. Upgrade React Native, or record with React Native DevTools and analyse the exported profile with `tracesift start`.');
        }
        throw error;
      }
      warnings.push('Recorded with the older Profiler domain; task boundaries are unavailable in this React Native version.');
    }

    await recordState(home, sink, target, 'recording');
    await sink.status({ state: 'recording' }).catch(() => undefined);
    options.onReady?.({ captureId: sink.captureId, mode: sink.mode });

    const onSignal = () => stop('manual');
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    const durationTimer = options.duration ? setTimeout(() => stop('manual'), options.duration) : null;
    const poller = setInterval(() => {
      void sink.stopRequested().then((requested) => { if (requested) stop('manual'); }).catch(() => undefined);
    }, STOP_POLL_MS);
    // An app that is reloaded or killed mid-recording has nothing left to
    // flush, and waiting for a tracingComplete it will never send is worse
    // than saying so. This promise only ever rejects; `stop()` ends the watch.
    const watch = watchDisconnect(cdp);
    releaseStopWatchers = () => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      if (durationTimer) clearTimeout(durationTimer);
      clearInterval(poller);
      watch.stop();
    };

    await Promise.race([stopped, watch.promise]);

    await sink.status({ state: 'flushing', stopReason }).catch(() => undefined);

    let dataLoss = false;
    try {
      if (useProfilerFallback) {
        const { profile } = await cdp.send('Profiler.stop');
        if (!profile) throw new Error('The app stopped profiling without returning a profile.');
        const events = cpuProfileToTraceEvents(profile);
        sourceMaps?.observe(events);
        await writer.write(events);
      } else {
        await Promise.race([cdp.send('Tracing.end'), watch.promise]);
        let flushTimer;
        const flushDeadline = new Promise((_resolve, reject) => {
          flushTimer = setTimeout(() => reject(new Error('The app did not finish flushing the trace in time.')), FLUSH_TIMEOUT_MS);
          flushTimer.unref?.();
        });
        // The deadline loses the race in the ordinary case, and a timer left
        // armed would reject with nobody listening.
        flushDeadline.catch(() => undefined);
        try {
          const finished = await Promise.race([complete, watch.promise, flushDeadline]);
          dataLoss = finished.dataLossOccurred === true;
        } finally {
          clearTimeout(flushTimer);
        }
        await collecting;
        if (collectError) throw collectError;
      }
    } finally {
      releaseStopWatchers();
    }
    await writer.end();

    await sink.status({ state: 'enriching' }).catch(() => undefined);
    const collected = sourceMaps ? await sourceMaps.collect() : { retained: [], warnings: [] };
    warnings.push(...collected.warnings);

    // No mainFrame and no traceMarker: React Native emits TracingStartedInPage,
    // which the exporter already accepts as real frame metadata, so there is
    // nothing for it to rebuild and no spool rescan to pay for.
    const result = await sink.finalize({
      dataLoss,
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
    cdp?.close();
  }
}
