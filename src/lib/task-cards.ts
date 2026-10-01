/**
 * One card per task.
 *
 * The node-based engine in `profile-cards.ts` had to answer "which single node
 * deserves a card", and every one of its rules — the R1-R6 descent, the
 * self-time ratio, the dominant-child ratio, the maximum card share — existed
 * only because there was no natural unit to hang a card on. A task is that
 * unit, so none of them are carried over: the boundary of a card is now a
 * classification lookup and its culprits are a sort.
 *
 * What that buys is arithmetic that holds. Tasks are disjoint, so their shares
 * add to at most 100%; self time inside a task is a true partition, so no
 * millisecond is claimed twice; and every headline number has a start offset a
 * reader can scrub to in a flame chart and check.
 */

import {
  compareByWeight,
  buildCallTree,
  nodeLabel,
  nodeLocation,
  nodeName,
  preOrder,
  sampleWeightsMs,
  type CallTree,
  type CallTreeNode,
} from "./call-tree.ts";
// Garbage collection and deoptimisation are charged to the frame that
// triggered them, so they never appear as culprits in their own right.
import { ATTRIBUTED_TO_PARENT, isTransparentFrame } from "./frame-names.ts";
import { effectiveSelfMs, selectCards, type ProfileCard } from "./profile-cards.ts";
import { formatMs } from "./format.ts";
import {
  invocationShapes,
  taskProfile,
  type InvocationShape,
  type ProfileTask,
  type TaskBoundaryKind,
  type TaskSet,
} from "./tasks.ts";
import type { FrameClass, FrameClassTable } from "./frame-classes.ts";
import type { CdpProfile } from "../app/js-profiler/types";

/**
 * The platform's own definition of a long task. A card is a claim that a user
 * could feel this block, and 50 ms is where the browser, React Native and every
 * profiler UI agree that they can.
 */
const LONG_TASK_MS = 50;

/**
 * The relative half of the cut. On a one-second interaction trace this is 10 ms
 * and the 50 ms floor governs; on a ninety-second startup trace it is 900 ms,
 * which is the scale at which a block is worth a reader's attention in a
 * recording that long. Without it such a trace produces hundreds of cards, all
 * of them technically long tasks.
 */
const TASK_SHARE_MIN = 0.01;

/** More cards than this is a list nobody reads; the tail is reported as a count instead. */
const MAX_TASK_CARDS = 12;

/** Culprits past the fifth are noise: their self time is already in the task total. */
const MAX_CULPRITS = 5;

/** A culprit holding less of the task than this explains none of why the task was long. */
const CULPRIT_MIN_SHARE = 0.03;

/**
 * Boundary frames are the card's rows, so this is how many findings a card
 * offers. Past the eighth the tail is small enough that the unattributed
 * footnote says as much as another row would.
 */
const MAX_BOUNDARY_FRAMES = 8;

/**
 * A boundary frame holding less of the task than this is not why the task was
 * long. Deliberately far below the culprit floor: this one is measured against
 * inclusive time, where an application frame that delegates its work still
 * carries the full weight of what it called.
 */
const BOUNDARY_MIN_SHARE = 0.02;

/** Root to frame, and frame to hot leaf, compacted at the same width the old cards used. */
const MAX_PATH_FRAMES = 8;

/** A card built on fewer samples than this is a hint, not a measurement. */
const LOW_CONFIDENCE_SAMPLES = 20;

/**
 * Twenty times the long-task definition. A block this long is not one thing a
 * user waited for, it is a phase — React Native startup is routinely one 8 s
 * task — and a flat culprit list cannot say which part of it to look at, so the
 * old descent is run inside it to break it into named pieces.
 */
const OVERLONG_TASK_MS = 20 * LONG_TASK_MS;

/** Segments past the fifth repeat what the culprit list already said. */
const MAX_SEGMENTS = 5;


const round1 = (value: number) => Math.round(value * 10) / 10;
const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * The outermost application frame on one branch: which feature this task is.
 *
 * These are what a card ranks by. No boundary frame is an ancestor of another —
 * the search stops at the first application frame on each branch — so they form
 * an antichain and their inclusive times are disjoint, summing to at most the
 * task duration. That is the same arithmetic guarantee self time offers, in the
 * unit a flame chart actually draws: a block's width is its inclusive time, and
 * ranking by self time instead reports the thin sliver at the top of each block
 * while calling the rest of the task too small to list.
 */
