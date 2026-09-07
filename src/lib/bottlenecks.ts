import type { CdpCallFrame, CdpProfile, CdpProfileNode } from "../app/js-profiler/types";

export const MIN_HOTSPOT_TIME_MS = 20;

export interface HotFunction {
  id: string;
  title: string;
  selfTimeMs: number;
  percentOfGroup: number;
  stack: string[];
}

export interface Bottleneck {
  id: string;
  title: string;
  combinedTimeMs: number;
  percentOfTotal: number;
  stack: string[];
  functions: HotFunction[];
}

const runtimeNames = new Set(["(root)", "(idle)", "(program)", "(garbage collector)", "(optimized code)"]);
const dispatchNames = new Set(["processTicksAndRejections", "runMicrotasks", "processTimers", "listOnTimeout", "flushWork", "workLoop", "performWorkUntilDeadline"]);

function identity(frame: CdpCallFrame): string {
  return JSON.stringify([frame.functionName, frame.scriptId, frame.url, frame.lineNumber, frame.columnNumber]);
}

function label(frame: CdpCallFrame): string {
  return `${frame.functionName || "(anonymous)"} (${frame.url || "(anonymous)"}:${frame.lineNumber + 1}:${frame.columnNumber + 1})`;
}

/** Partition sampled work by consecutive runs of its outermost meaningful caller.
 * Caller node IDs preserve call-path identity; source locations do not identify runs.
 * Separate invocations without an observed stack exit cannot be distinguished.
 * Each leaf sample contributes self time to exactly one function in one group.
 * Like the existing profiler, timings use duration / sample count.
 */
export function groupBottlenecks(profile: CdpProfile, durationMs: number): Bottleneck[] {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parents = new Map<number, number>();
  for (const node of profile.nodes) {
    if (node.parentId !== undefined && node.parentId >= 0) parents.set(node.id, node.parentId);
    for (const child of node.children ?? []) parents.set(child, node.id);
  }
  const samples = profile.samples ?? [];
  const sampleMs = samples.length ? durationMs / samples.length : 0;
  type Group = Bottleneck & { members: Map<string, HotFunction> };
  const groups: Group[] = [];
  const contexts = new Map<number, { owner: CdpProfileNode | undefined; meaningful: CdpProfileNode[] }>();
  function contextFor(id: number) {
    const cached = contexts.get(id);
    if (cached) return cached;
    const chain: CdpProfileNode[] = [];
    const visited = new Set<number>();
    let current: number | undefined = id;
    while (current !== undefined && !visited.has(current)) {
      visited.add(current);
      const node = nodes.get(current);
      if (!node) break;
      chain.push(node);
      current = parents.get(current);
    }
    const meaningful = chain.filter(({ callFrame: frame }) => !runtimeNames.has(frame.functionName) && (frame.functionName || frame.url));
    const outerFirst = [...meaningful].reverse();
    const owner = outerFirst.find(({ callFrame: frame }) => frame.functionName && !dispatchNames.has(frame.functionName)) ?? outerFirst[0];
    const context = { owner, meaningful };
    contexts.set(id, context);
    return context;
  }
  let activeOwner: number | undefined;
  let group: Group | undefined;
  for (const id of samples) {
    const leaf = nodes.get(id);
    const { owner, meaningful } = contextFor(id);
    // GC can interrupt a caller without unwinding it. A standalone GC sample
    // has no caller context, so preserve the current run without charging time.
    if (!owner && leaf?.callFrame.functionName === "(garbage collector)") continue;
    if (!owner || owner.id !== activeOwner) {
      activeOwner = owner?.id;
      group = undefined;
    }
    if (!owner || !leaf || runtimeNames.has(leaf.callFrame.functionName) || (!leaf.callFrame.functionName && !leaf.callFrame.url)) continue;
    if (!group) {
      group = { id: `b${groups.length + 1}`, title: owner.callFrame.functionName || "(anonymous)", combinedTimeMs: 0, percentOfTotal: 0, stack: meaningful.slice(meaningful.indexOf(owner)).map(node => label(node.callFrame)), functions: [], members: new Map() };
      groups.push(group);
    }
    group.combinedTimeMs += sampleMs;
    const leafKey = identity(leaf.callFrame);
    let member = group.members.get(leafKey);
    if (!member) {
      member = { id: `${group.id}-f${group.members.size + 1}`, title: leaf.callFrame.functionName || "(anonymous)", selfTimeMs: 0, percentOfGroup: 0, stack: meaningful.map(node => label(node.callFrame)) };
      group.members.set(leafKey, member);
    }
    member.selfTimeMs += sampleMs;
  }
  return groups.map(({ members, ...group }) => ({
    ...group,
    percentOfTotal: durationMs > 0 ? Math.round(group.combinedTimeMs / durationMs * 10000) / 100 : 0,
    // Filter after aggregating each function's samples; keep the full umbrella total.
    functions: [...members.values()].filter((member) => member.selfTimeMs > MIN_HOTSPOT_TIME_MS).map((member) => ({ ...member, percentOfGroup: group.combinedTimeMs > 0 ? Math.round(member.selfTimeMs / group.combinedTimeMs * 10000) / 100 : 0 })).sort((a, b) => b.selfTimeMs - a.selfTimeMs),
  })).filter((group) => group.combinedTimeMs > MIN_HOTSPOT_TIME_MS && group.functions.length > 0).sort((a, b) => b.combinedTimeMs - a.combinedTimeMs).slice(0, 12);
}
