import { isFrameworkInternalFrame } from "./framework-frames.ts";
import { frameSourceLocation } from "./source-location.ts";
import type { CdpCallFrame, CdpProfile, CdpProfileNode } from "../app/js-profiler/types";

/** Absolute weight a group needs before it is worth a card at all. */
export const MIN_HOTSPOT_TIME_MS = 20;

/**
 * Naming a leaf is a different question from ranking a group, and reusing the
 * group threshold for both hid ordinary application work: on a 13 s profile it
 * named under two functions per group and left ~60% of the measured time with no
 * function attached, while the agent had room for eight. A leaf still needs
 * enough samples to be distinguishable from scheduling jitter, so scale with the
 * sampling interval rather than trusting a fixed millisecond count on every profile.
 */
const MIN_FUNCTION_SAMPLES = 10;
const MIN_FUNCTION_TIME_FLOOR_MS = 3;

/**
 * Share of a group that named application frames must account for before the
 * group is worth showing. A group where internals dominate and application code
 * only appears in the margins explains nothing a developer can act on.
 */
const MIN_APPLICATION_SHARE = 0.1;

/**
 * A card has to be worth reading against the profile it came from. Merging bursts
 * promotes callers that are individually trivial — tens of a millisecond, dozens
 * of times — into totals that clear a fixed floor without being a bottleneck.
 * The absolute floor still governs short profiles, where a share means little.
 */
const MIN_HOTSPOT_SHARE_OF_PROFILE = 0.005;

/**
 * Grouping on the application caller resolves one framework-owned blob into the
 * several components that actually did the work, so the report needs more slots
 * than it did when a whole render phase arrived as a single card. Sized to clear
 * everything the share floor already admits; the floor, not this cap, is what
 * decides whether a finding is worth reporting.
 */
const MAX_HOTSPOTS = 20;

export interface HotFunction {
  id: string;
  title: string;
  selfTimeMs: number;
  percentOfGroup: number;
  /** `path:line:column` of the function itself, when the frame names a readable source file. */
  location?: string;
  stack: string[];
}

export interface Bottleneck {
  id: string;
  title: string;
  combinedTimeMs: number;
  percentOfTotal: number;
  stack: string[];
  functions: HotFunction[];
  /**
   * Separate contiguous runs of this caller that were sampled. A caller that
   * fires repeatedly is one bottleneck, not one per burst.
   */
  occurrences: number;
  /**
   * The longest single uninterrupted run. `combinedTimeMs` says how much total
   * work this caller costs; this says how much of it lands in one block, which
   * is the part a user can feel as a dropped frame.
   */
  longestRunMs: number;
  /**
   * Self time a leaf needed before it was named. Scales with the profile's
   * sampling interval, so the report has to carry it rather than restate a
   * constant that is not the threshold actually applied.
   */
  minFunctionTimeMs: number;
  /** Every hot function is React/scheduler internals, so the group is not actionable. */
  frameworkOnly: boolean;
}

const runtimeNames = new Set(["(root)", "(idle)", "(program)", "(garbage collector)", "(optimized code)"]);
const dispatchNames = new Set(["processTicksAndRejections", "runMicrotasks", "processTimers", "listOnTimeout", "flushWork", "workLoop", "performWorkUntilDeadline"]);

function identity(frame: CdpCallFrame): string {
  return JSON.stringify([frame.functionName, frame.scriptId, frame.url, frame.lineNumber, frame.columnNumber]);
}

function label(frame: CdpCallFrame): string {
  return `${frame.functionName || "(anonymous)"} (${frame.url || "(anonymous)"}:${frame.lineNumber + 1}:${frame.columnNumber + 1})`;
}

/** Attribute sampled work to the outermost application caller it ran under.
 * Self time is accumulated per contiguous run, then runs of the same caller are
 * combined: a caller that fires eleven times is one bottleneck with eleven
 * occurrences, not eleven cards burying every other finding out of the report.
 * The per-run partition is still what makes the attribution correct, and its
 * latency signal survives as `longestRunMs`.
 * Each leaf sample contributes self time to exactly one function in one group.
 * Profiles with time deltas retain their measured interval weights; profiles
 * without them fall back to duration / sample count.
 */
