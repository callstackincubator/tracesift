/**
 * The recording cut into the tasks the runtime actually ran.
 *
 * A merged call tree answers "what did this function cost across the whole
 * recording", which is a sum over scattered calls and has no point on the
 * timeline behind it. A task does: it is one contiguous block the event loop
 * spent on one piece of work, so its duration is wall clock, its start offset
 * can be scrubbed to in a flame chart, and — because tasks do not overlap —
 * the shares of several of them add up rather than double-counting the same
 * millisecond.
 */

import { isAttributedToParentFrame } from "./frame-names.ts";
import type { CallTreeNode } from "./call-tree.ts";
import type { CdpProfile } from "../app/js-profiler/types";

/** A task boundary exactly as the tracer recorded it: profile-clock microseconds. */
export interface RawTaskInterval {
  ts: number;
  dur: number;
  /**
   * The tracer recorded where this task began but never where it ended, so
   * `dur` is a floor reconstructed from the last thing seen on the thread
   * rather than a measurement. See {@link runTaskIntervals}.
   */
  truncated?: boolean;
}

/**
 * Where the boundaries came from. `measured` means the tracer emitted them;
 * `inferred` means they were reconstructed from the gaps between sample runs
 * and are an approximation. The distinction has to reach the UI, because
 * "a 1502 ms task" and "about 1502 ms of uninterrupted work" are different
 * claims and only one of them is a measurement.
 */
export type TaskBoundaryKind = "measured" | "inferred";

export interface ProfileTask {
  /** Position in the recording, in time order. Addresses a task in a URL. */
  index: number;
  /** Offset of the task's start from the start of the recording. */
  startMs: number;
  durationMs: number;
  /** Samples `[firstSample, endSample)` of the profile fell inside this task. */
  firstSample: number;
  endSample: number;
  /**
   * Where this one task's edges came from. It is per task and not per set
   * because a recording can carry both: a tracer that stops emitting `RunTask`
   * partway through leaves measured tasks up to the cut and nothing after it,
   * and the samples after the cut are still work that has to be accounted for.
   */
  boundaries: TaskBoundaryKind;
}

export interface TaskSet {
  tasks: ProfileTask[];
  /**
   * How the set's tasks were drawn overall: `measured` once the tracer supplied
   * any real boundary, even if reconstructed tasks fill gaps around them.
   * Per-card wording reads {@link ProfileTask.boundaries} instead.
   */
  boundaries: TaskBoundaryKind;
}

/** `pid:tid`. A trace records every thread it saw, and only the profiled one's tasks are this profile's. */
export function threadKey(event: Record<string, unknown>): string {
  return `${event.pid ?? ""}:${event.tid ?? ""}`;
}

/**
 * Every `RunTask` in a trace, grouped by the thread that ran it.
 *
 * Chrome emits these as complete events carrying their own duration. The
 * begin/end spelling is tolerated as well, because the trace format permits it
 * and a file stitched together from more than one recorder can hold either.
 */
export function runTaskIntervals(events: readonly Record<string, unknown>[]): Map<string, RawTaskInterval[]> {
  const byThread = new Map<string, RawTaskInterval[]>();
  /** A `B` whose `E` has not arrived yet, per thread. */
  const open = new Map<string, number>();
  /** The last timestamp seen on each thread, from events of any name. */
  const lastSeen = new Map<string, number>();

  const push = (key: string, interval: RawTaskInterval) => {
    const list = byThread.get(key);
    if (list) list.push(interval);
    else byThread.set(key, [interval]);
  };

  for (const event of events) {
    if (typeof event.ts !== "number") continue;
    const key = threadKey(event);
    const ts = event.ts;
    lastSeen.set(key, Math.max(lastSeen.get(key) ?? ts, ts));
    if (event.name !== "RunTask") continue;
    if (event.ph === "B") {
      open.set(key, ts);
    } else if (event.ph === "E") {
      const start = open.get(key);
      if (start === undefined) continue;
      open.delete(key);
      if (ts > start) push(key, { ts: start, dur: ts - start });
    } else {
      const dur = typeof event.dur === "number" ? event.dur : 0;
      if (dur > 0) push(key, { ts, dur });
    }
  }

  // A `B` still open when the events run out is a task that was executing when
  // the recording stopped — Chrome flushes a completed task as `X` with a
  // duration and one still on the stack as a bare `B`. Dropping it discards the
  // whole tail of the recording: on the local trace the renderer's last
  // `RunTask` opens at 11.4 s of a 16.7 s profile and never closes, so an
  // `E`-only parser decides the thread went quiet and 5.2 s of application work
  // — a third of the samples — is left belonging to no task at all.
  //
  // Closing it at the last timestamp seen on that thread is the most
  // conservative end available; the task may well have run past the end of the
  // trace. The interval is marked `truncated` so nothing downstream reports
  // that floor as a measured duration.
  for (const [key, start] of open) {
    const end = lastSeen.get(key);
    if (end !== undefined && end > start) push(key, { ts: start, dur: end - start, truncated: true });
  }

  return byThread;
}

