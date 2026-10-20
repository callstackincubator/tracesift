"use client";

import { useMemo, useState } from "react";
import type { FlameGraphNode } from "@rozenite/ui";

import { ChartNotes, STRETCH_ZOOM_NOTE, ZOOM_HINT } from "./chart-notes.tsx";
import { DEFAULT_MIN_FRAME_WIDTH, DEFAULT_MIN_LABEL_WIDTH, FlameLegend, TreeModeToggle, type TreeMode } from "./flame-legend.tsx";
import { useStretchZoom, ZoomControls } from "./stretch-zoom.tsx";
import { FlameGraph } from "../flame-graph/flame-graph.tsx";
import { isPickableName, picking, type FrameSelection } from "./frame-selection.tsx";
import { formatMs } from "../lib/format.ts";
import type { CardChildNode } from "../lib/profile-cards.ts";
import { focusedTree, type TaskTreeNode } from "../lib/task-cards.ts";

/** What makes two rows of the tree the same function: what it is called, and where it is. */
const frameIdentity = (node: TaskTreeNode) => `${node.name}\u0000${node.location ?? ""}`;

/** Every node of a tree, in whatever order the walk reaches them. */
function nodesOf(root: TaskTreeNode): TaskTreeNode[] {
  const found: TaskTreeNode[] = [];
  const pending: TaskTreeNode[] = [root];
  while (pending.length > 0) {
    const here = pending.pop()!;
    found.push(here);
    for (const child of here.children) pending.push(child);
  }
  return found;
}

/**
 * Every box of a flame graph that draws one of the reader's picks, and which pick
 * each shows.
 *
 * The tree merges a function's call sites, which is what makes it answer "what
 * cost the most" and what makes it disagree with the timeline about how many
 * boxes one frame has: a function that ran eight times is eight boxes against the
 * clock and one node here. A reader who rings that frame on the chart, counts
 * eight, and finds one box in the graph reasonably wonders whether the pick took,
 * so the ring follows the frame rather than the node — every box drawing this
 * function carries the same ring and the same number, however many paths the
 * recorder reached it by.
 *
 * A box the tree holds under its own picked id keeps that id's number, so the two
 * copies of a function picked at two call sites stay numbered as the two picks
 * they are. The copies nobody clicked take the lowest-numbered pick of that
 * function: a box has one number to print and the first one is the pick it came from.
 *
 * `ownerOf` is the other half of the bargain. A box ringed because it draws a
 * picked function rather than because it *is* the picked node has an id nobody
 * chose, so clicking it has to un-pick the frame it shows rather than add a second
 * pick of the same function — the second click has to undo the first wherever the
 * reader made it.
 *
 * `pickedFrom` is the whole task's tree rather than the subtree being drawn, so a
 * frame picked while looking at another view still lends its identity to a copy
 * inside the subtree this graph is rooted at. Both are walked because a pick's
 * identity is only known from the node that holds it, and the copies that borrow it
 * can be anywhere: two walks over a tree this size, on a view that is already
 * laying out its boxes, and cheaper than assuming the two trees share a shape.
 */
export function pickedFlamePicks(pickedFrom: TaskTreeNode, drawn: TaskTreeNode, selection: FrameSelection | undefined): {
  labels: Record<string, string> | undefined;
  ownerOf: (nodeId: string) => string;
} {
  const selected = selection?.selectedNodeIds ?? [];
  if (selected.length === 0) return { labels: undefined, ownerOf: id => id };

  // The pick each picked frame's identity is, lowest number first: two copies of a
  // function the reader picked twice are two picks, and each box is one of them.
  const own = new Map(selected.map((id, at) => [id, { pickedId: id, at }]));
  const borrowed = new Map<string, { pickedId: string; at: number }>();
  for (const node of nodesOf(pickedFrom)) {
    const pick = own.get(node.id);
    if (pick === undefined || !isPickableName(node.name)) continue;
    const identity = frameIdentity(node);
    const held = borrowed.get(identity);
    if (held === undefined || pick.at < held.at) borrowed.set(identity, pick);
  }

  const labels: Record<string, string> = {};
  const owners = new Map<string, string>();
  for (const here of nodesOf(drawn)) {
    const pick = own.get(here.id)
      ?? (isPickableName(here.name) ? borrowed.get(frameIdentity(here)) : undefined);
    if (pick === undefined) continue;
    labels[here.id] = String(pick.at + 1);
    owners.set(here.id, pick.pickedId);
  }
  return {
    labels: Object.keys(labels).length > 0 ? labels : undefined,
    ownerOf: id => owners.get(id) ?? id,
  };
}

/** The captured subtree, in the shape the flame graph reads. */
export function toFlameNode(name: string, totalMs: number, selfMs: number, children: CardChildNode[], path: string): FlameGraphNode {
  return {
    id: path,
    name,
    value: totalMs,
    selfValue: selfMs,
    tooltip: `${name} — ${formatMs(totalMs)} total, ${formatMs(selfMs)} self`,
    children: children.map((child, index) =>
      toFlameNode(child.name, child.totalMs, child.selfMs, child.children, `${path}.${index}`)
    ),
  };
}

export function taskFlameNode(node: TaskTreeNode): FlameGraphNode {
  return {
    id: node.id,
    name: node.name,
    value: node.totalMs,
    selfValue: node.selfMs,
    // The class is on the tooltip because the graph colours by heat and cannot
    // carry it in the fill. It matters most for an engine built-in: Hermes
    // writes `[Native] intlDateTimeFormatFormat`, V8 writes `toLocaleString`,
    // and the second gives a reader nothing to say the cost is in the engine.
    tooltip: `${node.name}${node.frameClass === "app" ? "" : ` [${node.frameClass}]`} — ${formatMs(node.totalMs)} total, ${formatMs(node.selfMs)} self`,
    children: node.children.map(taskFlameNode),
  };
}

