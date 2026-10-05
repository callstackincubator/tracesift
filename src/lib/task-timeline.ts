/**
 * A task laid out against the clock, the way Chrome's Performance panel draws
 * it, and with the framework and the engine collapsed away.
 *
 * Every other view in this tool reads the *merged* call tree, where siblings
 * carrying the same frame are folded into one node and children are sorted by
 * weight. That is the right shape for "what cost the most", and it is the wrong
 * shape for "what happened": the horizontal axis means nothing, so fourteen
 * separate renders spread across three seconds are drawn as one wide box, and a
 * reader holding the card against a flame chart cannot line the two up. This
 * module keeps the axis. A box here is one call, at the position it ran.
 *
 * It is built from the same sample sequence the invocation shapes are counted
 * on, so the two agree by construction: a frame with three boxes on this chart
 * is a frame the card says ran three times.
 *
 * Resolution is the sampling interval and nothing finer. Two calls separated by
 * less than one sample merge into a single box, and a call shorter than one
 * sample may not appear at all. That limit is the profiler's, not ours — the
 * frames under `RunTask` in Chrome's own chart are drawn from these same
 * samples and carry it too.
 */

import { isAttributedToParentFrame } from "./frame-names.ts";
import { nodeLocation, nodeName, type CallTreeNode } from "./call-tree.ts";
import type { FrameClass, FrameClassTable } from "./frame-classes.ts";

/** One call, at the position and for the span it ran. */
export interface TimelineBox {
  /**
   * Row, with 0 the outermost *kept* frame. The scheduler and reconciler frames
   * above it are gone, so a product frame that really sat twelve deep is drawn
   * at the top where it can be read.
   */
  depth: number;
  name: string;
  location?: string;
  frameClass: FrameClass;
  /** Offset from the start of the task. */
  startMs: number;
  durationMs: number;
  /**
   * Inclusive, so it covers whatever framework and library work this call
   * delegated to. The gap between a box and its children is that delegated
   * time plus this frame's own.
   */
  selfMs: number;
  /**
   * The merged-tree node to open in the call tree when this box is clicked.
   * Taken from the first sample in the box: a box can span samples reaching the
   * frame by different paths, and the one a reader clicked from is the one it
   * started on.
   */
  nodeId: string;
}

export interface TaskTimeline {
  boxes: TimelineBox[];
  durationMs: number;
  /**
   * Wall time spent under at least one kept frame. The remainder ran entirely
   * in framework or engine code and is drawn as a gap — the chart has to say
   * so, or a reader reads empty space as idle.
   */
  coveredMs: number;
  /** Rows in the chart, which is the deepest nesting *after* collapsing. */
  rows: number;
  /** Which classes survived the filter, so the view can name what it is hiding. */
  kept: FrameClass[];
  /**
   * Calls too narrow to draw, dropped with everything nested inside them. Zero
   * on any ordinary task; the cap exists so a pathological recording cannot
   * hand the browser a million boxes.
   */
  omittedBoxCount: number;
  omittedBoxMs: number;
}

/**
 * Everything except the framework and the engine, expressed as the classes that
 * survive rather than the two that do not.
 *
 * The chart used to keep `app` alone, which assumed the classifier could tell
 * the product's code from its dependencies. In a bundle it frequently cannot:
 * on a webpack build every URL is a hashed chunk, so most real frames come back
 * `library` — either because a rule pinned them there or because the model was
 * never asked — and an app-only chart renders empty while three seconds of work
 * goes undrawn. Keeping both makes that judgement cosmetic: a frame misread as
 * a dependency is still on the chart, in the right place, at the right width.
 *
 * What is dropped is dropped because a reader cannot act on it. Framework
 * internals are the bulk of the rows in a React profile and carry no decision —
 * nobody fixes `commitPassiveMountOnFiber` — and engine built-ins are not calls
 * the product made. Collapsing them lifts the frames they were burying to the
 * top of the chart. `anonymous` stays: it covers both the nameless frames and
 * V8's `Function call` wrappers, which are hard to reason about but do mark
 * where a real call began, and a chart that silently drops them breaks the
 * nesting around the frames a reader came for.
 */
export const SHOWN_CLASSES: readonly FrameClass[] = ["app", "library", "anonymous"];

/**
 * More boxes than a browser can lay out without stalling. A three-second task
 * with the framework collapsed away draws six or seven thousand, so this is a
 * guard rail rather than a working limit.
 */
const MAX_BOXES = 24_000;

interface OpenBox {
  key: string;
  box: TimelineBox;
  /** Index into `boxes`, so a pruned parent can take its descendants with it. */
  index: number;
  endMs: number;
}

