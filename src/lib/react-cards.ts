/**
 * One card per over-budget React commit, measured.
 *
 * This is the React counterpart of `task-cards.ts`, and it exists for the same
 * reason: the unit the measurements already come in is the unit a card should be
 * built on. On the CPU side that unit is a task; here it is a commit. React
 * hands us disjoint commits with a duration each, so their shares add up, and
 * self time inside a commit is a true partition of the render phase, so no
 * millisecond is claimed twice.
 *
 * What the model does in the current React path is select: `react-analyzer.ts`
 * already derives every title, severity and evidence string from measurements,
 * and `REACT_ANALYST_SYSTEM_PROMPT` asks the model for nothing but a
 * `componentId` and the commits it appears in. The prompt then spends most of
 * its length listing the judgments that selection has to make — attribute to
 * self time not inclusive, do not promote an ancestor, do not report a wide
 * cascade of cheap components as a component issue, do not treat a normal mount
 * as a defect. Each of those is a rule over numbers already in hand:
 *
 * - Attribute by self time and the ancestor problem cannot arise. An ancestor's
 *   inclusive time is its descendants' and is never a finding here.
 * - Compare the top culprit's share of summed self time and the cascade case
 *   names itself: one expensive component is a component to go and change,
 *   three hundred cheap ones are a boundary to memoize.
 * - Read `isFirstMount` and a mount stops looking like a regression.
 *
 * So no model runs. What a model can still add is a reading of the shape — and
 * that stays on the card as the same per-card `Explain with AI` button the CPU
 * tasks have, labelled as an inference, below the measurements it reads.
 */

import { formatReactMs as ms } from "./format.ts";
import { splitSourceHint, unwrapWrappers } from "./react-commit-tree.ts";
import type { TaskInsight } from "./task-insight.ts";
import type {
  ReactCommit,
  ReactRecording,
  ReactRenderCause,
  ReactRenderedFiber,
} from "./react-commit-tree.ts";

/**
 * React's own definition of a frame budget, and the default the upload form
 * already offers. A commit longer than this could not fit in a frame, which is
 * the claim a card makes.
 */
export const DEFAULT_FRAME_BUDGET_MS = 16;

/** More cards than this is a list nobody reads; the tail is reported as a count. */
const MAX_CARDS = 12;

/** Culprit rows a card carries. Beyond this a pathological commit ships a thousand rows. */
const MAX_CULPRITS = 60;

/**
 * A culprit's floor: half a millisecond, or one percent of the commit,
 * whichever is larger.
 *
 * Absolute alone is wrong at both ends. The 275.7 ms commit in
 * `react-profile-1.json` rendered 280 fibers with a median self time of
 * 0.04 ms, so a flat 0.5 ms floor still admits dozens of rows that explain
 * nothing; the relative term cuts it to the three that do. On a 20 ms commit
 * the relative term is 0.2 ms, which is noise, so the absolute term governs
 * there instead.
 */
const CULPRIT_MIN_MS = 0.5;
const CULPRIT_MIN_SHARE = 0.01;

/**
 * The top culprit's share of summed self time at which a commit is one
 * component's fault rather than everybody's.
 *
 * Both samples land far clear of this line — 53% and 85% — and the shape it
 * separates them from is the cascade, where the heaviest component of three
 * hundred holds 2 ms. The two shapes take opposite fixes, which is why this is
 * the one classification on the card.
 */
const SINGLE_CULPRIT_SHARE = 0.6;
const FEW_CULPRIT_SHARE = 0.7;
const FEW_CULPRIT_COUNT = 3;

/** A commit that re-rendered at least this many fibers is wide enough to call a cascade. */
const CASCADE_FIBER_COUNT = 50;

/** Components named in a headline. Past the second the line stops being readable. */
const HEADLINE_CULPRITS = 2;

/** Ancestors a path line prints. Four is a screen, a container, a wrapper and the component. */
const MAX_PATHLINE_NAMES = 5;

