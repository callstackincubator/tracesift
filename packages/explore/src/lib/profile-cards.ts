/**
 * Deterministic card extraction from a merged call tree.
 *
 * A card names the shallowest frame that actually explains a cost: the descent
 * walks past wrappers that only delegate, stops where a function does
 * substantial work in its own body or forks into several significant callees,
 * and never titles a card with a name that says nothing. Nothing here consults
 * a model — the same profile always produces the same cards.
 */

import {
  compareByWeight,
  nodeLabel,
  nodeLocation,
  nodeName,
  preOrder,
  type CallTree,
  type CallTreeNode,
} from "./call-tree.ts";
import { frameNameTier, isTransparentFrame, meaningfulName } from "./frame-names.ts";
import { isFrameworkInternalFrame } from "./framework-frames.ts";

/**
 * One dropped frame at 60 Hz. Nothing shorter is perceptible, so nothing
 * shorter earns a card. The sample term keeps a coarsely sampled profile from
 * asserting subtrees it only saw once or twice, and the share term stops a
 * 30 s recording from producing hundreds of cards.
 */
const minCardTotalMs = (durationMs: number, meanSampleMs: number) =>
  Math.max(16, 8 * meanSampleMs, 0.01 * durationMs);

/** Guards the self-time ratio against subtrees so small that a ratio of 1.0 means one sample. */
const minCardSelfMs = (meanSampleMs: number) => Math.max(4, 3 * meanSampleMs);

/**
 * A wrapper keeps nearly none of its own subtree; a function doing real work
 * beside a hot helper keeps a third or more. The gap between those two
 * populations is wide, and 0.25 sits in it: higher walks past genuine workers
 * that delegate heavily, lower stops on thin dispatch frames.
 */
const SELF_RATIO_MIN = 0.25;

/**
 * Descend through a frame only when it is genuinely a conduit. At a lower bar a
 * 60/40 fork would be descended and the branch point — the most informative
 * frame on the stack — would be lost.
 */
const DOMINANT_CHILD_RATIO = 0.8;

/** A card owning most of the recording explains nothing; split it into its branches instead. */
const MAX_CARD_SHARE = 0.6;

/**
 * A runaway guard, not a shape assumption: React Native stacks routinely run
 * past a hundred frames, and a cap tight enough to cut one of those short would
 * put the card on whichever frame the descent happened to stop at.
 */
const MAX_DESCENT_DEPTH = 512;
const MAX_CARDS = 20;

/**
 * Eight levels of callees per card. Breadth, not depth, is what could make this
 * expensive, and `CHILD_MIN_SHARE` already bounds it: siblings' totals sum to
 * at most their parent's, so a whole level holds at most 50 nodes however deep
 * the capture runs.
 */
const CHILD_LEVELS = 8;
const MAX_CHILDREN_PER_LEVEL = 6;
const CHILD_MIN_SHARE = 0.02;

const HIGHLIGHT_COUNT = 5;
const HIGHLIGHT_MIN_SHARE = 0.05;
/** A callee this close to its caller's total is the same finding stated twice. */
const HIGHLIGHT_PASSTHROUGH_RATIO = 0.9;

const MAX_REPEATED = 8;
const MAX_CALLERS = 3;
const REPEATED_MIN_SHARE = 0.02;

const MAX_PATH_FRAMES = 8;
/** A card built on fewer samples than this is a hint, not a measurement. */
const LOW_CONFIDENCE_SAMPLES = 20;

/**
 * Garbage collection and deoptimisation are charged to the frame that triggered
 * them. They arrive as children, but they are the running function's cost, not
 * delegation: counting them as delegation makes a hot allocator look like a
 * pure wrapper and sends the descent into `(garbage collector)`.
 */
const ATTRIBUTED_TO_PARENT = new Set(["(garbage collector)", "(optimized code)"]);

