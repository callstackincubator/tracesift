/**
 * The hand-off a developer pastes into their own coding agent, for one React
 * commit.
 *
 * Everything here is measured, so the prompt is built without a model call —
 * the same contract `card-prompt.ts` holds for a CPU task.
 *
 * What makes this hand-off worth more than the card it came from is where it
 * lands. A React profile records which component burned the time and why React
 * re-rendered it, and nothing at all about what inside that component was slow:
 * there is no call tree below a fiber, and `selfDurationMs` is one opaque
 * number covering the whole render body. That answer is in the source, which
 * the receiving agent has and this tool does not. So the prompt's job is to
 * name the component, the cost, the trigger and the file where one was
 * recorded, and then get out of the way.
 */

import type { ReactCard, ReactCardSet, ReactComponentAggregate } from "./react-cards.ts";
import { hookLabel } from "./react-commit-tree.ts";

const round1 = (value: number) => Math.round(value * 10) / 10;

/** Culprits the hand-off names. The card shows the same list; past this it is a log. */
const MAX_PROMPT_CULPRITS = 15;

/** Aggregate rows quoted for the components this card named. */
const MAX_PROMPT_AGGREGATES = 6;

/** Wasted renders worth a bullet of their own, matching the card's own cut. */
const WASTED_MIN_COUNT = 3;
const WASTED_MIN_MS = 1;

function causePhrase(card: ReactCard): string {
  const parts: string[] = [];
  for (const entry of card.causes) {
    if (entry.cause === "unknown") continue;
    parts.push(`${entry.count} ${entry.cause === "nothing-changed" ? "with nothing changed" : `on ${entry.cause}`}`);
  }
  return parts.join(", ");
}

function culpritLine(card: ReactCard, culprit: ReactCard["culprits"][number]): string {
  const where = culprit.sourceHint ? ` (\`${culprit.sourceHint}\`)` : "";
  const cause = culprit.cause === "unknown" ? "" : `, rendered because ${culprit.cause === "nothing-changed"
    ? "nothing it records had changed"
    : culprit.cause === "first-mount" ? "it mounted for the first time" : `its ${culprit.cause} changed`}`;
  const changed = culprit.changedProps.length > 0
    ? ` — changed props: ${culprit.changedProps.slice(0, 8).map((name) => `\`${name}\``).join(", ")}`
    : culprit.changedHooks.length > 0
      ? ` — changed hooks: ${culprit.changedHooks.slice(0, 8).map(hookLabel).join(", ")}` : "";
  // Only where memoization could have prevented the render. On a first mount
  // it could not, and saying the component is already memoized there reads as
  // "nothing to do about this one" about the most expensive row on the card.
  const forget = culprit.compiledWithForget && culprit.cause !== "first-mount"
    ? " It is compiled by React Compiler, so its props and hooks are already memoized — a re-render here was not caused by a reference it owns."
    : "";
  const path = culprit.path.length > 1 ? ` Rendered under ${culprit.path.slice(0, -1).join(" › ")}.` : "";
  return `- \`${culprit.component}\`${where} — ${culprit.selfMs} ms of its own render time, ${culprit.percentOfCommit}% of the commit${cause}.${changed}${path}${forget}`;
}

function aggregateLine(row: ReactComponentAggregate): string {
  const wasted = row.wastedRenders > 0
    ? `, ${row.wastedRenders} of them with nothing changed`
    : "";
  return `- \`${row.component}\` rendered ${row.renders} time${row.renders === 1 ? "" : "s"} in this recording for ${row.totalSelfMs} ms of its own time in total, worst single render ${row.maxSelfMs} ms${wasted}.`;
}

