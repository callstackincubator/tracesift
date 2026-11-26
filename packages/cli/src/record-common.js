import { createIngestSink, createLocalSink } from './record-sink.js';
import { readActiveService } from './service.js';

export const TRACE_CATEGORIES = [
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

export function errorText(error) {
  return error instanceof Error ? error.message : String(error || 'Unknown recording error.');
}


/** Choose where the trace goes: a running TraceSift if there is one, else disk. */
export async function resolveSink(home, target, title, options) {
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