export interface CardHighlight {
  name: string;
  location?: string;
  totalMs: number;
  selfMs: number;
  /** `getReportSections - 243ms total time, 80ms self time` */
  text: string;
}

export interface CardChildNode {
  name: string;
  location?: string;
  totalMs: number;
  selfMs: number;
  callSites: number;
  /** Present only when the profiler records one node per invocation. */
  invocations?: number;
  frameworkInternal: boolean;
  children: CardChildNode[];
  /** The callees that did not make the cap, kept as a number rather than dropped. */
  truncated?: { count: number; totalMs: number };
}

export interface RepeatedCaller {
  name: string;
  callSites: number;
  invocations?: number;
  totalMs: number;
}

export interface RepeatedFunction {
  name: string;
  location?: string;
  totalMs: number;
  selfMs: number;
  callSites: number;
  invocations?: number;
  callers: RepeatedCaller[];
}

export interface ProfileCard {
  id: string;
  title: string;
  location?: string;
  /** `getSections at src/report.ts:42:9 spent 327 ms in total time` */
  headline: string;
  totalMs: number;
  /** Includes GC and deoptimisation triggered by this frame. */
  selfMs: number;
  percentOfProfile: number;
  callSites: number;
  invocations?: number;
  /** The title came from an ancestor because this frame had no usable name. */
  nameInherited: boolean;
  /**
   * `longTail` when the self time is really spread across callees too small to
   * list — without it the card reads as if the function body were slow.
   */
  selfShape: "body" | "longTail";
  frameworkOnly: boolean;
  confidence: "ok" | "low";
  /** Root to this frame, compacted. */
  reachedVia: string[];
  /** This frame down to its heaviest leaf. */
  hotPath: string[];
  highlights: CardHighlight[];
  children: CardChildNode[];
  repeated: RepeatedFunction[];
  subtreeFunctionCount: number;
}

export interface CardSelection {
  cards: ProfileCard[];
  thresholds: {
    minCardTotalMs: number;
    minCardSelfMs: number;
    selfRatioMin: number;
    dominantChildRatio: number;
  };
  /** Time in subtrees that cleared the floor but offered no usable name. */
  unattributedMs: number;
  callCountIsExact: boolean;
  durationMs: number;
  idleMs: number;
}

const round1 = (value: number) => Math.round(value * 10) / 10;
const round2 = (value: number) => Math.round(value * 100) / 100;

/** Self time plus the GC and deoptimisation this frame caused. */
export function effectiveSelfMs(node: CallTreeNode): number {
  let total = node.selfMs;
  for (const child of node.children) {
    if (ATTRIBUTED_TO_PARENT.has(child.frame.functionName)) total += child.totalMs;
  }
  return total;
}

/**
 * Callees worth considering, with engine frames seen through rather than
 * treated as a wall: `(program)` between two application frames must not make
 * the outer one look childless.
 */
function significantChildren(node: CallTreeNode, floorMs: number): CallTreeNode[] {
  const out: CallTreeNode[] = [];
  const stack = [...node.children];
  while (stack.length > 0) {
    const child = stack.pop()!;
    if (ATTRIBUTED_TO_PARENT.has(child.frame.functionName)) continue;
    if (isTransparentFrame(child.frame)) {
      stack.push(...child.children);
      continue;
    }
    if (child.totalMs >= floorMs) out.push(child);
  }
  return out.sort(compareByWeight);
}

interface Ctx {
  inheritedName?: string;
  depth: number;
}

interface Emission {
  node: CallTreeNode;
  title: string;
  nameInherited: boolean;
  selfShape: "body" | "longTail";
}