export function buildTaskTimeline(
  sampleNodes: readonly (CallTreeNode | null)[],
  weights: readonly number[],
  classes: FrameClassTable,
  durationMs: number,
  kept: readonly FrameClass[] = SHOWN_CLASSES,
): TaskTimeline {
  const keptSet = new Set(kept);
  const boxes: TimelineBox[] = [];
  const parentOf: number[] = [];
  let open: OpenBox[] = [];
  let clock = 0;
  let coveredMs = 0;

  const closeFrom = (depth: number) => {
    for (let index = open.length - 1; index >= depth; index -= 1) {
      open[index].box.durationMs = open[index].endMs - open[index].box.startMs;
    }
    open = open.slice(0, depth);
  };

  for (let index = 0; index < sampleNodes.length; index += 1) {
    const node = sampleNodes[index] ?? null;
    const weight = weights[index] ?? 0;
    if (!node) {
      closeFrom(0);
      clock += weight;
      continue;
    }
    // A collection pause is the running frame's own cost, parked by V8 at the
    // root of the stack. Closing every open box on it would shred a long render
    // into a picket fence, so the sample opens nothing — but the clock still
    // advances, because the pause is wall time the enclosing call spent, and
    // this chart is drawn against the wall clock.
    if (isAttributedToParentFrame(node.frame)) {
      clock += weight;
      for (const entry of open) entry.endMs = clock;
      continue;
    }

    const chain: CallTreeNode[] = [];
    for (let current: CallTreeNode | null = node; current; current = current.parent) {
      // The synthetic tree root is not a frame anyone called.
      if (current.parent !== null && keptSet.has(classes.classOf(current.frame))) chain.push(current);
    }
    chain.reverse();

    // Matched on frame identity rather than node identity: after collapsing,
    // the same frame reached through two different framework paths in
    // consecutive samples is one call that the framework re-entered, not two.
    let shared = 0;
    while (shared < open.length && shared < chain.length && open[shared].key === chain[shared].key) shared += 1;
    closeFrom(shared);

    for (let depth = shared; depth < chain.length; depth += 1) {
      const source = chain[depth];
      const location = nodeLocation(source);
      const box: TimelineBox = {
        depth,
        name: nodeName(source),
        ...(location ? { location } : {}),
        frameClass: classes.classOf(source.frame),
        startMs: clock,
        durationMs: 0,
        selfMs: 0,
        nodeId: source.id,
      };
      parentOf.push(depth > 0 ? open[depth - 1].index : -1);
      boxes.push(box);
      open.push({ key: source.key, box, index: boxes.length - 1, endMs: clock });
    }

    clock += weight;
    for (const entry of open) entry.endMs = clock;
    if (open.length > 0) {
      coveredMs += weight;
      // Self time is what the innermost kept frame did not hand to another kept
      // frame. Framework work it delegated to counts as its own here, because
      // after collapsing there is nothing else on the chart to charge it to.
      open[open.length - 1].box.selfMs += weight;
    }
  }
  closeFrom(0);

  const pruned = prune(boxes, parentOf, durationMs);
  return {
    boxes: pruned.boxes.map(round),
    durationMs: round1(durationMs),
    coveredMs: round1(coveredMs),
    rows: pruned.boxes.reduce((deepest, box) => Math.max(deepest, box.depth + 1), 0),
    kept: [...kept],
    omittedBoxCount: pruned.omittedBoxCount,
    omittedBoxMs: round1(pruned.omittedBoxMs),
  };
}

/**
 * Drops the narrowest calls until the chart fits, each with everything nested
 * inside it. Taking the subtree whole is what keeps the result a chart: a box
 * removed on its own would leave its children floating a row below nothing.
 */
function prune(
  boxes: TimelineBox[],
  parentOf: number[],
  durationMs: number,
): { boxes: TimelineBox[]; omittedBoxCount: number; omittedBoxMs: number } {
  if (boxes.length <= MAX_BOXES) return { boxes, omittedBoxCount: 0, omittedBoxMs: 0 };

  // Start at a width no screen could draw and double until the count fits. A
  // box opens after its parent, so one forward pass settles every ancestor.
  let floor = durationMs > 0 ? durationMs / MAX_BOXES : 0;
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const dropped = boxes.map(() => false);
    let kept = 0;
    for (let index = 0; index < boxes.length; index += 1) {
      const parent = parentOf[index];
      dropped[index] = (parent >= 0 && dropped[parent]) || boxes[index].durationMs < floor;
      if (!dropped[index]) kept += 1;
    }
    if (kept <= MAX_BOXES) {
      const survivors: TimelineBox[] = [];
      let omittedBoxCount = 0;
      let omittedBoxMs = 0;
      for (let index = 0; index < boxes.length; index += 1) {
        if (dropped[index]) {
          omittedBoxCount += 1;
          // Only the outermost dropped box contributes: its time already
          // includes everything that went with it.
          if (parentOf[index] < 0 || !dropped[parentOf[index]]) omittedBoxMs += boxes[index].durationMs;
          continue;
        }
        survivors.push(boxes[index]);
      }
      return { boxes: survivors, omittedBoxCount, omittedBoxMs };
    }
    floor *= 2;
  }
  return { boxes: boxes.slice(0, MAX_BOXES), omittedBoxCount: boxes.length - MAX_BOXES, omittedBoxMs: 0 };
}

/** Microsecond precision. A chart is read by eye, and the payload is per box. */
function round(box: TimelineBox): TimelineBox {
  return {
    ...box,
    startMs: Math.round(box.startMs * 1000) / 1000,
    durationMs: Math.round(box.durationMs * 1000) / 1000,
    selfMs: Math.round(box.selfMs * 1000) / 1000,
  };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
