/**
 * Frame positions moved from the bundle they were sampled in back onto the
 * files a developer wrote.
 *
 * Everything downstream reads a frame's URL as a statement about whose code it
 * is: `frame-classes.ts` sorts `node_modules` from the product, `task-cards.ts`
 * picks a card's boundary from that sorting, and `source-location.ts` decides
 * whether a position is worth printing. A bundler defeats all three at once,
 * because it gives every frame in the recording one URL. Chrome's own profiles
 * mostly escape it — a dev server serves real paths, and a split build names a
 * vendor chunk — but a React Native recording never does: Metro serves one
 * `index.bundle`, so the product's screens, React's reconciler and every
 * dependency arrive indistinguishable, fall to the `library` fallback, and the
 * first internal with an ordinary-looking name becomes a card's headline.
 *
 * The capture already carries the answer. `record-session.js` harvests maps
 * over `Debugger.scriptParsed`, `record-rn-session.js` fetches Metro's `.map`
 * for each bundle a frame mentions, and `capture-store.ts` writes both into the
 * export's `metadata.sourceMaps` under DevTools' enhanced-trace schema. Until
 * now nothing read them back: `normalize.ts` reported `state: "none"` for every
 * upload, and the `bundleUrl` / `symbolicationStatus` fields its own frame type
 * declares were never filled.
 *
 * This runs once, over the parsed profile, before the frames are classified.
 */

import { AnyMap, originalPositionFor, type TraceMap } from "@jridgewell/trace-mapping";
import { stripRequest } from "./source-location.ts";
import type { CdpCallFrame, CdpProfile, SourceMapsInfo, SymbolicationFailure } from "../app/js-profiler/types.ts";

