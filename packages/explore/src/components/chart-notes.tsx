import type { ReactNode } from "react";

/**
 * The notes under a chart, split by the job each one does.
 *
 * Every view on this page had grown the same paragraph: how to drive the chart,
 * how to read it, and what it does not measure, all in one italic run. The
 * three are read at different moments — the reading key once, on arrival; the
 * controls when a reader wants to move; the caveats only when a figure looks
 * wrong — so stacking them in one block means the reader who wants any one of
 * them reads past the other two.
 *
 * So: the key is a line, upright, always there. The controls are a hint beside
 * it. The caveats are a list, because that is what they are — independent facts
 * in no particular order — and they are folded away, because a reader who has
 * not yet doubted a number has no use for them.
 */
export function ChartNotes({ reading, controls, caveats }: {
  reading?: ReactNode;
  controls?: ReactNode;
  caveats?: ReactNode[];
}) {
  // A conditional bullet is passed as `null` rather than spliced out by the
  // caller, so the list is filtered here instead of at every call site.
  const shown = (caveats ?? []).filter(Boolean);

  return (
    <div className="chart-notes">
      {reading ? <p className="chart-notes-reading">{reading}</p> : null}
      {controls ? <p className="chart-notes-controls">{controls}</p> : null}
      {shown.length > 0 ? (
        <details className="chart-notes-caveats">
          <summary>What this doesn&rsquo;t show</summary>
          <ul>
            {shown.map((caveat, index) => <li key={index}>{caveat}</li>)}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

/** The gesture every zooming chart here shares, worded once. */
export const ZOOM_HINT = "⌘/Ctrl + scroll to zoom about the pointer";

/** Why that zoom looks unlike the one a reader expects, worded once. */
export const STRETCH_ZOOM_NOTE =
  "Zoom stretches the chart and scrolls it sideways, so a thin box widens where it sits rather than being re-drawn on its own.";
