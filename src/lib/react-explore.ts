/**
 * A React recording as something to walk through, rather than as a ranked list
 * of findings.
 *
 * The cards answer "which commits blew the budget and which components burned
 * them". Two questions they cannot answer sit one level down, and this module
 * carries the data for both:
 *
 * - *When* did the commits happen? A card gives one commit's duration. A render
 *   storm is forty commits that are each innocent, and the only view in which
 *   it is visible is all of them against the clock. React DevTools draws its
 *   commits as evenly spaced bars, so a burst of eleven commits in 200 ms and
 *   eleven spread over a minute are the same picture there; here the axis is
 *   wall time and the budget is a line across it.
 * - *Where in the tree* did a commit's time go? A card names the components
 *   with the most self time, which is the right cut for a fix and loses the
 *   nesting: it cannot show that forty cheap components sit under one provider,
 *   which is the difference between memoizing one boundary and rewriting forty
 *   components.
 *
 * Why this is stored on the record rather than re-derived: the measured engine
 * never writes the upload to disk — it parses the export in the request and
 * drops it — so there is nothing to re-read later. The trees are kept small
 * enough to store whole; see `MAX_EXPLORE_NODES`.
 *
 * Nothing here is inferred. Every figure is read or summed from the export.
 */

import { classifyReactComponent, type ReactComponentClass } from "./react-cards.ts";
import type { ReactCardSet } from "./react-cards.ts";
import type { ReactFiber, ReactRecording, ReactRenderCause, ReactRenderedFiber } from "./react-commit-tree.ts";

/**
 * Rendered fibers kept across the whole recording.
 *
 * A commit's tree is small: the two checked-in samples carry 336 and 368
 * rendered fibers in total across every commit, which is 25 KB of JSON once the
 * per-fiber ancestor names are dropped in favour of the nesting. So the normal
 * case stores every commit's tree whole, and this cap exists only so a
 * pathological recording — a thousand commits of three hundred fibers — cannot
 * put thirty megabytes in a saved analysis. Commits past it keep their place on
 * the strip, with their tree dropped and said to be dropped; a strip missing
 * commits would misreport the recording, a commit missing its tree only refuses
 * to drill down.
 */
const MAX_EXPLORE_NODES = 60_000;

/** Commits kept on the strip. Past this the recording is not a view a reader scrubs. */
const MAX_STRIP_COMMITS = 5_000;

const round1 = (value: number) => Math.round(value * 10) / 10;
const round2 = (value: number) => Math.round(value * 100) / 100;

/** One rendered fiber, nested under the nearest fiber above it that also rendered. */
export interface ReactExploreNode {
  /** The fiber id, unique within a root and stable across the recording. */
  id: number;
  name: string;
  componentClass: ReactComponentClass;
  /** Time in this component alone. The partition; what the icicle colours by. */
  selfMs: number;
  /**
   * This component and everything it rendered, as React measured it.
   *
   * Not necessarily the sum of this node's self time and its children's: React
   * records an actual duration per fiber, and a subtree that bailed out
   * contributes its base duration to an ancestor without appearing here. The
   * drawn width is `max(actualMs, selfMs + children)` for that reason, and the
   * figure quoted in the tooltip is this one.
   */
  actualMs: number;
  cause: ReactRenderCause;
  changedProps: string[];
  changedHooks: string[];
  compiledWithForget: boolean;
  sourceHint: string | null;
  children: ReactExploreNode[];
}

/** One commit: its place on the clock, and the tree it rendered. */
export interface ReactExploreCommit {
  rootId: number;
  commitIndex: number;
  /** The card this commit produced, where it produced one. */
  cardId: string | null;
  /** Offset into the recording, as React timestamped it. */
  startMs: number;
  durationMs: number;
  effectDurationMs: number;
  passiveEffectDurationMs: number;
  priority: string | null;
  updaters: string[];
  renderedCount: number;
  summedSelfMs: number;
  /** Render time that reached no component: the reconciler walking the tree. */
  unattributedMs: number;
  overBudget: boolean;
  /** Whether this commit recorded why its components rendered. */
  causesRecorded: boolean;
  /** The heaviest component by self time, for the strip's tooltip. */
  topComponent: string | null;
  topComponentSelfMs: number;
  /** Roots of the rendered forest. Empty when the tree was dropped; see `treeDropped`. */
  tree: ReactExploreNode[];
  treeDropped: boolean;
}

