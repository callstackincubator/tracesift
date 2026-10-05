/**
 * The hand-off a developer pastes into their own coding agent.
 *
 * Everything here is measured, so the prompt is built without a model call.
 * `buildTaskPrompt` is the current engine's: it names a block of wall-clock
 * time, the feature it belongs to, what burned the time inside it, and how
 * often each of those ran. `buildCardPrompt` below belongs to the node-descent
 * engine and is still served for analyses produced by it.
 */

import type { FrameClass } from "./frame-classes";
import { isMeaningfulName } from "./frame-names.ts";
import type { ProfileCard, RepeatedFunction } from "./profile-cards";
import { CULPRIT_MIN_MS, type BoundaryFrame, type TaskCard, type TaskCulprit, type TaskTreeNode } from "./task-cards.ts";
import { taskCardLocations, type FrameLocations } from "./frame-location.ts";
import { SHOWN_CLASSES } from "./task-timeline.ts";

const round1 = (value: number) => Math.round(value * 10) / 10;

/**
 * How many frames the hand-off names, and how little of its own time one may
 * have to be named.
 *
 * The floor here was a share of the task, at 2%, and that is the wrong shape:
 * it means the longer the task, the less of it the hand-off explains. On a
 * 3.2 s task it cut at 64 ms and named five frames covering 24% of the
 * duration, leaving 2.4 seconds to a single remainder line — so the agent
 * could not tell whether the fix was in the five frames it saw or in the 76%
 * it did not. `CULPRIT_MIN_MS` is the same question answered absolutely, and
 * answered once: it is what the card admits a culprit on, so reusing it here
 * means the hand-off and the UI cut in the same place.
 *
 * The card admits a frame on either figure — 15 ms of its own time or 15 ms
 * including its callees — and this section only honours the first. A frame
 * that delegates everything burned nothing in its own body and belongs in the
 * inclusive breakdown above, which is where it now appears; listed here it
 * read `0 ms of its own time`, which is a row about nothing.
 */
const MAX_PROMPT_CULPRITS = 25;

/** The classes a frame can be named by: a reader acts on their own code and their dependencies. */
const DRAWABLE = new Set<FrameClass>(SHOWN_CLASSES);

/**
 * ` (where)` when the position earns its place on the row, and nothing when the
 * name locates the frame by itself. `frame-location.ts` holds the rule and the
 * reasoning; the hand-off only formats the answer, so a frame reads the same
 * here as it does in the UI.
 */
interface Locator {
  where: (name: string, location: string | undefined) => string;
  printedChunk: () => boolean;
}

function locator(card: TaskCard): Locator {
  const locations: FrameLocations = taskCardLocations(card);
  return {
    where: (name, location) => {
      const shown = locations.shown(name, location);
      return shown ? ` (${shown})` : "";
    },
    printedChunk: locations.showedArtefact,
  };
}

/**
 * A hot path that is one frame over and over is a recursive descent, not a
 * path. Seven identical lines say nothing the word "recurses" does not, and the
 * recursion is itself the part worth reading.
 */
/**
 * What the task ran, by inclusive time.
 *
 * Boundary frames are an antichain — the search for them stops at the first
 * product frame on each branch — so none nests inside another and their
 * inclusive times are disjoint. That makes this the one section that can
 * account for the whole task: self time on a React app is dust spread over
 * thousands of frames, which is why a self-time list leaves most of a long
 * block in its remainder line no matter how many rows it prints. Printed as a
 * bare list of names, as it was, it threw away the only numbers that add up.
 */
function boundaryLine(frame: BoundaryFrame, taskMs: number, locate: Locator): string {
  const where = locate.where(frame.name, frame.location);
  const share = taskMs > 0 ? `, ${Math.round((frame.totalMs / taskMs) * 100)}% of the task` : "";
  const shape = frame.invocations > 1
    ? ` Ran ${frame.invocations} times, longest single call ${frame.longestCallMs} ms.`
    : " Ran once.";
  const own = frame.selfMs >= 1 ? ` ${frame.selfMs} ms of it in this frame's own body.` : "";
  return `- \`${frame.name}\`${where} — ${frame.totalMs} ms including everything it called${share}.${shape}${own}`;
}

function selfRecursive(culprit: TaskCulprit): boolean {
  return culprit.hotPath.length > 1 && culprit.hotPath.every((frame) => frame === culprit.hotPath[0]);
}

