"use client";

import { Button, EmptyState } from "@rozenite/ui";

import { CardExplorer } from "./card-explorer.tsx";
import { ReactExplorer } from "./react-explorer.tsx";
import { TaskExplorer } from "./task-explorer.tsx";
import type { CardHandoff, ReactExploreHandoff, TaskHandoff } from "../handoff.ts";

/**
 * One hand-off on its way in.
 *
 * The views take data, so someone has to fetch it, and that someone is the
 * host: the Next app reads `localStorage` and calls `/api/task-card`, a plugin
 * hand-off server answers the same question its own way. This is the shape both
 * report back in, so the copy that explains a failure to a reader lives in one
 * place.
 */
export type ExploreLoad<T> =
  | { state: "loading" }
  | { state: "ready"; handoff: T }
  | { state: "failed"; reason: string };

export type TaskLoad = ExploreLoad<TaskHandoff>;
export type ReactLoad = ExploreLoad<ReactExploreHandoff>;

export interface ExploreViewProps {
  /** Set when the host was asked for a task; the task itself may still be in flight. */
  task?: TaskLoad | null;
  /** Set when the host was asked for a recording; its commits may still be in flight. */
  react?: ReactLoad | null;
  /** A node-descent card handed over directly, for analyses the old engine produced. */
  card?: CardHandoff | null;
  /** `TaskExplorer.focusNodeId`, for hosts that hold the task focus. */
  focusNodeId?: string;
  onFocusChange?: (nodeId: string) => void;
  /** `ReactExplorer.commitKey`, for hosts that hold the selected commit. */
  commitKey?: string;
  /** `ReactExplorer.defaultCommitKey`, for hosts that only name where to open. */
  defaultCommitKey?: string;
  onCommitChange?: (key: string) => void;
  /**
   * Renders the footer's `Close` button. The host decides what closing means —
   * `window.close` in a browser tab, posting a message to whatever owns the
   * panel, nothing at all where the reader navigates back instead.
   */
  onClose?: () => void;
  /** Shown when nothing was handed over at all. */
  emptyDescription?: string;
}

const NOTHING_TO_EXPLORE =
  "This view is opened from a result card, and the card it was given is no longer in this browser session. Re-run the analysis and choose Explore again.";

/**
 * The drill-down page, minus the parts only a host can own.
 *
 * This is what an Explore surface is: one of the three drill-downs, chosen by
 * what came in, over the load states that precede it. `PluginShell`, the header
 * and the theme stay with the host — the Next app wraps this in `ThemeGate` and
 * its own header, and a plugin has its own shell to mount into.
 */
export function ExploreView({
  task,
  react,
  card,
  focusNodeId,
  onFocusChange,
  commitKey,
  defaultCommitKey,
  onCommitChange,
  onClose,
  emptyDescription = NOTHING_TO_EXPLORE,
}: ExploreViewProps) {
  return (
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
      {react?.state === "ready" ? (
        <ReactExplorer handoff={react.handoff} commitKey={commitKey} defaultCommitKey={defaultCommitKey} onCommitChange={onCommitChange} />
      ) : null}
      {task?.state === "ready" ? (
        <TaskExplorer handoff={task.handoff} focusNodeId={focusNodeId} onFocusChange={onFocusChange} />
      ) : null}
      {!task && !react && card ? <CardExplorer handoff={card} /> : null}
      {!task && !react && !card ? (
        <EmptyState title="Nothing to explore" description={emptyDescription} />
      ) : null}
      {onClose ? (
        <footer className="explore-footer">
          <Button variant="outline" onClick={onClose}>Close</Button>
        </footer>
      ) : null}
    </section>
  );
}