export function groupBottlenecks(profile: CdpProfile, durationMs: number): Bottleneck[] {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parents = new Map<number, number>();
  for (const node of profile.nodes) {
    if (node.parentId !== undefined && node.parentId >= 0) parents.set(node.id, node.parentId);
    for (const child of node.children ?? []) parents.set(child, node.id);
  }
  const samples = profile.samples ?? [];
  const rawDeltas = profile.timeDeltas ?? [];
  const totalDelta = rawDeltas.reduce((sum, delta) => sum + Math.max(0, delta), 0);
  const deltaScale = totalDelta > 0 && durationMs > 0 ? durationMs / (totalDelta / 1000) : 1;
  const sampleTimesMs = samples.map((_, index) =>
    totalDelta > 0
      ? (Math.max(0, rawDeltas[index] ?? 0) / 1000) * deltaScale
      : samples.length > 0
        ? durationMs / samples.length
        : 0
  );
  type Member = HotFunction & { frameworkInternal: boolean };
  // frameworkOnly and minFunctionTimeMs are derived once every sample is counted.
  type Group = Omit<Bottleneck, "frameworkOnly" | "minFunctionTimeMs"> & { members: Map<string, Member> };
  const groups = new Map<string, Group>();
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
    // The outermost frame alone is the wrong owner under a framework: React calls
    // the application, so the outermost named frame of every rendered component is
    // always React's own scheduler, and all of it collapses into one group that
    // says nothing. Prefer the outermost *application* frame — the component the
    // work ran in — and fall back to the framework frame only when a stack holds
    // no application code at all, where `frameworkOnly` then drops the group.
    const nameable = ({ callFrame: frame }: CdpProfileNode) =>
      Boolean(frame.functionName) && !dispatchNames.has(frame.functionName);
    const owner = outerFirst.find((node) => nameable(node) && !isFrameworkInternalFrame(node.callFrame))
      ?? outerFirst.find(nameable)
      ?? outerFirst[0];
    const context = { owner, meaningful };
    contexts.set(id, context);
    return context;
  }
  // A run ends when the sampled caller changes or the profiler leaves user code.
  let runKey: string | undefined;
  let runGroup: Group | undefined;
  let runMs = 0;
  const closeRun = () => {
    if (runGroup) runGroup.longestRunMs = Math.max(runGroup.longestRunMs, runMs);
    runGroup = undefined;
    runMs = 0;
  };
  for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex++) {
    const id = samples[sampleIndex];
    const sampleMs = sampleTimesMs[sampleIndex];
    const leaf = nodes.get(id);
    const { owner, meaningful } = contextFor(id);
    // GC can interrupt a caller without unwinding it. A standalone GC sample
    // has no caller context, so preserve the current run without charging time.
    if (!owner && leaf?.callFrame.functionName === "(garbage collector)") continue;
    const key = owner ? identity(owner.callFrame) : undefined;
    if (key === undefined || key !== runKey) {
      closeRun();
      runKey = key;
    }
    if (!owner || !leaf || runtimeNames.has(leaf.callFrame.functionName) || (!leaf.callFrame.functionName && !leaf.callFrame.url)) continue;
    let group = groups.get(key!);
    if (!group) {
      group = { id: `b${groups.size + 1}`, title: owner.callFrame.functionName || "(anonymous)", combinedTimeMs: 0, percentOfTotal: 0, occurrences: 0, longestRunMs: 0, stack: meaningful.slice(meaningful.indexOf(owner)).map(node => label(node.callFrame)), functions: [], members: new Map() };
      groups.set(key!, group);
    }
    // The first sample of a run is what opens it; samples skipped above do not.
    if (!runGroup) {
      runGroup = group;
      group.occurrences += 1;
    }
    group.combinedTimeMs += sampleMs;
    runMs += sampleMs;
    const leafKey = identity(leaf.callFrame);
    let member = group.members.get(leafKey);
    if (!member) {
      member = { id: `${group.id}-f${group.members.size + 1}`, title: leaf.callFrame.functionName || "(anonymous)", selfTimeMs: 0, percentOfGroup: 0, location: frameSourceLocation(leaf.callFrame), stack: meaningful.map(node => label(node.callFrame)), frameworkInternal: isFrameworkInternalFrame(leaf.callFrame) };
      group.members.set(leafKey, member);
    }
    member.selfTimeMs += sampleMs;
  }
  closeRun();
  const sampledMs = sampleTimesMs.reduce((sum, ms) => sum + ms, 0);
  const meanSampleMs = sampleTimesMs.length > 0 ? sampledMs / sampleTimesMs.length : 0;
  // Never coarser than the group threshold: a sparsely sampled profile falls back
  // to the old behaviour instead of scaling up until it names nothing at all.
  const minFunctionTimeMs = Math.min(MIN_HOTSPOT_TIME_MS, Math.max(MIN_FUNCTION_TIME_FLOOR_MS, meanSampleMs * MIN_FUNCTION_SAMPLES));
  return [...groups.values()].map(({ members, ...group }) => {
    // Filter after aggregating each function's samples; keep the full umbrella total.
    const hot = [...members.values()].filter((member) => member.selfTimeMs > minFunctionTimeMs).sort((a, b) => b.selfTimeMs - a.selfTimeMs);
    const applicationMs = hot.reduce((sum, member) => member.frameworkInternal ? sum : sum + member.selfTimeMs, 0);
    return {
      ...group,
      percentOfTotal: durationMs > 0 ? Math.round(group.combinedTimeMs / durationMs * 10000) / 100 : 0,
      minFunctionTimeMs,
      // Framework internals stay in a group that also holds application work, where
      // they explain its cost; a group they dominate is dropped below.
      frameworkOnly: hot.length > 0 && (
        applicationMs < group.combinedTimeMs * MIN_APPLICATION_SHARE
        // Combining a caller's bursts also adds up its incidental application
        // frames, enough to clear a share test while the card still says nothing
        // but "flushMutationEffects took 1.5 s". One internal outweighing every
        // application frame in the group makes it a report about React.
        || (hot[0].frameworkInternal && hot[0].selfTimeMs > applicationMs)
      ),
      functions: hot.map((member) => ({
        id: member.id,
        title: member.title,
        selfTimeMs: member.selfTimeMs,
        percentOfGroup: group.combinedTimeMs > 0 ? Math.round(member.selfTimeMs / group.combinedTimeMs * 10000) / 100 : 0,
        location: member.location,
        stack: member.stack,
      })),
    };
  })
    // Drop framework-only groups before ranking, so excluding them promotes the
    // next actionable group rather than shortening the report.
    .filter((group) => group.combinedTimeMs > Math.max(MIN_HOTSPOT_TIME_MS, durationMs * MIN_HOTSPOT_SHARE_OF_PROFILE) && group.functions.length > 0 && !group.frameworkOnly)
    .sort((a, b) => b.combinedTimeMs - a.combinedTimeMs).slice(0, MAX_HOTSPOTS);
}
