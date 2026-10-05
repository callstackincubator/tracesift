/**
 * A merged call tree with both self and inclusive time.
 *
 * The selection path had neither: `groupBottlenecks` rolls leaf self time up to
 * one chosen caller, so a group is a flat bag of leaves and "what did this
 * function's subtree cost" has no answer. `normalize.ts` does compute inclusive
 * time, but dedups by global frame identity, collapsing every call path of a
 * function into one number — a correct answer to a different question, and one
 * that cannot be descended. This module keeps the paths.
 */

import { isTransparentFrame } from "./frame-names.ts";
import { compactLocation } from "./source-location.ts";
import type { CdpCallFrame, CdpProfile } from "../app/js-profiler/types";

export interface CallTreeNode {
  /**
   * Sibling path, e.g. `0.2.1`. Assigned after children are sorted, so an id is
   * a stable function of the profile bytes — prompts cache on it and the
   * drill-down view addresses cards by it.
   */
  id: string;
  /** Frame identity used to merge siblings. */
  key: string;
  frame: CdpCallFrame;
  depth: number;
  /** Sampled time where this node was the leaf, scaled to wall duration. */
  selfMs: number;
  /** `selfMs + sum(children.totalMs)`, exact by construction. */
  totalMs: number;
  selfSamples: number;
  totalSamples: number;
  /** Distinct raw profile nodes merged here. Only an invocation count when `callCountIsExact`. */
  callCount: number;
  children: CallTreeNode[];
  parent: CallTreeNode | null;
}

export interface CallTree {
  root: CallTreeNode;
  durationMs: number;
  sampleCount: number;
  meanSampleMs: number;
  /**
   * True only when each raw node is one invocation, which is the case for
   * Hermes duration traces and never for V8 sampling, where nodes are
   * path-unique. Gates every "called N times" phrase downstream.
   */
  callCountIsExact: boolean;
  /** Weight that landed in `(idle)` subtrees, excluded from the tree. */
  idleMs: number;
  /**
   * The node each sample landed in, in recording order, `null` for a sample
   * inside an `(idle)` subtree. Only present when `trackSamples` asked for it:
   * a whole-profile tree can hold millions of samples, and nothing but the
   * task-scoped invocation counting needs the ordering back.
   */
  sampleNodes?: (CallTreeNode | null)[];
}

/**
 * Identity deliberately excludes `scriptId`: it is a per-session V8 handle, and
 * the Hermes path fills it from `args.scriptId`, which is not stable across
 * invocations. Two frames agreeing on name, url and position are one function.
 */
export function frameIdentity(frame: CdpCallFrame): string {
  return `${frame.functionName}\u0000${frame.url}\u0000${frame.lineNumber}\u0000${frame.columnNumber}`;
}

/**
 * Per-sample weights in milliseconds. Profiles carrying time deltas keep their
 * measured interval weights, rescaled so they sum to the wall duration;
 * profiles without them fall back to duration / sample count. Kept identical to
 * the legacy engine so totals stay comparable while both paths exist.
 */
export function sampleWeightsMs(profile: CdpProfile, durationMs: number): number[] {
  const samples = profile.samples ?? [];
  const rawDeltas = profile.timeDeltas ?? [];
  const totalDelta = rawDeltas.reduce((sum, delta) => sum + Math.max(0, delta), 0);
  const deltaScale = totalDelta > 0 && durationMs > 0 ? durationMs / (totalDelta / 1000) : 1;
  return samples.map((_, index) =>
    totalDelta > 0
      ? (Math.max(0, rawDeltas[index] ?? 0) / 1000) * deltaScale
      : samples.length > 0
        ? durationMs / samples.length
        : 0
  );
}

const ROOT_FRAME: CdpCallFrame = { functionName: "(root)", scriptId: "", url: "", lineNumber: -1, columnNumber: -1 };

/** Idle is not work: its subtrees never enter the tree. */
const IDLE = "(idle)";

function newNode(frame: CdpCallFrame, parent: CallTreeNode | null): CallTreeNode {
  return {
    id: "",
    key: frameIdentity(frame),
    frame,
    depth: parent ? parent.depth + 1 : 0,
    selfMs: 0,
    totalMs: 0,
    selfSamples: 0,
    totalSamples: 0,
    callCount: 0,
    children: [],
    parent,
  };
}

