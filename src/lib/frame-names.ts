/**
 * One authority for deciding how much a recorded frame name explains.
 *
 * The selection code used to answer that question three different ways — a
 * runtime-name set, a dispatch-name set, and "has a non-empty functionName" —
 * which is how `(anonymous)` became a legal card title and why `Function call`
 * was filtered nowhere at all. A card's title is the one string a developer
 * reads first, so the bar for it is a single decision made here.
 */

import { isFrameworkInternalFrame } from "./framework-frames.ts";
import type { CdpCallFrame } from "../app/js-profiler/types";

/**
 * Frames that are the engine talking about itself. They carry real cost and so
 * stay in the tree, but they describe no call a developer can change and are
 * walked straight through when a parent is chosen.
 */
export const TRANSPARENT_NAMES = new Set([
  "(root)",
  "(program)",
  "(idle)",
  "(garbage collector)",
  "(optimized code)",
  "(anonymous function)",
]);

/** Work-loop plumbing: real functions, but never the answer to "what is slow". */
export const DISPATCH_NAMES = new Set([
  "processTicksAndRejections",
  "runMicrotasks",
  "processTimers",
  "listOnTimeout",
  "flushWork",
  "workLoop",
  "performWorkUntilDeadline",
]);

/** Every spelling of "this frame has no name". */
export const ANONYMOUS_NAMES = new Set(["", "(anonymous)", "anonymous", "<anonymous>"]);

/**
 * V8's label for a call it entered from outside JavaScript — an event handler,
 * a timer, a microtask drain. It carries no URL, which would otherwise sort it
 * with the engine built-ins and hide it, and that is wrong: a built-in is work
 * the engine did, while this is the moment the engine handed control back to
 * the product. On a time-ordered chart it is the frame that says *a new piece
 * of work started here*, so it is kept and classified alongside `(anonymous)`:
 * a real call boundary whose name explains nothing on its own.
 */
export const SYNTHETIC_CALL_NAMES = new Set(["Function call", "FunctionCall"]);

/**
 * Names that exist but explain nothing: generic call wrappers, module loaders,
 * and the shapes async transpilation leaves behind. Titling a card `eval` or
 * `Function call` tells a developer strictly less than the frame below it.
 */
export const OPAQUE_NAMES = new Set([
  "Function call",
  "FunctionCall",
  "(unknown)",
  "eval",
  "require",
  "metroRequire",
  "__webpack_require__",
  "loadModuleImplementation",
  "guardedLoadModule",
  "call",
  "apply",
  "bind",
  "tryCatch",
  "asyncGeneratorStep",
  "_asyncToGenerator",
  "step",
  "invokeFunc",
]);

/**
 * `t`, `_r`, `Ci` — a real name from a minified bundle that still says nothing.
 * Two characters, not three: `map`, `get`, `run` and `top` are far more often
 * something a developer wrote than a mangled identifier.
 */
const MINIFIED = /^[_$A-Za-z][_$A-Za-z0-9]?$/;

/**
 * 0 — never a title.
 * 1 — never a title either, but a real identifier: worth reading inside a call
 *     tree, worth nothing as a heading.
 * 2 — names something a developer wrote.
 *
 * Tiers 0 and 1 both fail to title a card, for different reasons. `t` names
 * nothing at all; `beginWork` and `commitLayoutEffectOnFiber` name React's own
 * machinery, so a card headed by one reports that React ran, which is never the
 * finding. The descent walks past both to the application frames underneath,
 * and a branch with no application frame anywhere is dropped rather than
 * titled with an internal.
 */
export type NameTier = 0 | 1 | 2;

/**
 * The half of the tier test that needs only the name, for a caller holding a
 * frame's name and class but not the recorded frame — a node in a shipped task
 * tree, for one. The other half is `isFrameworkInternalFrame`, which a caller
 * in that position asks `frameClass` instead.
 */
export function isMeaningfulName(name: string): boolean {
  if (
    ANONYMOUS_NAMES.has(name)
    || TRANSPARENT_NAMES.has(name)
    || OPAQUE_NAMES.has(name)
    || DISPATCH_NAMES.has(name)
  ) {
    return false;
  }
  return !MINIFIED.test(name);
}

export function frameNameTier(frame: CdpCallFrame): NameTier {
  const name = frame.functionName;
  if (
    ANONYMOUS_NAMES.has(name)
    || TRANSPARENT_NAMES.has(name)
    || OPAQUE_NAMES.has(name)
    || DISPATCH_NAMES.has(name)
  ) {
    return 0;
  }
  // Framework internals are demoted rather than banned: they still carry real
  // information inside a call tree or a hot path, they just cannot head one.
  if (MINIFIED.test(name) || isFrameworkInternalFrame(frame)) return 1;
  return 2;
}

export function isTransparentFrame(frame: CdpCallFrame): boolean {
  return TRANSPARENT_NAMES.has(frame.functionName);
}

export function isMeaningfulFrame(frame: CdpCallFrame): boolean {
  return frameNameTier(frame) === 2;
}

/** The frame's own name when it is meaningful, otherwise nothing. */
export function meaningfulName(frame: CdpCallFrame): string | undefined {
  return frameNameTier(frame) === 2 ? frame.functionName : undefined;
}

/**
 * Frames that are the running function's own cost rather than something it
 * called. V8 parks them at the root of the stack instead of under the frame
 * that triggered them, so to every reader of a sample they look like the whole
 * JS stack returned and a new one began.
 */
export const ATTRIBUTED_TO_PARENT = new Set(["(garbage collector)", "(optimized code)"]);

export function isAttributedToParentFrame(frame: CdpCallFrame): boolean {
  return ATTRIBUTED_TO_PARENT.has(frame.functionName);
}
