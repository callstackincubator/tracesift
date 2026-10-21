/**
 * What kind of code a recorded frame is: the user's own, a dependency, the
 * framework, the engine, or nothing nameable at all.
 *
 * Task cards are arithmetic over this one table. The boundary frames of a task
 * are the outermost `app` frames on its stack and nothing more clever than
 * that, so the quality of a card is the quality of this classification — and,
 * because the table is cached by `name+url`, re-running the same file produces
 * the same cards rather than whatever the model felt like that afternoon.
 *
 * The signals run cheapest first: the URL decides whenever it carries real
 * paths, and the hardcoded framework and runtime-name lists are a floor
 * beneath it. Nothing here asks a model. Uploading a profile is a measurement,
 * and a measurement that silently spends tokens is not one — the only model
 * call tracesift makes is the per-card reading a reader asks for by name.
 *
 * What the rules cannot resolve is a real identifier inside a single bundled
 * artefact, where application and dependency code share one URL. Those frames
 * are filed as `library` and the table is marked `degraded`: a card built on
 * one is still exact about time, and only less sure which frame is the
 * feature. Claiming such a frame as the reader's own would be the worse error.
 */

import { ANONYMOUS_NAMES, SYNTHETIC_CALL_NAMES, TRANSPARENT_NAMES, isMeaningfulFrame } from "./frame-names.ts";
import { isFrameworkInternalFrame } from "./framework-frames.ts";
import { isReadableSourcePath } from "./source-location.ts";
import type { CdpCallFrame } from "../app/js-profiler/types";

export type FrameClass = "app" | "library" | "framework" | "native" | "anonymous";

/** Dependencies, however the bundler spelled the path. */
const DEPENDENCY_URL = /(?:^|[\\/])node_modules[\\/]/;

/**
 * Chunk names a bundler generates for third-party code. These are decisive:
 * nothing a product developer wrote ends up in a file called `vendors~main`.
 *
 * Tested against the file's name rather than the whole URL, and anchored at the
 * start rather than scanning to the end. The URL arrives with an uploaded
 * profile, and a pattern of the shape `prefix[-.][^\\/]*$` is quadratic on a
 * name whose tail never satisfies that end anchor: `vendors~` followed by tens
 * of thousands of dashes and a separator made one classification take seconds,
 * and there is one classification per distinct frame in the recording. Cutting
 * the name first leaves the pattern nothing to backtrack over, because a name
 * carries no separators by construction.
 */
const VENDOR_CHUNK_NAME = /^(?:vendors~[^/\\]*|(?:vendor|vendors|chunk-vendors|framework|polyfills))[-.]/i;

/**
 * Whether a frame's URL names one of those chunks, which is the same as asking
 * whether its last path segment does: the old pattern's `[^\\/]*$` tail already
 * refused a match at anything but the final segment.
 */
function isVendorChunkUrl(url: string): boolean {
  let start = url.length;
  while (start > 0 && url[start - 1] !== "/" && url[start - 1] !== "\\") start -= 1;
  return VENDOR_CHUNK_NAME.test(url.slice(start));
}

/**
 * A single bundled artefact holds application and dependency code together, so
 * its URL says nothing about either. Frames carrying one are exactly the
 * residue the model call exists to resolve.
 */