export function selectCards(tree: CallTree): CardSelection {
  const { durationMs, meanSampleMs } = tree;
  const floorMs = minCardTotalMs(durationMs, meanSampleMs);
  const selfFloorMs = minCardSelfMs(meanSampleMs);
  const thresholds = {
    minCardTotalMs: round2(floorMs),
    minCardSelfMs: round2(selfFloorMs),
    selfRatioMin: SELF_RATIO_MIN,
    dominantChildRatio: DOMINANT_CHILD_RATIO,
  };
  const empty: CardSelection = {
    cards: [], thresholds, unattributedMs: 0,
    callCountIsExact: tree.callCountIsExact, durationMs, idleMs: round1(tree.idleMs),
  };
  if (tree.sampleCount === 0 || durationMs <= 0) return empty;

  let unattributedMs = 0;

  function emitOrDrop(node: CallTreeNode, ctx: Ctx, longTail = false): Emission[] {
    // Only a tier-2 name titles a card. A minified or framework-internal frame
    // takes the name carried down from above instead, and takes nothing at all
    // when the branch never held an application frame.
    const own = meaningfulName(node.frame);
    const title = own ?? ctx.inheritedName;
    if (!title) {
      unattributedMs += node.totalMs;
      return [];
    }
    return [{
      node,
      title,
      nameInherited: own === undefined,
      selfShape: longTail ? "longTail" : "body",
    }];
  }

  function visit(node: CallTreeNode, ctx: Ctx): Emission[] {
    if (ctx.depth > MAX_DESCENT_DEPTH) return emitOrDrop(node, ctx);
    const hot = significantChildren(node, floorMs);

    // The root, and nothing else, reaches here: `significantChildren` already
    // sees through every other engine frame.
    if (isTransparentFrame(node.frame)) {
      return hot.flatMap((child) => visit(child, { ...ctx, depth: ctx.depth + 1 }));
    }

    const self = effectiveSelfMs(node);
    const ratio = node.totalMs > 0 ? self / node.totalMs : 0;
    const named = frameNameTier(node.frame) === 2;

    // Substantial work in its own body: this is the frame to report.
    if (named && self >= selfFloorMs && ratio >= SELF_RATIO_MIN) return emitOrDrop(node, ctx);

    const descend = (child: CallTreeNode, label: string | undefined) =>
      visit(child, { inheritedName: label, depth: ctx.depth + 1 });

    // A conduit: nearly all of its time is one callee's. Carry the best name
    // seen so far down, so a nameless callee inherits it rather than becoming
    // a card titled `(anonymous)`.
    if (hot.length === 1 && hot[0].totalMs >= DOMINANT_CHILD_RATIO * node.totalMs) {
      return descend(hot[0], meaningfulName(node.frame) ?? ctx.inheritedName);
    }

    // Everything below it is dust: this frame is the best account of its own time.
    if (hot.length === 0) return emitOrDrop(node, ctx, node.children.length > 8);

    // A named fork is the natural grouping point — one card whose highlights
    // explain the fan-out — unless it is so large that it would be a card about
    // the whole recording.
    if (named && node.totalMs <= MAX_CARD_SHARE * durationMs) return emitOrDrop(node, ctx);

    const label = meaningfulName(node.frame) ?? ctx.inheritedName;

    // An unnameable fork: every branch becomes its own card. They are not tied
    // together — a heading over them hid which branch each number belonged to,
    // and the cap that came with it silently dropped the rest of the split.
    return hot.flatMap((child) => descend(child, label));
  }

  const emissions = visit(tree.root, { depth: 0 });
  return finalize(emissions, tree, thresholds, unattributedMs);
}