/**
 * The focused subtree as a flame graph, with the framework and the engine
 * either drawn or collapsed away.
 *
 * Collapsed is the default here, unlike the call tree. A flame graph is read by
 * eye rather than row by row, and on a React profile the recorded stack spends
 * its first dozen rows on `performWorkOnRoot`, `beginWork` and
 * `commitPassiveMountOnFiber` — boxes that carry the full width of the task and
 * name nothing a reader can change. Collapsing them puts the product frames at
 * the top of the graph where the eye lands. `Everything` is one click away for
 * the times the reconciler is the thing being read.
 */
export function TaskFlameGraph({ focus, taskTree, selection }: { focus: TaskTreeNode; taskTree: TaskTreeNode; selection?: FrameSelection }) {
  const [mode, setMode] = useState<TreeMode>("focused");
  const source = useMemo(() => (mode === "focused" ? focusedTree(focus) : focus), [mode, focus]);
  const flame = useMemo(() => taskFlameNode(source), [source]);
  const [drill, setDrill] = useState<{ key: string; name: string } | null>(null);
  const { zoom, viewport, canvas, readout, jumpTo, scrollToStart } = useStretchZoom();
  const pickingNow = picking(selection);
  // Which pick each box of the graph being drawn shows, and which pick a click on
  // it is the second click on. See `pickedFlamePicks` for why one pick of a
  // function is several boxes here.
  const picks = useMemo(() => pickedFlamePicks(taskTree, source, selection), [taskTree, source, selection]);

  // Both the mode toggle and a new focus change which frames exist, so a key
  // taken from the old graph names nothing in the new one and would silently
  // drop the view back to the root. Reset during render rather than in an
  // effect: a frame of the new graph drilled into a stale key would flash.
  const graphKey = `${mode}:${focus.id}`;
  const [drawnKey, setDrawnKey] = useState(graphKey);
  if (drawnKey !== graphKey) {
    setDrawnKey(graphKey);
    setDrill(null);
  }

  return (
    <>
      <div className="flame-controls">
        <TreeModeToggle label="frames" mode={mode} onChange={setMode} />
        <div className="timeline-controls">
          <ZoomControls zoom={zoom} jumpTo={jumpTo} readout={readout} />
        </div>
      </div>

      <FlameLegend what="a frame's own time" />

      {drill ? (
        <p className="explore-path">
          <span className="explore-path-label">zoomed into</span>
          <span className="explore-path-frame">{drill.name}</span>
          <button type="button" className="explore-tree-focus" onClick={() => setDrill(null)}>Show the whole subtree</button>
        </p>
      ) : null}

      <div className="flame-viewport" ref={viewport}>
        <div className="flame-scale" ref={canvas} style={{ width: `${zoom * 100}%` }}>
          {/* Keyed by mode so the graph remounts rather than animating one tree's
              boxes into the other's, which share neither ids nor widths. */}
          <FlameGraph
            key={graphKey}
            className="overflow-visible"
            data={flame}
            formatValue={formatMs}
            rowHeight={24}
            focusedKey={drill?.key}
            onFocusedKeyChange={(key, node) => {
              setDrill(key && node ? { key, name: node.name } : null);
              // The subtree clicked into is re-laid out across the whole
              // canvas, so wherever the view was scrolled to names nothing any
              // more. Its start is the one place worth being.
              scrollToStart();
            }}
            // A picked frame is drawn with the same ring it carries on the other
            // three views, numbered with the same figure, on every box that draws
            // it. While the reader is picking, a click is the pick and nothing
            // else: zooming into the frame they just chose would move the very
            // boxes they are working their way through.
            {...(picks.labels ? { selectedLabels: picks.labels } : {})}
            {...(pickingNow ? {
              selectOnly: true,
              // The graph draws the focused frame as its top box, which at the
              // top of a task is the synthetic root the timeline never shows.
              // A box that only carries someone else's ring toggles the pick it
              // shows rather than adding one the reader never made.
              onSelect: (key: string, node: FlameGraphNode) => {
                if (isPickableName(node.name)) selection?.onToggleSelection(picks.ownerOf(key));
              },
            } : {})}
            // The library hides frames narrower than a share of its own box,
            // and draws one narrower than another share without its name. That
            // box is now `zoom` times wider than what the reader sees, so the
            // unscaled floors would keep hiding exactly the frames, and the
            // names, that zooming in exists to reveal.
            minFrameWidth={DEFAULT_MIN_FRAME_WIDTH / zoom}
            minLabelWidth={DEFAULT_MIN_LABEL_WIDTH / zoom}
          />
        </div>
      </div>

      <ChartNotes
        controls={pickingNow
          ? `Click a frame to add it to your selection, or click it again to take it out \u00B7 ${ZOOM_HINT}`
          : `Click a frame to zoom into its subtree \u00B7 Esc to go back \u00B7 ${ZOOM_HINT}`}
        caveats={[
          STRETCH_ZOOM_NOTE,
          mode === "focused" ? (
            <>
              <strong>Rows are not stack depth.</strong> React and engine frames are collapsed away, the same cut the
              Timeline draws by, so a box&rsquo;s row is its depth here.
            </>
          ) : null,
          mode === "focused"
            ? "The time a dropped frame burned in its own body is charged to the nearest frame above it that was kept."
            : null,
        ]}
      />
    </>
  );
}