export function buildReactCardPrompt(card: ReactCard, set?: ReactCardSet): string {
  const sections: string[] = [];

  sections.push(`Use the evidence below to investigate the root cause of this ${card.durationMs} ms React commit in the code it names. It was measured from a React DevTools profiling recording of a running build, so it reports which components burned the time and why React re-rendered them — not what inside those components is slow. A component's self time is one opaque figure covering its whole render body; read the source of the components it names to establish what that body does.`);

  // The one inferred thing in an otherwise measured hand-off, fenced off as
  // one and placed above the evidence it was read from.
  if (card.insight) {
    const bullets = card.insight.findings.map((finding) => `- ${finding}`).join("\n");
    sections.push(`## What this looks like\n**${card.insight.title}**\n\n${bullets}\n\nThis section is a model's reading of the measurements below, not a measurement, and no source file was opened to write it. Treat it as a lead to verify against the evidence that follows.`);
  }

  const commit: string[] = [
    `- ${card.durationMs} ms of render work${card.percentOfRender >= 1 ? `, ${card.percentOfRender}% of all the render time in the recording` : ""}, at ${card.startMs} ms into the recording${card.priority ? ` at ${card.priority} priority` : ""}.`,
    `- ${card.renderedCount} component${card.renderedCount === 1 ? "" : "s"} re-rendered in it. ${card.summedSelfMs} ms is attributed to components; the remaining ${card.unattributedMs} ms is React walking the tree and committing it, which no component change can remove.`,
  ];
  if (card.updaters.length > 0) {
    commit.push(`- The update was scheduled by ${[...new Set(card.updaters)].map((name) => `\`${name}\``).join(", ")}. That is where the state change originated, which is not necessarily where the cost is.`);
  }
  if (card.effectDurationMs + card.passiveEffectDurationMs >= 1) {
    commit.push(`- After the render, ${card.effectDurationMs} ms went to layout effects and ${card.passiveEffectDurationMs} ms to passive effects. Those are not part of the ${card.durationMs} ms above and are not attributed to any component.`);
  }
  if (card.shape === "cascade") {
    commit.push(`- No single component holds much of this commit: the cost is ${card.renderedCount} components rendering, each cheaply. That shape is usually fixed at the boundary that re-rendered them — memoizing a subtree or narrowing what a provider publishes — rather than inside any one of them.`);
  }
  if (card.confidence === "low") {
    commit.push(`- Treat this card as a lead rather than a measurement: ${set && !set.causesRecorded ? "the recording did not capture render reasons" : "some of the heaviest components could not be named"}.`);
  }
  sections.push(`## The commit\n${commit.join("\n")}`);

  const listed = card.culprits.slice(0, MAX_PROMPT_CULPRITS);
  if (listed.length > 0) {
    const named = round1(listed.reduce((total, culprit) => total + culprit.selfMs, 0));
    const lines = listed.map((culprit) => culpritLine(card, culprit));
    // Self time inside a commit is a partition, so this remainder is exact.
    if (card.culpritTailCount > 0 && card.culpritTailMs >= 1) {
      lines.push(`- ${card.culpritTailMs} ms is spread across ${card.culpritTailCount} further components, none of them large enough on its own to list.`);
    }
    sections.push(`## Which components burned it\nRanked by each component's own render time, which is a true partition of the ${card.summedSelfMs} ms attributed above — these figures do not overlap and are not inclusive of children. The ${listed.length} listed here account for ${named} ms.\n${lines.join("\n")}`);
  }

  if (set && !set.causesRecorded) {
    sections.push(`## Why React rendered them\nNot recorded. This profile was captured without React DevTools' "Record why each component rendered" setting, so every render reason above is unavailable rather than absent. If the distinction matters — and for a re-render it usually decides the fix — re-record with that setting on.`);
  } else {
    const why: string[] = [];
    const phrase = causePhrase(card);
    if (phrase) why.push(`- Of the ${card.renderedCount} components that rendered: ${phrase}.`);
    // The same floor the card's cause line uses: one component re-rendering for
    // 0.1 ms is a true statement and a waste of the receiving agent's attention.
    if (card.wasted && (card.wasted.count >= WASTED_MIN_COUNT || card.wasted.selfMs >= WASTED_MIN_MS)) {
      why.push(`- ${card.wasted.count} of them re-rendered although none of the props, state, hooks or context React tracks had changed, costing ${card.wasted.selfMs} ms. That is work with no cause recorded against it, and the usual reason is a parent re-rendering with a new object, array or callback identity.`);
    }
    const mount = card.causes.find((entry) => entry.cause === "first-mount");
    if (mount && mount.count > 0) {
      why.push(`- ${mount.count} mounted for the first time, for ${mount.selfMs} ms. A mount is not a wasted render — the question for those is whether this much has to mount at once, or before the screen is interactive.`);
    }
    if (why.length > 0) sections.push(`## Why React rendered them\nAs recorded by React, not inferred.\n${why.join("\n")}`);
  }

  if (set) {
    const named = new Set(card.culprits.map((culprit) => culprit.componentId));
    const rows = set.components.filter((row) => named.has(row.componentId)).slice(0, MAX_PROMPT_AGGREGATES);
    const repeats = set.repeats.slice(0, 2);
    const lines = [...rows.map(aggregateLine)];
    for (const repeat of repeats) {
      lines.push(`- ${repeat.commitIndexes.length} commits in this recording re-rendered the same ${repeat.renderedCount} components${repeat.updaters.length > 0 ? ` behind ${repeat.updaters.map((name) => `\`${name}\``).join(", ")}` : ""}, ${repeat.totalMs} ms in total. Each one fits a frame on its own; together they may not.`);
    }
    if (lines.length > 0) {
      sections.push(`## Across the whole recording\nThe same components, outside this one commit. ${set.commitsOverBudget} of ${set.commitCount} commits ran longer than the ${set.budgetMs} ms budget.\n${lines.join("\n")}`);
    }
  }

  const caveats = [
    "- This report has component display names, render timings and recorded render reasons. It has not read any source file, and a React profile contains no call stack below a component, so what makes a component's own render body expensive is not in here. Read the source before changing it.",
    "- A component's self time is its own render body only. Inclusive time is not reported here on purpose: it overlaps every ancestor, so it cannot be added up or compared between components.",
    "- Render time is not paint time. A long commit does not by itself establish a delayed first paint, a dropped frame, or an unresponsive screen; it establishes that React spent that long rendering.",
  ];
  if (card.culprits.some((culprit) => !culprit.sourceHint)) {
    caveats.push("- A display name is not a file. Where a module path appears in parentheses it was recorded by the build; where none appears, locate the component by name.");
  }
  if (card.culprits.some((culprit) => culprit.changedProps.length > 0 || culprit.changedHooks.length > 0)) {
    caveats.push("- Changed props and hooks are recorded as names and indices, never values. They say which prop changed between renders, not what it changed from or to, and a name appearing here is not proof of an unstable reference.");
  }
  sections.push(`## How to read these numbers\n${caveats.join("\n")}`);

  return sections.join("\n\n");
}