function isAncestorOf(ancestor: CallTreeNode, node: CallTreeNode): boolean {
  let current = node.parent;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function finalize(
  emissions: Emission[],
  tree: CallTree,
  thresholds: CardSelection["thresholds"],
  unattributedMs: number,
): CardSelection {
  // Recursion can emit the same function twice on one chain. The outer
  // occurrence owns the whole cost, so the inner one is dropped; the same title
  // on disjoint branches is two real findings and both survive.
  const kept = emissions.filter((candidate) => !emissions.some((other) =>
    other !== candidate
    && other.title === candidate.title
    && nodeLocation(other.node) === nodeLocation(candidate.node)
    && isAncestorOf(other.node, candidate.node)
  ))
    // A branch holding no application code at all explains nothing a developer
    // can act on; dropping it promotes the next real finding.
    .filter((emission) => !isFrameworkOnly(emission.node))
    .sort((a, b) =>
      b.node.totalMs - a.node.totalMs
      || effectiveSelfMs(b.node) - effectiveSelfMs(a.node)
      || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0)
      || (a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0)
    );

  // Ranked and cut before the subtrees are walked: building a card rolls up its
  // whole subtree, and a wide fan-out can emit far more of them than are shown.
  return {
    cards: kept.slice(0, MAX_CARDS).map((emission) => buildCard(emission, tree)),
    thresholds,
    unattributedMs: round1(unattributedMs),
    callCountIsExact: tree.callCountIsExact,
    durationMs: tree.durationMs,
    idleMs: round1(tree.idleMs),
  };
}

function isFrameworkOnly(node: CallTreeNode): boolean {
  return isFrameworkInternalFrame(node.frame) && !hasApplicationFrame(node);
}

function buildCard(emission: Emission, tree: CallTree): ProfileCard {
  const { node, title } = emission;
  // A title carried down from an ancestor names a different function than this
  // frame, so this frame's source position would point at the wrong code.
  const location = emission.nameInherited ? undefined : nodeLocation(node);
  const totalMs = round1(node.totalMs);
  const selfMs = round1(effectiveSelfMs(node));
  const exact = tree.callCountIsExact;
  const { repeated, functionCount } = rollupSubtree(node, exact);

  return {
    id: node.id,
    title,
    location,
    headline: location
      ? `${title} at ${location} spent ${Math.round(node.totalMs)} ms in total time`
      : `${title} spent ${Math.round(node.totalMs)} ms in total time`,
    totalMs,
    selfMs,
    percentOfProfile: tree.durationMs > 0 ? round2((node.totalMs / tree.durationMs) * 100) : 0,
    callSites: countCallSites(node),
    invocations: exact ? node.callCount : undefined,
    nameInherited: emission.nameInherited,
    selfShape: emission.selfShape,
    frameworkOnly: isFrameworkOnly(node),
    confidence: node.totalSamples < LOW_CONFIDENCE_SAMPLES ? "low" : "ok",
    reachedVia: reachedVia(node),
    hotPath: hotPath(node),
    highlights: highlightsFor(node),
    children: captureChildren(node, node.totalMs, 1, exact),
    repeated,
    subtreeFunctionCount: functionCount,
  };
}

/** How many recorded call sites merged into this node. Always at least one. */
function countCallSites(node: CallTreeNode): number {
  return Math.max(1, node.callCount);
}

function hasApplicationFrame(node: CallTreeNode): boolean {
  return preOrder(node).some((entry) => frameNameTier(entry.frame) === 2);
}

