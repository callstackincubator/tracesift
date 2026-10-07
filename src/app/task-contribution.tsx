"use client";

import { useState } from "react";

import { formatMs } from "@/lib/format";
import {
  boundaryDrillSlices,
  taskBreakdownSlices,
  type ContributionSlice,
} from "@/lib/contribution";
import { taskCardLocations } from "@/lib/frame-location";
import { shortLocationLabel } from "@/lib/source-location";
import { BOUNDARY_MIN_SHARE, type BoundaryFrame, type TaskCard } from "@/lib/task-cards";
import {
  ContributionChart,
  SliceLegend,
  sliceColor,
  type ContributionChartKind,
} from "@/app/contribution-chart";

export type { ContributionChartKind };

/**
 * The task card's evidence: how the block divides between the features it
 * entered, and what burned the time inside whichever one the reader opens.
 *
 * Two levels of one chart rather than two charts stacked, because a reader
 * following a slice downward wants that slice's inside *in its place* — a
 * second chart below the first draws two different wholes at the same width and
 * leaves the reader working out which is which.
 */
export function TaskContribution({
  card,
  kind,
  onFocus,
}: {
  card: TaskCard;
  kind: ContributionChartKind;
  onFocus: (nodeId: string) => void;
}) {
  /** The feature being opened, by node id, or null for the task itself. */
  const [openId, setOpenId] = useState<string | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);

  const open = card.boundaryFrames.find((frame) => frame.nodeId === openId) ?? null;
  const slices = open ? boundaryDrillSlices(open) : taskBreakdownSlices(card);
  // The heaviest slice, so the strip reads as a finding before anyone has
  // touched the chart rather than as an empty box waiting for a hover.
  const active = slices.find((slice) => slice.key === activeKey) ?? slices[0];

  if (slices.length === 0) return null;

  const openFrame = (frame: BoundaryFrame) => {
    setOpenId(frame.nodeId);
    setActiveKey(null);
  };
  const surface = () => {
    setOpenId(null);
    setActiveKey(null);
  };

  // A slice with nothing to open is a residual, and what a reader wants from a
  // residual is the one view that can still name what is in it.
  const activate = (slice: ContributionSlice) => {
    if (slice.boundary) return openFrame(slice.boundary);
    if (slice.culprit) return onFocus(slice.culprit.nodeId);
    return onFocus(open?.nodeId ?? card.tree.id);
  };

  const chart = { slices, active, format: formatMs, onHover: setActiveKey, onOpen: activate };

  return (
    <div className="contribution" data-kind={kind} data-level={open ? "frame" : "task"}>
      {open ? (
        <div className="contribution-crumbs">
          <button type="button" className="contribution-crumb" onClick={surface}>
            ← the whole {formatMs(card.durationMs)}
          </button>
          <span className="contribution-crumb-current">inside {open.name}</span>
        </div>
      ) : null}

      <p className="contribution-lede">
        {open ? (
          <>
            How {open.name}&apos;s {formatMs(open.totalMs)} divides. Each {kind === "bar" ? "band" : "tile"} is
            one function&apos;s own time — these add up, because a sample&apos;s cost belongs to exactly one
            frame.
          </>
        ) : (
          <>
            How the {formatMs(card.durationMs)} divides between the features it entered. Each{" "}
            {kind === "bar" ? "band" : "tile"} is a frame of your own and everything it called — these add up,
            because no two of them overlap. Open one to see what burned its time.
          </>
        )}
      </p>

      <ContributionChart kind={kind} {...chart} />

      <SliceDetail card={card} open={open} slice={active} onOpen={() => activate(active)} onExplore={onFocus} />

      <SliceLegend {...chart} />
    </div>
  );
}

/**
 * What a residual stands for, which is the whole reason a level has one.
 *
 * "Everything else, 2.27 s" is a dead end: a reader asks what is in there and
 * the card has no answer. Each of these is a different statement, and two of
 * them are reasons to stop looking rather than to look harder.
 */
