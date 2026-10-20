"use client";

import { useMemo, useState } from "react";
import { EmptyState, Text } from "@rozenite/ui";

import { ChartNotes } from "./chart-notes.tsx";
import { TreeModeToggle, type TreeMode } from "./flame-legend.tsx";
import { RowLocation, TaskTreeRow } from "./tree-rows.tsx";
import { pickedClass, pickNumber, picking, PickTick, type FrameSelection } from "./frame-selection.tsx";
import { formatMs } from "../lib/format.ts";
import type { FrameLocations } from "../lib/frame-location.ts";
import { focusedTree, type TaskCulprit, type TaskTreeNode } from "../lib/task-cards.ts";
import { isShownFrame, SHOWN_CLASSES } from "../lib/task-timeline.ts";
import type { FrameClass } from "../lib/frame-classes.ts";

/**
 * The classes the focused views keep, as the set `isShownFrame` tests against.
 * `SHOWN_CLASSES` is the list and this is the lookup; the cut itself lives in
 * `task-timeline.ts` so the chart, the tree and the culprit table share it.
 */
const DRAWN_CLASSES = new Set<FrameClass>(SHOWN_CLASSES);

/**
 * The focused subtree, either as it was recorded or with the framework and the
 * engine collapsed away.
 *
 * Both are worth having. The full tree is the only view that can answer how a
 * frame was reached when the answer runs through the reconciler, and it is the
 * one to hold against a debugger. It is also, on a React profile, mostly rows
 * nobody can act on: a reader opening a task to find their own code scrolls
 * past `performWorkOnRoot`, `beginWork` and ten more frames before the first
 * name they recognise. The focused tree is the timeline's cut applied to the
 * rows — same frames kept, same frames dropped — so the two views line up.
 *
 * Full stays the default: this tab is the one view that still holds everything
 * the profiler recorded, and a reader who wanted the collapsed picture has had
 * it on the Timeline tab since arriving.
 */
export function TaskCallTree({ focus, taskMs, onFocus, locations, selection }: { focus: TaskTreeNode; taskMs: number; onFocus: (id: string) => void; locations: FrameLocations; selection?: FrameSelection }) {
  const [mode, setMode] = useState<TreeMode>("full");
  const tree = useMemo(() => (mode === "focused" ? focusedTree(focus) : focus), [mode, focus]);

  return (
    <>
      <TreeModeToggle label="tree" mode={mode} onChange={setMode} />
      <ul className="explore-tree">
        {/* Keyed by mode so the two trees do not share open/closed state: a row
            open at depth 4 in one is a different frame at that depth in the other. */}
        <TaskTreeRow key={mode} node={tree} taskMs={taskMs} depth={0} onFocus={onFocus} locations={locations} {...(selection ? { selection } : {})} />
      </ul>
      {mode === "focused" ? (
        <ChartNotes
          caveats={[
            <>
              <strong>Indent is not stack depth.</strong> React and engine frames are collapsed away, the same cut the
              Timeline draws by, so a row&rsquo;s indent is its depth here.
            </>,
            <>
              The time a dropped frame burned in its own body is charged to the nearest frame above it that was kept,
              which is why a row can read more self time here than on the full tree.
            </>,
          ]}
        />
      ) : null}
    </>
  );
}

/**
 * Every frame that burned time in this task, with the framework and the engine
 * either listed or cut away.
 *
 * The same toggle as the flame graph and the call tree, and the same cut behind
 * it, so a frame that is gone from one focused view is gone from all three. It
 * earns its place here for a different reason, though. The tree's problem is
 * depth — a product frame twelve rows under the reconciler. A ranked table has
 * no depth to scroll past, so the framework arrives interleaved instead: on a
 * React profile `batchedUpdatesImpl`, `batchedUpdates$1` and `dispatchEvent`
 * each hold the task's whole inclusive time at 0 ms of their own, and they sit
 * in the middle of the rows that name something to go and change.
 *
 * Nothing is recomputed under the filter, which is the part that differs from
 * the focused tree. A culprit's self time is measured over the whole task and
 * does not depend on which other rows are listed, so hiding a row leaves every
 * remaining figure exactly as it was. A dropped frame's time is not charged
 * onward either: it was never this table's to charge, since each row already
 * reports only what that frame burned in its own body.
 *
 * `Everything` is the default: this table is the measured partition of the
 * task — self time over every row sums to its duration — and a reader who
 * opened the Culprits tab asked what the task did, not what of it is theirs.
 */
export function TaskCulpritTable({ culprits, onFocus, locations, selection }: { culprits: readonly TaskCulprit[]; onFocus: (id: string) => void; locations: FrameLocations; selection?: FrameSelection }) {
  const [mode, setMode] = useState<TreeMode>("full");
  const rows = useMemo(
    () => (mode === "focused" ? culprits.filter((culprit) => isShownFrame(culprit.name, culprit.frameClass, DRAWN_CLASSES)) : culprits),
    [mode, culprits],
  );
  const hidden = culprits.length - rows.length;
  const pickingNow = picking(selection);

  if (culprits.length === 0) {
    return <EmptyState title="No culprit stands out" description="This task's time is spread too thinly for any single frame to account for it." />;
  }

  return (
    <>
      <TreeModeToggle label="rows" mode={mode} onChange={setMode} />
      {rows.length > 0 ? (
        <table className="explore-table">
          <thead>
            <tr>
              <th scope="col">Function</th>
              <th scope="col">Self</th>
              <th scope="col">Total</th>
              <th scope="col">Calls</th>
              <th scope="col">Longest call</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((culprit) => {
              const picked = pickedClass(selection, culprit.nodeId);
              return (
                <tr
                  key={culprit.nodeId}
                  className={pickingNow ? `${picked ? "is-picked " : ""}explore-pickable-row` : undefined}
                  onClick={() => { if (pickingNow) selection?.onToggleSelection(culprit.nodeId); }}
                >
                  <th scope="row">
                    {/* The cell lays its contents out as a column to stack the
                        source line under the name, so the name and its pick
                        number need a row of their own — left inline, the pill
                        becomes a full-width flex item and reads as a bar with a
                        digit on it. */}
                    <span className="explore-culprit-name">
                      {/* The name is still a button so the keyboard reaches it in
                          both modes; only what it does changes. */}
                      <button type="button" className="explore-tree-focus" aria-pressed={pickingNow ? pickNumber(selection, culprit.nodeId) !== undefined : undefined}
                        onClick={(event) => {
                          if (!pickingNow) return onFocus(culprit.nodeId);
                          event.stopPropagation();
                          selection?.onToggleSelection(culprit.nodeId);
                        }}>
                        {culprit.name}
                      </button>
                      <PickTick selection={selection} nodeId={culprit.nodeId} />
                    </span>
                    <RowLocation name={culprit.name} location={culprit.location} locations={locations} />
                  </th>
                  <td>{formatMs(culprit.selfMs)}</td>
                  <td>{formatMs(culprit.totalMs)}</td>
                  <td>{culprit.invocations}</td>
                  <td>{formatMs(culprit.longestCallMs)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <EmptyState
          title="None of these frames are yours"
          description="Every frame that burned time in this task is React's or the engine's. Switch to Everything to see them."
        />
      )}
      {mode === "focused" && hidden > 0 ? (
        <Text className="explore-caveat">
          {hidden === 1 ? "One React or engine frame is" : `${hidden} React and engine frames are`} hidden, the same cut
          the Timeline draws by. Every figure above is unchanged: a culprit&rsquo;s self time is measured over the whole
          task, so hiding a row neither moves time onto another row nor takes it off this one.
        </Text>
      ) : null}
    </>
  );
}
