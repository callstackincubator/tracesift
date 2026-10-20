"use client";

import { useMemo, useState, type CSSProperties, type MouseEvent } from "react";
import { EmptyState } from "@rozenite/ui";

import { formatMs } from "../lib/format.ts";
import { shortLocationLabel } from "../lib/source-location.ts";
import { isPickableName, pickedClass, pickNumber, picking, PickTick, type FrameSelection } from "./frame-selection.tsx";
import type { FrameLocations } from "../lib/frame-location.ts";
import type { CardChildNode, RepeatedFunction } from "../lib/profile-cards.ts";
import type { TaskTreeNode } from "../lib/task-cards.ts";

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
export function TreeRow({ node, cardTotalMs, exact, depth, locations }: { node: CardChildNode; cardTotalMs: number; exact: boolean; depth: number; locations: FrameLocations }) {
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

  if (node.children.length === 0) return <li className="explore-tree-leaf" style={{ "--depth": depth } as CSSProperties}>{row}</li>;
  return (
    <li style={{ "--depth": depth } as CSSProperties}>
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
 * The task tree's own row. Clicking a name refocuses the view on that frame —
 * or, while the reader is picking frames, adds this one to the set.
 * Children mount only while the row is open — see `TreeRow` for why.
 */
export function TaskTreeRow({ node, taskMs, depth, onFocus, locations, selection }: { node: TaskTreeNode; taskMs: number; depth: number; onFocus: (id: string) => void; locations: FrameLocations; selection?: FrameSelection }) {
  // A row holding a picked frame opens on its own, so a frame chosen on the
  // timeline is visible when the reader reaches the tree rather than buried
  // behind four closed rows. Until the reader opens or closes a row themselves
  // its state follows the picks; after that theirs wins, because a row they just
  // collapsed is not theirs to have sprung back open.
  const revealsPick = selection !== undefined && selection.selectedNodeIds.some(id => id.startsWith(`${node.id}.`));
  const [ownOpen, setOwnOpen] = useState<boolean | null>(null);
  const open = ownOpen ?? (depth < 2 || revealsPick);
  const where = locations.shown(node.name, node.location);
  const share = taskMs > 0 ? (node.totalMs / taskMs) * 100 : 0;
  const pickingNow = picking(selection);
  const number = pickNumber(selection, node.id);
  const picked = pickedClass(selection, node.id);
  // While picking, the whole row answers the click and the name does not move
  // the focus: a reader assembling a set expects the second click on a frame
  // they already picked to take it back out, not to re-root every view on it.
  const canPick = pickingNow && isPickableName(node.name);
  const pick = (event: MouseEvent) => {
    if (!canPick) return;
    // Opening a row is what a reader wants from a closed one here; collapsing it
    // in the same click would hide the children they are choosing between.
    event.preventDefault();
    if (node.children.length > 0) setOwnOpen(true);
    selection?.onToggleSelection(node.id);
  };
  const row = (
    <div
      className={[
        "explore-tree-row",
        ...(picked ? [picked] : []),
        ...(canPick ? ["explore-pickable-row"] : []),
      ].join(" ")}
      onClick={pick}
    >
      <span className="explore-tree-name">
        {/* The name stays a real button either way, so the keyboard reaches a row
            in both modes; only what it does changes. */}
        <button type="button" className="explore-tree-focus" aria-pressed={pickingNow && canPick ? number !== undefined : undefined}
          onClick={(event) => {
            if (!canPick) return onFocus(node.id);
            // The row's own handler would toggle a second time.
            event.stopPropagation();
            selection?.onToggleSelection(node.id);
          }}>
          {node.name}
        </button>
        {node.frameClass === "app" ? null : <span className="explore-tag">{node.frameClass}</span>}
        <PickTick selection={selection} nodeId={node.id} />
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

  if (node.children.length === 0) return <li className="explore-tree-leaf" style={{ "--depth": depth } as CSSProperties}>{row}</li>;
  return (
    <li style={{ "--depth": depth } as CSSProperties}>
      {/* A row React just opened to reveal a pick fires this too, and recording
          that as the reader's own choice would latch the row open for good: the
          pick would stop governing a row they never touched. Only a toggle that
          disagrees with what this render asked for is a reader's doing. */}
      <details open={open} onToggle={(event) => {
        if (event.currentTarget.open !== open) setOwnOpen(event.currentTarget.open);
      }}>
        <summary>{row}</summary>
        {open ? (
          <ul className="explore-tree">
            {node.children.map((child) => (
              <TaskTreeRow key={child.id} node={child} taskMs={taskMs} depth={depth + 1} onFocus={onFocus} locations={locations} {...(selection ? { selection } : {})} />
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
export function RowLocation({ name, location, locations }: { name: string; location: string | undefined; locations: FrameLocations }) {
  const where = locations.shown(name, location);
  return where ? <code title={where}>{shortLocationLabel(where)}</code> : null;
}

type SortKey = "totalMs" | "selfMs" | "callSites";

/** Every function that ran more than once under this parent, and what it cost across all of them. */
export function RepeatedTable({ rows, exact, locations }: { rows: RepeatedFunction[]; exact: boolean; locations: FrameLocations }) {
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
