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
import { ATTRIBUTED_TO_PARENT, isMeaningfulFrame, isTransparentFrame } from "./frame-names.ts";
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
import { buildTaskTimeline, isShownFrame, SHOWN_CLASSES, type TaskTimeline } from "./task-timeline.ts";
import type { FrameClass, FrameClassTable } from "./frame-classes.ts";
import type { TaskInsight } from "./task-insight.ts";
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

/**
 * How many culprits a task ships. Explore's Culprits tab is a table a reader
 * sorts and scans, so it holds all of them; a result card shows only its first
 * `CARD_CULPRIT_ROWS` of the same list, which is the length a card reads at.
 *
 * Raised from 24 when the floor below became an absolute one, because at 24 the
 * cap bound before the floor did and silently undid half of it: on the 3.2 s
 * task of the local trace 33 frames clear 15 ms of self time and 98 more clear
 * it only through their callees, and since self time sorts above inclusive
 * time, not one delegating frame reached the table. The floor is meant to
 * decide what a reader sees here; the cap exists so a pathological recording
 * cannot ship a thousand rows, and it should bind as rarely as it now does.
 *
 * The cost of the slots is nothing: a culprit serialises to about 1.4 kB
 * against a task tree that runs to several megabytes in the same response. What
 * length does govern is the hand-off, which lists culprits as prose a human
 * reads — `card-prompt.ts` caps its own list well below this one.
 */
export const MAX_CULPRITS = 60;

/**
 * A frame holding neither this much of its own time nor this much including its
 * callees explains none of why the task was long.
 *
 * Absolute rather than a share of the task, because what a reader can act on
 * does not scale with the block it sat in: 15 ms is a frame worth opening a
 * file over whether it ran inside a 200 ms task or a 3 s one, and a share floor
 * said the opposite at both ends — 2 ms rows on a short task, and on a long one
 * a cut that hid everything a reader could realistically fix.
 *
 * Either figure admits a row. Self time alone is the sharper ranking and stays
 * the sort, but it hides the shape a reader often arrives looking for: a frame
 * with 2 ms of its own and 400 ms through its callees is where the time went,
 * even though it delegated all of it.
 */
export const CULPRIT_MIN_MS = 15;

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
export const BOUNDARY_MIN_SHARE = 0.02;

/**
 * Boundary frames the heading names. The subtitle starts after these, so the
 * two lines do not open with the same two words.
 */
export const HEADLINE_FRAMES = 2;

/** Root to frame, and frame to hot leaf, compacted at the same width the old cards used. */
const MAX_PATH_FRAMES = 8;

/**
 * Named callers kept on a culprit row. Three is enough to place a function in
 * the feature that called it and short enough to read on one line.
 */
const MAX_CALLER_FRAMES = 3;

/** The classes a caller line can name: a reader acts on their own code and their dependencies. */
const NAMEABLE = new Set<FrameClass>(["app", "library"]);

/** The classes the timeline draws, so a card's captions name boxes a reader can find. */
const DRAWABLE = new Set<FrameClass>(SHOWN_CLASSES);

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

/**
 * Culprits a boundary frame carries for its drill-down. Eight is what the
 * contribution chart can divide into distinguishable slices, and the frame's
 * own residual carries whatever is left so the figures still add up.
 */
const MAX_BOUNDARY_CULPRITS = 8;

/**
 * The drill-down's floor, as a share of the frame being opened plus an
 * absolute guard. A share alone would admit 0.2 ms rows under a small feature;
 * the absolute guard alone is the task-wide floor, which hides how a 108 ms
 * feature spent itself.
 */
const BOUNDARY_CULPRIT_MIN_SHARE = 0.02;
const BOUNDARY_CULPRIT_MIN_MS = 1;


const round1 = (value: number) => Math.round(value * 10) / 10;
const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * The outermost product frame on one branch: which feature this task is.
 *
 * These are what a card ranks by. No boundary frame is an ancestor of another —
 * the search stops at the first product frame on each branch — so they form
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
  /**
   * What burned the time *inside* this frame, by self time within its own
   * subtree. A boundary frame answers "which feature", and on a React profile
   * it answers it with 0 ms of its own — `Search_Search` is 562 ms inclusive
   * and 0 ms self, because it delegates everything. These are the answer to the
   * question that follows, which is what to go and change, and they are a true
   * partition of this frame's inclusive time: self time over a subtree sums to
   * that subtree's total exactly.
   */
  culprits: BoundaryCulprit[];
}