export interface BoundaryFrame {
  name: string;
  location?: string;
  /** Node id inside this task's tree, so the UI can open Explore focused on it. */
  nodeId: string;
  totalMs: number;
  /** Effective self time summed over this frame's calls, including GC it triggered. */
  selfMs: number;
  invocations: number;
  longestCallMs: number;
  /** `ran 54 times in this task · 424 ms total · longest single call 11 ms` */
  shapeText: string;
}

export interface TaskCulprit {
  name: string;
  location?: string;
  frameClass: FrameClass;
  /** Effective self time inside this task, including the GC this frame triggered. */
  selfMs: number;
  /** Inclusive time across this frame's calls in this task. */
  totalMs: number;
  invocations: number;
  longestCallMs: number;
  /** `ran 54 times in this task · 424 ms total · longest single call 11 ms` */
  shapeText: string;
  /** The heaviest node carrying this frame, for the Explore focus link. */
  nodeId: string;
  reachedVia: string[];
  hotPath: string[];
}

/** One node of a task's call tree, shipped whole — the payload is bounded by the task. */
export interface TaskTreeNode {
  id: string;
  name: string;
  location?: string;
  frameClass: FrameClass;
  totalMs: number;
  selfMs: number;
  invocations: number;
  children: TaskTreeNode[];
}

export interface TaskCard {
  /** `task-3`. Stable for a given profile, and what a hand-off and an Explore link are keyed by. */
  id: string;
  taskIndex: number;
  startMs: number;
  durationMs: number;
  boundaries: TaskBoundaryKind;
  /** `A 1502 ms task 3.2 s into the recording` */
  headline: string;
  percentOfProfile: number;
  boundaryFrames: BoundaryFrame[];
  culprits: TaskCulprit[];
  tree: TaskTreeNode;
  subtreeFunctionCount: number;
  confidence: "ok" | "low";
  /**
   * The old node descent run inside this one task. Present only for a task long
   * enough that it is a phase rather than a single piece of work; scoped to one
   * disjoint block, the overlapping-cards problem that retired the descent
   * cannot occur.
   */
  segments?: ProfileCard[];
}

export interface TaskCardSet {
  cards: TaskCard[];
  boundaries: TaskBoundaryKind;
  /**
   * No task cleared the long-task cut, so the cards below are simply the
   * busiest work in the recording. A scroll profile that returns a blank screen
   * reads as a broken tool rather than as a finding, so the analysis never
   * comes back empty while there is any task at all.
   */
  noLongTasks: boolean;
  /** Frames inside a bundle were classified by rules alone, so boundary frames are less reliable. */
  classesDegraded: boolean;
  durationMs: number;
  taskCount: number;
  /** Tasks that cleared the cut but ranked past `MAX_TASK_CARDS`, kept as a number. */
  omittedTaskCount: number;
  omittedTaskMs: number;
}

/** Keep the entry point and the frames nearest the cost; say how many went missing. */
function compactPath(frames: string[]): string[] {
  if (frames.length <= MAX_PATH_FRAMES) return frames;
  const head = frames.slice(0, 2);
  const tail = frames.slice(-(MAX_PATH_FRAMES - 3));
  return [...head, `… (${frames.length - head.length - tail.length} frames omitted)`, ...tail];
}

function reachedVia(node: CallTreeNode): string[] {
  const chain: string[] = [];
  for (let current: CallTreeNode | null = node; current; current = current.parent) {
    if (!isTransparentFrame(current.frame)) chain.push(nodeLabel(current));
  }
  return compactPath(chain.reverse());
}

function hotPath(node: CallTreeNode): string[] {
  const path = [nodeLabel(node)];
  let current = node;
  while (path.length < MAX_PATH_FRAMES) {
    const next = current.children
      .filter((child) => !isTransparentFrame(child.frame))
      .sort(compareByWeight)[0];
    if (!next) break;
    path.push(nodeLabel(next));
    current = next;
  }
  return path;
}

/**
 * The outermost `app` frames walking down from the task root, one per branch.
 * A lookup, not a descent: the question it answers is "which feature is this
 * task", and the first application frame on a branch is the answer by
 * definition. The old engine walked straight past a frame like `Search_Search`
 * — the point where React hands off to product code, and the frame a human
 * points at — because it delegates all of its time downward.
 */