function culpritLine(culprit: TaskCulprit, taskMs: number, locate: Locator): string {
  const where = locate.where(culprit.name, culprit.location);
  const share = taskMs > 0 ? ` — ${Math.round((culprit.selfMs / taskMs) * 100)}% of the task` : "";
  const shape = culprit.invocations > 1
    ? ` Ran ${culprit.invocations} times inside this task, ${culprit.totalMs} ms inclusive across them, longest single call ${culprit.longestCallMs} ms.`
    : ` Ran once, ${culprit.totalMs} ms inclusive.`;
  const recursion = selfRecursive(culprit) ? " It recurses into itself." : "";
  // The caller chain is the most searchable thing on the row for an agent
  // holding the codebase, and it is what tells apart two frames that share a
  // minified name — the stacks below only reach the first couple of culprits.
  const via = culprit.callers.length > 0 ? ` Called via ${culprit.callers.join(" › ")}.` : "";
  return `- \`${culprit.name}\`${where} — ${culprit.selfMs} ms of its own time${share}.${shape}${recursion}${via}`;
}

// --- The frames around the culprits ---------------------------------------

/**
 * How far below a culprit the heaviest branch is followed. The question this
 * answers is "and then what", which the first few frames settle; past that it
 * is the next culprit's row talking.
 */
const MAX_HOT_DESCENT = 4;

/**
 * Culprits the tree anchors, against the 25 the list carries.
 *
 * The list is coverage — every frame worth naming, so the task adds up. The
 * tree is shape: which costs are siblings under one render and which are
 * reached from somewhere else entirely. A dozen anchors settles that, and past
 * it the tree turns back into the list with indentation, two frames per row.
 */
const MAX_TREE_ANCHORS = 12;

/**
 * A chain of uninteresting frames shorter than this is printed rather than
 * summarised. `… (2 frames)` costs a line and names nothing, where the two
 * frames themselves cost two lines and say which calls bridge the gap.
 */
const MIN_COLLAPSED_RUN = 3;

interface StackRow {
  label: string;
  /** Set on a culprit, which is a row in the list above and an anchor here. */
  note?: string;
  /**
   * A frame carrying a name a reader can act on, which is never summarised
   * away. This was `frameClass === "app"` and that guard almost never fired:
   * `boundaryFrames` in `task-cards.ts` notes that a bundled build routinely
   * files the product's own screens under `library`, so on the trace this was
   * written for, `Search_Search` was named in the section above and folded into
   * `… (10 frames)` here. The test is the one that section uses: a drawable
   * class, which already excludes the framework and the engine, and a name that
   * is neither mangled nor a generic wrapper.
   */
  named: boolean;
  frameClass: FrameClass;
  children: StackRow[];
}

/**
 * What a summarised run was. `… (10 frames)` asserts that something was hidden
 * without saying what kind of thing, so a reader cannot tell "that is all
 * React" from "the frame I need is in there".
 */
const FOLD_WORDS: Partial<Record<FrameClass, string>> = {
  framework: "framework",
  native: "engine",
  anonymous: "unnamed",
  library: "dependency",
};

function foldLabel(run: readonly StackRow[]): string {
  const kinds = new Set(run.map((row) => FOLD_WORDS[row.frameClass]));
  const kind = kinds.size === 1 ? [...kinds][0] : undefined;
  return `… (${run.length} ${kind ? `${kind} ` : ""}frames)`;
}

function treeLabel(node: TaskTreeNode, locate: Locator): string {
  return `${node.name}${locate.where(node.name, node.location)}`;
}

function culpritNote(culprit: TaskCulprit): string {
  const calls = culprit.invocations > 1 ? `, ${culprit.invocations} calls` : "";
  return `  ← ${culprit.selfMs} ms self${calls}`;
}

/**
 * The frames joining the task root to every listed culprit, as one tree.
 *
 * A stack per culprit repeats its neighbours: in a React task the culprits
 * under one render share the dozen frames above them, so ten stacks are mostly
 * ten copies of one chain — and the fact worth reading, that these costs are
 * siblings under a single render, is the first thing that repetition buries.
 * Merged, the shared chain is printed once and the branch points are what the
 * shape shows.
 *
 * Each culprit appears at its heaviest call site, which is the node its row and
 * its caller chain were measured at too.
 */