/**
 * A culprit scoped to one boundary frame.
 *
 * `TaskCulprit` without `reachedVia` and `hotPath`: those two carry every
 * frame's URL and column for a hand-off to an agent that will open the source,
 * which on a bundled app is several hundred characters of hashed chunk name
 * per row. The drill-down is read on a card, so it ships what a card shows.
 *
 * Its figures are measured inside this boundary only, so a helper called from
 * three features reports the share each feature is responsible for rather than
 * its task-wide total three times over.
 */
export interface BoundaryCulprit {
  name: string;
  location?: string;
  frameClass: FrameClass;
  /** Effective self time inside this boundary frame's subtree. */
  selfMs: number;
  /** Inclusive time across this frame's calls inside this boundary frame. */
  totalMs: number;
  invocations: number;
  longestCallMs: number;
  shapeText: string;
  nodeId: string;
  callers: string[];
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
  /**
   * The nearest named callers above it, outermost first — `Search_Search`,
   * `hooks_useSearchSnapshot`, `getSections`. Names only and short enough for a
   * card row, where `reachedVia` is the full path for a hand-off.
   */
  callers: string[];
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
  /**
   * Two candidate headings, under evaluation against `headline` above.
   *
   * `headline` leads with the boundary frame and then spends its remaining
   * words on the duration and the start offset — both of which the card
   * already prints as its time label and its figures row, and neither of which
   * can help a reader choose a card from a list that is ranked by duration
   * and numbered. These two replace that tail with the only things on the card
   * the reader cannot already see: where the cost sits, and what shape it is.
   *
   * Optional because both are read back from analyses saved before they
   * existed; the views fall back to `headline` when they are absent.
   */
  pathline?: string;
  shapeline?: string;
  percentOfProfile: number;
  boundaryFrames: BoundaryFrame[];
  /**
   * Boundary frames that exist but are too small to draw or past the cap, as a
   * count and a total. Without them a chart of the shown frames has a residual
   * that mixes "smaller features" with "never your code at all", which are
   * different findings — the first is a reason to look further down the list,
   * the second is a reason to stop looking.
   */
  boundaryTailCount: number;
  boundaryTailMs: number;
  /**
   * Time in this task that never reached a named frame of your own: framework
   * and engine only, all the way down. On the local trace's 3227 ms task this
   * is 471 ms — the reconciler and the bridge between your components.
   */
  outsideBoundariesMs: number;
  culprits: TaskCulprit[];
  tree: TaskTreeNode;
  /**
   * The same task against the clock, with everything but application code
   * collapsed away. The tree above answers "what cost the most"; this answers
   * "what happened, and when", which is the question a reader arrives with
   * after seeing the block in a flame chart.
   */
  timeline: TaskTimeline;
  subtreeFunctionCount: number;
  confidence: "ok" | "low";
  /**
   * The model's reading of this task, once asked for. Everything else on
   * the card is measured; this is the one field that is inferred, so the view
   * labels it and the hand-off says so in as many words.
   */
  insight?: TaskInsight;
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
 * The outermost drawable, meaningfully named frames walking down from the task
 * root, one per branch. A lookup, not a descent: the question it answers is
 * "which feature is this task", and the first such frame on a branch is the
 * answer by definition. The old engine walked straight past a frame like
 * `Search_Search` — the point where React hands off to product code, and the
 * frame a human points at — because it delegates all of its time downward.
 *
 * Drawable is the same test the timeline draws by, so a caption on a card names
 * a box a reader can go and find. It is deliberately not `app`: in a bundled
 * build the classifier routinely files the product's own screens under
 * `library`, and requiring `app` leaves a card with no caption at all rather
 * than one that calls a dependency a feature. The name test is what keeps the
 * row honest — `applyMerge` heads a card usefully, `t.A` does not, so a mangled
 * identifier is walked through to whatever it called.
 */
interface BoundaryEntry {
  key: string;
  totalMs: number;
  selfMs: number;
  /** Every node carrying this frame at the boundary, for the scoped culprit pass. */
  nodes: CallTreeNode[];
  best: CallTreeNode;
}

function boundaryEntries(root: CallTreeNode, classes: FrameClassTable): BoundaryEntry[] {
  const found: CallTreeNode[] = [];
  const stack = [...root.children];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (DRAWABLE.has(classes.classOf(node.frame)) && isMeaningfulFrame(node.frame)) {
      found.push(node);
      continue;
    }
    stack.push(...node.children);
  }

