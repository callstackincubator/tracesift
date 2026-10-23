const SAFE_BUFFER_LIMIT = 0.9;
// IO.read's size is not a promise about the UTF-8 byte length of its returned
// JavaScript string. 192K code units remains below the server's 1 MB cap even
// in the worst case of four-byte UTF-8 characters.
const MAX_UPLOAD_BYTES = 192 * 1024;
const MAX_SOURCE_MAP_BYTES = 8 * 1024 * 1024;
const MAX_ALL_SOURCE_MAP_BYTES = 16 * 1024 * 1024;
const TRACE_CATEGORIES = [
  "-*",
  "blink.console",
  "blink.user_timing",
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  "disabled-by-default-devtools.timeline.stack",
  "disabled-by-default-v8.cpu_profiler",
  "disabled-by-default-v8.cpu_profiler.hires",
  "disabled-by-default-v8.source_rundown",
  "disabled-by-default-v8.source_rundown_sources",
  "latencyInfo",
  "loading",
  "toplevel",
  "v8.execute",
].join(",");

let pairing = null;
let active = null;

void chrome.storage.session.get("pairing").then((stored) => { pairing = stored.pairing || null; });

function errorText(error) {
  return error instanceof Error ? error.message : String(error || "Unknown capture error.");
}

function normalizedBaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("TraceSift must be running on local loopback.");
  return url.origin;
}

function capturePageForTab(tab) {
  if (!Number.isInteger(tab?.id) || typeof tab.url !== "string") return null;
  try {
    const url = new URL(tab.url);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || url.pathname !== "/capture") return null;
    return { baseUrl: url.origin, bridgeTabId: tab.id };
  } catch { return null; }
}

function senderIsPaired(sender) {
  if (!pairing || sender.tab?.id !== pairing.bridgeTabId) return false;
  try {
    const url = new URL(sender.tab.url);
    return url.origin === pairing.baseUrl && url.pathname === "/capture";
  }
  catch { return false; }
}

async function jsonFetch(url, init = {}) {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `TraceSift returned HTTP ${response.status}.`);
  return body;
}

async function targets() {
  const candidates = await chrome.debugger.getTargets();
  return candidates
    .filter((target) => target.type === "page" && Number.isInteger(target.tabId) && !target.attached)
    .filter((target) => !/^(chrome|chrome-extension|devtools):/.test(target.url || ""))
    .filter((target) => target.url && !target.url.startsWith(`${pairing.baseUrl}/capture`))
    .map((target) => ({ tabId: target.tabId, title: target.title || "Untitled tab", url: target.url }));
}

function authHeaders(token) {
  return { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
}

async function postStatus(update) {
  if (!active) return;
  await jsonFetch(`${active.baseUrl}/api/captures/${active.captureId}/ingest/status`, {
    method: "POST",
    headers: authHeaders(active.token),
    body: JSON.stringify(update),
  });
}

function scriptKey(source, params) {
  return `${source.sessionId || "root"}:${params.scriptId}`;
}

async function configureChild(source) {
  // Keep renderer page metadata active on Chrome versions that still emit the
  // legacy TracingStartedInPage marker. Newer versions need the target-scoped
  // marker recorded below because chrome.debugger cannot trace browser events.
  await chrome.debugger.sendCommand(source, "Page.enable").catch(() => undefined);
  await chrome.debugger.sendCommand(source, "Debugger.enable").catch(() => undefined);
  await chrome.debugger.sendCommand(source, "Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
    filter: [
      { type: "iframe", exclude: false },
      { type: "worker", exclude: false },
      { type: "shared_worker", exclude: false },
      { type: "service_worker", exclude: false },
    ],
  }).catch(() => undefined);
}

async function inspectedMainFrame(source) {
  const result = await chrome.debugger.sendCommand(source, "Page.getFrameTree");
  const frame = result.frameTree?.frame;
  if (!frame || typeof frame.id !== "string") throw new Error("Chrome did not identify the inspected main frame.");
  return { id: frame.id, url: frame.url || "", name: frame.name || "" };
}

