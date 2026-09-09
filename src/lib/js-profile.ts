import { groupBottlenecks, type Bottleneck } from "./bottlenecks";
import { extractFromDurationTrace } from "./hermes-duration-profile";
import { normalizeProfile } from "@/app/js-profiler/normalize";
import { queryHotspots, querySummary } from "@/app/js-profiler/query";
import type { CdpCallFrame, CdpProfile, CdpProfileNode, JsHotspotsResult, JsProfileSummary } from "@/app/js-profiler/types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Accepts a V8/CDP CPU profile, a `{ profile }` wrapper, a Chrome
 * Performance / React DevTools trace (`traceEvents` with Profile + ProfileChunk),
 * or the begin/end duration trace produced by hermes-profile-transformer.
 */
export function coerceCdpProfile(raw: unknown): CdpProfile {
  const fromTrace = extractFromTrace(raw);
  if (fromTrace) {
    return fromTrace;
  }

  if (!isRecord(raw)) {
    throw new Error("The uploaded file is not a JSON object.");
  }

  if (isRecord(raw.cpuProfile) && Array.isArray(raw.cpuProfile.nodes)) {
    return fromCdpShape({
      ...raw.cpuProfile,
      timeDeltas: raw.timeDeltas ?? raw.cpuProfile.timeDeltas,
      startTime: raw.startTime ?? raw.cpuProfile.startTime,
      endTime: raw.endTime ?? raw.cpuProfile.endTime,
    });
  }

  const inner = isRecord(raw.profile) ? raw.profile : raw;
  if (!Array.isArray(inner.nodes) || inner.nodes.length === 0) {
    throw new Error("The uploaded file could not be parsed as a CPU profile (missing nodes).");
  }

  return fromCdpShape(inner);
}

function fromCdpShape(inner: Record<string, unknown>): CdpProfile {
  const head = isRecord(inner.head) ? inner.head : undefined;
  const startTime =
    typeof inner.startTime === "number"
      ? inner.startTime
      : typeof head?.startTime === "number"
        ? head.startTime
        : 0;
  const samples = Array.isArray(inner.samples) ? toNumberArray(inner.samples) : [];
  const timeDeltas = Array.isArray(inner.timeDeltas) ? toNumberArray(inner.timeDeltas) : [];
  let endTime =
    typeof inner.endTime === "number"
      ? inner.endTime
      : typeof head?.endTime === "number"
        ? head.endTime
        : 0;
  if (endTime <= startTime && timeDeltas.length > 0) {
    endTime = startTime + timeDeltas.reduce((sum, delta) => sum + delta, 0);
  }

  const rawNodes = Array.isArray(inner.nodes) ? inner.nodes : [];
  const nodes = rawNodes.filter(isRecord).map(normalizeNode);
  if (nodes.length === 0) {
    throw new Error("The uploaded file could not be parsed as a CPU profile (missing nodes).");
  }

  return { nodes, samples, timeDeltas, startTime, endTime };
}