function residualText(open: BoundaryFrame | null, slice: ContributionSlice): string {
  if (slice.kind === "tail") {
    const count = slice.tailCount ?? 0;
    const frames = count === 1 ? "one more frame" : `${count} more frames`;
    return `${frames} of your own were entered in this task, each under ${Math.round(BOUNDARY_MIN_SHARE * 100)}% of it — ${formatMs(slice.ms)} between them. Explore lists them all.`;
  }
  if (slice.kind === "outside") {
    return "No frame of your own was on the stack here: framework and engine the whole way down, between and underneath your features.";
  }
  return `${formatMs(slice.ms)} inside ${open?.name ?? "this frame"} ran in functions each too small to draw a slice for — the cost here is spread rather than concentrated.`;
}

/**
 * The active slice, in full: the figures, where the frame lives, what reached
 * it, and how its calls were shaped. This is where the row list's content went
 * — a reader wanted one row's detail at a time and was given eight copies of
 * it, which is what pushed the chart itself off the screen.
 *
 * It keeps a fixed footprint whichever slice is showing, so hovering across a
 * bar does not make the page jump under the cursor.
 */
function SliceDetail({
  card,
  open,
  slice,
  onOpen,
  onExplore,
}: {
  card: TaskCard;
  open: BoundaryFrame | null;
  slice: ContributionSlice;
  onOpen: () => void;
  onExplore: (nodeId: string) => void;
}) {
  const locations = taskCardLocations(card);
  const frame = slice.boundary ?? slice.culprit;
  const location = frame ? locations.shown(slice.name, frame.location) : undefined;

  // A boundary frame's own body is almost always empty — it is a component that
  // delegates — so the second figure says which of the two readings this is
  // instead of printing the same number twice.
  const secondary = slice.boundary
    ? slice.boundary.selfMs >= 1
      ? `${formatMs(slice.boundary.selfMs)} in its own body`
      : "none of it in its own body"
    : slice.culprit && slice.culprit.totalMs - slice.culprit.selfMs >= 1
      ? `${formatMs(slice.culprit.totalMs)} with callees`
      : undefined;

  return (
    <div className="contribution-detail">
      <div className="contribution-detail-head">
        <span className="contribution-swatch" style={{ background: sliceColor(slice) }} aria-hidden="true" />
        <span className="contribution-detail-name">{slice.name}</span>
        <span className="contribution-detail-share">
          {Math.round(slice.share * 100)}% of {open ? open.name : "task"}
        </span>
      </div>

      <div className="contribution-detail-figures">
        <span className="contribution-detail-ms">{formatMs(slice.ms)}</span>
        {secondary ? <span className="contribution-detail-secondary">{secondary}</span> : null}
      </div>

      {frame ? (
        <>
          {slice.culprit && slice.culprit.callers.length > 0 ? (
            <p className="contribution-detail-line">
              <span className="contribution-detail-label">via</span>
              {slice.culprit.callers.join(" › ")}
            </p>
          ) : null}
          {location ? (
            <p className="contribution-detail-line">
              <span className="contribution-detail-label">file</span>
              <code title={location}>{shortLocationLabel(location)}</code>
            </p>
          ) : null}
          <p className="contribution-detail-shape">{frame.shapeText}</p>
        </>
      ) : (
        <p className="contribution-detail-shape">{residualText(open, slice)}</p>
      )}

      <div className="contribution-detail-actions">
        <button type="button" className="contribution-detail-open" onClick={onOpen}>
          {slice.boundary ? "Show what ran inside →" : "Open in Explore →"}
        </button>
        {slice.boundary ? (
          <button
            type="button"
            className="contribution-detail-aside"
            onClick={() => onExplore(slice.boundary!.nodeId)}
          >
            Open in Explore
          </button>
        ) : null}
      </div>
    </div>
  );
}
