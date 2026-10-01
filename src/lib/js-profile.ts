import { groupBottlenecks, type Bottleneck } from "./bottlenecks";
import { buildCallTree } from "./call-tree";
import { selectCards, type CardSelection } from "./profile-cards";
import { extractFromDurationTrace } from "./hermes-duration-profile";
import { attachMeasuredTasks, extractTasks, runTaskIntervals, threadKey, type TaskSet } from "./tasks";
import { normalizeProfile } from "@/app/js-profiler/normalize";
import { queryHotspots, querySummary } from "@/app/js-profiler/query";
import type { CdpCallFrame, CdpProfile, CdpProfileNode, JsHotspotsResult, JsProfileSummary } from "@/app/js-profiler/types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Hermes duration traces carry one node per invocation, so merging them yields
 * a real call count. A V8 sampling profile's nodes are path-unique and can
 * never answer how often a function ran. The distinction has to survive
 * parsing, because only the parser knows which shape arrived.
 */
const DURATION_TRACE = Symbol.for("tracesift.durationTrace");

function markDurationTrace(profile: CdpProfile): CdpProfile {
  Object.defineProperty(profile, DURATION_TRACE, { value: true, enumerable: false });
  return profile;
}

export function recordsInvocations(profile: CdpProfile): boolean {
  return (profile as unknown as Record<symbol, unknown>)[DURATION_TRACE] === true;
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
      acc = { threadKey: threadKey(event), startTime: 0, firstTs: 0, nodes: new Map(), samples: [], timeDeltas: [] };
      profiles.set(key, acc);
    }

    // `Profile` is emitted on the thread being profiled; its `ProfileChunk`s
    // are emitted on the sampler thread. Only the former names the thread whose
    // `RunTask` events bound this profile's work.
    if (name === "Profile") acc.threadKey = threadKey(event);

    const data = isRecord(event.args) && isRecord(event.args.data) ? event.args.data : {};
    // A recorded start time always wins over the timestamp of whichever event
    // happened to arrive first: the chunks can precede the `Profile` that
    // carries it, and taking the chunk's `ts` instead shifts every
    // reconstructed sample timestamp later by the difference.
    if (typeof data.startTime === "number" && acc.startTime === 0) {
      acc.startTime = data.startTime;
    }
    if (acc.firstTs === 0 && typeof event.ts === "number") {
      acc.firstTs = event.ts;
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
      return markDurationTrace(durationProfile);
    }
    throw new Error(
      "This trace does not contain supported CPU profile data (expected V8 Profile/ProfileChunk events or Hermes B/E duration events)."
    );
  }

  const timeDeltas = assembled.timeDeltas;
  const startTime = assembled.startTime || assembled.firstTs;
  const endTime = startTime + timeDeltas.reduce((sum, delta) => sum + delta, 0);

  const profile: CdpProfile = {
    nodes: [...assembled.nodes.values()],
    samples: assembled.samples,
    timeDeltas,
    startTime,
    endTime,
  };
  // Only the profiled thread's tasks. A trace carries `RunTask` for every
  // thread it recorded, and the browser's other threads ran their own tasks
  // against a clock these samples know nothing about.
  const tasks = runTaskIntervals(events).get(assembled.threadKey);
  return tasks && tasks.length > 0 ? attachMeasuredTasks(profile, tasks) : profile;
}

interface TraceProfileAcc {
  /** `pid:tid` of the thread this profile was recorded on, which is what `RunTask` is keyed by. */
  threadKey: string;
  /** The tracer's own start time, or 0 until one is seen. */
  startTime: number;
  /** Timestamp of this profile's first event, used only when the tracer recorded no start time. */
  firstTs: number;
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

/**
 * A profile is identified by its process and its id, deliberately not by the
 * thread. Chrome emits the `Profile` event on the thread being profiled and
 * every `ProfileChunk` for it on the sampler thread, so keying by thread splits
 * one profile in two: the half holding the nodes loses the recorded start time,
 * and the half naming the profiled thread is dropped for having no nodes.
 */
function profileKey(event: Record<string, unknown>): string {
  return `${event.pid ?? ""}:${event.id ?? ""}`;
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
): {
  summary: JsProfileSummary;
  hotspots: JsHotspotsResult;
  /**
   * The parsed profile itself. Task cards need a second, task-scoped pass over
   * it, and re-parsing an upload that runs to hundreds of megabytes to get it
   * back is not an option.
   */
  profile: CdpProfile;
  /** The recording cut into tasks, which is the unit a card is built on. */
  tasks: TaskSet;
  cards: CardSelection;
  /**
   * The engine cards replace, behind a call rather than a value: it is a second
   * full pass over the profile, and nothing runs it unless `TRACESIFT_CPU_ENGINE`
   * asks for a comparison.
   */
  legacyBottlenecks: () => Bottleneck[];
} {
  const now = Date.now();
  // Parsed once: this runs over the whole upload, and the profiles this tool
  // exists for are hundreds of megabytes.
  const profile = coerceCdpProfile(raw);
  const session = normalizeProfile(profile, {
    sessionId,
    name,
    // Used only as fallback metadata when the profile duration is unavailable.
    startedAt: now,
    stoppedAt: now,
    samplingIntervalUs: undefined,
  });
  const durationMs = session.durationMs;

  return {
    summary: querySummary(session),
    profile,
    tasks: extractTasks(profile),
    legacyBottlenecks: () => groupBottlenecks(profile, durationMs),
    cards: selectCards(buildCallTree(profile, durationMs, { callCountIsExact: recordsInvocations(profile) })),
    hotspots: queryHotspots(session, {
      limit: 20,
      offset: 0,
      sortBy: "selfMs",
      includeRuntime: false,
    }),
  };
}
