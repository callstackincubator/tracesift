/**
 * The whole recording merged into one row per function.
 *
 * Every other CPU view in this tool is scoped to a task, which is what makes
 * its figures addressable on a timeline. The cost is that a function called
 * from several tasks is reported once per task and never as itself: a reader
 * who measures `getChildTransactions` at 206 ms in another tool and finds a
 * 103 ms card here has been told the truth about one block and nothing about
 * the function. This view answers the other question — what did this function
 * cost across the whole recording — and it is the figure that lines up with
 * the per-function totals a flame-graph tool reports.
 *
 * It is built from the same call tree the cards are, rather than from the
 * normalized session's own hotspot roll-up, for two reasons. The weights are
 * then the ones every other figure on the page was derived from, so the two
 * views cannot disagree. And the roll-up drops any frame that was never itself
 * the sampled leaf, which is exactly the wrong frame to drop here: a component
 * that delegates all its work has no self time at all. On one local trace that
 * filter removes `Search_Search` (1086 ms), `Search_SearchTypeMenuWide`
 * (325 ms) and `useSearchTypeMenuSections` (302 ms) — the frames a reader came
 * to find.
 */

import { nodeLocation, preOrder, type CallTree, type CallTreeNode } from "./call-tree.ts";
import { frameLocations } from "./frame-location.ts";
import { isMeaningfulFrame } from "./frame-names.ts";
import { SHOWN_CLASSES } from "./task-timeline.ts";
import type { FrameClass, FrameClassTable } from "./frame-classes.ts";
import type { CdpCallFrame } from "../app/js-profiler/types.ts";

const DRAWABLE = new Set<FrameClass>(SHOWN_CLASSES);

/**
 * How many rows reach the client at all. The page reveals them a page at a
 * time, so this is not what a reader first sees — it is the bound on the
 * payload and on the saved analysis, which a recording of a real app would
 * otherwise push past a thousand rows. What is left is reported as a count.
 */
const MAX_FUNCTIONS = 150;

/** Below this a function is not worth a row however the recording is sliced. */
const MIN_TOTAL_MS = 1;

export interface ProfileFunction {
  /** Stable within one analysis, and what a row is keyed by. */
  id: string;
  name: string;
  /** Where it came from, shown only when the name does not locate it by itself. */
  location?: string;
  /** Wall time with this function anywhere on the stack, across the recording. */
  totalMs: number;
  /** Wall time it was the function actually running. */
  selfMs: number;
  /** `totalMs` as a share of the recording. */
  totalPercent: number;
}

export interface ProfileFunctionSet {
  functions: ProfileFunction[];
  /** Functions that cleared the floor but ranked past {@link MAX_FUNCTIONS}, kept as a number. */
  omittedCount: number;
  durationMs: number;
}

/**
 * Framework frames go for the same reason the task cards drop them:
 * `performWorkOnRoot` is on the stack for every render in the recording, so
 * ranking by inclusive time without this filter returns React's own call stack
 * in descending order and nothing a reader can act on. On the local trace the
 * first eight rows would be `performWorkOnRoot`, `performUnitOfWork`,
 * `performSyncWorkOnRoot`, `workLoopSync` and friends, all within 150 ms of
 * each other.
 */
function isShown(frame: CdpCallFrame, classes: FrameClassTable): boolean {
  return DRAWABLE.has(classes.classOf(frame)) && isMeaningfulFrame(frame);
}

/**
 * A key already on the ancestor chain has had this node's time counted once
 * already: `walk` calling `walk` is one 40 ms call, not 40 ms plus the 30 ms
 * of its own tail. Self time carries no such risk and is summed outright.
 */
function countsTowardTotal(node: CallTreeNode): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (current.key === node.key) return false;
  }
  return true;
}

interface Accumulated {
  node: CallTreeNode;
  selfMs: number;
  totalMs: number;
}

export function selectProfileFunctions(
  tree: CallTree,
  classes: FrameClassTable,
  durationMs: number,
): ProfileFunctionSet {
  const byKey = new Map<string, Accumulated>();

  for (const node of preOrder(tree.root)) {
    // The root is the recording itself, not a function anyone wrote.
    if (!node.parent) continue;
    const seen = byKey.get(node.key);
    const totalMs = countsTowardTotal(node) ? node.totalMs : 0;
    if (seen) {
      seen.selfMs += node.selfMs;
      seen.totalMs += totalMs;
      // Keep the heaviest occurrence, so the location shown is the one that
      // accounts for most of the time rather than whichever came first.
      if (node.totalMs > seen.node.totalMs) seen.node = node;
    } else {
      byKey.set(node.key, { node, selfMs: node.selfMs, totalMs });
    }
  }

  const kept = [...byKey.values()]
    .filter((entry) => entry.totalMs >= MIN_TOTAL_MS && isShown(entry.node.frame, classes))
    .sort((a, b) => b.totalMs - a.totalMs || a.node.frame.functionName.localeCompare(b.node.frame.functionName));

  const shown = kept.slice(0, MAX_FUNCTIONS);
  // Decided across the shown rows only: whether a position earns its place
  // depends on how many same-named frames the reader is looking at.
  const locations = frameLocations(
    shown.map((entry) => ({ name: entry.node.frame.functionName, location: nodeLocation(entry.node) })),
  );

  return {
    functions: shown.map((entry) => {
      const name = entry.node.frame.functionName;
      const location = locations.shown(name, nodeLocation(entry.node));
      return {
        id: entry.node.key,
        name,
        ...(location ? { location } : {}),
        totalMs: round1(entry.totalMs),
        selfMs: round1(entry.selfMs),
        totalPercent: durationMs > 0 ? round1((entry.totalMs / durationMs) * 100) : 0,
      };
    }),
    omittedCount: Math.max(0, kept.length - shown.length),
    durationMs: round1(durationMs),
  };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
