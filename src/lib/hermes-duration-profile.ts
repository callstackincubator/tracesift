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

    for (const { event } of threadEvents) {
      const timestamp = event.ts as number;
      const delta = Math.max(0, timestamp - previousTime);
      const activeNode = stack.at(-1);
      if (delta > 0 && activeNode) {
        samples.push(activeNode.id);
        timeDeltas.push(delta);
        sampledTime += delta;
      }

      if (event.ph === "B") {
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
      }
      previousTime = timestamp;
    }

    if (nodes.length === 0 || samples.length === 0) continue;
    const candidate: CdpProfile = {
      nodes,
      samples,
      timeDeltas,
      startTime,
      endTime: previousTime,
    };
    if (sampledTime > bestSampledTime) {
      best = candidate;
      bestSampledTime = sampledTime;
    }
  }

  return best;
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