/** One map as the capture retained it. Mirrors `CaptureSourceMap`. */
export interface RetainedSourceMap {
  url: string;
  sourceMapUrl: string;
  sourceMap: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * The maps an exported trace carries, or nothing.
 *
 * A profile uploaded as a bare `.cpuprofile`, or exported by DevTools itself,
 * has none — which is not a failure, just a recording that was never enriched.
 */
export function collectRetainedSourceMaps(raw: unknown): RetainedSourceMap[] {
  if (!isRecord(raw) || !isRecord(raw.metadata)) return [];
  const maps = raw.metadata.sourceMaps;
  if (!Array.isArray(maps)) return [];
  const out: RetainedSourceMap[] = [];
  for (const entry of maps) {
    if (!isRecord(entry)) continue;
    if (typeof entry.url !== "string" || !isRecord(entry.sourceMap)) continue;
    out.push({
      url: entry.url,
      sourceMapUrl: typeof entry.sourceMapUrl === "string" ? entry.sourceMapUrl : "",
      sourceMap: entry.sourceMap,
    });
  }
  return out;
}

/**
 * The bundle URL a frame and a retained map agree on.
 *
 * Exact first, because that is what the capture stored. The fallback drops the
 * request, which is the one difference the two can have and still name the same
 * artefact: Metro writes a bundle's build options into the path itself
 * (`/index.bundle//&platform=ios&dev=true&…`), and a frame recorded before the
 * options changed carries a different tail for the same file.
 */
function mapKeys(url: string): string[] {
  const exact = url.split("#")[0];
  const stripped = stripRequest(exact);
  return stripped && stripped !== exact ? [exact, stripped] : [exact];
}

/**
 * A map held until something asks it a question.
 *
 * `trace-mapping` decodes a map's `mappings` on first lookup, and a Metro dev
 * map runs to tens of megabytes. A recording routinely mentions bundles no
 * frame was ever sampled in — a polyfill chunk, a second entry point — so
 * decoding on registration would spend that cost for nothing.
 */
interface LazyMap {
  entry: RetainedSourceMap;
  /** `undefined` until first use, `null` once it has failed to parse. */
  trace?: TraceMap | null;
}

/**
 * Deliberately not resolved against the map's own URL.
 *
 * `new AnyMap(map, mapUrl)` would rewrite every `sources` entry relative to the
 * URL the map was served from, which is exactly wrong here: Metro lists its
 * sources as absolute filesystem paths, and resolving `/Users/me/app/App.tsx`
 * against `http://localhost:8081/index.map` yields an `http:` URL that
 * `isReadableSourcePath` then refuses — turning a frame we had just located
 * back into an unclassifiable one. webpack's `webpack://` sources are already
 * handled downstream by `unwrapBundlerUrl`, so neither needs resolution.
 */
function traceFor(lazy: LazyMap, failures: SymbolicationFailure[]): TraceMap | null {
  if (lazy.trace !== undefined) return lazy.trace;
  try {
    lazy.trace = new AnyMap(lazy.entry.sourceMap as never);
  } catch (error) {
    lazy.trace = null;
    failures.push({
      bundleUrl: lazy.entry.url,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  return lazy.trace;
}

/** What a position resolved to, or `null` when the map had nothing for it. */
interface Resolved {
  url: string;
  lineNumber: number;
  columnNumber: number;
}

function state(mappable: number, symbolicated: number, maps: number): SourceMapsInfo["state"] {
  if (maps === 0) return "none";
  if (symbolicated === 0) return "failed";
  return symbolicated === mappable ? "full" : "partial";
}

/**
 * Rewrite every frame that a retained map can place, in situ.
 *
 * In situ because the parsed profile is the one copy: the analyze route hands
 * the same object to the call tree, the task splitter and the classification
 * table, and a profile that runs to hundreds of megabytes is not duplicated to
 * spare a mutation. The bundle position is kept on the frame rather than
 * discarded — `normalize.ts` reports it, and it is the only way back to what
 * was actually sampled.
 */
export function symbolicateProfile(profile: CdpProfile, maps: readonly RetainedSourceMap[], captureWarnings: readonly string[] = []): SourceMapsInfo {
  const failures: SymbolicationFailure[] = [];
  const bundleUrls = [...new Set(maps.map((entry) => entry.url))];
  const resolvedSourceMapUrls = [...new Set(maps.map((entry) => entry.sourceMapUrl).filter(Boolean))];
  const empty: SourceMapsInfo = {
    state: "none",
    bundleUrls,
    resolvedSourceMapUrls,
    symbolicatedFrameCount: 0,
    totalMappableFrameCount: 0,
    failures,
    captureWarnings: [...captureWarnings],
  };
  if (maps.length === 0) return empty;

  const byKey = new Map<string, LazyMap>();
  for (const entry of maps) {
    const lazy: LazyMap = { entry };
    for (const key of mapKeys(entry.url)) if (!byKey.has(key)) byKey.set(key, lazy);
  }

  // One profile holds far more nodes than distinct positions — a function
  // reached from twenty call paths is twenty nodes at one line and column.
  const cache = new Map<string, Resolved | null>();
  let mappable = 0;
  let symbolicated = 0;

  for (const node of profile.nodes) {
    const frame = node.callFrame;
    if (!frame.url || frame.lineNumber < 0) continue;
    const lazy = byKey.get(frame.url.split("#")[0]) ?? byKey.get(stripRequest(frame.url.split("#")[0]));
    if (!lazy) continue;
    mappable += 1;

    const key = `${frame.url}\u0000${frame.lineNumber}\u0000${frame.columnNumber}`;
    let resolved = cache.get(key);
    if (resolved === undefined) {
      resolved = resolve(lazy, frame, failures);
      cache.set(key, resolved);
    }
    if (!resolved) continue;

    symbolicated += 1;
    frame.bundleUrl = frame.url;
    frame.bundleLineNumber = frame.lineNumber;
    frame.bundleColumnNumber = frame.columnNumber;
    frame.url = resolved.url;
    frame.lineNumber = resolved.lineNumber;
    frame.columnNumber = resolved.columnNumber;
  }

  return {
    state: state(mappable, symbolicated, maps.length),
    bundleUrls,
    resolvedSourceMapUrls,
    symbolicatedFrameCount: symbolicated,
    totalMappableFrameCount: mappable,
    failures,
    captureWarnings: [...captureWarnings],
  };
}

/**
 * The warnings the capture wrote into the export, if it wrote any.
 *
 * `record.json` holds these too, but the next recording overwrites it, so by
 * the time an export is opened they are only here.
 */
export function collectCaptureWarnings(raw: unknown): string[] {
  if (!isRecord(raw) || !isRecord(raw.metadata) || !isRecord(raw.metadata.traceSift)) return [];
  const warnings = raw.metadata.traceSift.warnings;
  if (!Array.isArray(warnings)) return [];
  return warnings.filter((entry): entry is string => typeof entry === "string").slice(0, 100);
}

/**
 * CDP counts a frame's line and column from zero; a source map counts lines
 * from one and columns from zero. A frame recorded with no column (`-1`) is
 * asked for at the start of its line, which is the right answer for a position
 * the engine only knew that precisely.
 */
function resolve(lazy: LazyMap, frame: CdpCallFrame, failures: SymbolicationFailure[]): Resolved | null {
  const trace = traceFor(lazy, failures);
  if (!trace) return null;
  const found = originalPositionFor(trace, {
    line: frame.lineNumber + 1,
    column: Math.max(0, frame.columnNumber),
  });
  if (!found.source) return null;
  return {
    url: found.source,
    lineNumber: typeof found.line === "number" ? Math.max(0, found.line - 1) : -1,
    columnNumber: typeof found.column === "number" ? found.column : -1,
  };
}
