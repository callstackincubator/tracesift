import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const RECORD_STATE = 'record.json';
export const RECORD_API_VERSION = 1;

/**
 * @typedef {{
 *   apiVersion: 1,
 *   pid: number,
 *   mode: 'ingest' | 'local',
 *   state: 'starting' | 'recording' | 'flushing' | 'captured' | 'failed',
 *   startedAt: number,
 *   url: string,
 *   captureId?: string,
 *   baseUrl?: string,
 *   directory?: string,
 *   export?: { path: string, sizeBytes: number, eventCount: number },
 *   warnings?: string[],
 *   error?: string,
 * }} RecordState
 */

function statePath(home) { return join(home, RECORD_STATE); }

export function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

/** @returns {Promise<RecordState | null>} */
export async function readRecordState(home) {
  let raw;
  try { raw = await readFile(statePath(home), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let state;
  try { state = JSON.parse(raw); }
  catch { return null; }
  return state?.apiVersion === RECORD_API_VERSION ? state : null;
}

async function writeJsonAtomic(home, destination, value) {
  const temporary = join(home, `.record-${randomUUID()}`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** @param {RecordState} state */
export async function writeRecordState(home, state) {
  await writeJsonAtomic(home, statePath(home), state);
}

/** Remove only the state this recorder published, never a later recording. */
export async function clearRecordState(home, pid) {
  const current = await readRecordState(home);
  if (pid && current && current.pid !== pid) return;
  await rm(statePath(home), { force: true });
}

/** A state file left behind by a recorder that died is not an active recording. */
export async function activeRecordState(home) {
  const state = await readRecordState(home);
  if (!state) return null;
  if (['captured', 'failed'].includes(state.state)) return null;
  return processAlive(state.pid) ? state : null;
}