export interface ReactExplore {
  budgetMs: number;
  roots: { rootId: number; rootName: string | null }[];
  /** Every commit, in recorded order, including the ones well under budget. */
  commits: ReactExploreCommit[];
  /**
   * First commit start to last commit end. Reported as the length of the
   * recording, and never the length of the interaction: React timestamps
   * commits and nothing between them, so the idle time inside this span is
   * counted here without being attributable to anything.
   */
  spanMs: number;
  commitsOverBudget: number;
  causesRecorded: boolean;
  /** Commits past `MAX_STRIP_COMMITS`, which the chart does not draw. */
  omittedCommitCount: number;
}

/**
 * The nearest fiber above `fiber` that rendered in this commit.
 *
 * Rendering is top-down, so a rendered fiber's parent has usually rendered too
 * and this is one hop. It is not always: the fiber an update started at has
 * ancestors that did not render, and a Suspense or Activity boundary can leave
 * a gap in the middle. Walking the full fiber index rather than the rendered
 * set is what keeps those cases nested correctly instead of flattening a whole
 * subtree onto the top row.
 */
function nearestRenderedAncestor(
  fiber: ReactRenderedFiber,
  rendered: Set<number>,
  fibers: ReadonlyMap<number, ReactFiber>,
): number | null {
  const seen = new Set<number>([fiber.id]);
  let current = fiber.parentId;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (rendered.has(current)) return current;
    current = fibers.get(current)?.parentId ?? 0;
  }
  return null;
}

function exploreNode(fiber: ReactRenderedFiber): ReactExploreNode {
  return {
    id: fiber.id,
    name: fiber.displayName,
    componentClass: classifyReactComponent(fiber),
    // Two decimals, not one: the median self time in a cascade is 0.03 ms, and
    // rounded to tenths every component in it becomes a zero.
    selfMs: round2(fiber.selfMs),
    actualMs: round2(fiber.actualMs),
    cause: fiber.cause,
    changedProps: fiber.changedProps,
    changedHooks: fiber.changedHooks,
    compiledWithForget: fiber.compiledWithForget,
    sourceHint: fiber.sourceHint,
    children: [],
  };
}

/**
 * One commit's rendered fibers, nested.
 *
 * Children are ordered by inclusive time rather than by position in the tree.
 * Sibling order in a React tree is render order, which the export does carry —
 * but an icicle is read left to right as "where did the time go", and on a list
 * of two hundred rows document order puts the one row that matters wherever it
 * happens to sit.
 */
function buildTree(fibers: ReactRenderedFiber[], fiberIndex: ReadonlyMap<number, ReactFiber>): ReactExploreNode[] {
  const rendered = new Set(fibers.map((fiber) => fiber.id));
  const nodes = new Map<number, ReactExploreNode>();
  for (const fiber of fibers) nodes.set(fiber.id, exploreNode(fiber));

  const roots: ReactExploreNode[] = [];
  for (const fiber of fibers) {
    const node = nodes.get(fiber.id)!;
    const parent = nearestRenderedAncestor(fiber, rendered, fiberIndex);
    const parentNode = parent === null ? undefined : nodes.get(parent);
    if (parentNode) parentNode.children.push(node); else roots.push(node);
  }

  const sortDeep = (list: ReactExploreNode[]) => {
    list.sort((a, b) => b.actualMs - a.actualMs || b.selfMs - a.selfMs || a.id - b.id);
    for (const node of list) sortDeep(node.children);
  };
  sortDeep(roots);
  return roots;
}

