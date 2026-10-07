"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Button, EmptyState, FlameGraph, PluginHeader, PluginShell, Tabs, Text } from "@rozenite/ui";
import type { FlameGraphNode } from "@rozenite/ui";

import { ThemeGate } from "@/app/theme-gate";
import { ChartNotes, STRETCH_ZOOM_NOTE, ZOOM_HINT } from "./chart-notes";
import { useStretchZoom, ZoomControls } from "./stretch-zoom";
import { fetchReactExplore, fetchTaskHandoff, readCardHandoff, type CardHandoff, type ReactExploreHandoff, type TaskHandoff } from "@/lib/card-handoff";
import { formatMs } from "@/lib/format";
import { shortLocationLabel } from "@/lib/source-location";
import { profileCardLocations, taskCardLocations, type FrameLocations } from "@/lib/frame-location";
import type { FrameClass } from "@/lib/frame-classes";
import type { CardChildNode, RepeatedFunction } from "@/lib/profile-cards";
import { focusedTree, type TaskCulprit, type TaskTreeNode } from "@/lib/task-cards";
import { isShownFrame, SHOWN_CLASSES, type TaskTimeline, type TimelineBox } from "@/lib/task-timeline";
import { hookLabel, type ReactRenderCause } from "@/lib/react-commit-tree";
import { isOwnComponent } from "@/lib/react-cards";
import { focusedReactTree, type ReactExplore, type ReactExploreCommit, type ReactExploreNode } from "@/lib/react-explore";

/**
 * The classes the focused views keep, as the set `isShownFrame` tests against.
 * `SHOWN_CLASSES` is the list and this is the lookup; the cut itself lives in
 * `task-timeline.ts` so the chart, the tree and the culprit table share it.
 */