function reachedVia(node: CallTreeNode): string[] {
  const chain: string[] = [];
  let current: CallTreeNode | null = node;
  while (current) {
    if (!isTransparentFrame(current.frame)) chain.push(nodeLabel(current));
    current = current.parent;
  }
  chain.reverse();
  return compactPath(chain);
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

/** Keep the entry point and the frames nearest the cost; say how many went missing. */
function compactPath(frames: string[]): string[] {
  if (frames.length <= MAX_PATH_FRAMES) return frames;
  const head = frames.slice(0, 2);
  const tail = frames.slice(-(MAX_PATH_FRAMES - 3));
  return [...head, `… (${frames.length - head.length - tail.length} frames omitted)`, ...tail];
}

function highlightsFor(node: CallTreeNode): CardHighlight[] {
  const minMs = HIGHLIGHT_MIN_SHARE * node.totalMs;
  const candidates = preOrder(node)
    .slice(1)
    .filter((entry) => frameNameTier(entry.frame) === 2 && entry.totalMs >= minMs)
    .sort(compareByWeight);

  const selected: CallTreeNode[] = [];
  const seenKeys = new Set<string>();
  for (const candidate of candidates) {
    if (seenKeys.has(candidate.key)) continue;
    // A callee carrying nearly all of an already-listed ancestor's time is the
    // same finding one frame deeper — and the deeper frame is the more useful
    // of the two, because it names where the time actually goes rather than
    // the wrapper that delegated to it. Replace rather than skip, so a chain of
    // pass-throughs resolves to the frame at the bottom of it.
    // The deeper frame of a pass-through pair can arrive either before or
    // after its wrapper — they share an inclusive time, so the ordering falls
    // to self time, which the deeper one usually holds. Handle both directions.
    const wrapperOfCandidate = selected.findIndex((chosen) =>
      isAncestorOf(chosen, candidate) && candidate.totalMs >= HIGHLIGHT_PASSTHROUGH_RATIO * chosen.totalMs
    );
    if (wrapperOfCandidate >= 0) {
      seenKeys.delete(selected[wrapperOfCandidate].key);
      selected.splice(wrapperOfCandidate, 1, candidate);
      seenKeys.add(candidate.key);
      continue;
    }
    const alreadyDeeper = selected.some((chosen) =>
      isAncestorOf(candidate, chosen) && chosen.totalMs >= HIGHLIGHT_PASSTHROUGH_RATIO * candidate.totalMs
    );
    if (alreadyDeeper) continue;
    if (selected.length >= HIGHLIGHT_COUNT) continue;
    selected.push(candidate);
    seenKeys.add(candidate.key);
  }
  selected.sort(compareByWeight);

  return selected.map((entry) => {
    const totalMs = round1(entry.totalMs);
    const selfMs = round1(effectiveSelfMs(entry));
    return {
      name: nodeName(entry),
      location: nodeLocation(entry),
      totalMs,
      selfMs,
      text: `${nodeName(entry)} - ${totalMs}ms total time, ${selfMs}ms self time`,
    };
  });
}

function captureChildren(node: CallTreeNode, cardTotalMs: number, level: number, exact: boolean): CardChildNode[] {
  if (level > CHILD_LEVELS) return [];
  const visible = node.children.filter((child) => !ATTRIBUTED_TO_PARENT.has(child.frame.functionName));
  const minMs = CHILD_MIN_SHARE * cardTotalMs;
  const kept = visible.filter((child) => child.totalMs >= minMs).sort(compareByWeight);
  const head = kept.slice(0, MAX_CHILDREN_PER_LEVEL);
  const rest = [...kept.slice(MAX_CHILDREN_PER_LEVEL), ...visible.filter((child) => child.totalMs < minMs)];

  const out: CardChildNode[] = head.map((child) => ({
    name: nodeName(child),
    location: nodeLocation(child),
    totalMs: round1(child.totalMs),
    selfMs: round1(effectiveSelfMs(child)),
    callSites: Math.max(1, child.callCount),
    invocations: exact ? child.callCount : undefined,
    frameworkInternal: isFrameworkInternalFrame(child.frame),
    children: captureChildren(child, cardTotalMs, level + 1, exact),
  }));

  if (rest.length > 0) {
    const restMs = rest.reduce((sum, child) => sum + child.totalMs, 0);
    if (restMs > 0) {
      out.push({
        name: `${rest.length} smaller callee${rest.length === 1 ? "" : "s"}`,
        totalMs: round1(restMs),
        selfMs: round1(rest.reduce((sum, child) => sum + effectiveSelfMs(child), 0)),
        callSites: rest.length,
        frameworkInternal: false,
        children: [],
        truncated: { count: rest.length, totalMs: round1(restMs) },
      });
    }
  }
  return out;
}

interface RepeatedAcc {
  name: string;
  location?: string;
  totalMs: number;
  selfMs: number;
  callSites: number;
  invocations: number;
  callers: Map<string, { name: string; callSites: number; invocations: number; totalMs: number }>;
}

/**
 * Every function in the parent's whole subtree, grouped by identity, so a card
 * can say how often a helper ran underneath it and what it cost across all of
 * those calls.
 */
function rollupSubtree(root: CallTreeNode, exact: boolean): { repeated: RepeatedFunction[]; functionCount: number } {
  const acc = new Map<string, RepeatedAcc>();
  // Identities currently on the walked path. Inclusive time is only credited to
  // the outermost occurrence, or `f -> g -> f` counts the inner subtree twice.
  const onPath = new Map<string, number>();
  const callerStack: CallTreeNode[] = [root];

  type Frame = { node: CallTreeNode; enter: boolean; counted: boolean; pushedCaller: boolean };
  const stack: Frame[] = root.children.map((child) => ({ node: child, enter: true, counted: false, pushedCaller: false }));

  while (stack.length > 0) {
    const frame = stack.pop()!;
    const { node } = frame;
    if (!frame.enter) {
      if (frame.counted) {
        const depth = (onPath.get(node.key) ?? 1) - 1;
        if (depth <= 0) onPath.delete(node.key); else onPath.set(node.key, depth);
      }
      if (frame.pushedCaller) callerStack.pop();
      continue;
    }

    const transparent = isTransparentFrame(node.frame);
    if (!transparent) {
      const entry = acc.get(node.key) ?? {
        name: nodeName(node),
        location: nodeLocation(node),
        totalMs: 0, selfMs: 0, callSites: 0, invocations: 0,
        callers: new Map(),
      };
      const outermost = !onPath.has(node.key);
      entry.selfMs += effectiveSelfMs(node);
      entry.callSites += 1;
      entry.invocations += node.callCount;
      if (outermost) entry.totalMs += node.totalMs;
      acc.set(node.key, entry);

      const caller = callerStack[callerStack.length - 1];
      const callerEntry = entry.callers.get(caller.key) ?? { name: nodeName(caller), callSites: 0, invocations: 0, totalMs: 0 };
      callerEntry.callSites += 1;
      callerEntry.invocations += node.callCount;
      if (outermost) callerEntry.totalMs += node.totalMs;
      entry.callers.set(caller.key, callerEntry);

      onPath.set(node.key, (onPath.get(node.key) ?? 0) + 1);
      frame.counted = true;
      callerStack.push(node);
      frame.pushedCaller = true;
    }

    stack.push({ ...frame, enter: false });
    for (const child of node.children) {
      if (ATTRIBUTED_TO_PARENT.has(child.frame.functionName)) continue;
      stack.push({ node: child, enter: true, counted: false, pushedCaller: false });
    }
  }

  const minMs = Math.max(5, REPEATED_MIN_SHARE * root.totalMs);
  const repeated = [...acc.values()]
    .filter((entry) => entry.callSites >= 2 || entry.invocations >= 2)
    .filter((entry) => entry.totalMs >= minMs)
    .sort((a, b) => b.totalMs - a.totalMs || b.selfMs - a.selfMs || (a.name < b.name ? -1 : 1))
    .slice(0, MAX_REPEATED)
    .map((entry) => ({
      name: entry.name,
      location: entry.location,
      totalMs: round1(entry.totalMs),
      selfMs: round1(entry.selfMs),
      callSites: entry.callSites,
      invocations: exact ? entry.invocations : undefined,
      callers: [...entry.callers.values()]
        .sort((a, b) => b.totalMs - a.totalMs || b.callSites - a.callSites)
        .slice(0, MAX_CALLERS)
        .map((caller) => ({
          name: caller.name,
          callSites: caller.callSites,
          invocations: exact ? caller.invocations : undefined,
          totalMs: round1(caller.totalMs),
        })),
    }));

  return { repeated, functionCount: acc.size };
}