function culpritTree(card: TaskCard, listed: readonly TaskCulprit[], locate: Locator): string[] {
  const byId = new Map<string, TaskTreeNode>();
  const parentOf = new Map<string, TaskTreeNode>();
  const pending: TaskTreeNode[] = [card.tree];
  while (pending.length > 0) {
    const node = pending.pop()!;
    byId.set(node.id, node);
    for (const child of node.children) {
      parentOf.set(child.id, node);
      pending.push(child);
    }
  }

  const marked = new Map<string, TaskCulprit>();
  for (const culprit of listed) {
    if (byId.has(culprit.nodeId)) marked.set(culprit.nodeId, culprit);
  }
  if (marked.size === 0) return [];

  const keep = new Set<string>();
  for (const id of marked.keys()) {
    // Ancestors of a kept node are kept, so meeting one ends the walk.
    for (let node = byId.get(id); node && !keep.has(node.id); node = parentOf.get(node.id)) keep.add(node.id);
  }
  // And the heaviest few frames under each culprit: where its own time goes.
  for (const id of marked.keys()) {
    let node = byId.get(id)!;
    for (let depth = 0; depth < MAX_HOT_DESCENT; depth += 1) {
      const next = [...node.children].sort((a, b) => b.totalMs - a.totalMs)[0];
      // A frame descending into itself is recursion, already said on its row.
      if (!next || next.name === node.name) break;
      keep.add(next.id);
      node = next;
    }
  }

  const rowFor = (node: TaskTreeNode): StackRow => ({
    label: treeLabel(node, locate),
    ...(marked.has(node.id) ? { note: culpritNote(marked.get(node.id)!) } : {}),
    named: DRAWABLE.has(node.frameClass) && isMeaningfulName(node.name),
    frameClass: node.frameClass,
    children: node.children
      .filter((child) => keep.has(child.id))
      .sort((a, b) => b.totalMs - a.totalMs)
      .map(rowFor),
  });

  // The synthetic root is not a frame, so the tree starts at its children.
  return rowFor(card.tree).children.flatMap((row) => draw(compress(row), "", true, true));
}

/** Fold runs of single-child scaffolding into one line; never fold a named frame. */
function compress(row: StackRow): StackRow {
  const run: StackRow[] = [];
  let current = row;
  while (!current.note && !current.named && current.children.length === 1) {
    run.push(current);
    current = current.children[0];
  }
  const tail: StackRow = { ...current, children: current.children.map(compress) };
  if (run.length >= MIN_COLLAPSED_RUN) {
    return { label: foldLabel(run), named: false, frameClass: run[0].frameClass, children: [tail] };
  }
  return run.reduceRight<StackRow>((child, node) => ({ ...node, children: [child] }), tail);
}