async function startCapture(message) {
  if (active) throw new Error("A TraceSift capture is already active.");
  const baseUrl = normalizedBaseUrl(message.baseUrl);
  if (baseUrl !== pairing.baseUrl) throw new Error("Pair TraceSift again before starting a capture.");
  const debuggee = { tabId: message.target.tabId };
  active = {
    debuggee,
    captureId: message.captureId,
    token: message.token,
    baseUrl,
    sequence: 0,
    scripts: new Map(),
    sourceMapEntries: new Map(),
    sourceMapQueue: Promise.resolve(),
    sourceMapBytes: 0,
    sourceMapWarnings: [],
    sourceMapLimitReached: false,
    stopping: false,
    stopReason: "manual",
    pollTimer: null,
    lastEventCount: 0,
    mainFrame: null,
    traceMarker: `__tracesift_main_${message.captureId}`,
  };
  try {
    await postStatus({ state: "attaching" });
    await chrome.debugger.attach(debuggee, "1.3");
    await configureChild(debuggee);
    active.mainFrame = await inspectedMainFrame(debuggee);
    await chrome.debugger.sendCommand(debuggee, "Tracing.start", {
      categories: TRACE_CATEGORIES,
      options: "record-until-full",
      bufferUsageReportingInterval: 1000,
      transferMode: "ReturnAsStream",
      streamFormat: "json",
      streamCompression: "none",
    });
    // Chrome 156+ intentionally removes browser-process metadata from traces
    // started by chrome.debugger. Leave a renderer-main marker so the exporter
    // can restore the equivalent, target-scoped frame metadata offline.
    const markerResult = await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
      expression: `performance.mark(${JSON.stringify(active.traceMarker)})`,
      returnByValue: true,
    });
    if (markerResult.exceptionDetails) throw new Error("Chrome could not mark the inspected renderer main thread.");
    await postStatus({ state: "recording" });
    active.pollTimer = setInterval(() => void pollStopRequest(), 1000);
    return { ok: true };
  } catch (error) {
    const messageText = errorText(error);
    await postStatus({ state: "failed", stopReason: "error", error: messageText }).catch(() => undefined);
    await chrome.debugger.detach(debuggee).catch(() => undefined);
    active = null;
    throw new Error(messageText);
  }
}

async function pollStopRequest() {
  const capture = active;
  if (!capture || capture.stopping) return;
  try {
    const result = await jsonFetch(`${capture.baseUrl}/api/captures/${capture.captureId}`, { cache: "no-store" });
    if (result.capture?.state === "stop_requested") await stopCapture("manual");
  } catch (error) {
    await postStatus({ warning: `Could not read the stop signal: ${errorText(error)}` }).catch(() => undefined);
  }
}

async function stopCapture(reason) {
  if (!active || active.stopping) return;
  active.stopping = true;
  active.stopReason = reason;
  if (active.pollTimer) clearInterval(active.pollTimer);
  await postStatus({ state: "flushing", stopReason: reason, bufferUsage: reason === "buffer_limit" ? SAFE_BUFFER_LIMIT : undefined });
  await chrome.debugger.sendCommand(active.debuggee, "Tracing.end");
}

function decodeBase64Bytes(value) {
  const decoded = atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes;
}

async function uploadRawTraceStream(capture, handle) {
  try {
    while (true) {
      // Pull only after the previous disk append is acknowledged. At most one
      // fixed-size CDP read and one fetch body are retained by the extension.
      const result = await chrome.debugger.sendCommand(capture.debuggee, "IO.read", { handle, size: MAX_UPLOAD_BYTES });
      const body = result.base64Encoded ? decodeBase64Bytes(result.data) : new TextEncoder().encode(result.data);
      if (body.byteLength > 0) {
        const response = await fetch(`${capture.baseUrl}/api/captures/${capture.captureId}/ingest/raw?sequence=${capture.sequence}`, {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream", Authorization: `Bearer ${capture.token}` },
          body,
        });
        const responseBody = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(responseBody.error || `TraceSift returned HTTP ${response.status}.`);
        capture.sequence += 1;
      }
      if (result.eof) break;
    }
  } finally {
    await chrome.debugger.sendCommand(capture.debuggee, "IO.close", { handle }).catch(() => undefined);
  }
}

function decodeDataUrl(url) {
  const comma = url.indexOf(",");
  if (comma < 0) throw new Error("Malformed source-map data URL.");
  const header = url.slice(0, comma);
  const payload = url.slice(comma + 1);
  return header.includes(";base64") ? atob(payload) : decodeURIComponent(payload);
}

function resolveSourceMapUrl(script) {
  return new URL(script.sourceMapURL, script.url || undefined).href;
}

async function readProtocolStream(source, handle) {
  let content = "";
  try {
    while (true) {
      const result = await chrome.debugger.sendCommand(source, "IO.read", { handle, size: 512 * 1024 });
      const part = result.base64Encoded ? atob(result.data) : result.data;
      content += part;
      if (content.length > MAX_SOURCE_MAP_BYTES) throw new Error("Source map exceeds the 8 MB retention limit.");
      if (result.eof) return content;
    }
  } finally {
    await chrome.debugger.sendCommand(source, "IO.close", { handle }).catch(() => undefined);
  }
}

