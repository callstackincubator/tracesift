import { attachMeasuredTasks, type RawTaskInterval } from "./tasks.ts";
import type { CdpCallFrame, CdpProfile, CdpProfileNode } from "../app/js-profiler/types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * hermes-profile-transformer emits a Chrome-compatible flame chart as nested
 * duration events rather than a V8 CpuProfile. Reconstruct one weighted leaf
 * sample for each interval in which the active stack does not change. A fresh
 * node is used for every begin event so separate invocations remain separate
 * bottleneck groups even when they have the same source location.
 */
export function extractFromDurationTrace(events: Record<string, unknown>[]): CdpProfile | null {
  const byThread = new Map<string, Array<{ event: Record<string, unknown>; index: number }>>();

  events.forEach((event, index) => {
    if ((event.ph !== "B" && event.ph !== "E") || typeof event.ts !== "number") return;
    const key = `${event.pid ?? ""}:${event.tid ?? ""}`;
    const threadEvents = byThread.get(key) ?? [];
    threadEvents.push({ event, index });
    byThread.set(key, threadEvents);
  });

  let best: CdpProfile | null = null;
  let bestTasks: RawTaskInterval[] = [];
  let bestSampledTime = -1;

  for (const threadEvents of byThread.values()) {
    threadEvents.sort((a, b) => (a.event.ts as number) - (b.event.ts as number) || a.index - b.index);
    if (!threadEvents.some(({ event }) => event.ph === "B")) continue;

    const nodes: CdpProfileNode[] = [];
    const stack: CdpProfileNode[] = [];
    const samples: number[] = [];
    const timeDeltas: number[] = [];
    const startTime = threadEvents[0].event.ts as number;
    let previousTime = startTime;
    let sampledTime = 0;
    let nextNodeId = 1;
    // A begin event arriving on an empty stack opens a top-level call, which is
    // this format's equivalent of a task: nothing else was running, and the
    // whole of it is one uninterrupted block.
    const tasks: RawTaskInterval[] = [];
    let taskStart = -1;
    /**
     * Sample slots for the intervals between two top-level calls, recorded as
     * idle rather than dropped. A CDP profile's time deltas are what every
     * consumer reconstructs sample timestamps from, so a gap left out of them
     * silently shifts every later sample earlier — enough to put it in the
     * wrong task — and the time the runtime spent doing nothing would otherwise
     * be redistributed over the work as if it had been busy throughout. The id
     * is assigned after the walk so the call nodes keep theirs.
     */
    const idleSamples: number[] = [];

    for (const { event } of threadEvents) {
      const timestamp = event.ts as number;
      const delta = Math.max(0, timestamp - previousTime);
      const activeNode = stack.at(-1);
      if (delta > 0) {
        if (!activeNode) idleSamples.push(samples.length);
        samples.push(activeNode?.id ?? 0);
        timeDeltas.push(delta);
        if (activeNode) sampledTime += delta;
      }

      if (event.ph === "B") {
        if (stack.length === 0) taskStart = timestamp;
        const parent = stack.at(-1);
        const node: CdpProfileNode = {
          id: nextNodeId++,
          callFrame: callFrameFromDurationEvent(event),
          parentId: parent?.id,
        };
        if (parent) {
          (parent.children ??= []).push(node.id);
        }
        nodes.push(node);
        stack.push(node);
      } else if (stack.length > 0) {
        stack.pop();
        if (stack.length === 0 && taskStart >= 0 && timestamp > taskStart) {
          tasks.push({ ts: taskStart, dur: timestamp - taskStart });
          taskStart = -1;
        }
      }
      previousTime = timestamp;
    }

    if (nodes.length === 0 || samples.length === 0) continue;
    if (idleSamples.length > 0) {
      const idleId = nextNodeId++;
      nodes.push({
        id: idleId,
        callFrame: { functionName: "(idle)", scriptId: "", url: "", lineNumber: -1, columnNumber: -1 },
      });
      for (const index of idleSamples) samples[index] = idleId;
    }
    const candidate: CdpProfile = {
      nodes,
      samples,
      timeDeltas,
      startTime,
      endTime: previousTime,
    };
    if (sampledTime > bestSampledTime) {
      best = candidate;
      bestTasks = tasks;
      bestSampledTime = sampledTime;
    }
  }

  return best && bestTasks.length > 0 ? attachMeasuredTasks(best, bestTasks) : best;
}

function callFrameFromDurationEvent(event: Record<string, unknown>): CdpCallFrame {
  const args = isRecord(event.args) ? event.args : {};
  const rawLine = finiteNumber(args.line);
  const rawColumn = finiteNumber(args.column);
  const rawFunctionName =
    typeof event.name === "string"
      ? event.name
      : typeof args.name === "string"
        ? args.name
        : "";
  return {
    // Hermes spells its synthetic root differently from V8. Normalize it so
    // existing runtime-frame filtering does not report it as application work.
    functionName: rawFunctionName === "[root]" ? "(root)" : rawFunctionName,
    scriptId: args.scriptId == null ? "" : String(args.scriptId),
    url: typeof args.url === "string" ? args.url : "",
    // Source-map lines are one-based; source-map columns are zero-based.
    lineNumber: rawLine === undefined ? -1 : Math.max(-1, rawLine - 1),
    columnNumber: rawColumn ?? -1,
  };
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}