export function buildCallTree(
  profile: CdpProfile,
  durationMs: number,
  options: { callCountIsExact?: boolean; trackSamples?: boolean } = {},
): CallTree {
  const nodeById = new Map(profile.nodes.map((node) => [node.id, node]));
  const parentById = new Map<number, number>();
  for (const node of profile.nodes) {
    if (typeof node.parentId === "number" && node.parentId >= 0) parentById.set(node.id, node.parentId);
    for (const childId of node.children ?? []) parentById.set(childId, node.id);
  }

  const root = newNode(ROOT_FRAME, null);
  // Transient child lookup, discarded once the tree is built: keeping it on the
  // node would be serialized into every API response and prompt payload.
  const childIndex = new Map<CallTreeNode, Map<string, CallTreeNode>>();
  /** `null` marks a raw node inside an `(idle)` subtree. */
  const merged = new Map<number, CallTreeNode | null>();

  function childOf(parent: CallTreeNode, frame: CdpCallFrame): CallTreeNode {
    let index = childIndex.get(parent);
    if (!index) {
      index = new Map();
      childIndex.set(parent, index);
    }
    const key = frameIdentity(frame);
    const existing = index.get(key);
    if (existing) return existing;
    const child = newNode(frame, parent);
    parent.children.push(child);
    index.set(key, child);
    return child;
  }

  function mergedFor(rawId: number): CallTreeNode | null {
    if (merged.has(rawId)) return merged.get(rawId) ?? null;
    // Walk up to the nearest already-merged ancestor, collecting what is new.
    const pending: number[] = [];
    const seen = new Set<number>();
    let current: number | undefined = rawId;
    while (current !== undefined && !seen.has(current) && !merged.has(current)) {
      seen.add(current);
      pending.push(current);
      current = parentById.get(current);
    }
    // A cycle, or a node whose parent is missing, attaches under the root — the
    // same recovery the legacy walker makes with its `visited` guard.
    let node: CallTreeNode | null = current !== undefined && merged.has(current) ? merged.get(current) ?? null : root;
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const rawNode = nodeById.get(pending[index]);
      if (!rawNode) continue;
      if (node === null || rawNode.callFrame.functionName === IDLE) {
        node = null;
        merged.set(pending[index], null);
        continue;
      }
      // The profile's own `(root)` is the tree root, not a child of it.
      if (rawNode.callFrame.functionName === ROOT_FRAME.functionName) {
        merged.set(pending[index], node);
        continue;
      }
      node = childOf(node, rawNode.callFrame);
      node.callCount += 1;
      merged.set(pending[index], node);
    }
    return node;
  }

  for (const rawNode of profile.nodes) mergedFor(rawNode.id);

  const samples = profile.samples ?? [];
  const weights = sampleWeightsMs(profile, durationMs);
  let idleMs = 0;
  const sampleNodes = options.trackSamples === true ? new Array<CallTreeNode | null>(samples.length) : undefined;
  for (let index = 0; index < samples.length; index += 1) {
    const node = mergedFor(samples[index]);
    const weight = weights[index] ?? 0;
    if (sampleNodes) sampleNodes[index] = node;
    if (!node) {
      idleMs += weight;
      continue;
    }
    node.selfMs += weight;
    node.selfSamples += 1;
  }

  // Totals in one iterative post-order pass. Hermes traces run thousands of
  // frames deep, so recursion here would overflow the stack on real input.
  for (const node of postOrder(root)) {
    let totalMs = node.selfMs;
    let totalSamples = node.selfSamples;
    for (const child of node.children) {
      totalMs += child.totalMs;
      totalSamples += child.totalSamples;
    }
    node.totalMs = totalMs;
    node.totalSamples = totalSamples;
  }

  sortAndIdentify(root);
  childIndex.clear();

  const sampleCount = samples.length;
  const sampledMs = weights.reduce((sum, weight) => sum + weight, 0);
  return {
    root,
    durationMs,
    sampleCount,
    meanSampleMs: sampleCount > 0 ? sampledMs / sampleCount : 0,
    callCountIsExact: options.callCountIsExact === true,
    idleMs,
    ...(sampleNodes ? { sampleNodes } : {}),
  };
}

/** Children before parents, iteratively. */
export function postOrder(root: CallTreeNode): CallTreeNode[] {
  const out: CallTreeNode[] = [];
  const stack: CallTreeNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    out.push(node);
    for (const child of node.children) stack.push(child);
  }
  return out.reverse();
}

/** Every node, parents before children. */
export function preOrder(root: CallTreeNode): CallTreeNode[] {
  const out: CallTreeNode[] = [];
  const stack: CallTreeNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    out.push(node);
    for (let index = node.children.length - 1; index >= 0; index -= 1) stack.push(node.children[index]);
  }
  return out;
}

/**
 * Heaviest first, with name and position as tie-breakers so the order is total:
 * ids are derived from it, and equal float totals would otherwise leave them at
 * the mercy of insertion order.
 */
export function compareByWeight(a: CallTreeNode, b: CallTreeNode): number {
  return b.totalMs - a.totalMs
    || b.selfMs - a.selfMs
    || (a.frame.functionName < b.frame.functionName ? -1 : a.frame.functionName > b.frame.functionName ? 1 : 0)
    || (a.frame.url < b.frame.url ? -1 : a.frame.url > b.frame.url ? 1 : 0)
    || a.frame.lineNumber - b.frame.lineNumber
    || a.frame.columnNumber - b.frame.columnNumber;
}

function sortAndIdentify(root: CallTreeNode): void {
  root.id = "0";
  const stack: CallTreeNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    node.children.sort(compareByWeight);
    node.children.forEach((child, index) => {
      child.id = `${node.id}.${index}`;
      stack.push(child);
    });
  }
}

/** Display name for a tree row. Unlike a card title, `(anonymous)` is allowed here. */
export function nodeName(node: CallTreeNode): string {
  return node.frame.functionName || "(anonymous)";
}

/**
 * Where the frame is, as short as it can be said: a source path whole, and a
 * bundle chunk cut back to its file name and position.
 *
 * Readable-path-only was the rule here, and on a bundled app it left every row
 * in every stack, card and hand-off with no position at all — the frames a
 * reader most needs to tell apart are exactly the ones a minified build gives
 * the least to go on. `vendors.bundle.js:189:701931` is not a file to open, but
 * it separates two `(anonymous)` frames and says whether the cost is in the
 * product or in a dependency, and it is the string a source map resolves.
 * Anything that needs a path it can actually open tests it with
 * `isReadableSourcePath` rather than assuming this returned one.
 */
export function nodeLocation(node: CallTreeNode): string | undefined {
  const { frame } = node;
  if (!frame.url) return undefined;
  return compactLocation(frame.url, frame.lineNumber, frame.columnNumber);
}

/**
 * `name (where)` for a frame that has a position, and the bare name for one
 * that does not — `(anonymous) ((anonymous):0:0)` is noise, not detail.
 */
export function nodeLabel(node: CallTreeNode): string {
  const where = nodeLocation(node);
  return where ? `${nodeName(node)} (${where})` : nodeName(node);
}

export { isTransparentFrame };