function boundaryFrames(
  root: CallTreeNode,
  classes: FrameClassTable,
  shapes: Map<string, InvocationShape>,
  durationMs: number,
): BoundaryFrame[] {
  const found: CallTreeNode[] = [];
  const stack = [...root.children];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (classes.classOf(node.frame) === "app") {
      found.push(node);
      continue;
    }
    stack.push(...node.children);
  }

  // Merged by frame identity, because one component reached from three places
  // is one finding carrying all three. The antichain property survives the
  // merge: none of the nodes behind an entry is an ancestor of another, so
  // their inclusive times still do not overlap.
  const merged = new Map<string, { totalMs: number; selfMs: number; best: CallTreeNode }>();
  for (const node of found) {
    const entry = merged.get(node.key);
    if (!entry) merged.set(node.key, { totalMs: node.totalMs, selfMs: effectiveSelfMs(node), best: node });
    else {
      entry.totalMs += node.totalMs;
      entry.selfMs += effectiveSelfMs(node);
      if (compareByWeight(node, entry.best) < 0) entry.best = node;
    }
  }

  const floorMs = BOUNDARY_MIN_SHARE * durationMs;
  return [...merged.entries()]
    .filter(([, entry]) => entry.totalMs >= floorMs)
    .sort(([, a], [, b]) => b.totalMs - a.totalMs || compareByWeight(a.best, b.best))
    .slice(0, MAX_BOUNDARY_FRAMES)
    .map(([key, entry]) => {
      const shape = shapes.get(key);
      const totalMs = round1(entry.totalMs);
      const invocations = shape?.invocations ?? 1;
      const longestCallMs = round1(shape?.longestCallMs ?? entry.totalMs);
      return {
        name: nodeName(entry.best),
        location: nodeLocation(entry.best),
        nodeId: entry.best.id,
        totalMs,
        selfMs: round1(entry.selfMs),
        invocations,
        longestCallMs,
        shapeText: shapeText(invocations, totalMs, longestCallMs),
      };
    });
}

function shapeText(invocations: number, totalMs: number, longestCallMs: number): string {
  const ran = invocations === 1 ? "ran once in this task" : `ran ${invocations} times in this task`;
  const longest = invocations === 1 ? [] : [`longest single call ${formatMs(longestCallMs)}`];
  return [ran, `${formatMs(totalMs)} total`, ...longest].join(" · ");
}

/**
 * Culprits, ranked by effective self time and merged by frame identity.
 *
 * Self time is a true partition of the task: every sample's weight belongs to
 * exactly one frame, so these figures add up and nothing overlaps. Merging by
 * identity rather than by node is what makes the invocation shape useful — a
 * helper called from four places is one finding with 54 calls behind it, not
 * four rows that each tell a quarter of the story.
 */
function culprits(
  tree: CallTree,
  shapes: Map<string, InvocationShape>,
  classes: FrameClassTable,
  durationMs: number,
): TaskCulprit[] {
  const merged = new Map<string, { selfMs: number; best: CallTreeNode }>();
  for (const node of preOrder(tree.root)) {
    if (node === tree.root || isTransparentFrame(node.frame)) continue;
    if (ATTRIBUTED_TO_PARENT.has(node.frame.functionName)) continue;
    const self = effectiveSelfMs(node);
    const entry = merged.get(node.key);
    if (!entry) merged.set(node.key, { selfMs: self, best: node });
    else {
      entry.selfMs += self;
      if (compareByWeight(node, entry.best) < 0) entry.best = node;
    }
  }

  const floorMs = CULPRIT_MIN_SHARE * durationMs;
  return [...merged.entries()]
    .filter(([, entry]) => entry.selfMs >= floorMs)
    .sort(([, a], [, b]) => b.selfMs - a.selfMs || compareByWeight(a.best, b.best))
    .slice(0, MAX_CULPRITS)
    .map(([key, entry]) => {
      const shape = shapes.get(key) ?? { invocations: 1, totalMs: entry.best.totalMs, longestCallMs: entry.best.totalMs };
      const totalMs = round1(shape.totalMs);
      const longestCallMs = round1(shape.longestCallMs);
      return {
        name: nodeName(entry.best),
        location: nodeLocation(entry.best),
        frameClass: classes.classOf(entry.best.frame),
        selfMs: round1(entry.selfMs),
        totalMs,
        invocations: shape.invocations,
        longestCallMs,
        shapeText: shapeText(shape.invocations, totalMs, longestCallMs),
        nodeId: entry.best.id,
        reachedVia: reachedVia(entry.best),
        hotPath: hotPath(entry.best),
      };
    });
}

/**
 * The task's whole subtree. Nothing is truncated by depth or by breadth, which
 * the old card payload had to do: Explore is scoped to one task now, so the
 * payload is bounded by the task's duration rather than by the recording's.
 */
