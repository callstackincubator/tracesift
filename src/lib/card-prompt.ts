/**
 * The hand-off a developer pastes into their own coding agent.
 *
 * Everything here is measured, so the prompt is built without a model call.
 * `buildTaskPrompt` is the current engine's: it names a block of wall-clock
 * time, the feature it belongs to, what burned the time inside it, and how
 * often each of those ran. `buildCardPrompt` below belongs to the node-descent
 * engine and is still served for analyses produced by it.
 */

import type { ProfileCard, RepeatedFunction } from "./profile-cards";
import type { TaskCard, TaskCulprit } from "./task-cards";

const round1 = (value: number) => Math.round(value * 10) / 10;

/** Stacks that would run past this are compacted; the receiving agent needs the ends, not the middle. */
const MAX_PROMPT_FRAMES = 8;

/** Only the culprits worth opening a file over get a stack of their own. */
const MAX_STACKED_CULPRITS = 3;

function culpritLine(culprit: TaskCulprit, taskMs: number): string {
  const where = culprit.location ? ` (${culprit.location})` : "";
  const share = taskMs > 0 ? ` — ${Math.round((culprit.selfMs / taskMs) * 100)}% of the task` : "";
  const shape = culprit.invocations > 1
    ? ` Ran ${culprit.invocations} times inside this task, ${culprit.totalMs} ms inclusive across them, longest single call ${culprit.longestCallMs} ms.`
    : ` Ran once, ${culprit.totalMs} ms inclusive.`;
  return `- \`${culprit.name}\`${where} — ${culprit.selfMs} ms of its own time${share}.${shape}`;
}

function stackBlock(culprit: TaskCulprit): string {
  const lines = [`### ${culprit.name}`, `Reached from the task root:\n${culprit.reachedVia.slice(0, MAX_PROMPT_FRAMES).join("\n  → ")}`];
  if (culprit.hotPath.length > 1) {
    lines.push(`Where its time burns below it:\n${culprit.hotPath.slice(0, MAX_PROMPT_FRAMES).join("\n  → ")}`);
  }
  return lines.join("\n\n");
}

/**
 * The hand-off for one task.
 *
 * Deliberately evidence and no conclusion. This tool sees names and numbers; it
 * has never opened a source file, and the agent receiving this prompt can. A
 * guessed root cause here would anchor that agent on whatever this tool
 * happened to infer from a frame name, which is exactly the failure a hand-off
 * is supposed to avoid.
 */
export function buildTaskPrompt(card: TaskCard, totalMs: number): string {
  const sections: string[] = [];
  const share = totalMs > 0 ? `, ${round1(card.percentOfProfile)}% of the ${Math.round(totalMs)} ms recording` : "";
  const task = [
    card.boundaries === "measured"
      ? `- The runtime ran one task of ${card.durationMs} ms starting ${card.startMs} ms into the recording${share}.`
      : `- About ${card.durationMs} ms of uninterrupted work starting around ${card.startMs} ms into the recording${share}.`,
    card.boundaries === "measured"
      ? "- The profiler recorded this boundary itself, so the duration is wall-clock time in one unbroken block."
      : "- The profiler recorded no task boundaries on this thread. This block was reconstructed from the gaps between sample runs, so its edges are approximate.",
  ];
  if (card.boundaryFrames.length > 0) {
    const frames = card.boundaryFrames
      .map((frame) => `\`${frame.name}\`${frame.location ? ` (${frame.location})` : ""}`)
      .join(", ");
    task.push(`- The outermost application code on this task's stacks: ${frames}.`);
  }
  if (card.confidence === "low") task.push("- Few samples landed in this task, so treat these figures as a hint rather than a measurement.");
  sections.push(`## The task\n${task.join("\n")}`);

  if (card.culprits.length > 0) {
    const named = card.culprits.reduce((sum, culprit) => sum + culprit.selfMs, 0);
    const lines = card.culprits.map((culprit) => culpritLine(culprit, card.durationMs));
    const rest = round1(Math.max(0, card.durationMs - named));
    // Self time inside a task is a partition, so this remainder is exact rather
    // than the difference between two overlapping inclusive totals.
    if (rest >= 1) lines.push(`- ${rest} ms of the task is spread across frames too small to list individually.`);
    sections.push(`## Where the task's time went\n${lines.join("\n")}`);
  }

  const stacked = card.culprits.slice(0, MAX_STACKED_CULPRITS);
  if (stacked.length > 0) {
    sections.push(`## Stacks\n\n${stacked.map(stackBlock).join("\n\n")}`);
  }

  if (card.segments && card.segments.length > 0) {
    const names = card.segments.map((segment) => `\`${segment.title}\` (${segment.totalMs} ms)`).join(", ");
    sections.push(`## Named work inside the task\nThis block is long enough to be a phase rather than a single piece of work. The heaviest named subtrees inside it are ${names}.`);
  }

  sections.push(`## How to read these numbers
- These are sampling-profiler estimates derived from the profiler's duration-per-sample weights, not instrumented timings.
- Self time is a frame's own body plus any garbage collection it triggered. Inside one task it is a partition: every millisecond belongs to exactly one frame, so these figures add up and none of them overlap.
- Call counts are runs of consecutive samples in which the frame was on the stack. Two calls closer together than one sampling interval merge into one, and a frame that yields and resumes reads as two.
- This report has only frame names, source positions and timings. It has not read any source file. Confirm what each of these functions actually does before changing it.`);

  return sections.join("\n\n");
}

