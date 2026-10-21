"use client";

import { useMemo, useState } from "react";
import type { FlameGraphNode } from "@rozenite/ui";
import { EmptyState } from "@rozenite/ui";

import { ChartNotes, ZOOM_HINT } from "./chart-notes.tsx";
import { pickedClass, pickNumber, picking, PickTick, reactNodeKey, reactNodeKeyParts, type FrameSelection } from "./frame-selection.tsx";
import { FlameLegend, TreeModeToggle, type TreeMode } from "./flame-legend.tsx";
import { FlameGraph } from "../flame-graph/flame-graph.tsx";
import { formatMs } from "../lib/format.ts";
import { shortLocationLabel } from "../lib/source-location.ts";
import { hookLabel, type ReactRenderCause } from "../lib/react-commit-tree.ts";
import { isOwnComponent } from "../lib/react-cards.ts";
import { focusedReactTree, type ReactExplore, type ReactExploreCommit, type ReactExploreNode } from "../lib/react-explore.ts";

/**
 * A React duration, to the precision React recorded it at.
 *
 * `formatMs` rounds to whole milliseconds, which is right for a CPU task
 * measured in seconds and wrong for a frame budget of 16: the median self time
 * in a cascade is 0.03 ms, and every row of it would read `0 ms`.
 */
export function reactMs(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 ms";
  if (value < 1) return `${Number(value.toFixed(2))} ms`;
  if (value < 1000) return `${Number(value.toFixed(1))} ms`;
  return formatMs(value);
}

/** Why React rendered a component, in the words a reader acts on. */
export const CAUSE_TEXT: Record<ReactRenderCause, string> = {
  "first-mount": "first mount",
  state: "state changed",
  hooks: "a hook changed",
  props: "props changed",
  context: "context changed",
  "nothing-changed": "nothing changed",
  unknown: "render reason not recorded",
};

export function causeDetail(node: ReactExploreNode): string {
  const named = [...node.changedProps, ...node.changedHooks.map(hookLabel)].slice(0, 4);
  const base = CAUSE_TEXT[node.cause];
  return named.length > 0 ? `${base}: ${named.join(", ")}` : base;
}

/**
 * How many rows deep the tree runs.
 *
 * The note under the render tree used to quote the checked-in fixture — "nests
 * 110 deep and reads at 26" — at a reader looking at their own recording. The
 * point it was making is a good one and it is cheap to make truthfully, so the
 * figures are measured from the open commit instead.
 */
export function reactTreeDepth(nodes: ReactExploreNode[]): number {
  let deepest = 0;
  for (const node of nodes) deepest = Math.max(deepest, 1 + reactTreeDepth(node.children));
  return deepest;
}

/**
 * The commit's tree as an icicle, sized by inclusive time and coloured by self
 * time.
 *
 * Both halves matter and they are different questions. Width is where the time
 * went — a provider 400 ms wide with 0.1 ms of its own is still the thing that
 * rendered 400 ms of children. Heat is who burned it, which is the only figure
 * a fix attaches to.
 *
 * The drawn width is `max(actualMs, self + children)`. React records an actual
 * duration per fiber and the two are not guaranteed to agree — a bailed-out
 * subtree contributes its base duration to an ancestor without appearing in
 * this commit at all — and a parent drawn narrower than the children inside it
 * is not a chart. The recorded figure is the one the tooltip quotes.
 */
export function reactFlameNode(node: ReactExploreNode, path: string): FlameGraphNode {
  const children = node.children.map((child, index) => reactFlameNode(child, `${path}.${index}`));
  const inside = children.reduce((total, child) => total + child.value, 0);
  const cause = `${causeDetail(node)}${node.compiledWithForget ? " · React Compiler" : ""}`;
  return {
    id: `${path}:${node.id}`,
    name: node.name,
    value: Math.max(node.actualMs, node.selfMs + inside),
    selfValue: node.selfMs,
    tooltip: `${node.name}${node.componentClass === "app" ? "" : ` [${node.componentClass}]`}`
      + ` — ${reactMs(node.selfMs)} of its own, ${reactMs(node.actualMs)} including what it rendered`
      + `\n${cause}${node.sourceHint ? `\n${node.sourceHint}` : ""}`,
    children,
  };
}