const DRAWN_CLASSES = new Set<FrameClass>(SHOWN_CLASSES);

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
      {where ? <code className="explore-tree-location" title={where}>{shortLocationLabel(where)}</code> : null}
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
      {where ? <code className="explore-tree-location" title={where}>{shortLocationLabel(where)}</code> : null}
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
  return where ? <code title={where}>{shortLocationLabel(where)}</code> : null;
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
            <td className="explore-table-callers">
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
      <ChartNotes
        reading={<>One box is one call, drawn where it ran. Width is how long it took.</>}
        controls={ZOOM_HINT}
        caveats={[
          STRETCH_ZOOM_NOTE,
          <>
            <strong>Rows are not stack depth.</strong> React frames, and engine frames that name nothing, are
            collapsed away, so a box&rsquo;s row is its depth on this chart.
          </>,
          <>
            A built-in the code called by name &mdash; a date formatter, a locale comparison, a sort &mdash; is kept
            and drawn in a paler fill: it is engine code, and still a cost the code above it controls.
          </>,
          <>
            <strong>Drawn at sample resolution.</strong> Two calls closer together than one sample merge, and one
            shorter than a sample may not appear.
          </>,
          <>
            <strong>Spans are wall clock.</strong> A box covers the framework work its call delegated to and any
            collection pause that fell inside it. The card&rsquo;s longest-call figure counts neither, which is why a
            box can read slightly wider.
          </>,
        ]}
      />
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
  /** `<rootId>.<commitIndex>` when the URL names a React commit; the recording is fetched. */
  commitKey: string;
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
  const commitKey = params.get("commit") ?? "";
  const focus = params.get("focus") ?? "";
  const key = `${analysisId}:${taskParam ?? ""}:${cardId}:${commitKey}`;
  // Reading a card hand-off consumes it, and `useSyncExternalStore` calls this
  // on every render: without the cache the second call would find nothing.
  if (cached?.key !== key) {
    const taskIndex = taskParam === null ? Number.NaN : Number(taskParam);
    cached = {
      key,
      target: {
        card: cardId ? readCardHandoff(analysisId, cardId) : null,
        taskIndex: Number.isInteger(taskIndex) ? taskIndex : null,
        commitKey,
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

type ReactLoad =
  | { state: "loading" }
  | { state: "ready"; handoff: ReactExploreHandoff }
  | { state: "failed"; reason: string };

/**
 * The whole recording, fetched once.
 *
 * Like a task, and for the same reason: the measured React engine keeps the
 * commit trees on the analysis record, and they are far too large to hand
 * across tabs through storage. Unlike a task, what comes back is every commit
 * rather than the one the card named — the strip is the view, and it has to be
 * complete before a reader can scrub it.
 */
function useReactExplore(analysisId: string, wanted: boolean): ReactLoad | null {
  const [load, setLoad] = useState<ReactLoad>({ state: "loading" });

  useEffect(() => {
    if (!wanted) return;
    let live = true;
    fetchReactExplore(analysisId).then(
      (handoff) => { if (live) setLoad({ state: "ready", handoff }); },
      (error: unknown) => {
        if (live) setLoad({ state: "failed", reason: error instanceof Error ? error.message : "That recording could not be loaded." });
      }
    );
    return () => { live = false; };
  }, [analysisId, wanted]);

  return wanted ? load : null;
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
  const react = useReactExplore(target?.analysisId ?? "", Boolean(target?.commitKey));

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
          {react?.state === "loading" ? (
            <EmptyState title="Loading this recording" description="Fetching the commits the analysis recorded." />
          ) : null}
          {react?.state === "failed" ? (
            <EmptyState title="Nothing to explore" description={`${react.reason} Re-run the analysis and choose Explore again.`} />
          ) : null}
          {react?.state === "ready" ? <ReactExplorer handoff={react.handoff} initialKey={target?.commitKey ?? ""} /> : null}
          {task?.state === "ready" ? <TaskExplorer handoff={task.handoff} initialFocus={target?.focus ?? ""} /> : null}
          {!task && !react && target?.card ? <CardExplorer handoff={target.card} /> : null}
          {!task && !react && !target?.card ? (
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
 * The buckets `FlameGraph` colours frames by, and what the share is of.
 *
 * The library ships its own legend, but its labels ("Heaviest (>70%)") name a
 * percentage without saying of what, which is the one thing that has to be
 * said: a frame's bucket is its own time as a share of the *hottest frame's*
 * own time in this one graph, not of the profile and not of its parent. That is
 * why a field of green around a single red box is the usual shape, and reading
 * it as "almost nothing is hot" is reading it right.
 */
const FLAME_BUCKETS = [
  ["heaviest", "> 70%"],
  ["heavy", "40\u201370%"],
  ["moderate", "20\u201340%"],
  ["light", "< 20%"],
  ["none", "none"],
] as const;

/** `what` names the figure the colour is of, in the surface's own words. */
function FlameLegend({ what }: { what: string }) {
  return (
    <div className="flame-legend">
      <span className="flame-legend-lead">Colour is {what}, as a share of the hottest frame&rsquo;s:</span>
      {FLAME_BUCKETS.map(([bucket, label]) => (
        <span key={bucket} className="flame-legend-item">
          <span className="flame-legend-swatch" data-bucket={bucket} />
          {label}
        </span>
      ))}
    </div>
  );
}


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
function TaskCulpritTable({ culprits, onFocus, locations }: { culprits: readonly TaskCulprit[]; onFocus: (id: string) => void; locations: FrameLocations }) {
  const [mode, setMode] = useState<TreeMode>("full");
  const rows = useMemo(
    () => (mode === "focused" ? culprits.filter((culprit) => isShownFrame(culprit.name, culprit.frameClass, DRAWN_CLASSES)) : culprits),
    [mode, culprits],
  );
  const hidden = culprits.length - rows.length;

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
            {rows.map((culprit) => (
              <tr key={culprit.nodeId}>
                <th scope="row">
                  <button type="button" className="explore-tree-focus" onClick={() => onFocus(culprit.nodeId)}>{culprit.name}</button>
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
 * before any product code appears — so it opens on the focused frame, with one
 * way back out to the whole task. The context a reader wants from there — what
 * ran above and beside this frame — is the task's own views a click away, not
 * two more rows of links crowding the header.
 */
function TaskExplorer({ handoff, initialFocus }: { handoff: TaskHandoff; initialFocus: string }) {
  const { card } = handoff;
  const [focusId, setFocusId] = useState(initialFocus || card.tree.id);
  const path = useMemo(() => pathTo(card.tree, focusId), [card.tree, focusId]);
  // Judged over the whole card, so a frame reads the same in the tree, the
  // culprit table and the hand-off the developer copies from this page.
  const locations = useMemo(() => taskCardLocations(card), [card]);
  const focus = path[path.length - 1];
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
        <p className="explore-figures">
          {/* No `into the recording`: where the task sat on the profile's clock
              tells a reader nothing they act on, and the timeline tab below is
              already measured from this task's own start. */}
          <strong>{formatMs(card.durationMs)}</strong> of uninterrupted work
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
        {/* Under the measurements, not over them: the figures above are what the
            profiler recorded, and a model's reading of them is a second-class
            claim that should not be the first thing read. It stays in the
            header, immediately above the views it is a reading of. */}
        {card.insight ? (
          <div className="card-insight">
            <span className="card-insight-label">AI reading</span>
            <ul>{card.insight.findings.map((finding) => <li key={finding}>{finding}</li>)}</ul>
          </div>
        ) : null}
      </header>

      {path.length > 1 ? (
        <nav className="explore-breadcrumb" aria-label="Leave the focused frame">
          <Button size="sm" variant="outline" onClick={() => refocus(card.tree.id)}>Show the whole task</Button>
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
          <TaskCulpritTable culprits={card.culprits} onFocus={refocus} locations={locations} />
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
        {where ? <code className="explore-location" title={where}>{shortLocationLabel(where)}</code> : null}
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
          <FlameLegend what="a frame's own time" />
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

/* ---------------------------------------------------------------------------
 * The React drill-down: a recording's commits against the clock, and the tree
 * each one rendered.
 * ------------------------------------------------------------------------- */

/**
 * A React duration, to the precision React recorded it at.
 *
 * `formatMs` rounds to whole milliseconds, which is right for a CPU task
 * measured in seconds and wrong for a frame budget of 16: the median self time
 * in a cascade is 0.03 ms, and every row of it would read `0 ms`.
 */
function reactMs(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 ms";
  if (value < 1) return `${Number(value.toFixed(2))} ms`;
  if (value < 1000) return `${Number(value.toFixed(1))} ms`;
  return formatMs(value);
}

/** Why React rendered a component, in the words a reader acts on. */
const CAUSE_TEXT: Record<ReactRenderCause, string> = {
  "first-mount": "first mount",
  state: "state changed",
  hooks: "a hook changed",
  props: "props changed",
  context: "context changed",
  "nothing-changed": "nothing changed",
  unknown: "render reason not recorded",
};

function causeDetail(node: ReactExploreNode): string {
  const named = [...node.changedProps, ...node.changedHooks.map(hookLabel)].slice(0, 4);
  const base = CAUSE_TEXT[node.cause];
  return named.length > 0 ? `${base}: ${named.join(", ")}` : base;
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
/**
 * How many rows deep the tree runs.
 *
 * The note under the render tree used to quote the checked-in fixture — "nests
 * 110 deep and reads at 26" — at a reader looking at their own recording. The
 * point it was making is a good one and it is cheap to make truthfully, so the
 * figures are measured from the open commit instead.
 */
function reactTreeDepth(nodes: ReactExploreNode[]): number {
  let deepest = 0;
  for (const node of nodes) deepest = Math.max(deepest, 1 + reactTreeDepth(node.children));
  return deepest;
}

function reactFlameNode(node: ReactExploreNode, path: string): FlameGraphNode {
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

/** Every rendered fiber of one commit, flattened and ranked by self time. */
function flattenCommit(commit: ReactExploreCommit): ReactExploreNode[] {
  const out: ReactExploreNode[] = [];
  const walk = (nodes: ReactExploreNode[]) => {
    for (const node of nodes) { out.push(node); walk(node.children); }
  };
  walk(commit.tree);
  return out.sort((a, b) => b.selfMs - a.selfMs || b.actualMs - a.actualMs || a.id - b.id);
}

/** Rows the component table draws before it stops and says how many are left. */
const MAX_COMPONENT_ROWS = 150;

/**
 * The chart's height, and so the share of it the budget line sits at.
 *
 * A bar is linear in its commit's duration against the tallest commit in the
 * recording, so the budget line lands wherever the arithmetic puts it — low on
 * a recording with one 275 ms commit, which is the honest picture of a
 * recording with one 275 ms commit.
 */
const STRIP_HEIGHT = 132;

/**
 * The shortest bar drawn for a commit that took measurable time.
 *
 * Height is linear in duration against the tallest commit, and in a recording
 * whose peak is 275 ms a 1.6 ms commit is six tenths of a pixel: invisible. It
 * only ever applies to bars too small to compare by eye anyway, which is why
 * each carries its figure as a label. A commit React measured at zero is drawn
 * at 2px instead, because a floor there would draw time that does not exist.
 */
const MIN_BAR_HEIGHT = 6;

function commitKey(commit: { rootId: number; commitIndex: number }): string {
  return `${commit.rootId}.${commit.commitIndex}`;
}

/**
 * Room kept above the tallest bar for its duration label.
 *
 * The label sits above the bar rather than inside it because the interesting
 * bars here are the short ones: a 1.6 ms commit beside a 170 ms one is a few
 * pixels of fill with nowhere to print a figure.
 */
const BAR_LABEL_PX = 14;

/**
 * How many evenly spaced bars can carry their own label.
 *
 * Even spacing gives every commit the same width, so the labels either fit or
 * they do not: across forty commits a slot is a few pixels and every label
 * would be one clipped digit. Past this count the labels come off and the
 * figure lives in the tooltip; the axis underneath keeps thinning its commit
 * numbers so a reader never loses their place entirely.
 */
const MAX_LABELLED_BARS = 20;

/** Narrowest evenly spaced bar. Below this a click lands between two commits. */
const MIN_SLOT_PX = 14;

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
function commitTooltip(commit: ReactExploreCommit): string {
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
function CommitChart({
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
function ReactComponentTable({ commit }: { commit: ReactExploreCommit }) {
  const [mode, setMode] = useState<TreeMode>("full");
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
            {shown.map((node) => (
              <tr key={node.id} data-class={node.componentClass}>
                <th scope="row">
                  <span className="react-component-name">{node.name}</span>
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
            ))}
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
function ReactRenderTree({ commit }: { commit: ReactExploreCommit }) {
  const [mode, setMode] = useState<TreeMode>("focused");
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
      <FlameGraph data={flame} formatValue={reactMs} rowHeight={24} />
      <ChartNotes
        reading={
          <>
            Width is time including everything a component rendered. The colour is its own time alone.
          </>
        }
        controls={`Click a box to zoom into its subtree \u00B7 Esc to go back \u00B7 ${ZOOM_HINT}`}
        caveats={[
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

function ReactExplorer({ handoff, initialKey }: { handoff: ReactExploreHandoff; initialKey: string }) {
  const { explore } = handoff;
  const byKey = useMemo(
    () => new Map(explore.commits.map((commit) => [commitKey(commit), commit])),
    [explore.commits],
  );
  // The longest commit is the one a reader came for, and is where the view
  // opens when the URL names no commit or names one this recording lost.
  const fallbackKey = useMemo(() => {
    const longest = [...explore.commits].sort((a, b) => b.durationMs - a.durationMs)[0];
    return longest ? commitKey(longest) : "";
  }, [explore.commits]);
  const [selectedKey, setSelectedKey] = useState(byKey.has(initialKey) ? initialKey : fallbackKey);
  const commit = byKey.get(selectedKey) ?? null;
  const card = useMemo(
    () => (commit ? handoff.cards.find((entry) => entry.id === commit.cardId) ?? null : null),
    [commit, handoff.cards],
  );
  const select = (rootId: number, commitIndex: number) => {
    const key = `${rootId}.${commitIndex}`;
    setSelectedKey(key);
    // Keep the address bar in step, so the view reloads on the commit the
    // reader navigated to rather than on the one the card opened.
    const params = new URLSearchParams(window.location.search);
    params.set("commit", key);
    window.history.replaceState(null, "", `${window.location.pathname}?${params}`);
  };

  if (!commit) {
    return <EmptyState title="Nothing to explore" description="This recording contains no React commits." />;
  }

  return (
    <>
      <header className="explore-header">
        <h1>{card?.insight?.title ?? card?.headline ?? `Commit ${commit.commitIndex} rendered ${commit.renderedCount} components`}</h1>
        {card?.shapeline ? <p className="explore-shape">{card.shapeline}</p> : null}
        {/* Two figures only. The reconciler residual is still on the tree's own
            root row, and the commit's place on the clock and its effect
            durations are in the hand-off; neither was a number a reader of this
            page acts on. */}
        <p className="explore-figures">
          <strong>{reactMs(commit.durationMs)}</strong> rendering
          <span>·</span>
          {commit.renderedCount} component{commit.renderedCount === 1 ? "" : "s"} rendered
        </p>
        {!commit.causesRecorded ? (
          <Text className="explore-caveat">
            This recording was made without &ldquo;Record why each component rendered&rdquo;, so React captured no
            render reasons for this commit. Every other figure here is measured; turn that option on in the React
            DevTools profiler and record again to find out which of these renders changed nothing.
          </Text>
        ) : null}
        {/* Below the measurements, as in the task view above: a reading of the
            figures should not be read before them. */}
        {card?.insight ? (
          <div className="card-insight">
            <span className="card-insight-label">AI reading</span>
            <ul>{card.insight.findings.map((finding) => <li key={finding}>{finding}</li>)}</ul>
          </div>
        ) : null}
      </header>

      <CommitChart explore={explore} selectedKey={selectedKey} onSelect={select} />

      <Tabs className="explore-tabs" defaultValue="tree">
        <Tabs.List size="sm" aria-label="Views of this commit">
          <Tabs.Tab value="tree">Render tree</Tabs.Tab>
          <Tabs.Tab value="components">Components</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="tree" className="explore-panel">
          <ReactRenderTree commit={commit} />
        </Tabs.Panel>
        <Tabs.Panel value="components" className="explore-panel">
          <ReactComponentTable commit={commit} />
        </Tabs.Panel>
      </Tabs>
    </>
  );
}