/**
 * Measured task boundaries ride on the profile object rather than in it:
 * `CdpProfile` is the shared parse result used by three other modules, and the
 * boundaries only exist for a trace that carried `RunTask` events on the
 * thread the profile was selected from. The symbol is the same mechanism
 * `js-profile.ts` uses to mark a Hermes duration trace.
 */
const MEASURED_TASKS = Symbol.for("tracesift.measuredTasks");

export function attachMeasuredTasks(profile: CdpProfile, intervals: RawTaskInterval[]): CdpProfile {
  Object.defineProperty(profile, MEASURED_TASKS, { value: intervals, enumerable: false, configurable: true });
  return profile;
}

export function measuredTasks(profile: CdpProfile): RawTaskInterval[] | undefined {
  const value = (profile as unknown as Record<symbol, unknown>)[MEASURED_TASKS];
  return Array.isArray(value) && value.length > 0 ? (value as RawTaskInterval[]) : undefined;
}

const IDLE = "(idle)";

/**
 * Absolute timestamp of every sample, in profile-clock microseconds.
 * `timeDeltas[i]` is the gap *before* sample `i`, so the prefix sum has to
 * include the current delta: dropping it puts every sample one interval early
 * and the last task of a recording loses its samples to the one before it.
 *
 * A real recording carries negative deltas — V8's sampler reads a clock that
 * can step backwards, and a 13 s Chrome trace of a web app runs to several
 * hundred of them. They have to be added, not dropped: clamping each one to
 * zero leaves the reconstructed clock permanently ahead of the real one by
 * their sum, which on that trace is 69 ms. Nothing says so at the time — the
 * timestamps still look plausible — but the binary search below then cuts
 * every task's sample window at the wrong place, so a task picks up the tail
 * of the one before it, loses its own, and every box on the timeline sits that
 * far to the right of where it ran.
 *
 * The running maximum is what the clamp was reaching for. `lowerBound` needs a
 * non-decreasing array, and carrying the deltas raw does not give one. Holding
 * the clock flat across an inversion costs the few samples inside it their
 * ordering and nothing else: the series rejoins the true clock as soon as the
 * deltas make the time back up, so the error stays local instead of
 * accumulating over the recording.
 */
function sampleTimestamps(profile: CdpProfile): number[] {
  const samples = profile.samples ?? [];
  const deltas = profile.timeDeltas ?? [];
  const out = new Array<number>(samples.length);
  let clock = profile.startTime;
  let ceiling = profile.startTime;
  for (let index = 0; index < samples.length; index += 1) {
    clock += deltas[index] ?? 0;
    ceiling = Math.max(ceiling, clock);
    out[index] = ceiling;
  }
  return out;
}

/** Raw node ids that sit inside an `(idle)` subtree, which is absence of work rather than work. */
function idleNodeIds(profile: CdpProfile): Set<number> {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const parentById = new Map<number, number>();
  for (const node of profile.nodes) {
    if (typeof node.parentId === "number") parentById.set(node.id, node.parentId);
    for (const childId of node.children ?? []) parentById.set(childId, node.id);
  }
  const idle = new Set<number>();
  for (const node of profile.nodes) {
    let current: number | undefined = node.id;
    const seen = new Set<number>();
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      if (byId.get(current)?.callFrame.functionName === IDLE) {
        idle.add(node.id);
        break;
      }
      current = parentById.get(current);
    }
  }
  return idle;
}

/**
 * First index at which `timestamps[index] >= value`. The samples of a profile
 * are in time order and tasks do not overlap, so each task's samples are one
 * contiguous slice and two binary searches find it — scanning every task
 * against every sample is quadratic on the long traces this tool exists for.
 */