/**
 * Which box of a commit's icicle draws which of the reader's picks, and which
 * component a click on a box is a pick of.
 *
 * Simpler than the task side's equivalent, and for a reason worth writing down.
 * A task's tree merges a function's call sites, so one pick is several boxes and
 * the ring has to follow the function rather than the node. React's tree merges
 * nothing: a fiber is one box, in one commit, and a component rendered twice is
 * two fibers that are genuinely two renders — each with its own cause, its own
 * changed props and its own time. Ringing both because they share a name would
 * claim a sameness React did not record.
 *
 * Boxes are addressed by `reactFlameNode`'s own id, `<path>:<fiberId>`, so the
 * fiber is read back off the end of it. The commit's synthetic root is skipped
 * by starting at its children: it is the reconciler's own walk rather than
 * anything a reader can go and change, and it carries a fiber id of 0 that names
 * no fiber at all.
 */
export function pickedReactFlame(
  flame: FlameGraphNode,
  commit: { rootId: number; commitIndex: number },
  selection: FrameSelection | undefined,
): { labels: Record<string, string> | undefined; keyOf: (boxId: string) => string | undefined; drawnPicks: number } {
  const at = new Map((selection?.selectedNodeIds ?? []).map((id, index) => [id, index] as const));
  const labels: Record<string, string> = {};
  const keys = new Map<string, string>();
  const walk = (nodes: readonly FlameGraphNode[]) => {
    for (const node of nodes) {
      // `reactFlameNode` names every node, and the graph keys a frame by its id
      // when it has one, so a box's key is the id read here. A node without one
      // is not something this file built, and it carries no fiber to pick.
      const boxId = node.id;
      if (boxId !== undefined) {
        const fiberId = Number(boxId.slice(boxId.lastIndexOf(":") + 1));
        if (Number.isInteger(fiberId)) {
          const key = reactNodeKey(commit, fiberId);
          keys.set(boxId, key);
          const pick = at.get(key);
          if (pick !== undefined) labels[boxId] = String(pick + 1);
        }
      }
      walk(node.children ?? []);
    }
  };
  walk(flame.children ?? []);
  const drawnPicks = Object.keys(labels).length;
  return {
    labels: drawnPicks > 0 ? labels : undefined,
    keyOf: (boxId: string) => keys.get(boxId),
    drawnPicks,
  };
}

/** How many of the reader's picks name a component of this commit. */
export function reactPicksInCommit(
  commit: { rootId: number; commitIndex: number },
  selection: FrameSelection | undefined,
): number {
  let found = 0;
  for (const id of selection?.selectedNodeIds ?? []) {
    const parts = reactNodeKeyParts(id);
    if (parts && parts.rootId === commit.rootId && parts.commitIndex === commit.commitIndex) found += 1;
  }
  return found;
}

/** Every rendered fiber of one commit, flattened and ranked by self time. */
export function flattenCommit(commit: ReactExploreCommit): ReactExploreNode[] {
  const out: ReactExploreNode[] = [];
  const walk = (nodes: ReactExploreNode[]) => {
    for (const node of nodes) { out.push(node); walk(node.children); }
  };
  walk(commit.tree);
  return out.sort((a, b) => b.selfMs - a.selfMs || b.actualMs - a.actualMs || a.id - b.id);
}

/** Rows the component table draws before it stops and says how many are left. */
export const MAX_COMPONENT_ROWS = 150;

/**
 * The chart's height, and so the share of it the budget line sits at.
 *
 * A bar is linear in its commit's duration against the tallest commit in the
 * recording, so the budget line lands wherever the arithmetic puts it — low on
 * a recording with one 275 ms commit, which is the honest picture of a
 * recording with one 275 ms commit.
 */
export const STRIP_HEIGHT = 132;

/**
 * The shortest bar drawn for a commit that took measurable time.
 *
 * Height is linear in duration against the tallest commit, and in a recording
 * whose peak is 275 ms a 1.6 ms commit is six tenths of a pixel: invisible. It
 * only ever applies to bars too small to compare by eye anyway, which is why
 * each carries its figure as a label. A commit React measured at zero is drawn
 * at 2px instead, because a floor there would draw time that does not exist.
 */
export const MIN_BAR_HEIGHT = 6;

export function commitKey(commit: { rootId: number; commitIndex: number }): string {
  return `${commit.rootId}.${commit.commitIndex}`;
}

/**
 * Room kept above the tallest bar for its duration label.
 *
 * The label sits above the bar rather than inside it because the interesting
 * bars here are the short ones: a 1.6 ms commit beside a 170 ms one is a few
 * pixels of fill with nowhere to print a figure.
 */
