"use client";

import { useMemo } from "react";
import { EmptyState, Tabs, Text } from "@rozenite/ui";

import { FlameLegend } from "./flame-legend.tsx";
import { RepeatedTable, TreeRow } from "./tree-rows.tsx";
import { FlameGraph } from "../flame-graph/flame-graph.tsx";
import { toFlameNode } from "./task-flame-graph.tsx";
import { profileCardLocations } from "../lib/frame-location.ts";
import { formatMs } from "../lib/format.ts";
import { shortLocationLabel } from "../lib/source-location.ts";
import type { CardHandoff } from "../handoff.ts";

/** The node-descent engine's drill-down, kept for analyses produced by it. */
export function CardExplorer({ handoff }: { handoff: CardHandoff }) {
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