/**
 * A sampling profiler records call sites, not invocations. Only Hermes duration
 * traces record one node per call, so only they may say "called N times".
 */
function callUnit(count: number, exact: boolean): string {
  if (exact) return `called ${count} time${count === 1 ? "" : "s"}`;
  return `${count} call site${count === 1 ? "" : "s"}`;
}

function repeatedLine(entry: RepeatedFunction, exact: boolean): string {
  const count = exact ? entry.invocations ?? entry.callSites : entry.callSites;
  const [first, ...others] = entry.callers;
  const from = !first
    ? ""
    : others.length > 0
      ? ` from ${first.name} and ${others.length} other caller${others.length === 1 ? "" : "s"}`
      : ` from ${first.name}`;
  return `- ${entry.name} — ${callUnit(count, exact)}${from}, ${entry.totalMs} ms total, ${entry.selfMs} ms self.`;
}

export function buildCardPrompt(card: ProfileCard, totalMs: number, callCountIsExact = false): string {
  const sections: string[] = [];
  const profileShare = totalMs > 0 ? ` (${round1(card.percentOfProfile)}% of the ${Math.round(totalMs)} ms profile)` : "";
  const where = card.location ? ` (${card.location})` : "";

  const impact = [
    `- \`${card.title}\`${where} accounts for ${card.totalMs} ms of total time${profileShare}.`,
    card.selfShape === "longTail"
      ? `- ${card.selfMs} ms of that is not in any callee large enough to name: it is spread across small calls underneath it.`
      : `- ${card.selfMs} ms of that is spent in its own body; the rest is in the calls below.`,
    `- Recorded on ${callUnit(callCountIsExact ? card.invocations ?? card.callSites : card.callSites, callCountIsExact)}.`,
  ];
  if (card.confidence === "low") impact.push(`- Few samples landed here, so treat these figures as a hint rather than a measurement.`);
  sections.push(`## Issue and impact\n${impact.join("\n")}`);

  if (card.highlights.length > 0) {
    const listed = card.highlights.reduce((sum, highlight) => sum + highlight.totalMs, 0);
    const rest = round1(Math.max(0, card.totalMs - listed - card.selfMs));
    const lines = card.highlights.map((highlight) =>
      `- ${highlight.name}${highlight.location ? ` (${highlight.location})` : ""} — ${highlight.totalMs} ms total, ${highlight.selfMs} ms self.`
    );
    // Inclusive times overlap when one highlight sits under another, so the
    // remainder is only stated when the listed work is genuinely disjoint.
    if (rest >= 1 && listed + card.selfMs <= card.totalMs) {
      lines.push(`- ${rest} ms is in calls too small to list individually.`);
    }
    sections.push(`## Where the time goes\n${lines.join("\n")}`);
  }

  if (card.repeated.length > 0) {
    sections.push(`## Repeated work underneath\n${card.repeated.map((entry) => repeatedLine(entry, callCountIsExact)).join("\n")}`);
  }

  if (card.reachedVia.length > 0) {
    sections.push(`## How this code is reached\n${card.reachedVia.join("\n  → ")}`);
  }
  if (card.hotPath.length > 1) {
    sections.push(`## Where the time burns below it\n${card.hotPath.join("\n  → ")}`);
  }

  const caveats = [
    "- These are sampling-profiler estimates derived from the profiler's duration-per-sample weights, not instrumented timings.",
    callCountIsExact
      ? "- Call counts come from a duration trace, so they are real invocation counts."
      : "- Counts are distinct recorded call sites. A sampling profile cannot report how many times a function was invoked.",
    "- Total time includes everything a function called; self time is the function's own body, plus any garbage collection it triggered.",
  ];
  sections.push(`## How to read these numbers\n${caveats.join("\n")}`);

  return sections.join("\n\n");
}
