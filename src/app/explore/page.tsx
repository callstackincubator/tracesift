"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { PluginHeader, PluginShell } from "@rozenite/ui";
import { ExploreView, type ExploreLoad, type TaskLoad } from "@callstack/tracesift-explore";

import { ThemeGate } from "@/app/theme-gate";
import { fetchReactExplore, fetchTaskHandoff, readCardHandoff, type CardHandoff, type ReactExploreHandoff } from "@/lib/card-handoff";

import "@callstack/tracesift-explore/styles.css";

/**
 * The route around the drill-down.
 *
 * Everything a browser tab has and a plugin panel does not — the address bar,
 * a hand-off left in `localStorage` by the results page, the tab's own close
 * button — lives here, and the views are handed values and callbacks. So the
 * reader sees one Explore whether they arrived from a card here or from a
 * panel, and this file stays the only place that knows what `?task=` means.
 */

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

/**
 * The whole recording, fetched once.
 *
 * Like a task, and for the same reason: the measured React engine keeps the
 * commit trees on the analysis record, and they are far too large to hand
 * across tabs through storage. Unlike a task, what comes back is every commit
 * rather than the one the card named — the strip is the view, and it has to be
 * complete before a reader can scrub it.
 */
function useReactExplore(analysisId: string, wanted: boolean): ExploreLoad<ReactExploreHandoff> | null {
  const [load, setLoad] = useState<ExploreLoad<ReactExploreHandoff>>({ state: "loading" });

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

/** Keep the address bar in step with what the reader clicked, without a navigation. */
function writeParam(key: string, value: string): void {
  const params = new URLSearchParams(window.location.search);
  if (value) params.set(key, value); else params.delete(key);
  window.history.replaceState(null, "", `${window.location.pathname}?${params}`);
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

  // The views hold no address bar, so the two things the reader can navigate
  // within them live here: which frame a task view is opened on, and which
  // commit a recording is opened on. Each starts where `?focus=` or `?commit=`
  // said and is written back on every click, so reloading or sharing the page
  // lands on what the reader was actually looking at rather than on the frame
  // the card happened to name.
  const [focusNodeId, setFocusNodeId] = useState(target?.focus ?? "");
  const [commitKey, setCommitKey] = useState(target?.commitKey ?? "");
  const taskRootId = task?.state === "ready" ? task.handoff.card.tree.id : "";

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
        <ExploreView
          task={task}
          react={react}
          card={target?.card ?? null}
          focusNodeId={focusNodeId}
          onFocusChange={(id) => {
            setFocusNodeId(id);
            writeParam("focus", id === taskRootId ? "" : id);
          }}
          commitKey={commitKey}
          onCommitChange={(key) => {
            setCommitKey(key);
            writeParam("commit", key);
          }}
          onClose={() => window.close()}
        />
      </PluginShell.Body>
    </PluginShell>
  );
}

