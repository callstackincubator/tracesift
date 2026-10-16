"use client";

import { useMemo, useState } from "react";
import { EmptyState, Text } from "@rozenite/ui";
import { Tabs } from "@rozenite/ui";

import { CommitChart, commitKey, reactMs, ReactComponentTable, ReactRenderTree } from "./react-views.tsx";
import type { ReactExploreHandoff } from "../handoff.ts";

export interface ReactExplorerProps {
  handoff: ReactExploreHandoff;
  /**
   * The commit the view holds open, as `<rootId>.<commitIndex>` — the same
   * string a host keeps in its address bar. Given, the view follows it; omitted,
   * the view owns the selection and reports it through `onCommitChange`.
   */
  commitKey?: string;
  /** The commit to open on when the host does not hold the selection. */
  defaultCommitKey?: string;
  /** The commit the reader picked, in the same `<rootId>.<commitIndex>` form. */
  onCommitChange?: (key: string) => void;
}

export function ReactExplorer({ handoff, commitKey: heldKey, defaultCommitKey, onCommitChange }: ReactExplorerProps) {
  const { explore } = handoff;
  const byKey = useMemo(
    () => new Map(explore.commits.map((commit) => [commitKey(commit), commit])),
    [explore.commits],
  );
  // The longest commit is the one a reader came for, and is where the view
  // opens when the host names no commit or names one this recording lost.
  const fallbackKey = useMemo(() => {
    const longest = [...explore.commits].sort((a, b) => b.durationMs - a.durationMs)[0];
    return longest ? commitKey(longest) : "";
  }, [explore.commits]);
  // Held by the host when it names a commit — the Next route keeps the address
  // bar in step — and held here otherwise, so a host without a URL still gets a
  // working picker. Either way a key this recording lost falls back rather than
  // opening on nothing.
  const [ownKey, setOwnKey] = useState<string | null>(null);
  const wanted = heldKey ?? ownKey ?? defaultCommitKey ?? "";
  const selectedKey = byKey.has(wanted) ? wanted : fallbackKey;
  const commit = byKey.get(selectedKey) ?? null;
  const card = useMemo(
    () => (commit ? handoff.cards.find((entry) => entry.id === commit.cardId) ?? null : null),
    [commit, handoff.cards],
  );
  const select = (rootId: number, commitIndex: number) => {
    const key = `${rootId}.${commitIndex}`;
    setOwnKey(key);
    onCommitChange?.(key);
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
