import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
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

import { writeTraceExport } from "@callstack/tracesift/trace-export";

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
  if (target.tabId !== undefined && (!Number.isSafeInteger(target.tabId) || target.tabId < 0)) throw new Error("Choose a valid Chrome tab.");
  const targetId = typeof target.targetId === "string" ? cleanText(target.targetId, 300) : "";
  const appId = typeof target.appId === "string" ? cleanText(target.appId, 300) : "";
  const deviceName = typeof target.deviceName === "string" ? cleanText(target.deviceName, 300) : "";
  return {
    ...(target.tabId !== undefined ? { tabId: target.tabId } : {}),
    title: cleanText(target.title || "Untitled tab", 300),
    url: cleanText(target.url || "", 4000),
    ...(target.platform === "chrome" || target.platform === "react-native" ? { platform: target.platform } : {}),
    ...(targetId ? { targetId } : {}),
    ...(appId ? { appId } : {}),
    ...(deviceName ? { deviceName } : {}),
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

function sourceMapBasename(value: string): string {
  const clean = value.split(/[?#]/)[0];
  return clean.slice(clean.lastIndexOf("/") + 1);
}

/**
 * A bundled module's own `//# sourceMappingURL` comment can survive
 * concatenation, and Chrome reports the last comment it finds in a script. A
 * name that cannot belong to the script points at a file the bundler never
 * emitted, so it is no evidence that this script has a retrievable map.
 */
function sourceMapBelongsToScript(scriptUrl: string, sourceMapURL: string): boolean {
  const script = sourceMapBasename(scriptUrl);
  const map = sourceMapBasename(sourceMapURL).replace(/\.map$/, "");
  if (!script || !map) return true;
  return script.startsWith(map) || map.startsWith(script);
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
  const written = await writeTraceExport({
    spool: spoolPath(record.id),
    destination: join(captureDir(record.id), fileName),
    metadata,
    mainFrame,
    fallbackUrl: record.target.url,
    traceMarker,
  });
  return { export: { fileName, sizeBytes: written.sizeBytes }, eventCount: written.eventCount };
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
    const externalSourceMapsReported = scripts.some((script) => script.sourceMapURL && !script.sourceMapURL.startsWith("data:") && sourceMapBelongsToScript(script.url, script.sourceMapURL));
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