function treePayload(
  node: CallTreeNode,
  shapes: Map<string, InvocationShape>,
  classes: FrameClassTable,
): TaskTreeNode {
  return {
    id: node.id,
    name: nodeName(node),
    location: nodeLocation(node),
    frameClass: classes.classOf(node.frame),
    totalMs: round1(node.totalMs),
    selfMs: round1(effectiveSelfMs(node)),
    invocations: shapes.get(node.key)?.invocations ?? 1,
    children: node.children
      .filter((child) => !ATTRIBUTED_TO_PARENT.has(child.frame.functionName))
      .map((child) => treePayload(child, shapes, classes)),
  };
}

/**
 * A heading names what ran. Duration and offset alone produce one sentence
 * repeated down the page with different numbers, which tells a reader how long
 * each block was and nothing about which of them to open.
 */
function headlineFor(task: ProfileTask, boundaries: TaskBoundaryKind, frames: BoundaryFrame[]): string {
  const into = `${formatMs(task.startMs)} into the recording`;
  // An inferred boundary is reconstructed from idle gaps, so the sentence has
  // to stop short of claiming the runtime drew it there.
  const block = boundaries === "measured"
    ? `a ${Math.round(task.durationMs)} ms task ${into}`
    : `about ${Math.round(task.durationMs)} ms of uninterrupted work ${into}`;
  const subject = frames.slice(0, 2).map((frame) => frame.name).join(" and ");
  // Nothing classified as application code — a bundle with no usable URLs, or a
  // task that really was all framework. Fall back to the block alone rather
  // than heading the card with a framework internal.
  if (!subject) return `${block.charAt(0).toUpperCase()}${block.slice(1)}`;
  return `${subject} — ${block}`;
}

function buildCard(
  profile: CdpProfile,
  task: ProfileTask,
  boundaries: TaskBoundaryKind,
  classes: FrameClassTable,
  durationMs: number,
): TaskCard {
  const scoped = taskProfile(profile, task);
  const tree = buildCallTree(scoped, task.durationMs, { trackSamples: true });
  // The same weights `buildCallTree` used. Measuring the invocation shapes
  // against anything else would let a frame's calls sum to a different total
  // than the node they were counted on.
  const weights = sampleWeightsMs(scoped, task.durationMs);
  const shapes = invocationShapes(tree.sampleNodes ?? [], weights, (node) => node.key);
  const frames = boundaryFrames(tree.root, classes, shapes, task.durationMs);

  return {
    id: `task-${task.index}`,
    taskIndex: task.index,
    startMs: round1(task.startMs),
    durationMs: round1(task.durationMs),
    boundaries,
    headline: headlineFor(task, boundaries, frames),
    percentOfProfile: durationMs > 0 ? round2((task.durationMs / durationMs) * 100) : 0,
    boundaryFrames: frames,
    culprits: culprits(tree, shapes, classes, task.durationMs),
    tree: treePayload(tree.root, shapes, classes),
    subtreeFunctionCount: new Set(preOrder(tree.root).slice(1).map((node) => node.key)).size,
    confidence: tree.root.totalSamples < LOW_CONFIDENCE_SAMPLES ? "low" : "ok",
    ...(task.durationMs >= OVERLONG_TASK_MS
      ? { segments: selectCards(tree).cards.slice(0, MAX_SEGMENTS) }
      : {}),
  };
}

export function selectTaskCards(
  profile: CdpProfile,
  durationMs: number,
  taskSet: TaskSet,
  classes: FrameClassTable,
): TaskCardSet {
  const { tasks, boundaries } = taskSet;
  const byDuration = [...tasks].sort((a, b) => b.durationMs - a.durationMs || a.index - b.index);
  const cut = Math.max(LONG_TASK_MS, TASK_SHARE_MIN * durationMs);
  const long = byDuration.filter((task) => task.durationMs >= cut);
  // Falling through to the same ranking without the floor is the insurance
  // against a recording of short work — a scroll, a steady animation — coming
  // back as a blank screen, which reads as a broken tool rather than a finding.
  const ranked = long.length > 0 ? long : byDuration;
  const shown = ranked.slice(0, MAX_TASK_CARDS);
  const omitted = ranked.slice(MAX_TASK_CARDS);

  return {
    cards: shown.map((task) => buildCard(profile, task, boundaries, classes, durationMs)),
    boundaries,
    noLongTasks: long.length === 0,
    classesDegraded: classes.degraded,
    durationMs,
    taskCount: tasks.length,
    omittedTaskCount: omitted.length,
    omittedTaskMs: round1(omitted.reduce((sum, task) => sum + task.durationMs, 0)),
  };
}