function sourceMapLoadFailure(resource, sourceMapUrl) {
  const details = [];
  if (Number.isInteger(resource?.httpStatusCode)) details.push(`HTTP ${resource.httpStatusCode}`);
  if (resource?.netErrorName) details.push(resource.netErrorName);
  return new Error(details.length > 0 ? `${sourceMapUrl} returned ${details.join("; ")}` : `Could not load ${sourceMapUrl}`);
}

async function loadSourceMap(capture, script, sourceMapUrl = resolveSourceMapUrl(script)) {
  if (!script.url || !script.sourceMapURL || script.url.startsWith("chrome-extension:")) return null;
  let raw;
  if (sourceMapUrl.startsWith("data:")) {
    raw = decodeDataUrl(sourceMapUrl);
  } else {
    const source = { ...capture.debuggee, ...(script.sessionId ? { sessionId: script.sessionId } : {}) };
    const result = await chrome.debugger.sendCommand(source, "Network.loadNetworkResource", {
      ...(script.frameId ? { frameId: script.frameId } : {}),
      url: sourceMapUrl,
      options: { disableCache: false, includeCredentials: true },
    });
    if (!result.resource?.success || !result.resource.stream) throw sourceMapLoadFailure(result.resource, sourceMapUrl);
    raw = await readProtocolStream(source, result.resource.stream);
  }
  if (raw.length > MAX_SOURCE_MAP_BYTES) throw new Error("Source map exceeds the 8 MB retention limit.");
  const sourceMap = JSON.parse(raw);
  if (!sourceMap || typeof sourceMap !== "object" || Array.isArray(sourceMap)) throw new Error("Source map is not a JSON object.");
  return { url: script.url, sourceMapUrl, sourceMap, bytes: raw.length };
}

async function tryRetainSourceMap(capture, entry) {
  if (entry.retained || capture.sourceMapLimitReached) return;
  entry.attempts += 1;
  try {
    const loaded = await loadSourceMap(capture, entry.script, entry.sourceMapUrl);
    if (!loaded) return;
    if (capture.sourceMapBytes + loaded.bytes > MAX_ALL_SOURCE_MAP_BYTES) {
      capture.sourceMapLimitReached = true;
      capture.sourceMapWarnings.push("Stopped retaining source maps after the 16 MB safety limit.");
      return;
    }
    capture.sourceMapBytes += loaded.bytes;
    entry.retained = { url: loaded.url, sourceMapUrl: loaded.sourceMapUrl, sourceMap: loaded.sourceMap };
    entry.error = null;
  } catch (error) {
    entry.error = errorText(error);
  }
}

function queueSourceMap(capture, script) {
  if (!script.url || !script.sourceMapURL || script.url.startsWith("chrome-extension:")) return;
  let sourceMapUrl;
  try { sourceMapUrl = resolveSourceMapUrl(script); }
  catch {
    capture.sourceMapWarnings.push(`Ignored an invalid source-map URL for ${script.url || "an anonymous script"}.`);
    return;
  }
  // DevTools does not duplicate data-URL maps in metadata: source-rundown
  // events already carry their contents in the trace.
  if (sourceMapUrl.startsWith("data:")) return;
  const key = `${script.url}\n${sourceMapUrl}`;
  if (capture.sourceMapEntries.has(key)) return;
  const entry = { script, sourceMapUrl, attempts: 0, retained: null, error: null };
  capture.sourceMapEntries.set(key, entry);
  // Serialize reads so eager retention cannot temporarily hold an unbounded
  // number of large maps while still enforcing the aggregate byte limit.
  capture.sourceMapQueue = capture.sourceMapQueue.then(() => tryRetainSourceMap(capture, entry));
}

async function collectSourceMaps(capture) {
  await capture.sourceMapQueue;
  // A development server can still be compiling when scriptParsed arrives.
  // Retry eager failures once at finalization, matching DevTools' fallback.
  for (const entry of capture.sourceMapEntries.values()) {
    if (!entry.retained && entry.error && !capture.sourceMapLimitReached) await tryRetainSourceMap(capture, entry);
  }
  const warnings = [...capture.sourceMapWarnings];
  for (const entry of capture.sourceMapEntries.values()) {
    if (!entry.retained && entry.error) {
      warnings.push(`Could not retain source map ${entry.sourceMapUrl} for ${entry.script.url || "an anonymous script"}: ${entry.error}`);
    }
  }
  return {
    retained: [...capture.sourceMapEntries.values()].flatMap((entry) => entry.retained ? [entry.retained] : []),
    warnings: [...new Set(warnings)],
  };
}

