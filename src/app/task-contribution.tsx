"use client";

import { useState } from "react";

import { formatMs } from "@/lib/format";
import {
  boundaryDrillSlices,
  taskBreakdownSlices,
  squarify,
  type ContributionSlice,
} from "@/lib/contribution";
import { taskCardLocations } from "@/lib/frame-location";
import { BOUNDARY_MIN_SHARE, type BoundaryFrame, type TaskCard } from "@/lib/task-cards";

/**
 * Which drawing a task card carries. Both are part-of-whole readings of the
 * same slices, so they are interchangeable and one of them will be deleted once
 * we have looked at real traces in each.
 */
export type ContributionChartKind = "bar" | "treemap";

/**
 * The treemap's shape, fixed rather than measured. The layout needs the
 * container's aspect ratio before it can place a tile, and taking it from the
 * DOM means a first paint with no tiles, a resize observer, and a relayout on
 * every card. A ratio the CSS also holds costs nothing and is the same number
 * on every card.
 */
const TREEMAP_ASPECT_W = 16;
const TREEMAP_ASPECT_H = 5;

/**
 * A nominal pixel size for the treemap, used only to decide which tiles are
 * big enough to label. The real box is fluid, so this errs on the narrow side —
 * a label that would collide is worth losing more than a tile that could have
 * held one.
 */
const TREEMAP_NOMINAL_WIDTH = 880;
const TREEMAP_LABEL_MIN_PX = 66;
const TREEMAP_FIGURE_MIN_PX = 30;

/**
 * A frame takes a palette slot; a residual takes neutral ink. The two residuals
 * at the top level sit side by side and mean opposite things — code of yours
 * that is merely small, and code that was never yours — so they cannot share a
 * fill or they read as one band.
 */
const sliceColor = (slice: ContributionSlice) => {
  if (slice.colorIndex >= 0) return `var(--series-${slice.colorIndex + 1})`;
  if (slice.kind === "tail") return "var(--series-tail)";
  if (slice.kind === "outside") return "var(--series-outside)";
  return "var(--series-rest)";
};

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

  const chart = { slices, active, onHover: setActiveKey, onOpen: activate };

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

      {kind === "bar" ? <ContributionBar {...chart} /> : <ContributionTreemap {...chart} />}

      <SliceDetail card={card} open={open} slice={active} onOpen={() => activate(active)} onExplore={onFocus} />

      <SliceLegend slices={slices} active={active} onHover={setActiveKey} onOpen={activate} />
    </div>
  );
}

interface ChartProps {
  slices: ContributionSlice[];
  active: ContributionSlice;
  onHover: (key: string | null) => void;
  onOpen: (slice: ContributionSlice) => void;
}

const sliceLabel = (slice: ContributionSlice) =>
  `${slice.name}, ${formatMs(slice.ms)}, ${Math.round(slice.share * 100)}%`;

/**
 * One bar, the level's whole wide, divided into its slices.
 *
 * Percentages rather than flex growth: a slice's width is its share, and
 * `flex-grow` would quietly redistribute the 2px gaps between fills into the
 * widths and make the drawing wrong by a few milliseconds per slice.
 */
function ContributionBar({ slices, active, onHover, onOpen }: ChartProps) {
  return (
    <div className="contribution-bar" onMouseLeave={() => onHover(null)}>
      {slices.map((slice) => (
        <button
          type="button"
          key={slice.key}
          className={`contribution-band${slice.key === active.key ? " is-active" : ""}${slice.kind === "outside" ? " is-outside" : ""}`}
          style={{ width: `${slice.share * 100}%`, background: sliceColor(slice) }}
          onMouseEnter={() => onHover(slice.key)}
          onFocus={() => onHover(slice.key)}
          onClick={() => onOpen(slice)}
          aria-label={sliceLabel(slice)}
        />
      ))}
    </div>
  );
}

/** The same slices as area. Tiles carry their own labels, so the fills are never alone in naming them. */
function ContributionTreemap({ slices, active, onHover, onOpen }: ChartProps) {
  const rects = squarify(
    slices.map((slice) => slice.share),
    TREEMAP_ASPECT_H / TREEMAP_ASPECT_W,
  );
  const nominalHeight = (TREEMAP_NOMINAL_WIDTH * TREEMAP_ASPECT_H) / TREEMAP_ASPECT_W;

  return (
    <div
      className="contribution-treemap"
      style={{ aspectRatio: `${TREEMAP_ASPECT_W} / ${TREEMAP_ASPECT_H}` }}
      onMouseLeave={() => onHover(null)}
    >
      {slices.map((slice, index) => {
        const rect = rects[index];
        const named = rect.w * TREEMAP_NOMINAL_WIDTH >= TREEMAP_LABEL_MIN_PX
          && rect.h * nominalHeight >= TREEMAP_FIGURE_MIN_PX;
        return (
          <button
            type="button"
            key={slice.key}
            className={`contribution-tile${slice.key === active.key ? " is-active" : ""}${slice.kind === "outside" ? " is-outside" : ""}${slice.colorIndex < 0 ? " is-neutral" : ""}`}
            style={{
              left: `${rect.x * 100}%`,
              top: `${rect.y * 100}%`,
              width: `${rect.w * 100}%`,
              height: `${rect.h * 100}%`,
              background: sliceColor(slice),
            }}
            onMouseEnter={() => onHover(slice.key)}
            onFocus={() => onHover(slice.key)}
            onClick={() => onOpen(slice)}
            aria-label={sliceLabel(slice)}
          >
            {named ? (
              <span className="contribution-tile-copy">
                <span className="contribution-tile-name">{slice.name}</span>
                <span className="contribution-tile-figure">
                  {formatMs(slice.ms)} · {Math.round(slice.share * 100)}%
                </span>
              </span>
            ) : null}
          </button>
        );
      })}
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
              <code>{location}</code>
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

/**
 * Names and figures for every slice, in rank order.
 *
 * Present on both charts and not negotiable on either: it is what keeps
 * identity off colour alone, and it is the table view of the same numbers for a
 * reader who wants to compare them rather than look at them.
 */
function SliceLegend({
  slices,
  active,
  onHover,
  onOpen,
}: {
  slices: ContributionSlice[];
  active: ContributionSlice;
  onHover: (key: string | null) => void;
  onOpen: (slice: ContributionSlice) => void;
}) {
  return (
    <ul className="contribution-legend" onMouseLeave={() => onHover(null)}>
      {slices.map((slice) => (
        <li key={slice.key}>
          <button
            type="button"
            className={`contribution-legend-row${slice.key === active.key ? " is-active" : ""}`}
            onMouseEnter={() => onHover(slice.key)}
            onFocus={() => onHover(slice.key)}
            onClick={() => onOpen(slice)}
          >
            <span className="contribution-swatch" style={{ background: sliceColor(slice) }} aria-hidden="true" />
            <span className="contribution-legend-name">{slice.name}</span>
            <span className="contribution-legend-ms">{formatMs(slice.ms)}</span>
            <span className="contribution-legend-share">{Math.round(slice.share * 100)}%</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