/**
 * Wasted renders worth leading the cause line with. Below this the breakdown
 * beside it already says as much, and "1 component re-rendered with nothing
 * changed (0.1 ms)" is a true sentence that wastes the most prominent line on
 * the card.
 */
const WASTED_HEADLINE_MIN_COUNT = 3;
const WASTED_HEADLINE_MIN_MS = 1;

/**
 * The share of attributed time in first mounts at which a commit is a mount
 * rather than a re-render.
 *
 * This is the distinction the React analyst prompt asks a model to make when it
 * says a normal list mount is not an issue by itself. A mount is still worth a
 * card — 275 ms of it is a frozen screen transition — but it is a different
 * finding from the same cost in a re-render, and it has a different fix.
 */
const MOUNT_DOMINANT_SHARE = 0.8;

/** Aggregate rows kept for the whole recording. */
const MAX_AGGREGATE_ROWS = 20;

/** Commits sharing a shape this many times are a repeat, not a coincidence. */
const MIN_REPEAT_COMMITS = 3;

/**
 * Effects worth a line of their own: a tenth of the commit, or half a frame.
 *
 * `effectDuration` and `passiveEffectDuration` reach no part of the current
 * pipeline — `ReactCommitEvidence` does not carry them — so a commit that
 * renders in 8 ms and then spends 40 ms in layout effects is today reported as
 * being under budget. It is not.
 */
const EFFECT_MIN_SHARE = 0.1;

const round1 = (value: number) => Math.round(value * 10) / 10;

/**
 * What kind of thing a component is, which is what decides whether a reader can
 * act on it.
 *
 * The CPU engine needs `frame-classes.ts` and a bundle heuristic to answer the
 * same question, because a stack frame carries nothing but a name. React hands
 * us the element type outright, so host components and the reconciler's own
 * wrappers separate themselves, and only the app/library split is left to a
 * name table.
 */
export type ReactComponentClass = "app" | "library" | "framework" | "host" | "unnamed";

const ELEMENT_TYPE_HOST = 7;
const ELEMENT_TYPE_ROOT = 11;
const ELEMENT_TYPE_SUSPENSE = 12;
const ELEMENT_TYPE_SUSPENSE_LIST = 13;
const ELEMENT_TYPE_CONTEXT = 2;
const ELEMENT_TYPE_PROFILER = 10;

/**
 * Components that belong to React, the navigator, or the platform's own
 * component library. A card may still name one — self time is self time, and a
 * `VirtualizedList` burning its own milliseconds is a real finding about how it
 * was configured — but a cascade through them is a boundary to memoize rather
 * than a component to rewrite.
 */
const FRAMEWORK_NAMES = new Set([
  "(root)", "Suspense", "SuspenseList", "Freeze", "DelayedFreeze", "Suspender",
  "Profiler", "Activity", "Offscreen", "Fragment", "StrictMode",
]);

const LIBRARY_NAME_PATTERN = /^(?:Base)?(?:Navigation|Screen|Scene|Route|Stack|Tab|Drawer)|^(?:Virtualized|Flat|Section)List$|^(?:Animated|Scroll|Safe|Pressable|Touchable|Text|Image|Modal|Internal|Ensure|Static)/;

