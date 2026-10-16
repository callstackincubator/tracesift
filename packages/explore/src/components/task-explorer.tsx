"use client";

import { useMemo, useState } from "react";
import { Button, Tabs, Text } from "@rozenite/ui";

import { TaskCallTree, TaskCulpritTable } from "./task-views.tsx";
import { TaskFlameGraph } from "./task-flame-graph.tsx";
import { TaskTimelineChart } from "./task-timeline-chart.tsx";
import { formatMs } from "../lib/format.ts";
import { taskCardLocations } from "../lib/frame-location.ts";
import { type TaskHandoff } from "../handoff.ts";
import type { TaskTreeNode } from "../lib/task-cards.ts";

/** Root to `id`, or just the root when the id names nothing in this task. */
export function pathTo(root: TaskTreeNode, id: string): TaskTreeNode[] {
  const stack: TaskTreeNode[][] = [[root]];
  while (stack.length > 0) {
    const path = stack.pop()!;
    const node = path[path.length - 1];
    if (node.id === id) return path;
    for (const child of node.children) stack.push([...path, child]);
  }
  return [root];
}

export interface TaskExplorerProps {
  handoff: TaskHandoff;
  /**
   * The frame the view holds open, as an id from `card.tree`'s descendants. An
   * empty or unknown id means the whole task. Given, the view follows it and the
   * host owns the selection — that is how the Next route keeps the address bar
   * in step; omitted, the view owns the selection and reports it through
   * `onFocusChange`, which is enough for a host with no address bar.
   */
  focusNodeId?: string;
  /** The frame the reader navigated to: a tree row, a culprit, a timeline box. */
  onFocusChange?: (nodeId: string) => void;
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
export function TaskExplorer({ handoff, focusNodeId, onFocusChange }: TaskExplorerProps) {
  const { card } = handoff;
  // Controlled when the host names the focus, uncontrolled when it does not.
  // The Next route keeps the address bar in step and so owns the value; a host
  // without a URL still gets a working view, and neither has to know about the
  // other.
  const [ownFocusId, setOwnFocusId] = useState<string | null>(null);
  const focusId = focusNodeId || ownFocusId || card.tree.id;
  const path = useMemo(() => pathTo(card.tree, focusId), [card.tree, focusId]);
  // Judged over the whole card, so a frame reads the same in the tree, the
  // culprit table and the hand-off the developer copies from this page.
  const locations = useMemo(() => taskCardLocations(card), [card]);
  const focus = path[path.length - 1];
  const refocus = (id: string) => {
    setOwnFocusId(id);
    onFocusChange?.(id);
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
            The profiler recorded no boundary around this block, so its edges were reconstructed from the gaps
            between sample runs. Its start and duration are approximate — the work inside it is not.
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
