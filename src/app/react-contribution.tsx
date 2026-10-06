"use client";

import { useState } from "react";

import { formatReactMs } from "@/lib/format";
import { hookLabel } from "@/lib/react-commit-tree";
import { reactCommitSlices, type ReactSlice } from "@/lib/react-contribution";
import type { ReactCard } from "@/lib/react-cards";
import { shortLocationLabel } from "@/lib/source-location";
import {
  ContributionChart,
  SliceLegend,
  sliceColor,
  type ContributionChartKind,
} from "@/app/contribution-chart";

/**
 * The React card's evidence: how the commit divides between the components that
 * rendered in it.
 *
 * The same drawing the task cards carry, over the one partition a React export
 * supports. It replaces the card's row list, which answered "how big is this
 * one component" up to eight times and never drew the commit itself — see
 * `react-contribution.ts` for why a commit has one level where a task has two,
 * and why the reconciler's share is a slice rather than a footnote.
 */
export function ReactContribution({
  card,
  kind,
  onExplore,
}: {
  card: ReactCard;
  kind: ContributionChartKind;
  /** Opens this commit in Explore, where every component it rendered is listed. */
  onExplore?: () => void;
}) {
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const slices = reactCommitSlices(card);
  // The heaviest slice, so the strip reads as a finding before anyone has
  // touched the chart rather than as an empty box waiting for a hover.
  const active = slices.find((slice) => slice.key === activeKey) ?? slices[0];

  if (slices.length === 0) return null;

  const chart = {
    slices,
    active,
    format: formatReactMs,
    onHover: setActiveKey,
    // Every slice opens the same place: React measures no level inside a
    // component's render, so there is nothing of a component's own to open into.
    onOpen: () => onExplore?.(),
  };

  return (
    <div className="contribution" data-kind={kind} data-level="commit">
      <p className="contribution-lede">
        How the {formatReactMs(card.durationMs)} divides between the components that rendered. Each{" "}
        {kind === "bar" ? "band" : "tile"} is one component&apos;s own render time — these add up, because
        React charges a component&apos;s time to it alone and never to its children.
      </p>

      <ContributionChart kind={kind} {...chart} />

      <ReactSliceDetail card={card} slice={active} onExplore={onExplore} />

      <SliceLegend {...chart} />
    </div>
  );
}

/**
 * Why React rendered this component.
 *
 * The single most actionable line on a React card, in the same slot the task
 * cards use for a call shape: `142 ms in one render` and `142 ms over 54
 * renders that changed nothing` are the same number and different bugs.
 */
export function reactCulpritShape(culprit: ReactCard["culprits"][number]): string | undefined {
  const changed = culprit.changedProps.length > 0
    ? ` · props ${culprit.changedProps.slice(0, 3).join(", ")}`
    : culprit.changedHooks.length > 0 ? ` · hooks ${culprit.changedHooks.slice(0, 3).map(hookLabel).join(", ")}` : "";
  const forget = culprit.compiledWithForget ? " · React Compiler" : "";
  if (culprit.cause === "unknown") return `render reason not recorded${forget}`;
  const cause = culprit.cause === "nothing-changed" ? "re-rendered with nothing changed"
    : culprit.cause === "first-mount" ? "first mount"
      : `${culprit.cause} changed`;
  return `${cause}${changed}${forget}`;
}

/**
 * What a residual stands for, which is the whole reason the commit has one.
 *
 * Both of these used to be footnotes under the rows — "+ 12 ms across 268
 * further components", "+ 34 ms React walking the tree" — and both were cut for
 * being time the reader cannot act on. That is still true, and it is exactly
 * what makes them worth saying here: the drawing shows a grey band, and these
 * are the two reasons a band can be grey.
 */
function residualText(card: ReactCard, slice: ReactSlice): string {
  if (slice.kind === "tail") {
    const count = slice.tailCount ?? 0;
    const components = count === 1 ? "one more component" : `${count} more components`;
    return `${components} rendered in this commit, each too small to draw a slice for — ${formatReactMs(slice.ms)} between them. A cost spread this thin is fixed at the boundary that re-rendered them, not inside any one of them.`;
  }
  return `No component's own body was running here: React walking the tree, comparing it and committing it. ${formatReactMs(slice.ms)} of the ${formatReactMs(card.durationMs)} is the reconciler's own work, which no change to a component removes.`;
}

/** How a component that is not the app's own should be read, where that changes the fix. */
const CLASS_NOTE: Partial<Record<ReactCard["culprits"][number]["componentClass"], string>> = {
  library: "a library component",
  framework: "React's own wrapper",
  host: "a host view",
  unnamed: "not named by the recording",
};

/**
 * The active slice, in full: the figures, where the component lives, what
 * rendered it, and why React rendered it. This is where the row list's content
 * went — a reader wanted one component's detail at a time and was given eight
 * copies of it.
 *
 * It keeps a fixed footprint whichever slice is showing, so hovering across a
 * bar does not make the page jump under the cursor.
 */
function ReactSliceDetail({
  card,
  slice,
  onExplore,
}: {
  card: ReactCard;
  slice: ReactSlice;
  onExplore?: () => void;
}) {
  const culprit = slice.culprit;
  const via = culprit && culprit.path.length > 1 ? culprit.path.slice(0, -1).join(" › ") : undefined;
  const secondary = culprit ? CLASS_NOTE[culprit.componentClass] : undefined;

  return (
    <div className="contribution-detail">
      <div className="contribution-detail-head">
        <span className="contribution-swatch" style={{ background: sliceColor(slice) }} aria-hidden="true" />
        <span className="contribution-detail-name">{slice.name}</span>
        <span className="contribution-detail-share">{Math.round(slice.share * 100)}% of commit</span>
      </div>

      <div className="contribution-detail-figures">
        <span className="contribution-detail-ms">{formatReactMs(slice.ms)}</span>
        {secondary ? <span className="contribution-detail-secondary">{secondary}</span> : null}
      </div>

      {culprit ? (
        <>
          {via ? (
            <p className="contribution-detail-line" title={via}>
              <span className="contribution-detail-label">via</span>
              {via}
            </p>
          ) : null}
          {culprit.sourceHint ? (
            <p className="contribution-detail-line">
              <span className="contribution-detail-label">file</span>
              <code title={culprit.sourceHint}>{shortLocationLabel(culprit.sourceHint)}</code>
            </p>
          ) : null}
          <p className="contribution-detail-shape">{reactCulpritShape(culprit)}</p>
        </>
      ) : (
        <p className="contribution-detail-shape">{residualText(card, slice)}</p>
      )}

      {onExplore ? (
        <div className="contribution-detail-actions">
          <button type="button" className="contribution-detail-open" onClick={onExplore}>
            {culprit ? "Find this render in Explore →" : "Open the commit in Explore →"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