export function classifyReactComponent(fiber: { displayName: string; elementType: number }): ReactComponentClass {
  if (/^#\d+$/.test(fiber.displayName)) return "unnamed";
  if (fiber.elementType === ELEMENT_TYPE_HOST) return "host";
  if (fiber.elementType === ELEMENT_TYPE_ROOT || fiber.elementType === ELEMENT_TYPE_SUSPENSE
    || fiber.elementType === ELEMENT_TYPE_SUSPENSE_LIST || fiber.elementType === ELEMENT_TYPE_CONTEXT
    || fiber.elementType === ELEMENT_TYPE_PROFILER) return "framework";
  if (FRAMEWORK_NAMES.has(fiber.displayName) || /\.(?:Provider|Consumer)$/.test(fiber.displayName)) return "framework";
  if (LIBRARY_NAME_PATTERN.test(fiber.displayName)) return "library";
  return "app";
}

export interface ReactCardCulprit {
  /** `1:728`, the same identity the current analyzer and its saved records use. */
  componentId: string;
  component: string;
  componentClass: ReactComponentClass;
  selfMs: number;
  percentOfCommit: number;
  cause: ReactRenderCause;
  changedProps: string[];
  changedHooks: string[];
  compiledWithForget: boolean;
  /**
   * The module the recorded name named, where it named one. The only source
   * location a React export ever yields, and what makes a hand-off actionable
   * without a second profile.
   */
  sourceHint: string | null;
  /** Root to this component, with the reconciler's wrappers dropped. */
  path: string[];
  /** `HeavyActivityHeatmap used 124.8 ms self time, 73.5% of a 169.7 ms over-budget React render.` */
  evidence: string;
}

/**
 * Whether a culprit row is worth a line in a prompt.
 *
 * A row for something that is not the app's own code and carries no recorded
 * module path — `Route(explore-details)`, a provider, a host view — is a name
 * and two numbers with nowhere to go: neither a reader nor an agent can open
 * it, and no render reason is usually recorded against it either. The app's own
 * components always stay, as does anything the build recorded a file for.
 */
export function isActionableCulprit(culprit: ReactCardCulprit): boolean {
  return isOwnComponent(culprit);
}

/**
 * Whether a component is one the reader can go and open.
 *
 * The app's own components always are. So is anything the build recorded a
 * module for, whatever its class: a `library` row with a file behind it is a
 * component in the reader's own `node_modules`, and the file is where a fix
 * for it starts. What this leaves out is React's own wrappers and the
 * platform's own views with no recorded source — a name and two numbers with
 * nowhere to go.
 *
 * The same cut the culprit rows are filtered by and the Components table's
 * `Your code only` toggle draws by, so a component missing from one is missing
 * from the other for the same reason.
 */
export function isOwnComponent(
  component: { componentClass: ReactComponentClass; sourceHint: string | null },
): boolean {
  return component.componentClass === "app" || component.sourceHint !== null;
}

export interface ReactCauseBreakdown {
  cause: ReactRenderCause;
  count: number;
  selfMs: number;
}

export type ReactCommitShape = "single" | "few" | "cascade" | "spread";

export interface ReactCard {
  /** Stable for a given profile, and what a hand-off and a drill-down are keyed by. */
  id: string;
  rootId: number;
  commitIndex: number;
  /** Offset into the recording, so a reader can find this commit on the strip. */
  startMs: number;
  durationMs: number;
  percentOfRender: number;
  severity: "low" | "medium" | "high";
  shape: ReactCommitShape;
  /** `HeavyActivityHeatmap spent 124.8 ms rendering in a 169.7 ms commit` */
  headline: string;
  /** Where that component sits: `DetailsScreen › ThemedView › ScrollView › HeavyActivityHeatmap` */
  pathline?: string;
  /** `74% of the commit in one component · 329 components rendered · median 0.03 ms` */
  shapeline: string;
  /** `all 153 components rendered on first mount` or `why each component rendered was not recorded` */
  causeline: string;
  /** `update scheduled by BaseNavigationContainer`, when recorded. */
  updaterline?: string;
  /** Present only when effects are material; they are invisible in the current pipeline. */
  effectline?: string;
  renderedCount: number;
  summedSelfMs: number;
  /**
   * Render time in this commit that reached no component of its own: the
   * reconciler walking the tree. The CPU cards carry the same figure as
   * `outsideBoundariesMs`, for the same reason — a residual that mixes "smaller
   * components" with "never a component at all" hides which of the two it was.
   */
  unattributedMs: number;
  effectDurationMs: number;
  passiveEffectDurationMs: number;
  priority: string | null;
  updaters: string[];
  culprits: ReactCardCulprit[];
  culpritTailCount: number;
  culpritTailMs: number;
  causes: ReactCauseBreakdown[];
  /**
   * Components React re-rendered although nothing it recorded had changed, and
   * what they cost. Null — not zero — when the recording did not capture render
   * reasons, because "none" and "not asked" are different answers.
   */
  wasted: { count: number; selfMs: number } | null;
  /** Low when render reasons are missing or the hot components could not be named. */
  confidence: "ok" | "low";
  /**
   * The model's reading of this commit, when AI assist is on. Everything else
   * on the card is measured; this is the one field that is inferred, so the
   * view labels it and the hand-off says so in as many words.
   */
  insight?: TaskInsight;
}

export interface ReactComponentAggregate {
  componentId: string;
  component: string;
  componentClass: ReactComponentClass;
  renders: number;
  totalSelfMs: number;
  maxSelfMs: number;
  /** Renders where nothing recorded had changed. The strongest memoization signal in the export. */
  wastedRenders: number;
  causes: ReactCauseBreakdown[];
}

export interface ReactCommitRepeat {
  /** Commits that re-rendered the same number of fibers behind the same updaters. */
  updaters: string[];
  renderedCount: number;
  commitIndexes: number[];
  totalMs: number;
}

export interface ReactRootSummary {
  rootId: number;
  rootName: string | null;
  commitCount: number;
  totalRenderMs: number;
  peakCommitMs: number;
}

export interface ReactCardSet {
  cards: ReactCard[];
  budgetMs: number;
  /**
   * Every profiled root, not just the busiest.
   *
   * A React Native recording routinely holds two — the app and a dev overlay —
   * and the checked-in fixture holds exactly that. Cards carry their own
   * `rootId`, so one ranked list across all of them is the right page; this is
   * what lets a reader see that the second root existed at all.
   */
  roots: ReactRootSummary[];
  commitCount: number;
  commitsOverBudget: number;
  /**
   * No commit cleared the budget, so the cards below are the busiest commits in
   * the recording rather than findings. A profile of a healthy interaction
   * should read as a verdict, not as an empty page.
   */
  noOverBudgetCommits: boolean;
  totalRenderMs: number;
  peakCommitMs: number;
  omittedCardCount: number;
  omittedCardMs: number;
  components: ReactComponentAggregate[];
  repeats: ReactCommitRepeat[];
  /** False when the recording was made without "Record why each component rendered". */
  causesRecorded: boolean;
  /** Fibers mounted before the recording started, which `operations` never named. */
  unnamedFiberCount: number;
}

const CAUSE_ORDER: ReactRenderCause[] = ["first-mount", "state", "hooks", "props", "context", "nothing-changed", "unknown"];

function causeBreakdown(fibers: ReactRenderedFiber[]): ReactCauseBreakdown[] {
  const totals = new Map<ReactRenderCause, ReactCauseBreakdown>();
  for (const fiber of fibers) {
    const entry = totals.get(fiber.cause) ?? { cause: fiber.cause, count: 0, selfMs: 0 };
    entry.count += 1;
    entry.selfMs += fiber.selfMs;
    totals.set(fiber.cause, entry);
  }
  return CAUSE_ORDER.filter((cause) => totals.has(cause))
    .map((cause) => ({ ...totals.get(cause)!, selfMs: round1(totals.get(cause)!.selfMs) }))
    .sort((a, b) => b.selfMs - a.selfMs || b.count - a.count);
}

/**
 * Severity, as the existing analyzer defines it for a component, plus a floor
 * the commit itself sets.
 *
 * `reactIssueSeverity` alone grades a 170 ms commit as low whenever no single
 * component holds much of it — which is exactly the cascade, the shape most
 * worth a reader's time. A commit several budgets long is at least medium
 * however its cost is spread.
 */
function cardSeverity(commit: ReactCommit, topSelfMs: number, budget: number): ReactCard["severity"] {
  const share = commit.durationMs > 0 ? topSelfMs / commit.durationMs : 0;
  if (topSelfMs >= budget * 2 || share >= 0.5 || commit.durationMs >= budget * 4) return "high";
  if (topSelfMs >= budget || share >= 0.25 || commit.durationMs >= budget * 2) return "medium";
  return "low";
}

/**
 * `few` is tested before `cascade` and after `single`, and the order is the
 * whole point.
 *
 * The 275.7 ms commit in `react-profile-1.json` puts 53% of its attributed time
 * in `MerchantLeaderboard` and 90% in that component plus `SpendingSummary`.
 * Calling it `single` is how a reader comes away thinking one fix closes a
 * 275 ms commit, when the second component is still 101 ms on its own — so the
 * single-culprit line sits high enough that two comparable components fall to
 * `few` and the headline names both. A cascade cannot reach `few`: three
 * components out of three hundred do not hold 70% of anything.
 */
function commitShape(culpritShare: number, topThreeShare: number, renderedCount: number): ReactCommitShape {
  if (culpritShare >= SINGLE_CULPRIT_SHARE) return "single";
  if (topThreeShare >= FEW_CULPRIT_SHARE) return "few";
  if (renderedCount >= CASCADE_FIBER_COUNT) return "cascade";
  return "spread";
}

/**
 * Where a component sits, as a reader would say it.
 *
 * Providers, suspense boundaries and memo wrappers are dropped — they are the
 * reconciler's bookkeeping, and on a React Native tree they are most of the
 * depth. What is left is narrowed from the cost outward rather than from the
 * root inward, because `RootComponent › AppContainer › …` is the same on every
 * component in the app and says nothing. The outermost app-class ancestor is
 * then put back at the front: that is the screen, and naming it is what lets a
 * reader open the right file.
 */
function readablePath(path: string[]): string[] {
  const entries = path
    .map((name) => splitSourceHint(unwrapWrappers(name)))
    .filter((entry) => classifyReactComponent({ displayName: entry.displayName, elementType: 9 }) !== "framework");
  // `Memo(StaticContainer) › StaticContainer` is two fibers and one component
  // to a reader, so a repeat adds a step to the path and no information.
  const names = entries
    .map((entry) => entry.displayName)
    .filter((name, index, all) => name !== all[index - 1]);
  if (names.length <= MAX_PATHLINE_NAMES) return names;

  const near = names.slice(-(MAX_PATHLINE_NAMES - 1));
  const outer = entries.slice(0, entries.length - near.length);
  // A recorded module path is what makes an ancestor a screen. `ThemedView` is
  // the app's own code and the nearest app-class ancestor on both samples, but
  // it is a presentational wrapper reused everywhere; `DetailsScreen` carries
  // `./explore-details.tsx`, and that is the line a reader needs. The
  // app-class search is the fallback for a build that records no paths.
  const screen = outer.findLast((entry) => entry.sourceHint !== null)
    ?? outer.findLast((entry) => classifyReactComponent({ displayName: entry.displayName, elementType: 9 }) === "app"
      && !near.includes(entry.displayName));
  return screen ? [screen.displayName, "…", ...near.slice(1)] : ["…", ...near];
}

function headline(shape: ReactCommitShape, culprits: ReactCardCulprit[], commit: ReactCommit): string {
  const duration = ms(commit.durationMs);
  if (shape === "single" && culprits[0]) {
    return `${culprits[0].component} spent ${ms(culprits[0].selfMs)} rendering in a ${duration} commit`;
  }
  if ((shape === "few" || shape === "spread") && culprits.length > 0) {
    // The named components and their own time, with no trailing count. "and 1
    // more" earned its place when the tail was comparable, and here the third
    // culprit of the 275.7 ms commit is 2.8 ms — so the count read as though a
    // third of the problem were unnamed while the figure beside it covered only
    // two components. The rows below the headline carry the tail already.
    const named = culprits.slice(0, HEADLINE_CULPRITS);
    const measured = named.reduce((total, culprit) => total + culprit.selfMs, 0);
    return `${named.map((culprit) => culprit.component).join(" and ")} spent ${ms(measured)} of a ${duration} commit`;
  }
  const heaviest = culprits[0]?.selfMs ?? commit.fibers[0]?.selfMs ?? 0;
  return `${commit.fibers.length} components re-rendered in a ${duration} commit, none over ${ms(heaviest)}`;
}

function shapeline(shape: ReactCommitShape, culprits: ReactCardCulprit[], commit: ReactCommit): string {
  const median = commit.fibers.length > 0
    ? commit.fibers[Math.floor(commit.fibers.length / 2)].selfMs
    : 0;
  const top = culprits[0]?.percentOfCommit ?? 0;
  const parts = [`${commit.fibers.length} component${commit.fibers.length === 1 ? "" : "s"} rendered`];
  if (shape === "single") {
    parts.unshift(`${Math.round(top)}% of the commit in one component`);
  } else if (shape === "cascade") {
    parts.push(`median ${ms(median)} each`, `heaviest ${Math.round(top)}%`);
  } else {
    // The share the headline's components hold together, so the two lines agree.
    const named = culprits.slice(0, HEADLINE_CULPRITS);
    const share = named.reduce((total, culprit) => total + culprit.percentOfCommit, 0);
    parts.unshift(`${Math.round(share)}% of the commit in ${named.length} component${named.length === 1 ? "" : "s"}`);
  }
  return parts.join(" · ");
}

function causeline(
  card: Pick<ReactCard, "causes" | "wasted" | "renderedCount" | "summedSelfMs">,
  commitRecorded: boolean,
  profileRecorded: boolean,
): string {
  // Two different answers, and a reader acts on them differently: a profile
  // recorded without "Record why each component rendered" can be recorded
  // again, while a commit that recorded nothing inside a profile that did is a
  // commit React attributed to no component.
  if (!profileRecorded) return "why each component rendered was not recorded in this profile";
  if (!commitRecorded) return "no render reasons recorded for this commit";

  const parts: string[] = [];
  const mount = card.causes.find((entry) => entry.cause === "first-mount");
  if (mount && mount.selfMs >= MOUNT_DOMINANT_SHARE * card.summedSelfMs) {
    parts.push(mount.count === card.renderedCount
      ? `a first mount: all ${mount.count} components mounting, ${ms(mount.selfMs)}`
      : `mostly a first mount: ${mount.count} of ${card.renderedCount} components mounting, ${ms(mount.selfMs)}`);
  }
  if (card.wasted && (card.wasted.count >= WASTED_HEADLINE_MIN_COUNT || card.wasted.selfMs >= WASTED_HEADLINE_MIN_MS)) {
    parts.push(`${card.wasted.count} re-rendered with nothing changed (${ms(card.wasted.selfMs)})`);
  }
  for (const entry of card.causes) {
    if (entry.cause === "unknown" || (parts.length > 0 && entry.cause === "first-mount")) continue;
    if (parts.length >= 3) break;
    parts.push(`${entry.cause} ×${entry.count}${entry.selfMs >= 0.1 ? ` (${ms(entry.selfMs)})` : ""}`);
  }
  return parts.join(" · ") || "no render reasons recorded for this commit";
}

function buildCard(commit: ReactCommit, budget: number, totalRenderMs: number, causesRecorded: boolean): ReactCard {
  const floor = Math.max(CULPRIT_MIN_MS, CULPRIT_MIN_SHARE * commit.durationMs);
  const admitted = commit.fibers.filter((fiber) => fiber.selfMs >= floor);
  const kept = admitted.slice(0, MAX_CULPRITS);
  const tail = commit.fibers.filter((fiber) => !kept.includes(fiber));

  const culprits: ReactCardCulprit[] = kept.map((fiber) => {
    const percentOfCommit = commit.durationMs > 0 ? round1((fiber.selfMs / commit.durationMs) * 100) : 0;
    return {
      componentId: `${commit.rootId}:${fiber.id}`,
      component: fiber.displayName,
      componentClass: classifyReactComponent(fiber),
      selfMs: round1(fiber.selfMs),
      percentOfCommit,
      cause: fiber.cause,
      changedProps: fiber.changedProps,
      changedHooks: fiber.changedHooks,
      compiledWithForget: fiber.compiledWithForget,
      sourceHint: fiber.sourceHint,
      path: readablePath(fiber.path),
      // Word for word the string the current analyzer derives, so a card built
      // by rules reads as the same finding the model-selected one did.
      evidence: `${fiber.displayName} used ${ms(fiber.selfMs)} self time, ${percentOfCommit}% of a ${ms(commit.durationMs)} over-budget React render.`,
    };
  });

  const topSelfMs = commit.fibers[0]?.selfMs ?? 0;
  const topThreeMs = commit.fibers.slice(0, FEW_CULPRIT_COUNT).reduce((total, fiber) => total + fiber.selfMs, 0);
  const divisor = Math.max(commit.summedSelfMs, 1e-9);
  const shape = commitShape(topSelfMs / divisor, topThreeMs / divisor, commit.fibers.length);
  const causes = causeBreakdown(commit.fibers);
  const wastedFibers = commit.causesRecorded
    ? commit.fibers.filter((fiber) => fiber.cause === "nothing-changed")
    : null;
  const wasted = wastedFibers
    ? { count: wastedFibers.length, selfMs: round1(wastedFibers.reduce((total, fiber) => total + fiber.selfMs, 0)) }
    : null;
  const unnamedTop = commit.fibers.slice(0, 3).filter((fiber) => /^#\d+$/.test(fiber.displayName)).length;

  const card: ReactCard = {
    id: `react-commit-${commit.rootId}-${commit.commitIndex}`,
    rootId: commit.rootId,
    commitIndex: commit.commitIndex,
    startMs: round1(commit.timestampMs),
    durationMs: round1(commit.durationMs),
    percentOfRender: totalRenderMs > 0 ? round1((commit.durationMs / totalRenderMs) * 100) : 0,
    severity: cardSeverity(commit, topSelfMs, budget),
    shape,
    headline: headline(shape, culprits, commit),
    shapeline: shapeline(shape, culprits, commit),
    causeline: "",
    renderedCount: commit.fibers.length,
    summedSelfMs: round1(commit.summedSelfMs),
    unattributedMs: round1(Math.max(0, commit.durationMs - commit.summedSelfMs)),
    effectDurationMs: round1(commit.effectDurationMs),
    passiveEffectDurationMs: round1(commit.passiveEffectDurationMs),
    priority: commit.priority,
    updaters: commit.updaters,
    culprits,
    culpritTailCount: tail.length,
    culpritTailMs: round1(tail.reduce((total, fiber) => total + fiber.selfMs, 0)),
    causes,
    wasted,
    confidence: !commit.causesRecorded || unnamedTop > 0 ? "low" : "ok",
  };
  card.causeline = causeline(card, commit.causesRecorded, causesRecorded);
  const path = culprits[0]?.path;
  if (path && path.length > 1) card.pathline = path.join(" › ");
  if (commit.updaters.length > 0) {
    card.updaterline = `update scheduled by ${[...new Set(commit.updaters)].slice(0, 3).join(", ")}`;
  }
  const effects = commit.effectDurationMs + commit.passiveEffectDurationMs;
  if (effects >= Math.min(budget / 2, EFFECT_MIN_SHARE * commit.durationMs)) {
    card.effectline = `plus ${ms(commit.effectDurationMs)} layout effects and ${ms(commit.passiveEffectDurationMs)} passive effects after the render`;
  }
  return card;
}

function aggregateComponents(commits: ReactCommit[]): ReactComponentAggregate[] {
  const rows = new Map<string, ReactComponentAggregate & { fibers: ReactRenderedFiber[] }>();
  for (const commit of commits) {
    for (const fiber of commit.fibers) {
      const componentId = `${commit.rootId}:${fiber.id}`;
      const row = rows.get(componentId) ?? {
        componentId, component: fiber.displayName, componentClass: classifyReactComponent(fiber),
        renders: 0, totalSelfMs: 0, maxSelfMs: 0, wastedRenders: 0, causes: [], fibers: [],
      };
      row.renders += 1;
      row.totalSelfMs += fiber.selfMs;
      row.maxSelfMs = Math.max(row.maxSelfMs, fiber.selfMs);
      if (fiber.cause === "nothing-changed") row.wastedRenders += 1;
      row.fibers.push(fiber);
      rows.set(componentId, row);
    }
  }
  return [...rows.values()]
    .map(({ fibers, ...row }) => ({
      ...row,
      totalSelfMs: round1(row.totalSelfMs),
      maxSelfMs: round1(row.maxSelfMs),
      causes: causeBreakdown(fibers),
    }))
    .sort((a, b) => b.totalSelfMs - a.totalSelfMs || b.renders - a.renders || a.component.localeCompare(b.component))
    .slice(0, MAX_AGGREGATE_ROWS);
}

/**
 * Commits that re-rendered the same number of components behind the same
 * updaters.
 *
 * A render storm is the one React finding a single commit cannot show: each
 * commit is individually under budget and individually innocent, and the cost
 * is that there are forty of them. Grouping on the updater set and the rendered
 * count is deliberately coarse — it is a claim that these commits are the same
 * work repeating, which is checkable on the strip, not a claim about why.
 */
function commitRepeats(commits: ReactCommit[]): ReactCommitRepeat[] {
  const groups = new Map<string, ReactCommitRepeat>();
  for (const commit of commits) {
    const updaters = [...new Set(commit.updaters)].sort();
    const key = `${updaters.join(",")}|${commit.fibers.length}`;
    const group = groups.get(key) ?? { updaters, renderedCount: commit.fibers.length, commitIndexes: [], totalMs: 0 };
    group.commitIndexes.push(commit.commitIndex);
    group.totalMs += commit.durationMs;
    groups.set(key, group);
  }
  return [...groups.values()]
    .filter((group) => group.commitIndexes.length >= MIN_REPEAT_COMMITS && group.renderedCount > 0)
    .map((group) => ({ ...group, totalMs: round1(group.totalMs) }))
    .sort((a, b) => b.totalMs - a.totalMs);
}

export function buildReactCards(recordings: ReactRecording[], budgetMs = DEFAULT_FRAME_BUDGET_MS): ReactCardSet {
  const commits = recordings.flatMap((recording) => recording.commits);
  const totalRenderMs = recordings.reduce((total, recording) => total + recording.totalRenderMs, 0);
  const causesRecorded = recordings.some((recording) => recording.causesRecorded);
  const overBudget = commits.filter((commit) => commit.durationMs > budgetMs);
  // A recording of nothing but cheap commits is a real answer, not an empty
  // one: say so, and show the busiest commits anyway. The cut is taken across
  // every root, because a reader ranks by what they felt, not by which root
  // rendered it.
  const selected = (overBudget.length > 0 ? overBudget : [...commits])
    .sort((a, b) => b.durationMs - a.durationMs || a.rootId - b.rootId || a.commitIndex - b.commitIndex);
  const shown = selected.slice(0, MAX_CARDS);
  const omitted = selected.slice(MAX_CARDS);

  return {
    cards: shown.map((commit) => buildCard(commit, budgetMs, totalRenderMs, causesRecorded)),
    budgetMs,
    roots: recordings.map((recording) => ({
      rootId: recording.rootId,
      rootName: recording.rootName,
      commitCount: recording.commits.length,
      totalRenderMs: round1(recording.totalRenderMs),
      peakCommitMs: round1(recording.peakCommitMs),
    })),
    commitCount: commits.length,
    commitsOverBudget: overBudget.length,
    noOverBudgetCommits: overBudget.length === 0,
    totalRenderMs: round1(totalRenderMs),
    peakCommitMs: round1(recordings.reduce((max, recording) => Math.max(max, recording.peakCommitMs), 0)),
    omittedCardCount: omitted.length,
    omittedCardMs: round1(omitted.reduce((total, commit) => total + commit.durationMs, 0)),
    components: aggregateComponents(commits),
    repeats: recordings.flatMap((recording) => commitRepeats(recording.commits)).sort((a, b) => b.totalMs - a.totalMs),
    causesRecorded,
    unnamedFiberCount: recordings.reduce((total, recording) => total + recording.unnamedFiberCount, 0),
  };
}
