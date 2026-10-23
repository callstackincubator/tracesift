import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  appendFile,
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { finished } from "node:stream/promises";
import { createGzip } from "node:zlib";

import {
  ACTIVE_CAPTURE_STATES,
  type CaptureRecord,
  type CaptureMainFrame,
  type CaptureScriptMetadata,
  type CaptureSourceMap,
  type CaptureState,
  type CaptureStopReason,
  type CaptureTarget,
} from "./capture-types.ts";

interface StoredCapture extends CaptureRecord {
  uploadTokenHash: string;
  ownerInstance: string;
}

interface CaptureStoreShared {
  mutation: Promise<unknown>;
  instance: string;
}

const shared = (globalThis as typeof globalThis & { [key: symbol]: CaptureStoreShared })[
  Symbol.for("tracesift.capture-store.v1")
] ??= { mutation: Promise.resolve(), instance: process.env.TRACE_SIFT_INSTANCE || randomUUID() };

const CAPTURE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// IO.read is deliberately smaller than this limit. Keeping the server limit
// close to the read size prevents either side from retaining a large request.
export const MAX_RAW_CHUNK_BYTES = 1024 * 1024;
const MAX_TRACE_PREFIX_BYTES = 1024 * 1024;
const MAX_INSPECTED_EVENT_BYTES = 512 * 1024;
const MAX_WARNING_LENGTH = 500;
const TERMINAL_STATES = new Set<CaptureState>(["captured", "captured_with_warnings", "failed", "interrupted"]);

function storeRoot(): string {
  const home = resolve(/* turbopackIgnore: true */ process.env.TRACE_SIFT_HOME || join(homedir(), ".tracesift"));
  return join(home, "captures");
}

function captureDir(id: string): string {
  if (!CAPTURE_ID.test(id)) throw new Error("Invalid capture id.");
  return join(storeRoot(), id);
}

function metadataPath(id: string): string { return join(captureDir(id), "capture.json"); }
function spoolPath(id: string): string { return join(captureDir(id), "trace.spool"); }
function scriptsPath(id: string): string { return join(captureDir(id), "scripts.json"); }

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function publicRecord(record: StoredCapture): CaptureRecord {
  const { uploadTokenHash: _secret, ownerInstance: _owner, ...visible } = record;
  void _secret; void _owner;
  return visible;
}

function cleanText(value: string, maximum: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maximum);
}

function safeTarget(target: CaptureTarget): CaptureTarget {
  if (!Number.isSafeInteger(target.tabId) || target.tabId < 0) throw new Error("Choose a valid Chrome tab.");
  return {
    tabId: target.tabId,
    title: cleanText(target.title || "Untitled tab", 300),
    url: cleanText(target.url || "", 4000),
  };
}

async function ensureRoot(): Promise<void> {
  await mkdir(storeRoot(), { recursive: true, mode: 0o700 });
  await chmod(storeRoot(), 0o700);
}

