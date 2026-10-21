"use client";

import { useMemo } from "react";
import { EmptyState } from "@rozenite/ui";

import { ChartNotes, STRETCH_ZOOM_NOTE, ZOOM_HINT } from "./chart-notes.tsx";
import { useStretchZoom, ZoomControls } from "./stretch-zoom.tsx";
import { pickedClass, pickNumber, picking, PickTick, type FrameSelection } from "./frame-selection.tsx";
import { formatMs } from "../lib/format.ts";
import type { TaskTimeline, TimelineBox } from "../lib/task-timeline.ts";

export const ROW_HEIGHT = 22;

/** Round tick spacing: a ruler labelled 322.7 ms apart is a ruler nobody reads. */
export function tickStepMs(visibleMs: number): number {
  const rough = visibleMs / 10;
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(rough, 0.001)));
  for (const step of [1, 2, 5, 10]) {
    if (rough <= step * magnitude) return step * magnitude;
  }
  return 10 * magnitude;
}

/**
 * The task against the clock, which is the view a reader arrives with after
 * seeing the block in Chrome's Performance panel.
 *
 * Positions are percentages of the task's duration, so the chart fits its
 * container at zoom 1 with nothing measured, and zooming is one width on the
 * scrolling element. The framework and the engine have been collapsed away
 * upstream, so a frame that really sat twelve deep under the reconciler is
 * drawn on the first row — and the stretches where nothing but framework or
 * engine code was on the stack are left as gaps rather than filled in, because
 * they were not idle and the chart must not imply they were.
 */
export function TaskTimelineChart({
  timeline,
  focusId,
  onFocus,
  selection,
}: {
  timeline: TaskTimeline;
  focusId: string;
  onFocus: (nodeId: string) => void;
  /** When picking, a click adds this box to the set instead of moving the focus. */
  selection?: FrameSelection;
}) {
  const { zoom, viewport, canvas, readout, jumpTo } = useStretchZoom();
  const { durationMs } = timeline;

  const ticks = useMemo(() => {
    const step = tickStepMs(durationMs / zoom);
    const out: number[] = [];
    for (let at = 0; at <= durationMs; at += step) out.push(at);
    return out;
  }, [durationMs, zoom]);

  if (timeline.boxes.length === 0) {
    return (
      <EmptyState
        title="Nothing to draw in this task"
        description="Every frame the profiler recorded in this block was React or engine code, so there is nothing left once they are collapsed. The call tree still holds all of it."
      />
    );
  }

  const uncoveredMs = Math.max(0, durationMs - timeline.coveredMs);
  const percent = (value: number) => `${(value / durationMs) * 100}%`;

  return (
    <div className="timeline">
      <div className="timeline-controls">
        <ZoomControls zoom={zoom} jumpTo={jumpTo} readout={readout} />
        <span className="timeline-legend">
          {formatMs(timeline.coveredMs)} of {formatMs(durationMs)} under your code, a dependency or a built-in it
          called
          {uncoveredMs > 0.5 ? ` · ${formatMs(uncoveredMs)} in React or unnamed engine code` : ""}
          {timeline.omittedBoxCount > 0
            ? ` · ${timeline.omittedBoxCount} calls too short or too many to draw`
            : ""}
        </span>
      </div>

      <div className="timeline-scroll" ref={viewport}>
        <div className="timeline-canvas" ref={canvas} style={{ width: `${zoom * 100}%` }}>
          <div className="timeline-ruler">
            {ticks.map((at) => (
              <span key={at} className="timeline-tick" style={{ left: percent(at) }}>
                {formatMs(at)}
              </span>
            ))}
          </div>
          <div className="timeline-rows" style={{ height: `${timeline.rows * ROW_HEIGHT}px` }}>
            {timeline.boxes.map((box, index) => (
              <TimelineBoxView
                key={`${box.nodeId}-${index}`}
                box={box}
                percent={percent}
                selected={box.nodeId === focusId}
                onFocus={onFocus}
                {...(selection ? { selection } : {})}
              />
            ))}
          </div>
        </div>
      </div>
      <ChartNotes
        reading={<>One box is one call, drawn where it ran. Width is how long it took.</>}
        controls={ZOOM_HINT}
        caveats={[
          STRETCH_ZOOM_NOTE,
          <>
            <strong>Rows are not stack depth.</strong> React frames, and engine frames that name nothing, are
            collapsed away, so a box&rsquo;s row is its depth on this chart.
          </>,
          <>
            A built-in the code called by name &mdash; a date formatter, a locale comparison, a sort &mdash; is kept
            and drawn in a paler fill: it is engine code, and still a cost the code above it controls.
          </>,
          <>
            <strong>Drawn at sample resolution.</strong> Two calls closer together than one sample merge, and one
            shorter than a sample may not appear.
          </>,
          <>
            <strong>Spans are wall clock.</strong> A box covers the framework work its call delegated to and any
            collection pause that fell inside it. The card&rsquo;s longest-call figure counts neither, which is why a
            box can read slightly wider.
          </>,
        ]}
      />
    </div>
  );
}

/**
 * How long the call took, and where it sat.
 *
 * Only the outermost box names its start. An offset is read against the start
 * of the task, and on a nested box that invites the reader to subtract it from
 * the parent's — which is wrong, because the two are measured from the same
 * origin rather than from each other, so `278 ms from 550 ms` under `678 ms
 * from 394 ms` reads as a call that began 550 ms into its parent. The duration
 * is the figure a nested box is there to give.
 */
export function timingLine(box: TimelineBox): string {
  const own = `${formatMs(box.selfMs)} of its own`;
  if (box.depth > 0) return `${formatMs(box.durationMs)}, ${own}`;
  return `${formatMs(box.durationMs)} from ${formatMs(box.startMs)}, ${own}`;
}

export function TimelineBoxView({
  box,
  percent,
  selected,
  onFocus,
  selection,
}: {
  box: TimelineBox;
  percent: (value: number) => string;
  selected: boolean;
  onFocus: (nodeId: string) => void;
  /** When picking, a click adds this box to the set instead of moving the focus. */
  selection?: FrameSelection;
}) {
  const pickingNow = picking(selection);
  const picked = pickedClass(selection, box.nodeId);
  const number = pickNumber(selection, box.nodeId);
  return (
    <button
      type="button"
      className={[
        "timeline-box",
        ...(selected ? ["is-selected"] : []),
        ...(picked ? [picked] : []),
      ].join(" ")}
      // A built-in the product called is drawn like any other box and must not
      // read like code the reader wrote: the fill is what says `engine`.
      data-class={box.frameClass}
      aria-pressed={pickingNow ? number !== undefined : undefined}
      style={{ left: percent(box.startMs), width: percent(box.durationMs), top: `${box.depth * ROW_HEIGHT}px` }}
      title={`${box.name}\n${timingLine(box)}${box.location ? `\n${box.location}` : ""}${number === undefined ? "" : `\nSelected for investigation (#${number})`}`}
      onClick={() => (pickingNow ? selection?.onToggleSelection(box.nodeId) : onFocus(box.nodeId))}
    >
      <span>
        <PickTick selection={selection} nodeId={box.nodeId} />
        {box.name}
      </span>
    </button>
  );
}
