import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { writeTraceExport } from './trace-export.js';

/**
 * A sink receives the raw trace Chrome streams back and turns it into a
 * finished export. Two exist: one hands the bytes to a running TraceSift so the
 * capture appears in its UI, the other writes the same `.json.gz` on its own.
 *
 * @typedef {{
 *   mode: 'ingest' | 'local',
 *   captureId: string,
 *   directory?: string,
 *   baseUrl?: string,
 *   status(update: Record<string, unknown>): Promise<void>,
 *   stopRequested(): Promise<boolean>,
 *   chunk(bytes: Uint8Array): Promise<void>,
 *   finalize(input: Record<string, unknown>): Promise<{ path?: string, fileName: string, sizeBytes: number, eventCount: number, warnings: string[] }>,
 *   fail(message: string, reason?: string): Promise<void>,
 * }} RecordSink
 */

async function jsonFetch(url, init = {}) {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `TraceSift returned HTTP ${response.status}.`);
  return body;
}

function authHeaders(token) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

function exportStamp(createdAt) {
  return new Date(createdAt).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Build the enhanced-trace `metadata` object, matching what the web app writes
 * for an extension capture so both exports import identically.
 */
function exportMetadata(captureId, target, createdAt, scripts, sourceMaps) {
  return {
    enhancedTraceVersion: 1,
    sourceMaps,
    traceSift: {
      captureId,
      target,
      createdAt: new Date(createdAt).toISOString(),
      scripts,
    },
  };
}

/** Hand the trace to a running TraceSift, exactly as the extension does. */
export async function createIngestSink(service, target, title) {
  const { capture, uploadToken } = await jsonFetch(`${service.baseUrl}/api/captures`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, target }),
  });
  let sequence = 0;
  return {
    mode: 'ingest',
    captureId: capture.id,
    baseUrl: service.baseUrl,
    async status(update) {
      await jsonFetch(`${service.baseUrl}/api/captures/${capture.id}/ingest/status`, {
        method: 'POST', headers: authHeaders(uploadToken), body: JSON.stringify(update),
      });
    },
    async stopRequested() {
      const result = await jsonFetch(`${service.baseUrl}/api/captures/${capture.id}`, { cache: 'no-store' });
      return result.capture?.state === 'stop_requested';
    },
    async chunk(bytes) {
      const response = await fetch(`${service.baseUrl}/api/captures/${capture.id}/ingest/raw?sequence=${sequence}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${uploadToken}` },
        body: bytes,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `TraceSift returned HTTP ${response.status}.`);
      sequence += 1;
    },
    async finalize(input) {
      const result = await jsonFetch(`${service.baseUrl}/api/captures/${capture.id}/ingest/finalize`, {
        method: 'POST', headers: authHeaders(uploadToken), body: JSON.stringify(input),
      });
      const record = result.capture ?? result;
      return {
        fileName: record.export?.fileName ?? '',
        sizeBytes: record.export?.sizeBytes ?? 0,
        eventCount: record.eventCount ?? 0,
        warnings: record.warnings ?? [],
      };
    },
    async fail(message, reason = 'error') {
      await this.status({ state: 'failed', stopReason: reason, error: message }).catch(() => undefined);
    },
  };
}

/**
 * Write the trace without a running TraceSift. Recordings live beside the
 * capture store rather than inside it: they carry none of the store's
 * bookkeeping, so they must not look like records it owns.
 */
export async function createLocalSink(home, target, options = {}) {
  const captureId = randomUUID();
  const createdAt = Date.now();
  const directory = join(home, 'recordings', captureId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const spool = join(directory, 'trace.spool');
  await writeFile(spool, '', { flag: 'wx', mode: 0o600 });
  const fileName = `Trace-${exportStamp(createdAt)}.json.gz`;
  const destination = options.out
    ? resolve(isAbsolute(options.out) ? options.out : join(process.cwd(), options.out))
    : join(directory, fileName);
  return {
    mode: 'local',
    captureId,
    directory,
    async status() { /* No server holds this recording's state; record.json does. */ },
    async stopRequested() { return false; },
    async chunk(bytes) { await appendFile(spool, bytes); },
    async finalize(input) {
      await mkdir(dirname(destination), { recursive: true });
      const written = await writeTraceExport({
        spool,
        destination,
        metadata: exportMetadata(captureId, target, createdAt, input.scripts ?? [], input.sourceMaps ?? []),
        mainFrame: input.mainFrame,
        fallbackUrl: target.url,
        traceMarker: input.traceMarker,
      });
      // The spool is several times the size of the export it produced and
      // nothing reads it again once the gzip is on disk.
      await rm(spool, { force: true });
      return {
        path: destination,
        fileName: destination.slice(destination.lastIndexOf('/') + 1),
        sizeBytes: written.sizeBytes,
        eventCount: written.eventCount,
        warnings: input.warnings ?? [],
      };
    },
    async fail() { /* The caller records the failure in record.json. */ },
  };
}