const BUNDLE_URL = /\.(?:bundle|min\.js)(?:[?#]|$)/i;

/** Schemes that name no file on disk: engine internals, extensions, eval'd code. */
const VIRTUAL_SCHEME = /^(?:node|extensions|chrome-extension|chrome|webpack-internal|v8|evalmachine|blob|data):/i;

/**
 * V8 and Hermes label built-ins `native array.js`. The leading word is the
 * whole signal — the rest of the string is shaped exactly like a source path,
 * which is why `source-location.ts` refuses it too.
 */
const NATIVE_URL = /^native\s/i;

/** Frame identity for the cache. Two frames agreeing on both are one function. */
export function frameClassKey(frame: CdpCallFrame): string {
  return `${frame.functionName}\u0000${frame.url}`;
}

/**
 * The classification the cheap signals can make on their own, or `undefined`
 * when they cannot — which means a real identifier inside a bundle, the one
 * case no rule can settle.
 */
export function classifyByRule(frame: CdpCallFrame, codeSplit = false): FrameClass | undefined {
  const { functionName: name, url } = frame;
  if (TRANSPARENT_NAMES.has(name)) return "native";
  if (NATIVE_URL.test(url)) return "native";
  if (ANONYMOUS_NAMES.has(name) && !url) return "anonymous";
  if (VIRTUAL_SCHEME.test(url)) return "native";
  if (isFrameworkInternalFrame(frame)) return "framework";
  if (DEPENDENCY_URL.test(url) || isVendorChunkUrl(url)) return "library";
  if (ANONYMOUS_NAMES.has(name)) return "anonymous";
  // No URL means the engine, with one exception: the call wrappers V8 parks at
  // the boundary between native and JavaScript name a real call the product
  // made, not work the engine did on its own account.
  if (!url) return SYNTHETIC_CALL_NAMES.has(name) ? "anonymous" : "native";
  // A bundler that emitted a vendor chunk has already sorted the dependencies
  // out of the rest, so a frame in a sibling chunk is the product's own code.
  // This only holds when such a chunk was actually seen in the recording —
  // `codeSplit` carries that, because a single artefact like an React Native
  // `index.bundle` holds application and dependency code together and would
  // otherwise promote lodash to a feature boundary. The name must still carry
  // meaning: the same chunk holds mangled identifiers that would head a card
  // as `l` or `t.A`, and those stay residue.
  if (BUNDLE_URL.test(url)) {
    return codeSplit && !isVendorChunkUrl(url) && isMeaningfulFrame(frame) ? "app" : undefined;
  }
  // A path a developer could open, outside `node_modules`, is their own code.
  // `source-location.ts` already owns the question of what counts as one, and
  // its answer is deliberately narrow.
  if (isReadableSourcePath(url)) return "app";
  return undefined;
}

export interface FrameClassTable {
  classOf(frame: CdpCallFrame): FrameClass;
  /**
   * This profile carried frames inside a bundle that no rule could resolve, so
   * they were filed as `library`. Cards built on a degraded table are still
   * correct about time; they are less reliable about which frame is the
   * feature boundary, and must say so.
   */
  degraded: boolean;
  /** How many distinct frames fell through to {@link UNRESOLVED}, for the log. */
  unresolvedCount: number;
}

/** The residue's fallback. A name inside a bundle is far more often a dependency than the engine. */
const UNRESOLVED: FrameClass = "library";

/**
 * The one classification table, built from the rules alone.
 *
 * The frames are read twice before anything is classified, and both passes
 * are why this takes the whole profile rather than answering one frame at a
 * time. The first asks whether this build split its dependencies into a vendor
 * chunk, because that is what decides how a bundled frame reads: with such a
 * chunk present, a named frame in a sibling chunk is the product's own code,
 * and without one — a React Native `index.bundle`, say — the same frame could
 * be anyone's. The second counts what no rule could settle, which is what
 * `degraded` reports.
 *
 * Callers with no profile in hand, which in practice means tests of the rules
 * themselves, may pass nothing.
 */
export function ruleClassTable(frames: Iterable<CdpCallFrame> = []): FrameClassTable {
  const all = [...frames];
  const codeSplit = all.some((frame) => isVendorChunkUrl(frame.url));
  const unresolved = new Set<string>();
  for (const frame of all) {
    if (!classifyByRule(frame, codeSplit)) unresolved.add(frameClassKey(frame));
  }
  return {
    classOf(frame) {
      return classifyByRule(frame, codeSplit) ?? UNRESOLVED;
    },
    degraded: unresolved.size > 0,
    unresolvedCount: unresolved.size,
  };
}
