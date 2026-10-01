"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Button, EmptyState, FlameGraph, PluginHeader, PluginShell, Tabs, Text } from "@rozenite/ui";
import type { FlameGraphNode } from "@rozenite/ui";

import { ThemeGate } from "@/app/theme-gate";
import { fetchTaskHandoff, readCardHandoff, type CardHandoff, type TaskHandoff } from "@/lib/card-handoff";
import { formatMs } from "@/lib/format";
import type { CardChildNode, RepeatedFunction } from "@/lib/profile-cards";
import type { TaskTreeNode } from "@/lib/task-cards";

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
    tooltip: `${node.name} — ${formatMs(node.totalMs)} total, ${formatMs(node.selfMs)} self`,
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
 */
function TreeRow({ node, cardTotalMs, exact, depth }: { node: CardChildNode; cardTotalMs: number; exact: boolean; depth: number }) {
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
      {node.location ? <code className="explore-tree-location" title={node.location}>{node.location}</code> : null}
    </div>
  );

  if (node.children.length === 0) return <li className="explore-tree-leaf" style={{ "--depth": depth } as React.CSSProperties}>{row}</li>;
  return (
    <li style={{ "--depth": depth } as React.CSSProperties}>
      <details open={depth === 0}>
        <summary>{row}</summary>
        <ul className="explore-tree">
          {node.children.map((child, index) => (
            <TreeRow key={`${child.name}-${index}`} node={child} cardTotalMs={cardTotalMs} exact={exact} depth={depth + 1} />
          ))}
        </ul>
      </details>
    </li>
  );
}

/** The task tree's own row. Clicking a name refocuses the view on that frame. */
function TaskTreeRow({ node, taskMs, depth, onFocus }: { node: TaskTreeNode; taskMs: number; depth: number; onFocus: (id: string) => void }) {
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
      {node.location ? <code className="explore-tree-location" title={node.location}>{node.location}</code> : null}
    </div>
  );

  if (node.children.length === 0) return <li className="explore-tree-leaf" style={{ "--depth": depth } as React.CSSProperties}>{row}</li>;
  return (
    <li style={{ "--depth": depth } as React.CSSProperties}>
      <details open={depth < 2}>
        <summary>{row}</summary>
        <ul className="explore-tree">
          {node.children.map((child) => (
            <TaskTreeRow key={child.id} node={child} taskMs={taskMs} depth={depth + 1} onFocus={onFocus} />
          ))}
        </ul>
      </details>
    </li>
  );
}

type SortKey = "totalMs" | "selfMs" | "callSites";

/** Every function that ran more than once under this parent, and what it cost across all of them. */
function RepeatedTable({ rows, exact }: { rows: RepeatedFunction[]; exact: boolean }) {
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
              {row.location ? <code title={row.location}>{row.location}</code> : null}
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
  const focus = path[path.length - 1];
  const parent = path.length > 1 ? path[path.length - 2] : null;
  const siblings = parent ? parent.children.filter((child) => child.id !== focus.id) : [];
  const flame = useMemo(() => taskFlameNode(focus), [focus]);

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
        <h1>{card.headline}</h1>
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

      <Tabs className="explore-tabs" defaultValue="flame">
        <Tabs.List size="sm" aria-label="Views of this task">
          <Tabs.Tab value="flame">Flame graph</Tabs.Tab>
          <Tabs.Tab value="tree">Call tree</Tabs.Tab>
          <Tabs.Tab value="culprits">Culprits</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="flame" className="explore-panel">
          <FlameGraph data={flame} formatValue={formatMs} rowHeight={24} />
        </Tabs.Panel>
        <Tabs.Panel value="tree" className="explore-panel">
          <ul className="explore-tree">
            <TaskTreeRow node={focus} taskMs={card.durationMs} depth={0} onFocus={refocus} />
          </ul>
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
                      {culprit.location ? <code title={culprit.location}>{culprit.location}</code> : null}
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

  return (
    <>
      <header className="explore-header">
        <h1>{card.title}</h1>
        {card.location ? <code className="explore-location">{card.location}</code> : null}
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
                />
              ))}
            </ul>
          ) : (
            <EmptyState title="No callees" description="Every sample landed in this function's own body." />
          )}
        </Tabs.Panel>
        <Tabs.Panel value="repeated" className="explore-panel">
          <RepeatedTable rows={card.repeated} exact={handoff.callCountIsExact} />
        </Tabs.Panel>
      </Tabs>
    </>
  );
}