async function readStored(id: string): Promise<StoredCapture | undefined> {
  let raw: string;
  try { raw = await readFile(metadataPath(id), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return JSON.parse(raw) as StoredCapture;
}

async function writeStored(record: StoredCapture): Promise<void> {
  const temporary = join(captureDir(record.id), `.capture-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, metadataPath(record.id));
  } finally {
    await rm(temporary, { force: true });
  }
}

function mutate<T>(operation: () => Promise<T>): Promise<T> {
  const result = shared.mutation.then(operation, operation);
  shared.mutation = result.catch(() => undefined);
  return result;
}

function tokenMatches(record: StoredCapture, token: string): boolean {
  if (!token) return false;
  const expected = Buffer.from(record.uploadTokenHash, "hex");
  const supplied = Buffer.from(hashToken(token), "hex");
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

async function authorized(id: string, token: string): Promise<StoredCapture> {
  const record = await readStored(id);
  if (!record || !tokenMatches(record, token)) throw new Error("Capture authorization failed.");
  return record;
}

export async function createCapture(input: { title?: string; target: CaptureTarget }): Promise<{ capture: CaptureRecord; uploadToken: string }> {
  return mutate(async () => {
    const active = (await listCaptures()).find((record) => ACTIVE_CAPTURE_STATES.has(record.state));
    if (active) throw new Error(`A capture is already active for “${active.target.title}”.`);

    await ensureRoot();
    const id = randomUUID();
    const uploadToken = randomBytes(32).toString("base64url");
    const dir = captureDir(id);
    await mkdir(dir, { mode: 0o700 });
    const now = Date.now();
    const target = safeTarget(input.target);
    const record: StoredCapture = {
      id,
      createdAt: now,
      updatedAt: now,
      title: cleanText(input.title || target.title || "Chrome performance capture", 300),
      target,
      state: "pending",
      bufferUsage: 0,
      eventCount: 0,
      chunkCount: 0,
      byteCount: 0,
      dataLoss: false,
      scriptsSeen: 0,
      sourceMapsSeen: 0,
      warnings: [],
      uploadTokenHash: hashToken(uploadToken),
      ownerInstance: shared.instance,
    };
    await writeFile(spoolPath(id), "", { flag: "wx", mode: 0o600 });
    await writeStored(record);
    return { capture: publicRecord(record), uploadToken };
  });
}

export async function getCapture(id: string): Promise<CaptureRecord | undefined> {
  const record = await readStored(id);
  return record ? publicRecord(record) : undefined;
}

export async function listCaptures(): Promise<CaptureRecord[]> {
  await ensureRoot();
  const entries = await readdir(storeRoot(), { withFileTypes: true });
  const records = (await Promise.all(entries.filter((entry) => entry.isDirectory() && CAPTURE_ID.test(entry.name)).map((entry) => readStored(entry.name))))
    .filter((record): record is StoredCapture => Boolean(record));
  for (const record of records) {
    if (ACTIVE_CAPTURE_STATES.has(record.state) && record.ownerInstance !== shared.instance) {
      record.state = "interrupted";
      record.stopReason = "shutdown";
      record.error = "TraceSift stopped before Chrome completed this capture.";
      record.stoppedAt = Date.now();
      record.updatedAt = record.stoppedAt;
      await writeStored(record);
    }
  }
  return records.map(publicRecord).sort((a, b) => b.createdAt - a.createdAt);
}

export async function requestCaptureStop(id: string): Promise<CaptureRecord> {
  return mutate(async () => {
    const record = await readStored(id);
    if (!record) throw new Error("Capture not found.");
    if (record.state !== "recording" && record.state !== "attaching") return publicRecord(record);
    record.state = "stop_requested";
    record.stopReason = "manual";
    record.updatedAt = Date.now();
    await writeStored(record);
    return publicRecord(record);
  });
}

export async function updateCaptureFromExtension(id: string, token: string, update: {
  state?: "attaching" | "recording" | "flushing" | "enriching" | "failed" | "interrupted";
  stopReason?: CaptureStopReason;
  bufferUsage?: number;
  eventCount?: number;
  warning?: string;
  error?: string;
}): Promise<CaptureRecord> {
  return mutate(async () => {
    const record = await authorized(id, token);
    if (TERMINAL_STATES.has(record.state)) return publicRecord(record);
    // A Stop click can race with Chrome's attach handshake. Do not let the
    // extension's late "recording" acknowledgement erase that stop request;
    // its poller will observe it and end tracing immediately.
    if (update.state && !(record.state === "stop_requested" && (update.state === "attaching" || update.state === "recording"))) {
      record.state = update.state;
    }
    if (update.state === "recording" && !record.startedAt) record.startedAt = Date.now();
    if (update.stopReason) record.stopReason = update.stopReason;
    if (typeof update.bufferUsage === "number" && Number.isFinite(update.bufferUsage)) {
      record.bufferUsage = Math.max(record.bufferUsage, Math.min(1, Math.max(0, update.bufferUsage)));
    }
    if (typeof update.eventCount === "number" && Number.isSafeInteger(update.eventCount) && update.eventCount >= 0) {
      record.eventCount = Math.max(record.eventCount, update.eventCount);
    }
    if (update.warning) record.warnings.push(cleanText(update.warning, MAX_WARNING_LENGTH));
    if (update.error) record.error = cleanText(update.error, 2000);
    record.updatedAt = Date.now();
    await writeStored(record);
    return publicRecord(record);
  });
}

export async function appendCaptureRawChunk(id: string, token: string, sequence: number, bytes: Uint8Array): Promise<CaptureRecord> {
  return mutate(async () => {
    const record = await authorized(id, token);
    if (!Number.isSafeInteger(sequence) || sequence !== record.chunkCount) {
      throw new Error(`Expected trace chunk ${record.chunkCount}, received ${sequence}.`);
    }
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_RAW_CHUNK_BYTES) {
      throw new Error("Raw trace chunk exceeds the 1 MB limit.");
    }
    if (bytes.byteLength > 0) await appendFile(spoolPath(id), bytes);
    record.chunkCount += 1;
    record.byteCount += bytes.byteLength;
    if (record.state !== "stop_requested") record.state = "flushing";
    record.updatedAt = Date.now();
    await writeStored(record);
    return publicRecord(record);
  });
}

async function writeWithBackpressure(stream: NodeJS.WritableStream, chunk: Uint8Array | string): Promise<void> {
  if (!stream.write(chunk)) await new Promise<void>((resolveDrain) => stream.once("drain", resolveDrain));
}

/**
 * Copy only the traceEvents array body from Chrome's JSON trace stream.
 *
 * ReturnAsStream still produces one valid JSON document. We never parse or
 * retain its events: this small byte-level state machine locates the array and
 * streams its contents into the enhanced-trace wrapper. JSON punctuation is
 * ASCII, so scanning bytes remains correct across UTF-8 and input boundaries.
 */
async function copyTraceEvents(spool: string, output: NodeJS.WritableStream): Promise<number> {
  let prefix = Buffer.alloc(0);
  let started = false;
  let ended = false;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let objectDepth = 0;
  let eventCount = 0;

  const copyArrayBytes = async (bytes: Buffer): Promise<void> => {
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
      if (prefix.byteLength > MAX_TRACE_PREFIX_BYTES) throw new Error("Chrome trace is missing a traceEvents array near its start.");
      const text = prefix.toString("utf8");
      const first = text.search(/\S/);
      let opening = first >= 0 && text[first] === "[" ? first : -1;
      if (opening < 0) {
        const marker = text.indexOf('"traceEvents"');
        if (marker >= 0) opening = text.indexOf("[", marker + 13);
      }
      if (opening < 0) continue;
      // The stream can be either a bare trace-event array or Chrome's usual
      // {"traceEvents":[...]} object. Start immediately after its outer array.
      chunk = prefix.subarray(Buffer.byteLength(text.slice(0, opening + 1), "utf8"));
      prefix = Buffer.alloc(0);
      started = true;
      depth = 1;
    }
    await copyArrayBytes(chunk);
  }
  if (!started || !ended || inString || depth !== 0 || objectDepth !== 0) throw new Error("Chrome returned an incomplete trace stream.");
  return eventCount;
}

async function inspectTraceMetadata(spool: string, traceMarker: string): Promise<{
  hasInspectorMetadata: boolean;
  marker?: { pid: number; tid: number; ts: number };
}> {
  let prefix = Buffer.alloc(0);
  let started = false;
  let depth = 0;
  let objectDepth = 0;
  let inString = false;
  let escaped = false;
  let eventParts: Buffer[] = [];
  let eventBytes = 0;
  let eventOverflow = false;
  let capturingEvent = false;
  let hasInspectorMetadata = false;

  const inspectEvent = (): { pid: number; tid: number; ts: number } | undefined => {
    if (eventOverflow) return undefined;
    try {
      const event = JSON.parse(Buffer.concat(eventParts, eventBytes).toString("utf8")) as Record<string, unknown>;
      if (["TracingStartedInBrowser", "TracingStartedInPage", "CpuProfile"].includes(String(event.name))) {
        hasInspectorMetadata = true;
      }
      if (event.name === traceMarker && typeof event.pid === "number" && typeof event.tid === "number" && typeof event.ts === "number" && Number.isFinite(event.pid) && Number.isFinite(event.tid) && Number.isFinite(event.ts)) {
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
      const text = prefix.toString("utf8");
      const first = text.search(/\S/);
      let opening = first >= 0 && text[first] === "[" ? first : -1;
      if (opening < 0) {
        const marker = text.indexOf('"traceEvents"');
        if (marker >= 0) opening = text.indexOf("[", marker + 13);
      }
      if (opening < 0) continue;
      chunk = prefix.subarray(Buffer.byteLength(text.slice(0, opening + 1), "utf8"));
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

function validScripts(value: CaptureScriptMetadata[]): CaptureScriptMetadata[] {
  return value.slice(0, 50_000).filter((script) => script && typeof script.scriptId === "string" && typeof script.url === "string").map((script) => ({
    scriptId: cleanText(script.scriptId, 200),
    url: cleanText(script.url, 4000),
    ...(script.sourceMapURL ? { sourceMapURL: cleanText(script.sourceMapURL, 4000) } : {}),
    ...(script.frameId ? { frameId: cleanText(script.frameId, 300) } : {}),
    ...(script.sessionId ? { sessionId: cleanText(script.sessionId, 300) } : {}),
  }));
}

function validSourceMaps(value: CaptureSourceMap[]): CaptureSourceMap[] {
  return value.slice(0, 5_000).filter((entry) => entry && typeof entry.url === "string" && typeof entry.sourceMapUrl === "string" && entry.sourceMap && typeof entry.sourceMap === "object" && !Array.isArray(entry.sourceMap)).map((entry) => ({
    url: cleanText(entry.url, 4000),
    sourceMapUrl: cleanText(entry.sourceMapUrl, 4000),
    sourceMap: entry.sourceMap,
  }));
}

async function writeGzipExport(record: StoredCapture, scripts: CaptureScriptMetadata[], sourceMaps: CaptureSourceMap[], mainFrame?: CaptureMainFrame, traceMarker?: string): Promise<{ export: { fileName: string; sizeBytes: number }; eventCount: number }> {
  const stamp = new Date(record.createdAt).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const fileName = `Trace-${stamp}.json.gz`;
  const destination = join(captureDir(record.id), fileName);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  const output = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
  const gzip = createGzip({ level: 6 });
  gzip.pipe(output);
  const metadata = {
    // DevTools' enhanced-trace schema is currently version 1. The source
    // rundown events in traceEvents carry script content; these retained maps
    // let an offline import resolve authored names without refetching assets.
    enhancedTraceVersion: 1,
    sourceMaps,
    traceSift: {
      captureId: record.id,
      target: record.target,
      createdAt: new Date(record.createdAt).toISOString(),
      scripts,
    },
  };
  const traceMetadata = traceMarker ? await inspectTraceMetadata(spoolPath(record.id), traceMarker) : { hasInspectorMetadata: false };
  const syntheticMetadata = !traceMetadata.hasInspectorMetadata && traceMetadata.marker && mainFrame ? {
    name: "TracingStartedInBrowser",
    cat: "disabled-by-default-devtools.timeline",
    ph: "I",
    s: "t",
    pid: traceMetadata.marker.pid,
    tid: traceMetadata.marker.tid,
    ts: traceMetadata.marker.ts,
    args: { data: { persistentIds: true, frames: [{
      frame: mainFrame.id,
      url: mainFrame.url || record.target.url,
      name: mainFrame.name,
      processId: traceMetadata.marker.pid,
      isOutermostMainFrame: true,
      isInPrimaryMainFrame: true,
    }] } },
  } : undefined;
  try {
    gzip.write(`{"metadata":${JSON.stringify(metadata)},"traceEvents":[`);
    if (syntheticMetadata) gzip.write(`${JSON.stringify(syntheticMetadata)},`);
    const eventCount = await copyTraceEvents(spoolPath(record.id), gzip);
    gzip.end("]}");
    await finished(output);
    await rename(temporary, destination);
    const info = await stat(destination);
    return { export: { fileName, sizeBytes: info.size }, eventCount: eventCount + (syntheticMetadata ? 1 : 0) };
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function finalizeCapture(id: string, token: string, input: {
  dataLoss?: boolean;
  stopReason?: CaptureStopReason;
  scripts?: CaptureScriptMetadata[];
  sourceMaps?: CaptureSourceMap[];
  warnings?: string[];
  mainFrame?: CaptureMainFrame;
  traceMarker?: string;
}): Promise<CaptureRecord> {
  return mutate(async () => {
    const record = await authorized(id, token);
    if (record.export && TERMINAL_STATES.has(record.state)) return publicRecord(record);
    record.state = "enriching";
    record.updatedAt = Date.now();
    await writeStored(record);

    const scripts = validScripts(Array.isArray(input.scripts) ? input.scripts : []);
    const sourceMaps = validSourceMaps(Array.isArray(input.sourceMaps) ? input.sourceMaps : []);
    await writeFile(scriptsPath(id), `${JSON.stringify(scripts)}\n`, { mode: 0o600 });
    record.scriptsSeen = scripts.length;
    record.sourceMapsSeen = sourceMaps.length;
    record.dataLoss = Boolean(input.dataLoss);
    if (input.stopReason) record.stopReason = input.stopReason;
    if (record.dataLoss) record.warnings.push("Chrome reported that trace data was lost before export completed.");
    for (const warning of input.warnings ?? []) record.warnings.push(cleanText(String(warning), MAX_WARNING_LENGTH));
    const externalSourceMapsReported = scripts.some((script) => script.sourceMapURL && !script.sourceMapURL.startsWith("data:"));
    if (externalSourceMapsReported && record.sourceMapsSeen === 0) record.warnings.push("Chrome reported external source maps, but none could be retained; generated function names may remain minified.");
    if (!scripts.some((script) => script.sourceMapURL)) record.warnings.push("No source-map URLs were reported by Chrome; generated function names may remain minified.");
    record.warnings = [...new Set(record.warnings)].slice(0, 100);
    const mainFrame = input.mainFrame && typeof input.mainFrame.id === "string" ? {
      id: cleanText(input.mainFrame.id, 300),
      url: cleanText(input.mainFrame.url || record.target.url, 4000),
      name: cleanText(input.mainFrame.name || "", 300),
    } : undefined;
    const traceMarker = input.traceMarker ? cleanText(input.traceMarker, 300) : undefined;
    const completedExport = await writeGzipExport(record, scripts, sourceMaps, mainFrame, traceMarker);
    record.export = completedExport.export;
    record.eventCount = completedExport.eventCount;
    record.state = record.warnings.length > 0 ? "captured_with_warnings" : "captured";
    record.stoppedAt = Date.now();
    record.updatedAt = record.stoppedAt;
    await writeStored(record);
    return publicRecord(record);
  });
}

export async function failCapture(id: string, token: string, input: { error: string; reason?: CaptureStopReason; interrupted?: boolean }): Promise<CaptureRecord> {
  return mutate(async () => {
    const record = await authorized(id, token);
    if (TERMINAL_STATES.has(record.state)) return publicRecord(record);
    record.state = input.interrupted ? "interrupted" : "failed";
    record.stopReason = input.reason ?? "error";
    record.error = cleanText(input.error || "Capture failed.", 2000);
    record.stoppedAt = Date.now();
    record.updatedAt = record.stoppedAt;
    await writeStored(record);
    return publicRecord(record);
  });
}

export async function deleteCapture(id: string): Promise<boolean> {
  return mutate(async () => {
    const record = await readStored(id);
    if (!record) return false;
    if (ACTIVE_CAPTURE_STATES.has(record.state)) throw new Error("Stop the active capture before deleting it.");
    await rm(captureDir(id), { recursive: true, force: true });
    return true;
  });
}

export async function captureExport(id: string): Promise<{ path: string; fileName: string; sizeBytes: number } | undefined> {
  const record = await readStored(id);
  if (!record?.export) return undefined;
  const fileName = basename(record.export.fileName);
  const path = join(captureDir(id), fileName);
  const info = await stat(path);
  return { path, fileName, sizeBytes: info.size };
}

export function bearerToken(request: Request): string {
  const authorization = request.headers.get("authorization") ?? "";
  return authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
}