function lowerBound(timestamps: number[], value: number): number {
  let low = 0;
  let high = timestamps.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (timestamps[mid] < value) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * Tasks whose boundaries the tracer measured. A task that caught no sample is
 * dropped: it ran, but this profile has nothing to say about what was in it.
 *
 * A truncated interval keeps its measured start and loses the claim on its
 * duration — the recording stopped inside it, so the figure is a floor.
 */
function measuredTaskSet(profile: CdpProfile, intervals: RawTaskInterval[]): ProfileTask[] {
  const timestamps = sampleTimestamps(profile);
  const ordered = [...intervals].sort((a, b) => a.ts - b.ts);
  const tasks: ProfileTask[] = [];
  for (const interval of ordered) {
    const firstSample = lowerBound(timestamps, interval.ts);
    const endSample = lowerBound(timestamps, interval.ts + interval.dur);
    if (endSample <= firstSample) continue;
    tasks.push({
      index: tasks.length,
      startMs: (interval.ts - profile.startTime) / 1000,
      durationMs: interval.dur / 1000,
      firstSample,
      endSample,
      boundaries: interval.truncated ? "inferred" : "measured",
    });
  }
  return tasks;
}

/**
 * Runs of consecutive non-idle samples within `[from, to)`, each treated as one
 * task. An idle gap is evidence that the loop went quiet, not a record of where
 * the runtime drew a task boundary, so everything built here is `inferred` and
 * must stay marked: a stretch busy enough never to idle collapses into a single
 * enormous "task", and the wording on the card is the only thing that stops a
 * reader taking that number for a measurement.
 */
function inferredRuns(profile: CdpProfile, from: number, to: number, idle: Set<number>): ProfileTask[] {
  const samples = profile.samples ?? [];
  const timestamps = sampleTimestamps(profile);
  const tasks: ProfileTask[] = [];
  let runStart = -1;

  const close = (end: number) => {
    if (runStart < 0) return;
    const startUs = timestamps[runStart];
    // The run's last sample timed the interval that ended at it, so the work
    // reaches to that sample's timestamp and no further.
    const endUs = timestamps[end - 1];
    const durationMs = Math.max(0, endUs - startUs) / 1000;
    // A run spanning no time is a sample or two that fell between two measured
    // tasks, in the microseconds the tracer's own boundaries did not claim: the
    // local trace carries 203 of them. They are seams, not work, and admitting
    // them would bury the real gaps under zero-millisecond cards.
    if (durationMs > 0) {
      tasks.push({
        index: tasks.length,
        startMs: (startUs - profile.startTime) / 1000,
        durationMs,
        firstSample: runStart,
        endSample: end,
        boundaries: "inferred",
      });
    }
    runStart = -1;
  };

  for (let index = from; index < to; index += 1) {
    if (idle.has(samples[index])) close(index);
    else if (runStart < 0) runStart = index;
  }
  close(to);
  return tasks;
}

/**
 * The samples no measured task claimed, recovered as inferred tasks.
 *
 * `RunTask` and the CPU profile are two independent streams, and nothing makes
 * the tracer keep emitting the first for as long as it samples the second. On
 * the local Chrome trace the renderer's `RunTask` stream stops 11.4 s into a
 * 16.7 s profile while sibling threads keep emitting to the end, which leaves
 * 18,056 consecutive non-idle samples — 5.2 s, a third of the recording, and
 * real application work — belonging to no task at all. Every card is built from
 * a task, so without this those samples reach no reader: a function's time is
 * reported as the part of it that happened to land inside a measured window,
 * which is how a 206 ms function comes back as 103 ms.
 *
 * The recovered tasks are `inferred` and say so on the card. An approximate
 * boundary around work that ran is a far smaller error than silence about it.
 */
function withGapTasks(profile: CdpProfile, measured: ProfileTask[]): ProfileTask[] {
  const total = (profile.samples ?? []).length;
  const idle = idleNodeIds(profile);
  const ordered = [...measured].sort((a, b) => a.firstSample - b.firstSample);

  const filled: ProfileTask[] = [];
  let cursor = 0;
  for (const task of ordered) {
    if (task.firstSample > cursor) filled.push(...inferredRuns(profile, cursor, task.firstSample, idle));
    filled.push(task);
    cursor = Math.max(cursor, task.endSample);
  }
  if (cursor < total) filled.push(...inferredRuns(profile, cursor, total, idle));

  filled.sort((a, b) => a.startMs - b.startMs || a.firstSample - b.firstSample);
  return filled.map((task, index) => ({ ...task, index }));
}

export function extractTasks(profile: CdpProfile): TaskSet {
  const measured = measuredTasks(profile);
  if (measured) {
    const tasks = measuredTaskSet(profile, measured);
    if (tasks.length > 0) return { tasks: withGapTasks(profile, tasks), boundaries: "measured" };
  }
  const total = (profile.samples ?? []).length;
  return { tasks: inferredRuns(profile, 0, total, idleNodeIds(profile)), boundaries: "inferred" };
}

/**
 * The profile restricted to one task, for building a call tree scoped to it.
 *
 * The node table is cut down to the stacks this task's samples actually stood
 * on, which is not an optimisation. A call tree is built from every node it is
 * given, sampled or not, so handing it the whole table would put branches that
 * belong to other tasks into this one at zero cost — and a zero-millisecond
 * frame listed as this task's feature boundary is simply wrong. It is also
 * what keeps a recording of many tasks from re-walking the entire node table
 * once per card.
 */
export function taskProfile(profile: CdpProfile, task: ProfileTask): CdpProfile {
  const samples = (profile.samples ?? []).slice(task.firstSample, task.endSample);
  const timeDeltas = (profile.timeDeltas ?? []).slice(task.firstSample, task.endSample);

  const parentById = new Map<number, number>();
  for (const node of profile.nodes) {
    if (typeof node.parentId === "number") parentById.set(node.id, node.parentId);
    for (const childId of node.children ?? []) parentById.set(childId, node.id);
  }
  const reached = new Set<number>();
  for (const sample of samples) {
    for (let current: number | undefined = sample; current !== undefined && !reached.has(current); current = parentById.get(current)) {
      reached.add(current);
    }
  }

  return {
    nodes: profile.nodes.filter((node) => reached.has(node.id)),
    samples,
    timeDeltas,
    startTime: 0,
    endTime: task.durationMs * 1000,
  };
}

/**
 * How a frame's time inside one task is distributed over separate calls.
 *
 * This is sample resolution, not instrumentation: a run of consecutive samples
 * in which a frame is on the stack counts as one call, so two calls separated
 * by less than a sampling interval merge into one, and a frame that yields and
 * later resumes inside the same task reads as two. It is still the figure that
 * tells a reader whether they are looking at one slow algorithm or at a call
 * made far too often, which no inclusive total can.
 */
export interface InvocationShape {
  invocations: number;
  /** Inclusive time across those calls, within this task. */
  totalMs: number;
  /** The longest single call. `totalMs / invocations` hides exactly the case worth seeing. */
  longestCallMs: number;
}

/**
 * Invocation shape for everything on a task's stacks.
 *
 * A call is a maximal run of consecutive samples in which the subject is on the
 * stack — not a run in which it is the leaf. A parent that delegates to three
 * helpers in turn ran once, and counting leaf runs would report it as three.
 *
 * `keyOf` chooses what "the subject" means. Keyed by node, the answer is per
 * call path; keyed by frame identity, one function's calls are counted however
 * many places on the stack it occupies, which is what a culprit row reports.
 * Either way a key appearing twice on one stack — `walk` calling `walk` — is
 * credited once, to the outermost occurrence, so a recursive descent is one
 * call and not one per level.
 */
export function invocationShapes<K>(
  sampleNodes: readonly (CallTreeNode | null)[],
  weights: readonly number[],
  keyOf: (node: CallTreeNode) => K,
): Map<K, InvocationShape> {
  const shapes = new Map<K, InvocationShape>();
  // The keys whose call is still open, outermost first, each with the time
  // accumulated since it opened.
  let open: { key: K; ms: number }[] = [];

  const closeFrom = (depth: number) => {
    for (let index = open.length - 1; index >= depth; index -= 1) {
      const { key, ms } = open[index];
      const shape = shapes.get(key) ?? { invocations: 0, totalMs: 0, longestCallMs: 0 };
      shape.invocations += 1;
      shape.totalMs += ms;
      shape.longestCallMs = Math.max(shape.longestCallMs, ms);
      shapes.set(key, shape);
    }
    open = open.slice(0, depth);
  };

  for (let index = 0; index < sampleNodes.length; index += 1) {
    const node = sampleNodes[index] ?? null;
    if (!node) {
      closeFrom(0);
      continue;
    }
    // A garbage collection sample is not a return. V8 parks it at the root of
    // the stack rather than under the frame that allocated, so treating it as
    // an ordinary sample closes every open call and reopens it on the next
    // one: one React render that collected eleven times reads as twelve calls
    // of 25 ms instead of one call of 290 ms, which inverts the finding. The
    // sample is carried over rather than credited, so these figures still sum
    // to the totals the call tree reports.
    if (isAttributedToParentFrame(node.frame)) continue;
    const chain: K[] = [];
    const onChain = new Set<K>();
    const nodes: CallTreeNode[] = [];
    for (let current: CallTreeNode | null = node; current; current = current.parent) nodes.push(current);
    for (let depth = nodes.length - 1; depth >= 0; depth -= 1) {
      const key = keyOf(nodes[depth]);
      if (onChain.has(key)) continue;
      onChain.add(key);
      chain.push(key);
    }

    let shared = 0;
    while (shared < open.length && shared < chain.length && open[shared].key === chain[shared]) shared += 1;
    closeFrom(shared);
    for (let depth = shared; depth < chain.length; depth += 1) open.push({ key: chain[depth], ms: 0 });

    const weight = weights[index] ?? 0;
    for (const entry of open) entry.ms += weight;
  }
  closeFrom(0);
  return shapes;
}