  // Merged by frame identity, because one component reached from three places
  // is one finding carrying all three. The antichain property survives the
  // merge: none of the nodes behind an entry is an ancestor of another, so
  // their inclusive times still do not overlap.
  const merged = new Map<string, BoundaryEntry>();
  for (const node of found) {
    const entry = merged.get(node.key);
    if (!entry) {
      merged.set(node.key, { key: node.key, totalMs: node.totalMs, selfMs: effectiveSelfMs(node), nodes: [node], best: node });
      continue;
    }
    entry.totalMs += node.totalMs;
    entry.selfMs += effectiveSelfMs(node);
    entry.nodes.push(node);
    if (compareByWeight(node, entry.best) < 0) entry.best = node;
  }

  return [...merged.values()].sort((a, b) => b.totalMs - a.totalMs || compareByWeight(a.best, b.best));
}

function boundaryFrame(
  entry: BoundaryEntry,
  shapes: Map<string, InvocationShape>,
  culprits: BoundaryCulprit[],
): BoundaryFrame {
  const shape = shapes.get(entry.key);
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
    culprits,
  };
}

/**
 * The culprits inside one boundary frame, measured inside it.
 *
 * The shapes are recomputed against a sample sequence masked to this frame's
 * subtree rather than read off the task-wide table, because `ran 13 times in
 * this task` is the wrong figure under a feature that accounts for five of
 * them. Masking rather than filtering is what keeps it correct: the sequence
 * keeps its length and its alignment with the weights, and a masked sample
 * closes every open call, so a run that leaves the subtree and comes back
 * counts as two calls instead of one long one.
 */
function boundaryCulprits(
  entry: BoundaryEntry,
  sampleNodes: readonly (CallTreeNode | null)[],
  weights: readonly number[],
  classes: FrameClassTable,
): BoundaryCulprit[] {
  const inside = new Set<CallTreeNode>();
  for (const node of entry.nodes) for (const descendant of preOrder(node)) inside.add(descendant);
  const scopedShapes = invocationShapes(
    sampleNodes.map((node) => (node && inside.has(node) ? node : null)),
    weights,
    (node) => node.key,
  );

  const merged = new Map<string, { selfMs: number; best: CallTreeNode }>();
  for (const node of inside) {
    if (isTransparentFrame(node.frame) || ATTRIBUTED_TO_PARENT.has(node.frame.functionName)) continue;
    const self = effectiveSelfMs(node);
    const found = merged.get(node.key);
    if (!found) merged.set(node.key, { selfMs: self, best: node });
    else {
      found.selfMs += self;
      if (compareByWeight(node, found.best) < 0) found.best = node;
    }
  }

  // Relative to the frame being opened, not to the task. The task-wide floor is
  // an absolute 15 ms because that is the size of a thing worth opening a file
  // over; inside a 108 ms feature it would leave the drill-down empty and say
  // nothing about how that feature spent its time.
  const floorMs = Math.max(BOUNDARY_CULPRIT_MIN_MS, BOUNDARY_CULPRIT_MIN_SHARE * entry.totalMs);
  return [...merged.entries()]
    .filter(([, found]) => found.selfMs >= floorMs)
    .sort(([, a], [, b]) => b.selfMs - a.selfMs || compareByWeight(a.best, b.best))
    .slice(0, MAX_BOUNDARY_CULPRITS)
    .map(([key, found]) => {
      const shape = scopedShapes.get(key);
      const totalMs = round1(shape?.totalMs ?? found.best.totalMs);
      const longestCallMs = round1(shape?.longestCallMs ?? totalMs);
      const invocations = shape?.invocations ?? 1;
      return {
        name: nodeName(found.best),
        location: nodeLocation(found.best),
        frameClass: classes.classOf(found.best.frame),
        selfMs: round1(found.selfMs),
        totalMs,
        invocations,
        longestCallMs,
        shapeText: shapeText(invocations, totalMs, longestCallMs, "inside this frame"),
        nodeId: found.best.id,
        callers: callers(found.best, classes),
      };
    });
}