function draw(row: StackRow, prefix: string, isLast: boolean, isRoot: boolean): string[] {
  const connector = isRoot ? "" : isLast ? "└─ " : "├─ ";
  const lines = [`${prefix}${connector}${row.label}${row.note ?? ""}`];
  const childPrefix = isRoot ? prefix : `${prefix}${isLast ? "   " : "│  "}`;
  row.children.forEach((child, index) => {
    lines.push(...draw(child, childPrefix, index === row.children.length - 1, false));
  });
  return lines;
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
export function buildTaskPrompt(card: TaskCard): string {
  const sections: string[] = [];
  const locate = locator(card);
  // What the reader is holding and what it is for. A hand-off that opens on
  // `## The task` reads as a report, and a report invites a summary back; this
  // is evidence for an investigation, and the first two lines are where that
  // gets said. The instruction is to find the cause, not to propose a fix: the
  // numbers below say where the time went and nothing about why.
  sections.push(`Use the evidence below to investigate the root cause of this ${card.durationMs} ms bottleneck in the code it names. It was measured from a CPU profile of a running build, so it reports where the time went and not why — read the source of the frames it names to establish that.`);
  // The one inferred thing in an otherwise measured hand-off, so it is fenced
  // off as one: labelled as a reading of the evidence below, and placed above
  // it so the receiving agent has the claim and the numbers to check it
  // against in the same message. Everything after this section is measured.
  if (card.insight) {
    const bullets = card.insight.findings.map((finding) => `- ${finding}`).join("\n");
    sections.push(`## What this looks like\n**${card.insight.title}**\n\n${bullets}\n\nThis section is a model's reading of the task timeline below, not a measurement, and no source file was opened to write it. Treat it as a lead to verify against the evidence that follows.`);
  }
  // Where the task sits on the clock and how its edges were decided are on the
  // card the developer copied from. The agent receiving this needs the code the
  // task ran, not the recording it came out of.
  if (card.boundaryFrames.length > 0) {
    const lines = card.boundaryFrames.map((frame) => boundaryLine(frame, card.durationMs, locate));
    const covered = card.boundaryFrames.reduce((sum, frame) => sum + frame.totalMs, 0);
    const rest = round1(Math.max(0, card.durationMs - covered));
    // Disjoint by construction, so this subtraction is exact.
    if (rest >= 1) {
      lines.push(`- ${rest} ms of the task sits under none of these: framework or engine work with no application frame beneath it, plus application frames too small to list.`);
    }
    if (card.confidence === "low") lines.push("- Few samples landed in this task, so treat these figures as a hint rather than a measurement.");
    sections.push(`## The task\nThe outermost application code on this task's stacks, with everything each frame called. None of these frames nests inside another, so their times divide the task's ${card.durationMs} ms between them.\n${lines.join("\n")}`);
  } else if (card.confidence === "low") {
    sections.push("## The task\n- Few samples landed in this task, so treat these figures as a hint rather than a measurement.");
  }

  const burned = card.culprits.filter((culprit) => culprit.selfMs >= CULPRIT_MIN_MS);
  const listed = burned.slice(0, MAX_PROMPT_CULPRITS);
  if (listed.length > 0) {
    const named = listed.reduce((sum, culprit) => sum + culprit.selfMs, 0);
    const lines = listed.map((culprit) => culpritLine(culprit, card.durationMs, locate));
    const rest = round1(Math.max(0, card.durationMs - named));
    // Self time inside a task is a partition, so this remainder is exact rather
    // than the difference between two overlapping inclusive totals. What it is
    // spread across is said as a measurement too: "spread thin" and "there are
    // forty more rows you were not shown" are different situations, and the
    // line used to read the same either way.
    if (rest >= 1) {
      const unlisted = burned.length - listed.length;
      const next = burned[listed.length];
      const tail = unlisted > 0 && next
        ? ` ${unlisted} more frame${unlisted === 1 ? "" : "s"} ranked below these, the largest at ${next.selfMs} ms of its own time; the rest are smaller still.`
        : "";
      lines.push(`- ${rest} ms of the task is spread across frames smaller than the ones listed above.${tail}`);
    }
    sections.push(`## Where the task's time went\nThe frames that burned the time in their own bodies, heaviest first. Unlike the section above these are leaves rather than entry points, so a frame here is usually somewhere inside one of the frames there.\n${lines.join("\n")}`);
  }

  const anchors = listed.slice(0, MAX_TREE_ANCHORS);
  const tree = culpritTree(card, anchors, locate);
  if (tree.length > 0) {
    const scope = anchors.length < listed.length
      ? `The heaviest ${anchors.length} frames above, each at its heaviest call site`
      : "Every culprit above, at its heaviest call site";
    sections.push(`## Where those frames sit\n${scope}, with the frames joining them. \`←\` marks a culprit, and \`…\` a run of frames carrying no name worth reading.\n\n\`\`\`\n${tree.join("\n")}\n\`\`\``);
  }

  // The one caveat that changes what the receiving agent does. How a sampling
  // profiler arrives at these numbers changes how they are read, and the card
  // the developer copied from is where that is explained.
  const caveats = [
    "- This report has only frame names, source positions and timings. It has not read any source file. Confirm what each of these functions actually does before changing it.",
  ];
  // Only when one was printed. A position like `vendors.bundle.js:192:8489`
  // invites an agent to go looking for that file, and it has no file: saying
  // what it is for is cheaper than letting it waste a tool call. The caveat
  // names no example, because quoting a position the prompt does not contain
  // is one more string for a reader to go looking for.
  if (locate.printedChunk()) {
    caveats.push("- A position that names a bundle chunk rather than a source file is an offset into a build artefact: not a file to open, and different on the next build. It appears only where the frame's name does not identify it on its own, and its job there is to tell two frames apart.");
  }
  sections.push(`## How to read these numbers\n${caveats.join("\n")}`);

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
  sections.push("Use the evidence below to investigate the root cause of this bottleneck in the code it names. It was measured from a CPU profile of a running build, so it reports where the time went and not why — read the source of the frames it names to establish that.");
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