function extractFromTrace(raw: unknown): CdpProfile | null {
  const events = getTraceEvents(raw);
  if (!events) {
    return null;
  }

  const profiles = new Map<string, TraceProfileAcc>();

  for (const event of events) {
    const name = event.name;
    if (name !== "Profile" && name !== "ProfileChunk" && name !== "CpuProfile") {
      continue;
    }

    const key = profileKey(event);
    let acc = profiles.get(key);
    if (!acc) {
      acc = { startTime: 0, nodes: new Map(), samples: [], timeDeltas: [] };
      profiles.set(key, acc);
    }

    const data = isRecord(event.args) && isRecord(event.args.data) ? event.args.data : {};
    if (typeof data.startTime === "number" && acc.startTime === 0) {
      acc.startTime = data.startTime;
    } else if (acc.startTime === 0 && typeof event.ts === "number") {
      acc.startTime = event.ts;
    }

    const cpuProfile = isRecord(data.cpuProfile) ? data.cpuProfile : name === "CpuProfile" ? data : null;
    if (!cpuProfile) {
      continue;
    }

    if (Array.isArray(cpuProfile.nodes)) {
      for (const node of cpuProfile.nodes) {
        if (!isRecord(node)) continue;
        const normalized = normalizeNode(node);
        acc.nodes.set(normalized.id, normalized);
      }
    }

    if (Array.isArray(cpuProfile.samples)) {
      acc.samples.push(...toNumberArray(cpuProfile.samples));
    }
    if (Array.isArray(data.timeDeltas)) {
      acc.timeDeltas.push(...toNumberArray(data.timeDeltas));
    } else if (Array.isArray(cpuProfile.timeDeltas)) {
      acc.timeDeltas.push(...toNumberArray(cpuProfile.timeDeltas));
    }

    if (typeof cpuProfile.startTime === "number" && acc.startTime === 0) {
      acc.startTime = cpuProfile.startTime;
    }
  }

  const assembled = [...profiles.values()]
    .filter((acc) => acc.nodes.size > 0)
    .sort((a, b) => b.samples.length - a.samples.length)[0];

  if (!assembled) {
    const durationProfile = extractFromDurationTrace(events);
    if (durationProfile) {
      return durationProfile;
    }
    throw new Error(
      "This trace does not contain supported CPU profile data (expected V8 Profile/ProfileChunk events or Hermes B/E duration events)."
    );
  }

  const timeDeltas = assembled.timeDeltas;
  const startTime = assembled.startTime;
  const endTime = startTime + timeDeltas.reduce((sum, delta) => sum + delta, 0);

  return {
    nodes: [...assembled.nodes.values()],
    samples: assembled.samples,
    timeDeltas,
    startTime,
    endTime,
  };
}

interface TraceProfileAcc {
  startTime: number;
  nodes: Map<number, CdpProfileNode>;
  samples: number[];
  timeDeltas: number[];
}

function getTraceEvents(raw: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(raw)) {
    if (raw.length === 0 || !raw.some((item) => isRecord(item) && typeof item.name === "string")) {
      return null;
    }
    return raw.filter(isRecord);
  }
  if (isRecord(raw) && Array.isArray(raw.traceEvents)) {
    return raw.traceEvents.filter(isRecord);
  }
  return null;
}

function profileKey(event: Record<string, unknown>): string {
  const id = event.id ?? "";
  const pid = event.pid ?? "";
  const tid = event.tid ?? "";
  return `${pid}:${tid}:${id}`;
}

function normalizeNode(node: Record<string, unknown>): CdpProfileNode {
  const id = typeof node.id === "number" ? node.id : Number(node.id);
  const parentRaw = node.parent ?? node.parentId;
  const parentId = typeof parentRaw === "number" ? parentRaw : undefined;
  const children = Array.isArray(node.children) ? toNumberArray(node.children) : undefined;

  return {
    id: Number.isFinite(id) ? id : 0,
    callFrame: normalizeCallFrame(node.callFrame),
    hitCount: typeof node.hitCount === "number" ? node.hitCount : undefined,
    children,
    parentId,
  };
}

function normalizeCallFrame(raw: unknown): CdpCallFrame {
  const cf = isRecord(raw) ? raw : {};
  return {
    functionName: typeof cf.functionName === "string" ? cf.functionName : "",
    scriptId: cf.scriptId == null ? "" : String(cf.scriptId),
    url: typeof cf.url === "string" ? cf.url : "",
    lineNumber: typeof cf.lineNumber === "number" ? cf.lineNumber : -1,
    columnNumber: typeof cf.columnNumber === "number" ? cf.columnNumber : -1,
  };
}

function toNumberArray(values: unknown[]): number[] {
  const out: number[] = [];
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) out.push(value);
  }
  return out;
}

export function summarizeCpuProfile(
  raw: unknown,
  sessionId: string,
  name: string
): { summary: JsProfileSummary; hotspots: JsHotspotsResult; bottlenecks: Bottleneck[] } {
  const now = Date.now();
  const session = normalizeProfile(coerceCdpProfile(raw), {
    sessionId,
    name,
    // Used only as fallback metadata when the profile duration is unavailable.
    startedAt: now,
    stoppedAt: now,
    samplingIntervalUs: undefined,
  });

  return {
    summary: querySummary(session),
    bottlenecks: groupBottlenecks(coerceCdpProfile(raw), session.durationMs),
    hotspots: queryHotspots(session, {
      limit: 20,
      offset: 0,
      sortBy: "selfMs",
      includeRuntime: false,
    }),
  };
}