async function finalize(params) {
  const capture = active;
  if (!capture) return;
  if (capture.pollTimer) clearInterval(capture.pollTimer);
  try {
    if (!params.stream) throw new Error("Chrome completed tracing without returning a stream.");
    await uploadRawTraceStream(capture, params.stream);
    await postStatus({ state: "enriching" });
    const sourceMaps = await collectSourceMaps(capture);
    await jsonFetch(`${capture.baseUrl}/api/captures/${capture.captureId}/ingest/finalize`, {
      method: "POST",
      headers: authHeaders(capture.token),
      body: JSON.stringify({
        dataLoss: params.dataLossOccurred === true,
        stopReason: capture.stopReason,
        scripts: [...capture.scripts.values()],
        sourceMaps: sourceMaps.retained,
        warnings: sourceMaps.warnings,
        mainFrame: capture.mainFrame,
        traceMarker: capture.traceMarker,
      }),
    });
  } catch (error) {
    await postStatus({ state: "failed", stopReason: "error", error: `Trace export failed: ${errorText(error)}` }).catch(() => undefined);
  } finally {
    await chrome.debugger.detach(capture.debuggee).catch(() => undefined);
    if (active === capture) active = null;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (!senderIsPaired(sender)) throw new Error("Pair this TraceSift tab with the extension first.");
    if (message.type === "STATUS") return { ok: true };
    if (message.type === "LIST_TARGETS") return { ok: true, targets: await targets() };
    if (message.type === "START") return startCapture(message);
    throw new Error("Unknown TraceSift extension request.");
  })().then(sendResponse, (error) => sendResponse({ ok: false, error: errorText(error) }));
  return true;
});

chrome.debugger.onEvent.addListener((source, method, params = {}) => {
  const capture = active;
  if (!capture || source.tabId !== capture.debuggee.tabId) return;

  if (method === "Target.attachedToTarget") {
    void configureChild({ ...capture.debuggee, sessionId: params.sessionId });
    return;
  }
  if (method === "Debugger.scriptParsed" && typeof params.scriptId === "string") {
    if (capture.scripts.size >= 50_000) return;
    const script = {
      scriptId: params.scriptId,
      url: params.url || "",
      ...(params.sourceMapURL ? { sourceMapURL: params.sourceMapURL } : {}),
      ...(typeof params.executionContextAuxData?.frameId === "string" ? { frameId: params.executionContextAuxData.frameId } : {}),
      ...(source.sessionId ? { sessionId: source.sessionId } : {}),
    };
    capture.scripts.set(scriptKey(source, params), script);
    queueSourceMap(capture, script);
    return;
  }
  if (method === "Tracing.bufferUsage") {
    const usage = Number(params.percentFull ?? params.value ?? 0);
    capture.lastEventCount = Math.max(capture.lastEventCount, Number(params.eventCount || 0));
    void postStatus({ bufferUsage: usage, eventCount: capture.lastEventCount }).catch(() => undefined);
    if (usage >= SAFE_BUFFER_LIMIT) void stopCapture("buffer_limit").catch(async (error) => {
      await postStatus({ state: "failed", stopReason: "error", error: errorText(error) }).catch(() => undefined);
    });
    return;
  }
  // ReturnAsStream deliberately avoids dataCollected arrays: they can arrive
  // faster than HTTP uploads and a promise queue would retain every batch.
  if (method === "Tracing.tracingComplete") void finalize(params);
});

chrome.debugger.onDetach.addListener((source, reason) => {
  const capture = active;
  if (!capture || source.tabId !== capture.debuggee.tabId) return;
  if (capture.stopping) return;
  if (capture.pollTimer) clearInterval(capture.pollTimer);
  void postStatus({
    state: "interrupted",
    stopReason: reason === "target_closed" ? "target_closed" : "detached",
    error: reason === "target_closed" ? "The captured tab was closed before Chrome flushed the trace." : "Chrome detached the profiler. Opening DevTools or dismissing Chrome’s debugging banner can cause this.",
  }).finally(() => { if (active === capture) active = null; });
});

chrome.action.onClicked.addListener((tab) => {
  const approved = capturePageForTab(tab);
  if (approved) {
    pairing = approved;
    void chrome.storage.session.set({ pairing }).then(() => chrome.tabs.sendMessage(approved.bridgeTabId, { type: "PAIRED_BY_USER" }).catch(() => undefined));
    return;
  }
  if (pairing?.baseUrl) void chrome.tabs.create({ url: `${pairing.baseUrl}/capture` });
});

function forgetPairingForTab(tabId) {
  if (pairing?.bridgeTabId !== tabId) return;
  pairing = null;
  void chrome.storage.session.remove("pairing");
}

// Approval belongs to the exact document on which the user clicked the
// extension action, not merely to a loopback port that another process could
// later claim. Reload/navigation requires another explicit click.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") forgetPairingForTab(tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => forgetPairingForTab(tabId));