function shapeText(
  invocations: number,
  totalMs: number,
  longestCallMs: number,
  /** Where the count was measured. A drill-down counts calls inside one frame, not the task. */
  scope = "in this task",
): string {
  const ran = invocations === 1 ? `ran once ${scope}` : `ran ${invocations} times ${scope}`;
  const longest = invocations === 1 ? [] : [`longest single call ${formatMs(longestCallMs)}`];
  return [ran, `${formatMs(totalMs)} total`, ...longest].join(" · ");
}

/**
 * The nearest few named callers above a culprit, outermost first.
 *
 * A function name on its own is not yet a finding: `isReceiptBeingScanned`
 * could be anything, and `isReceiptBeingScanned, via reportMatchesTodoBucket ›
 * isApproveAction › isScanning` is a per-item predicate running inside a
 * filter, which is a thing to go and change. That line is what makes a culprit
 * row act like a row rather than a name.
 *
 * `reachedVia` already walks this chain and cannot be reused here: it starts at
 * the root and carries each frame's URL and column, because it is written for a
 * hand-off to an agent that will open the source. On a bundled app that runs to
 * several hundred characters of hashed chunk name per row. This keeps names
 * only, and only the ones a reader can act on — framework and engine frames go,
 * because the question is what the product called, and mangled and anonymous
 * frames go because they name nothing.
 */
