/** Durations as a reader scans them: whole milliseconds until seconds are clearer. */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0 ms";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(2)} s`;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} m ${Math.round(seconds % 60)} s`;
}

/**
 * Durations as React records them.
 *
 * `formatMs` rounds to whole milliseconds, which is the right width for a CPU
 * task measured in seconds and the wrong one here: a frame is 16 ms, the
 * evidence strings the React analyzer writes carry tenths, and the median self
 * time in a cascade is 0.03 ms — which `formatMs` prints as `0 ms`, turning the
 * most load-bearing figure on the card into a zero.
 */
export function formatReactMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0 ms";
  if (ms < 1) return `${Number(ms.toFixed(2))} ms`;
  if (ms < 1000) return `${Number(ms.toFixed(1))} ms`;
  return formatMs(ms);
}