export function buildReactExplore(recordings: ReactRecording[], cards: ReactCardSet): ReactExplore {
  const cardIds = new Set(cards.cards.map((card) => card.id));
  const budgetMs = cards.budgetMs;
  const all = recordings.flatMap((recording) =>
    recording.commits.map((commit) => ({ commit, fiberIndex: recording.fiberIndex })),
  );
  // Recorded order, across roots: the strip is a clock, and a recording with an
  // app root and a dev-overlay root interleaves on it.
  all.sort((a, b) => a.commit.timestampMs - b.commit.timestampMs
    || a.commit.rootId - b.commit.rootId || a.commit.commitIndex - b.commit.commitIndex);
  const kept = all.slice(0, MAX_STRIP_COMMITS);

  let budget = MAX_EXPLORE_NODES;
  const commits: ReactExploreCommit[] = kept.map(({ commit, fiberIndex }) => {
    const id = `react-commit-${commit.rootId}-${commit.commitIndex}`;
    const affordable = commit.fibers.length <= budget;
    if (affordable) budget -= commit.fibers.length;
    const top = commit.fibers[0] ?? null;
    return {
      rootId: commit.rootId,
      commitIndex: commit.commitIndex,
      cardId: cardIds.has(id) ? id : null,
      startMs: round1(commit.timestampMs),
      durationMs: round2(commit.durationMs),
      effectDurationMs: round2(commit.effectDurationMs),
      passiveEffectDurationMs: round2(commit.passiveEffectDurationMs),
      priority: commit.priority,
      updaters: commit.updaters,
      renderedCount: commit.fibers.length,
      summedSelfMs: round2(commit.summedSelfMs),
      unattributedMs: round2(Math.max(0, commit.durationMs - commit.summedSelfMs)),
      overBudget: commit.durationMs > budgetMs,
      causesRecorded: commit.causesRecorded,
      topComponent: top ? top.displayName : null,
      topComponentSelfMs: top ? round2(top.selfMs) : 0,
      tree: affordable ? buildTree(commit.fibers, fiberIndex) : [],
      treeDropped: !affordable,
    };
  });

  const spanEnd = commits.reduce((end, commit) => Math.max(end, commit.startMs + commit.durationMs), 0);
  const spanStart = commits.reduce((start, commit) => Math.min(start, commit.startMs), spanEnd);
  return {
    budgetMs,
    roots: recordings.map((recording) => ({ rootId: recording.rootId, rootName: recording.rootName })),
    commits,
    spanMs: round1(Math.max(0, spanEnd - spanStart)),
    commitsOverBudget: commits.filter((commit) => commit.overBudget).length,
    causesRecorded: cards.causesRecorded,
    omittedCommitCount: all.length - kept.length,
  };
}

/**
 * Own time at which a component is doing something rather than passing through.
 *
 * React records self durations to a hundredth of a millisecond, and the median
 * in a 280-component commit is 0.04. A component below this floor did not
 * compute anything a reader can act on; what it did was render its child.
 */
const COLLAPSE_SELF_MS = 0.1;

/**
 * The same tree with the pass-through components collapsed away.
 *
 * This is not cosmetic. The 275.7 ms commit in `react-profile-1.json` nests 110
 * deep, and the rows an icicle can actually show are `LocaleDirContext.Provider`,
 * `UnhandledLinkingContext.Provider`, `LinkingContext.Provider`, `ThemeProvider`,
 * `NavigationContent` and twenty more like them — each with a hundredth of a
 * millisecond of its own and the entire commit as its width.
 *
 * The cut is deliberately not by kind. A first attempt kept `app` and `library`
 * components and dropped React's own wrappers, which collapsed almost nothing:
 * most of those rows are the app's and the navigator's own providers. What
 * makes a row worth drawing is not who wrote the component but whether it
 * answers anything — so a node survives when it burned time of its own, or
 * when it is a branch point where the time below it divides. A component with
 * neither rendered one child and charged nothing for it, and says nothing its
 * child does not say better.
 *
 * Dropping a node lifts its children into its place and charges its own time to
 * the nearest component still shown above it, so a parent's own time accounts
 * for every millisecond that did not reach a component drawn below it. The
 * unfiltered tree is one toggle away, because when the question is which
 * provider re-rendered the subtree, the provider is the answer.
 */
export function focusedReactTree(
  nodes: readonly ReactExploreNode[],
): { nodes: ReactExploreNode[]; strippedMs: number } {
  const out: ReactExploreNode[] = [];
  let strippedMs = 0;
  for (const node of nodes) {
    const below = focusedReactTree(node.children);
    if (node.selfMs >= COLLAPSE_SELF_MS || below.nodes.length > 1) {
      out.push({ ...node, selfMs: round2(node.selfMs + below.strippedMs), children: below.nodes });
      continue;
    }
    strippedMs += node.selfMs + below.strippedMs;
    out.push(...below.nodes);
  }
  // Hoisted children arrive among the siblings they are joining, and every
  // other ranking in this tool is heaviest first.
  out.sort((a, b) => b.actualMs - a.actualMs || b.selfMs - a.selfMs || a.id - b.id);
  return { nodes: out, strippedMs };
}
