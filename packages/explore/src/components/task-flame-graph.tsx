"use client";

import { useMemo, useState } from "react";
import type { FlameGraphNode } from "@rozenite/ui";

import { ChartNotes, STRETCH_ZOOM_NOTE, ZOOM_HINT } from "./chart-notes.tsx";
import { DEFAULT_MIN_FRAME_WIDTH, DEFAULT_MIN_LABEL_WIDTH, FlameLegend, TreeModeToggle, type TreeMode } from "./flame-legend.tsx";
import { useStretchZoom, ZoomControls } from "./stretch-zoom.tsx";
import { FlameGraph } from "../flame-graph/flame-graph.tsx";
import { formatMs } from "../lib/format.ts";
import type { CardChildNode } from "../lib/profile-cards.ts";
import { focusedTree, type TaskTreeNode } from "../lib/task-cards.ts";

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
export function TaskFlameGraph({ focus }: { focus: TaskTreeNode }) {
  const [mode, setMode] = useState<TreeMode>("focused");
  const flame = useMemo(() => taskFlameNode(mode === "focused" ? focusedTree(focus) : focus), [mode, focus]);
  const [drill, setDrill] = useState<{ key: string; name: string } | null>(null);
  const { zoom, viewport, canvas, readout, jumpTo, scrollToStart } = useStretchZoom();

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
        controls={`Click a frame to zoom into its subtree \u00B7 Esc to go back \u00B7 ${ZOOM_HINT}`}
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