export const BAR_LABEL_PX = 14;

/**
 * How many evenly spaced bars can carry their own label.
 *
 * Even spacing gives every commit the same width, so the labels either fit or
 * they do not: across forty commits a slot is a few pixels and every label
 * would be one clipped digit. Past this count the labels come off and the
 * figure lives in the tooltip; the axis underneath keeps thinning its commit
 * numbers so a reader never loses their place entirely.
 */
export const MAX_LABELLED_BARS = 20;

/** Narrowest evenly spaced bar. Below this a click lands between two commits. */
export const MIN_SLOT_PX = 14;

/**
 * Every commit as its own bar, in commit order.
 *
 * The bars are evenly spaced, as React DevTools' commit chart is, which costs
 * the recording's shape in time: forty commits in 300 ms and forty across a
 * minute draw the same. That is the right trade for a picker. Laying the same
 * bars against the clock puts a 170 ms commit across half the axis and leaves
 * its neighbours as three-pixel stubs, and a chart whose job is to let a reader
 * choose a commit cannot have commits that are hard to click. Every bar is the
 * same width whatever it cost, so each is a target the size of its neighbours,
 * and height alone carries time.
 */
function CommitBars({
  explore,
  selectedKey,
  onSelect,
}: {
  explore: ReactExplore;
  selectedKey: string;
  onSelect: (rootId: number, commitIndex: number) => void;
}) {
  const peakMs = useMemo(
    () => explore.commits.reduce((max, commit) => Math.max(max, commit.durationMs), 0),
    [explore.commits],
  );
  const plotMs = STRIP_HEIGHT - BAR_LABEL_PX;
  const labelled = explore.commits.length <= MAX_LABELLED_BARS;
  // Beyond the labelled count the axis keeps roughly twenty numbers, so a long
  // recording still reads as `#0 … #19 … #38` rather than as anonymous bars.
  const numberEvery = Math.ceil(explore.commits.length / MAX_LABELLED_BARS);
  const budgetTop = peakMs > explore.budgetMs
    ? STRIP_HEIGHT - (explore.budgetMs / peakMs) * plotMs
    : null;

  return (
    <div className="timeline-scroll">
      <div className="commit-bars">
        <div className="commit-bars-plot" style={{ height: `${STRIP_HEIGHT}px` }}>
          {budgetTop !== null ? (
            <div className="commit-strip-budget" style={{ top: `${budgetTop}px` }}>
              <span>{explore.budgetMs} ms</span>
            </div>
          ) : null}
          {explore.commits.map((commit) => {
            const key = commitKey(commit);
            const height = commit.durationMs > 0 && peakMs > 0
              ? Math.max(MIN_BAR_HEIGHT, (commit.durationMs / peakMs) * plotMs)
              : 2;
            return (
              <button
                type="button"
                key={key}
                className="commit-slot"
                style={{ minWidth: `${MIN_SLOT_PX}px` }}
                aria-pressed={key === selectedKey}
                title={commitTooltip(commit)}
                onClick={() => onSelect(commit.rootId, commit.commitIndex)}
              >
                {labelled ? <span className="commit-slot-label">{reactMs(commit.durationMs)}</span> : null}
                <span
                  className={key === selectedKey ? "commit-fill is-selected" : "commit-fill"}
                  data-over={commit.overBudget ? "yes" : "no"}
                  data-carded={commit.cardId ? "yes" : "no"}
                  style={{ height: `${height}px` }}
                />
              </button>
            );
          })}
        </div>
        <div className="commit-bars-axis">
          {explore.commits.map((commit, index) => (
            <span key={commitKey(commit)} style={{ minWidth: `${MIN_SLOT_PX}px` }}>
              {labelled || index % numberEvery === 0 ? `#${commit.commitIndex}` : ""}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/** The hover text both layouts share: the same commit, described the same way. */
export function commitTooltip(commit: ReactExploreCommit): string {
  return `Commit ${commit.commitIndex} · ${reactMs(commit.durationMs)}`
    + ` · ${reactMs(commit.startMs)} into the recording`
    + `\n${commit.renderedCount} component${commit.renderedCount === 1 ? "" : "s"} rendered`
    + (commit.topComponent ? `, ${commit.topComponent} heaviest at ${reactMs(commit.topComponentSelfMs)}` : "")
    + (commit.updaters.length > 0 ? `\nscheduled by ${[...new Set(commit.updaters)].join(", ")}` : "")
    + (commit.cardId ? "\nthis commit produced a card" : "");
}

/**
 * The commit picker, and the frame the bars sit in.
 *
 * Separate from `CommitBars` so the legend and the caveat — which describe the
 * recording rather than the drawing — stay out of the loop that draws bars.
 */
export function CommitChart({
  explore,
  selectedKey,
  onSelect,
}: {
  explore: ReactExplore;
  selectedKey: string;
  onSelect: (rootId: number, commitIndex: number) => void;
}) {
  if (explore.commits.length === 0) {
    return <EmptyState title="No commits" description="This recording contains no React commits to lay out." />;
  }

  return (
    <div className="timeline commit-strip">
      <div className="timeline-controls">
        <span className="timeline-legend">
          {explore.commits.length} commit{explore.commits.length === 1 ? "" : "s"} across {reactMs(explore.spanMs)}
          {" · "}{explore.commitsOverBudget} over the {explore.budgetMs} ms budget
          {explore.omittedCommitCount > 0 ? ` · ${explore.omittedCommitCount} further commits not drawn` : ""}
        </span>
      </div>

      <CommitBars explore={explore} selectedKey={selectedKey} onSelect={onSelect} />

      <ChartNotes
        reading={
          <>
            One bar is one commit, in the order React committed them. Height is the render duration against the
            tallest commit here, red is over the budget, and a ringed bar produced a card on the results page.
          </>
        }
        controls="Click any bar to drill into it below"
        caveats={[
          <>
            <strong>Width is not time.</strong> Every bar is the same width, so each is as easy to hit as its
            neighbours.
          </>,
          <>
            <strong>Spacing is not time.</strong> The bars are in order, but nothing here says whether two commits
            were a frame or a minute apart.
          </>,
          <>
            <strong>Height is not effect time.</strong> A commit that renders in 8 ms and then spends 40 ms in layout
            effects is a short bar here. That figure is in the card&rsquo;s hand-off rather than on this page.
          </>,
        ]}
      />
    </div>
  );
}

/**
 * Every component the commit rendered, ranked by its own time, with React's own
 * wrappers and the platform's own views either listed or filtered out.
 *
 * This is the table the card deliberately does not have. A card shows the rows
 * a reader can act on and hides the three hundred that each cost 0.03 ms;
 * hiding them is right on a card and wrong as a default here, because the whole
 * question behind opening a drill-down is what else was in there. The toggle is
 * for the second look, once that question is answered.
 *
 * The same toggle as the render tree beside it, but not the same cut, and the
 * difference is the point. The tree collapses by what a row *answers* — a
 * component that burned nothing and rendered one child says nothing its child
 * does not — because in a tree a pass-through is depth to scroll past. A
 * ranked table has no depth, so what gets in the way here is the opposite
 * thing: a row with real self time and nowhere to go. `(root)`, a context
 * provider, a host view — measured, interleaved among the rows that name
 * something to change, and not openable. So this filter is by whose code it
 * is, the same cut the cards' culprit rows are chosen by.
 *
 * Nothing is recomputed under the filter. A component's self time is React's
 * own `selfDuration` and does not depend on which other rows are listed, and a
 * dropped row's time is not charged onward to anything — unlike the tree,
 * where a collapsed node's time has to go somewhere because its parent's width
 * still has to account for it. Every figure here reads the same in both modes.
 *
 * `Everything` is the default, as on the task side: this table is the measured
 * partition of the commit, and a reader who opened it asked what React
 * rendered, not what of it is theirs.
 */
export function ReactComponentTable({ commit, selection }: { commit: ReactExploreCommit; selection?: FrameSelection }) {
  const [mode, setMode] = useState<TreeMode>("full");
  const pickingNow = picking(selection);
  const all = useMemo(() => flattenCommit(commit), [commit]);
  const rows = useMemo(() => (mode === "focused" ? all.filter(isOwnComponent) : all), [mode, all]);
  const filtered = all.length - rows.length;
  if (all.length === 0) {
    return (
      <EmptyState
        title="No components in this commit"
        description={commit.treeDropped
          ? "This recording was large enough that the trees were dropped to keep the saved analysis small."
          : "React recorded no per-component durations for this commit."}
      />
    );
  }
  const shown = rows.slice(0, MAX_COMPONENT_ROWS);
  const hidden = rows.length - shown.length;
  return (
    <div className="react-components">
      <TreeModeToggle label="rows" mode={mode} onChange={setMode} />
      {shown.length === 0 ? (
        <EmptyState
          title="None of these components are yours"
          description="Every component this commit rendered is React's own or a platform view with no recorded source. Switch to Everything to see them."
        />
      ) : (
        <table className="react-component-table">
          <thead>
            <tr>
              <th scope="col">Component</th>
              <th scope="col">Own time</th>
              <th scope="col">Of commit</th>
              <th scope="col">With children</th>
              <th scope="col">Why it rendered</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((node) => {
              // A pick names the commit as well as the fiber, so the row a reader
              // ticked here is still ticked after they step through four commits
              // and come back. See `reactNodeKey`.
              const key = reactNodeKey(commit, node.id);
              const picked = pickedClass(selection, key);
              return (
              <tr
                key={node.id}
                data-class={node.componentClass}
                className={pickingNow ? `${picked ? "is-picked " : ""}explore-pickable-row` : undefined}
                onClick={() => { if (pickingNow) selection?.onToggleSelection(key); }}
              >
                <th scope="row">
                  {/* A name is plain text here until there is something to click
                      it for: this table navigates nowhere, so a button that did
                      nothing would be a promise it cannot keep. While picking it
                      becomes one, so the keyboard reaches the row too. It keeps
                      the name's own class either way, which is what greys out a
                      host element or a framework wrapper. */}
                  {pickingNow ? (
                    <button
                      type="button"
                      className="react-component-name explore-tree-focus"
                      aria-pressed={pickNumber(selection, key) !== undefined}
                      onClick={(event) => { event.stopPropagation(); selection?.onToggleSelection(key); }}
                    >
                      {node.name}
                    </button>
                  ) : (
                    <span className="react-component-name">{node.name}</span>
                  )}
                  <PickTick selection={selection} nodeId={key} />
                  {node.sourceHint ? <code title={node.sourceHint}>{shortLocationLabel(node.sourceHint)}</code> : null}
                </th>
                <td>{reactMs(node.selfMs)}</td>
                <td>{commit.durationMs > 0 ? `${((node.selfMs / commit.durationMs) * 100).toFixed(1)}%` : "—"}</td>
                <td>{reactMs(node.actualMs)}</td>
                <td>
                  {causeDetail(node)}
                  {node.compiledWithForget ? <em> · React Compiler</em> : null}
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {shown.length > 0 ? (
        <ChartNotes
          reading={
            <>
              <strong>Own time</strong> is React&rsquo;s <code>selfDuration</code> and is what a fix attaches to.
              <strong> With children</strong> is inclusive, and overlaps every ancestor.
            </>
          }
          caveats={[
            <>
              Own time is a true partition of the render phase: over every component React rendered they add up, and
              the remainder is the reconciler&rsquo;s own walk. <code>With children</code> never sums to anything.
            </>,
            hidden > 0 ? (
              <>
                {hidden} further component{hidden === 1 ? "" : "s"} {mode === "focused" ? "of yours " : ""}rendered in
                this commit, each with less of its own time than the last row above.
              </>
            ) : null,
            mode === "focused" && filtered > 0 ? (
              <>
                {filtered === 1
                  ? "One component that is React\u2019s own, or a platform view with no recorded source, is"
                  : `${filtered} components that are React\u2019s own, or platform views with no recorded source, are`}
                {" "}hidden &mdash; which is why the percentages no longer add up to the commit. Every figure above is
                unchanged: own time is measured per component, so hiding a row neither moves time onto another row nor
                takes it off this one.
              </>
            ) : null,
          ]}
        />
      ) : null}
    </div>
  );
}

/**
 * The commit as an icicle, with React's own wrappers either drawn or collapsed.
 *
 * Collapsed by default, as on the CPU side and for a stronger reason: the
 * 275.7 ms commit in the checked-in fixture nests 110 deep and its visible rows
 * are all context providers. `Everything` is one click away for the times a
 * provider is the finding.
 */
export function ReactRenderTree({ commit, selection }: { commit: ReactExploreCommit; selection?: FrameSelection }) {
  const [mode, setMode] = useState<TreeMode>("focused");
  const pickingNow = picking(selection);
  // Both depths, in both modes: the note compares them, so it needs the one the
  // reader is not looking at as much as the one they are.
  const depth = useMemo(() => ({
    full: reactTreeDepth(commit.tree),
    focused: reactTreeDepth(focusedReactTree(commit.tree).nodes),
  }), [commit.tree]);
  const flame = useMemo(() => {
    if (commit.tree.length === 0) return null;
    const below = mode === "focused" ? focusedReactTree(commit.tree) : { nodes: commit.tree, strippedMs: 0 };
    return reactFlameNode(
      {
        id: 0,
        name: `Commit ${commit.commitIndex}`,
        componentClass: "framework",
        // The reconciler's own walk, plus whatever the collapse charged
        // upwards, so the top bar is the commit's duration and every row below
        // it is a share of that figure rather than of a filtered total.
        selfMs: commit.unattributedMs + below.strippedMs,
        actualMs: commit.durationMs,
        cause: "unknown",
        changedProps: [],
        changedHooks: [],
        compiledWithForget: false,
        sourceHint: null,
        children: below.nodes,
      },
      "commit",
    );
  }, [commit, mode]);

  // Which boxes carry a ring, and which component a click on a box picks. Built
  // from the drawn tree, so a mode toggle that collapses a component away takes
  // its ring with it rather than leaving one on the row that absorbed it.
  const picks = useMemo(() => (flame ? pickedReactFlame(flame, commit, selection) : null), [flame, commit, selection]);
  const hiddenPicks = picks ? reactPicksInCommit(commit, selection) - picks.drawnPicks : 0;

  if (!flame) {
    return (
      <EmptyState
        title="No tree for this commit"
        description={commit.treeDropped
          ? "This recording held more components than the drill-down stores, so this commit's tree was dropped. The strip and the figures above are complete."
          : "React recorded no per-component durations for this commit."}
      />
    );
  }

  return (
    <>
      <TreeModeToggle label="show" mode={mode} onChange={setMode} />
      <FlameLegend what="a component's own render time" />
      {/* Same patched graph as the task side, so the two flame graphs are the
          same component here and in a plugin panel. */}
      {/* A picked component is ringed and numbered the same way it is on the task
          side. While the reader is picking, a click is the pick and nothing else:
          zooming into the component they just chose would move the very boxes
          they are working through. */}
      <FlameGraph
        data={flame}
        formatValue={reactMs}
        rowHeight={24}
        {...(picks?.labels ? { selectedLabels: picks.labels } : {})}
        {...(pickingNow ? {
          selectOnly: true,
          // The commit's own root box is not a fiber and has no key, so a click
          // on it picks nothing rather than picking the reconciler.
          onSelect: (boxId: string) => {
            const key = picks?.keyOf(boxId);
            if (key !== undefined) selection?.onToggleSelection(key);
          },
        } : {})}
      />
      <ChartNotes
        reading={
          <>
            Width is time including everything a component rendered. The colour is its own time alone.
          </>
        }
        controls={pickingNow
          ? "Click a component to add it to your selection, or click it again to take it out"
          : `Click a box to zoom into its subtree \u00B7 Esc to go back \u00B7 ${ZOOM_HINT}`}
        caveats={[
          hiddenPicks > 0 ? (
            <>
              {hiddenPicks === 1 ? "One component you picked is" : `${hiddenPicks} components you picked are`} not drawn
              here{mode === "focused" ? " \u2014 collapsed away as a pass-through, or below a component that was" : ""}.
              {mode === "focused" ? " Switch to Everything to see " : " They are still in your selection, and the Components table lists "}
              {hiddenPicks === 1 ? "it" : "them"}.
            </>
          ) : null,
          <>
            A wide pale box rendered expensive children and cost nothing itself &mdash; memoize it, or move the work
            down. A narrow hot box is the component to go and change.
          </>,
          <>
            <strong>Nesting is by the nearest ancestor that also rendered</strong>, so a component whose parent bailed
            out sits higher here than it does in your source.
          </>,
          mode === "focused" ? (
            <>
              A component that burned no measurable time of its own and rendered exactly one child is collapsed away,
              and whatever it did cost is charged to the nearest component still shown above it. That is most of a
              React tree: this commit nests {depth.full} deep and reads at {depth.focused} once the pass-throughs are
              gone, with nothing dropped that the rows above and below do not already say.
            </>
          ) : (
            <>
              Everything React rendered, at its real depth &mdash; every context provider and wrapper included, which
              in this commit is {depth.full} rows.
            </>
          ),
        ]}
      />
    </>
  );
}
