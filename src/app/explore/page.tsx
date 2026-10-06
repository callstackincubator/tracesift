"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Button, EmptyState, FlameGraph, PluginHeader, PluginShell, Tabs, Text } from "@rozenite/ui";
import type { FlameGraphNode } from "@rozenite/ui";

import { ThemeGate } from "@/app/theme-gate";
import { useStretchZoom, ZoomControls } from "./stretch-zoom";
import { fetchTaskHandoff, readCardHandoff, type CardHandoff, type TaskHandoff } from "@/lib/card-handoff";
import { formatMs } from "@/lib/format";
import { profileCardLocations, taskCardLocations, type FrameLocations } from "@/lib/frame-location";
import type { CardChildNode, RepeatedFunction } from "@/lib/profile-cards";
import { focusedTree, type TaskTreeNode } from "@/lib/task-cards";
import type { TaskTimeline, TimelineBox } from "@/lib/task-timeline";

/** The captured subtree, in the shape the flame graph reads. */
function toFlameNode(name: string, totalMs: number, selfMs: number, children: CardChildNode[], path: string): FlameGraphNode {
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

function taskFlameNode(node: TaskTreeNode): FlameGraphNode {
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

function callLabel(count: number, exact: boolean): string {
  if (exact) return `${count} call${count === 1 ? "" : "s"}`;
  return `${count} site${count === 1 ? "" : "s"}`;
}

/**
 * The same subtree as the flame graph, but openable row by row: a flame graph
 * answers "where is the time", a tree answers "what called what", and the two
 * questions come up at different moments.
 *
 * A closed row renders no children at all. A collapsed `<details>` still mounts
 * everything inside it, and a real stack runs hundreds of frames deep (936 in
 * the trace fixture), so mounting the whole tree at once nested the DOM deeply
 * enough to overflow the JS stack in React's commit traversal before a single
 * row appeared. Rows now mount as they are opened.
 */
function TreeRow({ node, cardTotalMs, exact, depth, locations }: { node: CardChildNode; cardTotalMs: number; exact: boolean; depth: number; locations: FrameLocations }) {
  const [open, setOpen] = useState(depth === 0);
  const where = locations.shown(node.name, node.location);
  const share = cardTotalMs > 0 ? (node.totalMs / cardTotalMs) * 100 : 0;
  const count = exact ? node.invocations ?? node.callSites : node.callSites;
  const row = (
    <div className="explore-tree-row">
      <span className="explore-tree-name">
        {node.name}
        {node.frameworkInternal ? <span className="explore-tag">framework</span> : null}
        {node.truncated ? <span className="explore-tag">collapsed</span> : null}
      </span>
      <span className="explore-tree-figures">
        <span className="row-figure">{formatMs(node.totalMs)}</span>
        <span className="row-secondary">{formatMs(node.selfMs)} self</span>
        {count > 1 ? <span className="row-share">{callLabel(count, exact)}</span> : null}
      </span>
      <span className="row-bar-track" aria-hidden="true"><span className="row-bar-fill" style={{ width: `${share}%` }} /></span>
      {where ? <code className="explore-tree-location" title={where}>{where}</code> : null}
    </div>
  );

  if (node.children.length === 0) return <li className="explore-tree-leaf" style={{ "--depth": depth } as React.CSSProperties}>{row}</li>;
  return (
    <li style={{ "--depth": depth } as React.CSSProperties}>
      <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>{row}</summary>
        {open ? (
          <ul className="explore-tree">
            {node.children.map((child, index) => (
              <TreeRow key={`${child.name}-${index}`} node={child} cardTotalMs={cardTotalMs} exact={exact} depth={depth + 1} locations={locations} />
            ))}
          </ul>
        ) : null}
      </details>
    </li>
  );
}

/**
 * The task tree's own row. Clicking a name refocuses the view on that frame.
 * Children mount only while the row is open — see `TreeRow` for why.
 */
function TaskTreeRow({ node, taskMs, depth, onFocus, locations }: { node: TaskTreeNode; taskMs: number; depth: number; onFocus: (id: string) => void; locations: FrameLocations }) {
  const [open, setOpen] = useState(depth < 2);
  const where = locations.shown(node.name, node.location);
  const share = taskMs > 0 ? (node.totalMs / taskMs) * 100 : 0;
  const row = (
    <div className="explore-tree-row">
      <span className="explore-tree-name">
        <button type="button" className="explore-tree-focus" onClick={() => onFocus(node.id)}>{node.name}</button>
        {node.frameClass === "app" ? null : <span className="explore-tag">{node.frameClass}</span>}
      </span>
      <span className="explore-tree-figures">
        <span className="row-figure">{formatMs(node.totalMs)}</span>
        <span className="row-secondary">{formatMs(node.selfMs)} self</span>
        {node.invocations > 1 ? <span className="row-share">{node.invocations} calls</span> : null}
      </span>
      <span className="row-bar-track" aria-hidden="true"><span className="row-bar-fill" style={{ width: `${share}%` }} /></span>
      {where ? <code className="explore-tree-location" title={where}>{where}</code> : null}
    </div>
  );

  if (node.children.length === 0) return <li className="explore-tree-leaf" style={{ "--depth": depth } as React.CSSProperties}>{row}</li>;
  return (
    <li style={{ "--depth": depth } as React.CSSProperties}>
      <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>{row}</summary>
        {open ? (
          <ul className="explore-tree">
            {node.children.map((child) => (
              <TaskTreeRow key={child.id} node={child} taskMs={taskMs} depth={depth + 1} onFocus={onFocus} locations={locations} />
            ))}
          </ul>
        ) : null}
      </details>
    </li>
  );
}

/**
 * A frame's position in a table cell, drawn only when it locates the frame.
 * A chunk offset in a `file` column is worse than nothing: it labels a build
 * artefact as a file and invites a reader to go looking for it.
 */
function RowLocation({ name, location, locations }: { name: string; location: string | undefined; locations: FrameLocations }) {
  const where = locations.shown(name, location);
  return where ? <code title={where}>{where}</code> : null;
}

type SortKey = "totalMs" | "selfMs" | "callSites";

/** Every function that ran more than once under this parent, and what it cost across all of them. */
function RepeatedTable({ rows, exact, locations }: { rows: RepeatedFunction[]; exact: boolean; locations: FrameLocations }) {
  const [sortKey, setSortKey] = useState<SortKey>("totalMs");
  const sorted = useMemo(() => [...rows].sort((a, b) => b[sortKey] - a[sortKey]), [rows, sortKey]);

  if (rows.length === 0) {
    return <EmptyState title="Nothing repeated" description="No function ran more than once underneath this parent." />;
  }

  const header = (key: SortKey, label: string) => (
    <th scope="col" aria-sort={sortKey === key ? "descending" : "none"}>
      <button type="button" onClick={() => setSortKey(key)} className={sortKey === key ? "is-sorted" : undefined}>{label}</button>
    </th>
  );

  return (
    <table className="explore-table">
      <thead>
        <tr>
          <th scope="col">Function</th>
          {header("totalMs", "Total")}
          {header("selfMs", "Self")}
          {header("callSites", exact ? "Calls" : "Call sites")}
          <th scope="col">Called from</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((row) => (
          <tr key={`${row.name}-${row.location ?? ""}`}>
            <th scope="row">
              {row.name}
              <RowLocation name={row.name} location={row.location} locations={locations} />
            </th>
            <td>{formatMs(row.totalMs)}</td>
            <td>{formatMs(row.selfMs)}</td>
            <td>{exact ? row.invocations ?? row.callSites : row.callSites}</td>
            <td>
              {row.callers.map((caller) => (
                <span className="explore-caller" key={caller.name}>
                  {caller.name} <em>{callLabel(exact ? caller.invocations ?? caller.callSites : caller.callSites, exact)}, {formatMs(caller.totalMs)}</em>
                </span>
              ))}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}


const ROW_HEIGHT = 22;

/** Round tick spacing: a ruler labelled 322.7 ms apart is a ruler nobody reads. */
function tickStepMs(visibleMs: number): number {
  const rough = visibleMs / 10;
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(rough, 0.001)));
  for (const step of [1, 2, 5, 10]) {
    if (rough <= step * magnitude) return step * magnitude;
  }
  return 10 * magnitude;
}

/**
 * The task against the clock, which is the view a reader arrives with after
 * seeing the block in Chrome's Performance panel.
 *
 * Positions are percentages of the task's duration, so the chart fits its
 * container at zoom 1 with nothing measured, and zooming is one width on the
 * scrolling element. The framework and the engine have been collapsed away
 * upstream, so a frame that really sat twelve deep under the reconciler is
 * drawn on the first row — and the stretches where nothing but framework or
 * engine code was on the stack are left as gaps rather than filled in, because
 * they were not idle and the chart must not imply they were.
 */
function TaskTimelineChart({
  timeline,
  focusId,
  onFocus,
}: {
  timeline: TaskTimeline;
  focusId: string;
  onFocus: (nodeId: string) => void;
}) {
  const { zoom, viewport, canvas, readout, jumpTo } = useStretchZoom();
  const { durationMs } = timeline;

  const ticks = useMemo(() => {
    const step = tickStepMs(durationMs / zoom);
    const out: number[] = [];
    for (let at = 0; at <= durationMs; at += step) out.push(at);
    return out;
  }, [durationMs, zoom]);

  if (timeline.boxes.length === 0) {
    return (
      <EmptyState
        title="Nothing to draw in this task"
        description="Every frame the profiler recorded in this block was React or engine code, so there is nothing left once they are collapsed. The call tree still holds all of it."
      />
    );
  }

  const uncoveredMs = Math.max(0, durationMs - timeline.coveredMs);
  const percent = (value: number) => `${(value / durationMs) * 100}%`;

  return (
    <div className="timeline">
      <div className="timeline-controls">
        <ZoomControls zoom={zoom} jumpTo={jumpTo} readout={readout} />
        <span className="timeline-legend">
          {formatMs(timeline.coveredMs)} of {formatMs(durationMs)} under your code, a dependency or a built-in it
          called
          {uncoveredMs > 0.5 ? ` · ${formatMs(uncoveredMs)} in React or unnamed engine code` : ""}
          {timeline.omittedBoxCount > 0
            ? ` · ${timeline.omittedBoxCount} calls too short to draw`
            : ""}
        </span>
      </div>

      <div className="timeline-scroll" ref={viewport}>
        <div className="timeline-canvas" ref={canvas} style={{ width: `${zoom * 100}%` }}>
          <div className="timeline-ruler">
            {ticks.map((at) => (
              <span key={at} className="timeline-tick" style={{ left: percent(at) }}>
                {formatMs(at)}
              </span>
            ))}
          </div>
          <div className="timeline-rows" style={{ height: `${timeline.rows * ROW_HEIGHT}px` }}>
            {timeline.boxes.map((box, index) => (
              <TimelineBoxView
                key={`${box.nodeId}-${index}`}
                box={box}
                percent={percent}
                selected={box.nodeId === focusId}
                onFocus={onFocus}
              />
            ))}
          </div>
        </div>
      </div>
      <Text className="explore-caveat">
        Zoom stretches the chart and scrolls it sideways, so a short call widens where it sits rather than being
        re-drawn on its own; &#8984;/Ctrl with the scroll wheel zooms about the pointer.
        React frames, and engine frames that name nothing, are collapsed away, so a box&rsquo;s row is its depth on
        this chart rather than its real stack depth. A built-in the code called by name &mdash; a date formatter, a
        locale comparison, a sort &mdash; is kept and drawn in a paler fill, because it is engine code and still a
        cost the code above it controls. A box is one call, at the moment it ran, drawn at sample resolution — two calls closer
        together than one sample merge, and one shorter than a sample may not appear. Its span is wall clock, so it
        covers the framework work the call delegated to and any collection pause that fell inside it; the card&rsquo;s
        longest-call figure counts neither, which is why a box can read slightly wider.
      </Text>
    </div>
  );
}

/**
 * How long the call took, and where it sat.
 *
 * Only the outermost box names its start. An offset is read against the start
 * of the task, and on a nested box that invites the reader to subtract it from
 * the parent's — which is wrong, because the two are measured from the same
 * origin rather than from each other, so `278 ms from 550 ms` under `678 ms
 * from 394 ms` reads as a call that began 550 ms into its parent. The duration
 * is the figure a nested box is there to give.
 */
function timingLine(box: TimelineBox): string {
  const own = `${formatMs(box.selfMs)} of its own`;
  if (box.depth > 0) return `${formatMs(box.durationMs)}, ${own}`;
  return `${formatMs(box.durationMs)} from ${formatMs(box.startMs)}, ${own}`;
}

function TimelineBoxView({
  box,
  percent,
  selected,
  onFocus,
}: {
  box: TimelineBox;
  percent: (value: number) => string;
  selected: boolean;
  onFocus: (nodeId: string) => void;
}) {
  return (
    <button
      type="button"
      className={selected ? "timeline-box is-selected" : "timeline-box"}
      // A built-in the product called is drawn like any other box and must not
      // read like code the reader wrote: the fill is what says `engine`.
      data-class={box.frameClass}
      style={{ left: percent(box.startMs), width: percent(box.durationMs), top: `${box.depth * ROW_HEIGHT}px` }}
      title={`${box.name}\n${timingLine(box)}${box.location ? `\n${box.location}` : ""}`}
      onClick={() => onFocus(box.nodeId)}
    >
      <span>{box.name}</span>
    </button>
  );
}

/** The hand-off never changes once read, so there is nothing to subscribe to. */
const noSubscribe = () => () => {};

interface ExploreTarget {
  card: CardHandoff | null;
  /** Present when the URL names a task; the task itself is fetched. */
  taskIndex: number | null;
  /** The frame the view opens on, from `?focus=`. */
  focus: string;
  analysisId: string;
}

const noTarget = (): ExploreTarget | null => null;

let cached: { key: string; target: ExploreTarget } | undefined;

function readTargetOnce(): ExploreTarget {
  const params = new URLSearchParams(window.location.search);
  const analysisId = params.get("a") ?? "";
  const taskParam = params.get("task");
  const cardId = params.get("c") ?? "";
  const focus = params.get("focus") ?? "";
  const key = `${analysisId}:${taskParam ?? ""}:${cardId}`;
  // Reading a card hand-off consumes it, and `useSyncExternalStore` calls this
  // on every render: without the cache the second call would find nothing.
  if (cached?.key !== key) {
    const taskIndex = taskParam === null ? Number.NaN : Number(taskParam);
    cached = {
      key,
      target: {
        card: cardId ? readCardHandoff(analysisId, cardId) : null,
        taskIndex: Number.isInteger(taskIndex) ? taskIndex : null,
        focus,
        analysisId,
      },
    };
  }
  return cached.target;
}

type TaskLoad =
  | { state: "loading" }
  | { state: "ready"; handoff: TaskHandoff }
  | { state: "failed"; reason: string };

/**
 * The task arrives over the network rather than through storage, because a
 * task card ships the task's call tree whole and that runs to megabytes.
 */
function useTaskHandoff(analysisId: string, taskIndex: number | null): TaskLoad | null {
  // The URL is read once for the life of the page, so `taskIndex` never
  // changes under this hook: the initial state is the loading state, and the
  // effect only ever resolves it.
  const [load, setLoad] = useState<TaskLoad>({ state: "loading" });

  useEffect(() => {
    if (taskIndex === null) return;
    let live = true;
    fetchTaskHandoff(analysisId, taskIndex).then(
      (handoff) => { if (live) setLoad({ state: "ready", handoff }); },
      (error: unknown) => {
        if (live) setLoad({ state: "failed", reason: error instanceof Error ? error.message : "That task could not be loaded." });
      }
    );
    return () => { live = false; };
  }, [analysisId, taskIndex]);

  return taskIndex === null ? null : load;
}

export default function ExplorePage() {
  return <ThemeGate><Explorer /></ThemeGate>;
}

function Explorer() {
  // `ThemeGate` only renders this on the client, so the URL can be read during
  // the first render rather than a frame later. The read is cached because it
  // consumes any card hand-off it finds, and because a snapshot has to stay
  // identical between renders.
  const target = useSyncExternalStore(noSubscribe, readTargetOnce, noTarget);
  const task = useTaskHandoff(target?.analysisId ?? "", target?.taskIndex ?? null);

  return (
    <PluginShell>
      <PluginHeader>
        <PluginHeader.Title className="brand" render={<div />}>
          <span>TraceSift</span>
        </PluginHeader.Title>
        <PluginHeader.Actions>
          <PluginHeader.ThemeSwitcher />
        </PluginHeader.Actions>
      </PluginHeader>
      <PluginShell.Body>
        <section className="explore-page">
          {task?.state === "loading" ? (
            <EmptyState title="Loading this task" description="Fetching the call tree the analysis recorded for it." />
          ) : null}
          {task?.state === "failed" ? (
            <EmptyState
              title="Nothing to explore"
              description={`${task.reason} Re-run the analysis and choose Explore again.`}
            />
          ) : null}
          {task?.state === "ready" ? <TaskExplorer handoff={task.handoff} initialFocus={target?.focus ?? ""} /> : null}
          {!task && target?.card ? <CardExplorer handoff={target.card} /> : null}
          {!task && !target?.card ? (
            <EmptyState
              title="Nothing to explore"
              description="This view is opened from a result card, and the card it was given is no longer in this browser session. Re-run the analysis and choose Explore again."
            />
          ) : null}
          <footer className="explore-footer">
            <Button variant="outline" onClick={() => window.close()}>Close</Button>
          </footer>
        </section>
      </PluginShell.Body>
    </PluginShell>
  );
}

/**
 * The library's own floors, both of which the zoom has to divide: a frame
 * narrower than the first is not drawn at all, and one narrower than the second
 * is drawn without its name. Both are shares of the canvas rather than of what
 * the reader sees, and at 64× the canvas is sixty-four screens wide — so a box
 * filling the window outright is 1.6% of it, and the unscaled floor would leave
 * it blank with its name only in the tooltip.
 */
const DEFAULT_MIN_FRAME_WIDTH = 0.08;
const DEFAULT_MIN_LABEL_WIDTH = 3;

type TreeMode = "full" | "focused";

/**
 * The two cuts of the same subtree, as a pair of buttons. Shared by the flame
 * graph and the call tree so the one toggle reads the same wherever it appears.
 */
function TreeModeToggle({ label, mode, onChange }: { label: string; mode: TreeMode; onChange: (mode: TreeMode) => void }) {
  return (
    <div className="timeline-controls">
      <span className="explore-path-label">{label}</span>
      {([["full", "Everything"], ["focused", "Your code only"]] as const).map(([value, text]) => (
        <button
          key={value}
          type="button"
          className={value === mode ? "timeline-zoom is-current" : "timeline-zoom"}
          aria-pressed={value === mode}
          onClick={() => onChange(value)}
        >
          {text}
        </button>
      ))}
    </div>
  );
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
function TaskFlameGraph({ focus }: { focus: TaskTreeNode }) {
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

      <Text className="explore-caveat">
        Click a frame to zoom into its subtree, Escape to come back out. The zoom stretches the whole graph instead,
        so thin frames widen in place and the view scrolls sideways; &#8984;/Ctrl with the scroll wheel zooms about
        the pointer.
        {mode === "focused" ? (
          <>
            {" "}React and engine frames are collapsed away, the same cut the Timeline draws by, so a box&rsquo;s row
            is its depth here rather than its real stack depth. The time a dropped frame burned in its own body is
            charged to the nearest frame above it that was kept.
          </>
        ) : null}
      </Text>
    </>
  );
}

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
function TaskCallTree({ focus, taskMs, onFocus, locations }: { focus: TaskTreeNode; taskMs: number; onFocus: (id: string) => void; locations: FrameLocations }) {
  const [mode, setMode] = useState<TreeMode>("full");
  const tree = useMemo(() => (mode === "focused" ? focusedTree(focus) : focus), [mode, focus]);

  return (
    <>
      <TreeModeToggle label="tree" mode={mode} onChange={setMode} />
      <ul className="explore-tree">
        {/* Keyed by mode so the two trees do not share open/closed state: a row
            open at depth 4 in one is a different frame at that depth in the other. */}
        <TaskTreeRow key={mode} node={tree} taskMs={taskMs} depth={0} onFocus={onFocus} locations={locations} />
      </ul>
      {mode === "focused" ? (
        <Text className="explore-caveat">
          React and engine frames are collapsed away, the same cut the Timeline draws by, so a row&rsquo;s indent is
          its depth here rather than its real stack depth. The time a dropped frame burned in its own body is charged
          to the nearest frame above it that was kept, which is why a row can read more self time here than on the
          full tree.
        </Text>
      ) : null}
    </>
  );
}

/** Root to `id`, or just the root when the id names nothing in this task. */
function pathTo(root: TaskTreeNode, id: string): TaskTreeNode[] {
  const stack: TaskTreeNode[][] = [[root]];
  while (stack.length > 0) {
    const path = stack.pop()!;
    const node = path[path.length - 1];
    if (node.id === id) return path;
    for (const child of node.children) stack.push([...path, child]);
  }
  return [root];
}

/**
 * One task, opened on one frame inside it.
 *
 * The view holds the whole task and shows a slice of it. Rooting it at the top
 * of the task makes a terrible first screen — a wall of `Function call`,
 * `(anonymous)`, `performWorkOnRoot`, `beginWork` and ten more React frames
 * before any product code appears — but a view that only ever holds the focused
 * subtree can never answer "how did we get here, and what else ran beside
 * this", which is the second question every single time. So the ancestors fold
 * into a breadcrumb that expands, and the siblings stay one click away.
 */
function TaskExplorer({ handoff, initialFocus }: { handoff: TaskHandoff; initialFocus: string }) {
  const { card } = handoff;
  const [focusId, setFocusId] = useState(initialFocus || card.tree.id);
  const path = useMemo(() => pathTo(card.tree, focusId), [card.tree, focusId]);
  // Judged over the whole card, so a frame reads the same in the tree, the
  // culprit table and the hand-off the developer copies from this page.
  const locations = useMemo(() => taskCardLocations(card), [card]);
  const focus = path[path.length - 1];
  const parent = path.length > 1 ? path[path.length - 2] : null;
  const siblings = parent ? parent.children.filter((child) => child.id !== focus.id) : [];
  const refocus = (id: string) => {
    setFocusId(id);
    // Keep the address bar in step so the view can be reloaded or shared at the
    // frame the reader actually navigated to.
    const params = new URLSearchParams(window.location.search);
    if (id === card.tree.id) params.delete("focus"); else params.set("focus", id);
    window.history.replaceState(null, "", `${window.location.pathname}?${params}`);
  };

  return (
    <>
      <header className="explore-header">
        <h1>{card.pathline ?? card.headline}</h1>
        {card.shapeline ? <p className="explore-shape">{card.shapeline}</p> : null}
        {card.insight ? (
          <div className="card-insight">
            <span className="card-insight-label">AI reading</span>
            <ul>{card.insight.findings.map((finding) => <li key={finding}>{finding}</li>)}</ul>
          </div>
        ) : null}
        {card.boundaryFrames.length > 0 ? (
          <p className="explore-path">
            <span className="explore-path-label">feature</span>
            {card.boundaryFrames.map((frame) => (
              <button type="button" key={frame.nodeId} className="explore-path-frame explore-tree-focus" onClick={() => refocus(frame.nodeId)}>
                {frame.name}
              </button>
            ))}
          </p>
        ) : null}
        <p className="explore-figures">
          <strong>{formatMs(card.durationMs)}</strong> of uninterrupted work
          <span>·</span>
          {formatMs(card.startMs)} into the recording
          <span>·</span>
          {card.percentOfProfile}% of a {formatMs(handoff.totalMs)} profile
          <span>·</span>
          {card.subtreeFunctionCount} functions inside it
        </p>
        {card.boundaries === "inferred" ? (
          <Text className="explore-caveat">
            The profiler recorded no task boundaries on this thread, so this block was reconstructed from the gaps
            between sample runs. Its start and duration are approximate.
          </Text>
        ) : null}
      </header>

      {path.length > 1 ? (
        <nav className="explore-breadcrumb" aria-label="Frames above the focused one">
          <details>
            <summary>
              <span className="explore-path-label">above</span>
              {path.length - 1} frame{path.length === 2 ? "" : "s"} up to the task root
            </summary>
            <ol>
              {path.slice(0, -1).map((node) => (
                <li key={node.id}>
                  <button type="button" className="explore-tree-focus" onClick={() => refocus(node.id)}>{node.name}</button>
                  <em>{formatMs(node.totalMs)}</em>
                </li>
              ))}
            </ol>
          </details>
          <Button size="sm" variant="outline" onClick={() => refocus(card.tree.id)}>Show the whole task</Button>
        </nav>
      ) : null}

      {siblings.length > 0 ? (
        <nav className="explore-siblings" aria-label="Frames beside the focused one">
          <span className="explore-path-label">beside</span>
          {siblings.map((sibling) => (
            <button type="button" key={sibling.id} className="explore-tree-focus" onClick={() => refocus(sibling.id)}>
              {sibling.name} <em>{formatMs(sibling.totalMs)}</em>
            </button>
          ))}
        </nav>
      ) : null}

      <Tabs className="explore-tabs" defaultValue="timeline">
        <Tabs.List size="sm" aria-label="Views of this task">
          <Tabs.Tab value="timeline">Timeline</Tabs.Tab>
          <Tabs.Tab value="flame">Flame graph</Tabs.Tab>
          <Tabs.Tab value="tree">Call tree</Tabs.Tab>
          <Tabs.Tab value="culprits">Culprits</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="timeline" className="explore-panel">
          <TaskTimelineChart timeline={card.timeline} focusId={focusId} onFocus={refocus} />
        </Tabs.Panel>
        <Tabs.Panel value="flame" className="explore-panel">
          <TaskFlameGraph focus={focus} />
        </Tabs.Panel>
        <Tabs.Panel value="tree" className="explore-panel">
          <TaskCallTree focus={focus} taskMs={card.durationMs} onFocus={refocus} locations={locations} />
        </Tabs.Panel>
        <Tabs.Panel value="culprits" className="explore-panel">
          {card.culprits.length > 0 ? (
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
                {card.culprits.map((culprit) => (
                  <tr key={culprit.nodeId}>
                    <th scope="row">
                      <button type="button" className="explore-tree-focus" onClick={() => refocus(culprit.nodeId)}>{culprit.name}</button>
                      <RowLocation name={culprit.name} location={culprit.location} locations={locations} />
                    </th>
                    <td>{formatMs(culprit.selfMs)}</td>
                    <td>{formatMs(culprit.totalMs)}</td>
                    <td>{culprit.invocations}</td>
                    <td>{formatMs(culprit.longestCallMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <EmptyState title="No culprit stands out" description="This task's time is spread too thinly for any single frame to account for it." />
          )}
        </Tabs.Panel>
      </Tabs>
    </>
  );
}

/** The node-descent engine's drill-down, kept for analyses produced by it. */
function CardExplorer({ handoff }: { handoff: CardHandoff }) {
  const { card } = handoff;
  const flame = useMemo(() => toFlameNode(card.title, card.totalMs, card.selfMs, card.children, card.id), [card]);
  const locations = useMemo(() => profileCardLocations(card), [card]);
  const where = locations.shown(card.title, card.location);

  return (
    <>
      <header className="explore-header">
        <h1>{card.title}</h1>
        {where ? <code className="explore-location">{where}</code> : null}
        <p className="explore-figures">
          <strong>{formatMs(card.totalMs)}</strong> total
          <span>·</span>
          {formatMs(card.selfMs)} self
          <span>·</span>
          {card.percentOfProfile}% of a {formatMs(handoff.totalMs)} profile
          <span>·</span>
          {card.subtreeFunctionCount} functions underneath
        </p>
        {card.reachedVia.length > 1 ? (
          <p className="explore-path">
            <span className="explore-path-label">reached via</span>
            {card.reachedVia.map((frame, index) => (
              <span key={`${frame}-${index}`} className="explore-path-frame">{frame}</span>
            ))}
          </p>
        ) : null}
        {!handoff.callCountIsExact ? (
          <Text className="explore-caveat">
            This is a sampling profile: counts are distinct call sites, not invocation counts, and times are estimates.
          </Text>
        ) : null}
      </header>

      <Tabs className="explore-tabs" defaultValue="flame">
        <Tabs.List size="sm" aria-label="Views of this subtree">
          <Tabs.Tab value="flame">Flame graph</Tabs.Tab>
          <Tabs.Tab value="tree">Call tree</Tabs.Tab>
          <Tabs.Tab value="repeated">Repeated work</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="flame" className="explore-panel">
          <FlameGraph data={flame} formatValue={formatMs} rowHeight={24} />
        </Tabs.Panel>
        <Tabs.Panel value="tree" className="explore-panel">
          {card.children.length > 0 ? (
            <ul className="explore-tree">
              {card.children.map((child, index) => (
                <TreeRow
                  key={`${child.name}-${index}`}
                  node={child}
                  cardTotalMs={card.totalMs}
                  exact={handoff.callCountIsExact}
                  depth={0}
                  locations={locations}
                />
              ))}
            </ul>
          ) : (
            <EmptyState title="No callees" description="Every sample landed in this function's own body." />
          )}
        </Tabs.Panel>
        <Tabs.Panel value="repeated" className="explore-panel">
          <RepeatedTable rows={card.repeated} exact={handoff.callCountIsExact} locations={locations} />
        </Tabs.Panel>
      </Tabs>
    </>
  );
}