function callers(node: CallTreeNode, classes: FrameClassTable): string[] {
  const chain: string[] = [];
  // `current.parent` rather than `current`: the synthetic tree root is not a
  // frame anyone called.
  for (let current = node.parent; current?.parent; current = current.parent) {
    if (!isMeaningfulFrame(current.frame)) continue;
    if (!NAMEABLE.has(classes.classOf(current.frame))) continue;
    chain.push(nodeName(current));
    if (chain.length === MAX_CALLER_FRAMES) break;
  }
  return chain.reverse();
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

  // The shape carries the inclusive figure the floor tests, so it is resolved
  // before the cut rather than after it.
  return [...merged.entries()]
    .map(([key, entry]) => ({
      entry,
      shape: shapes.get(key) ?? { invocations: 1, totalMs: entry.best.totalMs, longestCallMs: entry.best.totalMs },
    }))
    .filter(({ entry, shape }) => entry.selfMs >= CULPRIT_MIN_MS || shape.totalMs >= CULPRIT_MIN_MS)
    .sort((a, b) => b.entry.selfMs - a.entry.selfMs || b.shape.totalMs - a.shape.totalMs || compareByWeight(a.entry.best, b.entry.best))
    .slice(0, MAX_CULPRITS)
    .map(({ entry, shape }) => {
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
        callers: callers(entry.best, classes),
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
 * The same tree with the framework and the engine collapsed away — the cut the
 * timeline draws by, applied to the rows instead of the boxes.
 *
 * A real React stack is mostly frames nobody can act on: `performWorkOnRoot`,
 * `beginWork`, `commitPassiveMountOnFiber`, `Function call`, and a product
 * frame sitting twelve rows under them. The unfiltered tree is still the one to
 * read when the question is "what called what" and the answer runs through the
 * reconciler, so this is a second view of the same data rather than a
 * replacement: the view offers both and the reader picks.
 *
 * Dropping a frame lifts its children into its place and charges the time it
 * burned in its own body to the nearest kept frame above it, which is what the
 * timeline does with the same frames. So a parent's total still accounts for
 * its own self time plus its children's totals, and the figures on the two
 * views agree where a frame appears on both.
 *
 * `node` itself is always kept, whatever it is: it is the frame the reader
 * focused the view on, and a tree rendered without its own root is not a tree.
 *
 * `isShownFrame` rather than the class alone, so a built-in that names itself —
 * `[Native] intlDateTimeFormatFormat` — survives the cut here exactly as it
 * does on the chart. It is engine code and it is still the answer.
 */
export function focusedTree(node: TaskTreeNode, kept: ReadonlySet<FrameClass> = DRAWABLE): TaskTreeNode {
  const below = focusedChildren(node.children, kept);
  return { ...node, selfMs: round1(node.selfMs + below.strippedMs), children: below.nodes };
}

function focusedChildren(
  nodes: readonly TaskTreeNode[],
  kept: ReadonlySet<FrameClass>,
): { nodes: TaskTreeNode[]; strippedMs: number } {
  const out: TaskTreeNode[] = [];
  let strippedMs = 0;
  for (const node of nodes) {
    const below = focusedChildren(node.children, kept);
    if (isShownFrame(node.name, node.frameClass, kept)) {
      out.push({ ...node, selfMs: round1(node.selfMs + below.strippedMs), children: below.nodes });
      continue;
    }
    // The frame goes, its children come up a row, and its own time travels on
    // up to whichever kept frame delegated into it.
    strippedMs += node.selfMs + below.strippedMs;
    out.push(...below.nodes);
  }
  // Hoisted children arrive interleaved with the siblings they are joining, and
  // every other ranking in this tool is heaviest first.
  out.sort((a, b) => b.totalMs - a.totalMs);
  return { nodes: out, strippedMs };
}

/**
 * A dominant culprit holds at least this much of the time that reached the
 * reader's own code. Below it the cost has no single home, and a line naming
 * the heaviest frame would read as a finding where the measurement only
 * supports "spread thin".
 */
const DOMINANT_SELF_SHARE = 0.25;

/**
 * Below this much of the task reaching the reader's code, the shape line states
 * the figure it is measuring shares against before it states a share.
 *
 * Every percentage on this row is a share of the reader's own code, not of the
 * task — those are the same number when the framework took almost none of the
 * task, and wildly different when it took most of it. `datePrototypeToLocale‐
 * StringHelper` is 2923 ms either way: 6% of a 50.6 s task, and 77% of the
 * 3.79 s that ever reached a frame of the reader's own. The second figure is
 * the one that says where to look, and measuring against the task instead made
 * the same frame dominant on one recording and invisible on another purely
 * because of how much framework time sat beside it.
 *
 * Which leaves one hazard: `77%` beside a 50.6 s time label invites the reader
 * to multiply the two. Naming the 3.79 s first closes that, and costs a clause
 * only on the cards where the two denominators actually diverge.
 */
const SCOPE_IMPLICIT_SHARE = 0.9;

/**
 * A feature this far below the task is noise in a heading — the reader would be
 * handed a name for something the chart draws as a seam between its neighbours.
 */
const FEATURE_MIN_SHARE = 0.1;

/**
 * One feature holding this much of the task *is* the task, and a call path into
 * it is the right heading. Below it, with another feature of comparable weight
 * beside it, naming one path leaves the rest of the measurement unaccounted for
 * while sounding just as certain.
 */
const DOMINANT_FEATURE_SHARE = 0.6;

/**
 * A split reading has to be a reading of the task, not of a corner of it: the
 * features it names must cover this much between them, and the heaviest must
 * clear `SPLIT_LEAD_SHARE`.
 *
 * Both gates exist because a task can fail to have a dominant feature in two
 * opposite ways. `37% _onFocus · 12% _onChange` *is* the task — half of it
 * never reached the product's code at all, so those two are nearly all of what
 * did. A task divided 17/11/9/7/6/5/5/3 across sixty frames is not split
 * between two features, it is spread across all of them, and naming the top
 * two would present 28% of the task as its shape. That task has better
 * readings further down — its segments, or how thin the heaviest frame was.
 */
const SPLIT_COVERAGE_SHARE = 0.4;
const SPLIT_LEAD_SHARE = 0.25;

/** Features a heading names before the list stops reading as a sentence. */
const MAX_HEADING_FEATURES = 3;

/** Frames a reader can open. An engine built-in is never where the fix goes. */
const ACTIONABLE = NAMEABLE;

/**
 * The features a task is split between, or nothing when it has no such shape.
 *
 * Shared by both heading rows so they cannot contradict each other: when this
 * returns frames, the path row names them instead of a path into one of them,
 * and the shape row reads their shares. Boundary frames are an antichain, so
 * these shares are a true partition and can be stated side by side.
 */
function splitFeatures(card: Pick<TaskCard, "boundaryFrames" | "durationMs">): BoundaryFrame[] | undefined {
  const taskMs = card.durationMs;
  if (taskMs <= 0) return undefined;

  const features = card.boundaryFrames.filter((frame) => frame.totalMs / taskMs >= FEATURE_MIN_SHARE);
  if (features.length < 2) return undefined;
  if (features[0].totalMs / taskMs >= DOMINANT_FEATURE_SHARE) return undefined;
  if (features[0].totalMs / taskMs < SPLIT_LEAD_SHARE) return undefined;

  const named = features.slice(0, MAX_HEADING_FEATURES);
  const covered = named.reduce((sum, frame) => sum + frame.totalMs, 0);
  return covered / taskMs >= SPLIT_COVERAGE_SHARE ? named : undefined;
}

/**
 * Row one: the call path a developer opens.
 *
 * The heaviest culprit placed in the feature that reached it, which is the
 * question that follows "which card" — not how big it was, which the rank and
 * the time label already answered twice over.
 *
 * It stops at the last frame of the reader's own when the cost landed in an
 * engine built-in. `intlDateTimeFormatFormat` is not a file anyone can edit;
 * `formatDate`, which called it twelve times, is. The shape line names the
 * built-in, so nothing is lost by ending the path above it.
 *
 * A path is a confident claim — this is where the cost sits — and the one shape
 * of task that cannot support one is a task split between features of
 * comparable weight, where any single path is a fraction of the answer. There
 * the features are named instead.
 *
 * The culprit's share of the *task* is deliberately not a gate here. On a task
 * that spent 93% of itself in the framework, the heaviest frame of the reader's
 * own is 6% of the task and 77% of the code that ran — the second figure is the
 * one that says whether the path is worth naming, and the shape line states the
 * 93% beside it, so the reader cannot mistake a small slice for the whole.
 */
export function pathlineFor(card: Pick<TaskCard, "culprits" | "boundaryFrames" | "durationMs">): string {
  const split = splitFeatures(card);
  if (split) return split.map((frame) => frame.name).join(" + ");

  const dominant = card.culprits[0];
  if (!dominant) return card.boundaryFrames.map((frame) => frame.name).join(" › ");

  const chain = [...dominant.callers];
  // `callers` keeps the three nearest named frames, so on a deep stack the
  // feature the work belongs to can fall off the top. Anchoring there costs one
  // frame and an ellipsis, and without it the path starts in the middle of a
  // stack with no indication that it does.
  const feature = card.boundaryFrames.find((frame) =>
    frame.culprits.some((culprit) => culprit.name === dominant.name)
  ) ?? card.boundaryFrames[0];
  if (feature && chain[0] !== feature.name) chain.unshift(feature.name, "…");

  if (ACTIONABLE.has(dominant.frameClass)) chain.push(dominant.name);
  // A culprit with no named caller above it and no path of its own is all the
  // line has to name.
  return chain.length > 0 ? chain.join(" › ") : dominant.name;
}

/**
 * Row two: the measured shape of the cost.
 *
 * One of several readings, each a claim the card's own figures carry — no
 * inference, so this line is the same sentence for the bundled samples as for
 * an upload.
 *
 * The share is what makes it a finding rather than a label: `64% in
 * intlDateTimeFormatFormat` says the card is about one frame, and `heaviest 9%
 * of 512 functions` says it is about none. The invocation count separates the
 * two shapes a merged call tree cannot tell apart — one slow call, or a cheap
 * one paid per item.
 *
 * Every share on this row is measured against the time that reached the
 * reader's own code, for the reasons under `SCOPE_IMPLICIT_SHARE`. When no
 * frame dominates, the reading falls back to the task's division by
 * feature. That is deliberately the same partition the contribution chart under
 * this heading draws, so a reader is not handed two different decompositions of
 * one task and left to reconcile them.
 */
export function shapelineFor(card: Pick<TaskCard,
  "culprits" | "durationMs" | "outsideBoundariesMs" | "boundaryFrames" | "segments" | "subtreeFunctionCount">): string {
  const taskMs = card.durationMs;
  if (taskMs <= 0) return "no measurable work in this block";

  // The whole this line measures against: the time that reached a named frame
  // of the reader's own. Framework and engine time is deliberately absent from
  // this row — the contribution chart below draws it as its own slice, so the
  // card still reports it, and the heading gets to be about code the reader can
  // open instead of spending its words on code they cannot.
  const codeMs = Math.max(0, taskMs - card.outsideBoundariesMs);
  if (codeMs <= 0) return "no code of your own ran in this block";

  const pct = (ms: number) => Math.round((ms / codeMs) * 100);
  // Stated only where it is not the task's own duration, and only on the
  // readings that print a percentage for it to qualify.
  const scope = codeMs / taskMs < SCOPE_IMPLICIT_SHARE ? `${formatMs(codeMs)} in your code · ` : "";

  const dominant = card.culprits[0];
  if (dominant && dominant.selfMs / codeMs >= DOMINANT_SELF_SHARE) {
    const share = `${scope}${pct(dominant.selfMs)}% in ${dominant.name}`;
    return dominant.invocations > 1
      ? `${share} · ${dominant.invocations} calls, longest ${formatMs(dominant.longestCallMs)}`
      : `${share} · one ${formatMs(dominant.totalMs)} call`;
  }

  // No one frame to pin the cost on, but the task is split between a few
  // features that hold most of it — the same partition the contribution chart
  // under this heading draws, so the two now agree instead of dividing one task
  // two different ways.
  const split = splitFeatures(card);
  if (split) {
    return scope + split.map((frame) => `${pct(frame.totalMs)}% ${frame.name}`).join(" · ");
  }

  // Long enough to be a phase, and no one frame or feature to pin it on: the
  // segments are the only division of it left to offer. No percentage, so no
  // denominator to qualify.
  if (card.segments && card.segments.length > 0) {
    return `${card.segments.length} distinct pieces of work · ${card.segments.map((segment) => segment.title).join(", ")}`;
  }

  return dominant
    ? `${scope}no single hot frame · heaviest ${pct(dominant.selfMs)}% (${dominant.name}) of ${card.subtreeFunctionCount} functions`
    : `no single hot frame · ${card.subtreeFunctionCount} functions, none over ${CULPRIT_MIN_MS} ms`;
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
  const subject = frames.slice(0, HEADLINE_FRAMES).map((frame) => frame.name).join(" and ");
  // Nothing drawable and nameable on any branch — a bundle whose identifiers
  // are all mangled, or a task that really was all framework. Fall back to the
  // block alone rather than heading the card with a framework internal.
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

  // The whole antichain, so the residuals below can tell "features too small to
  // draw" apart from "never your code at all". On the local trace's 3227 ms
  // task the shown frames are 63% of it, the tail another 22%, and what is
  // left — 15% — is framework and engine the whole way down.
  const entries = boundaryEntries(tree.root, classes);
  const entriesMs = entries.reduce((sum, entry) => sum + entry.totalMs, 0);
  const floorMs = BOUNDARY_MIN_SHARE * task.durationMs;
  const shownEntries = entries.filter((entry) => entry.totalMs >= floorMs).slice(0, MAX_BOUNDARY_FRAMES);
  const frames = shownEntries.map((entry) =>
    boundaryFrame(entry, shapes, boundaryCulprits(entry, tree.sampleNodes ?? [], weights, classes)),
  );
  const shownMs = shownEntries.reduce((sum, entry) => sum + entry.totalMs, 0);

  const card: TaskCard = {
    id: `task-${task.index}`,
    taskIndex: task.index,
    startMs: round1(task.startMs),
    durationMs: round1(task.durationMs),
    boundaries,
    headline: headlineFor(task, boundaries, frames),
    percentOfProfile: durationMs > 0 ? round2((task.durationMs / durationMs) * 100) : 0,
    boundaryFrames: frames,
    boundaryTailCount: entries.length - shownEntries.length,
    boundaryTailMs: round1(Math.max(0, entriesMs - shownMs)),
    outsideBoundariesMs: round1(Math.max(0, task.durationMs - entriesMs)),
    culprits: culprits(tree, shapes, classes),
    tree: treePayload(tree.root, shapes, classes),
    timeline: buildTaskTimeline(tree.sampleNodes ?? [], weights, classes, task.durationMs),
    subtreeFunctionCount: new Set(preOrder(tree.root).slice(1).map((node) => node.key)).size,
    confidence: tree.root.totalSamples < LOW_CONFIDENCE_SAMPLES ? "low" : "ok",
    ...(task.durationMs >= OVERLONG_TASK_MS
      ? { segments: selectCards(tree).cards.slice(0, MAX_SEGMENTS) }
      : {}),
  };

  // Both read the finished card rather than the tree: they are statements
  // about the figures the card ships, so deriving them from anything else
  // would let a heading and the chart under it disagree.
  return { ...card, pathline: pathlineFor(card), shapeline: shapelineFor(card) };
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
