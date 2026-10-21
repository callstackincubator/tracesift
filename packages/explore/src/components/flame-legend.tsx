"use client";

/**
 * The library's own floors, both of which the zoom has to divide: a frame
 * narrower than the first is not drawn at all, and one narrower than the second
 * is drawn without its name. Both are shares of the canvas rather than of what
 * the reader sees, and at 64× the canvas is sixty-four screens wide — so a box
 * filling the window outright is 1.6% of it, and the unscaled floors would leave
 * it blank with its name only in the tooltip.
 */
export const DEFAULT_MIN_FRAME_WIDTH = 0.08;
export const DEFAULT_MIN_LABEL_WIDTH = 3;

export type TreeMode = "full" | "focused";

/**
 * The buckets `FlameGraph` colours frames by, and what the share is of.
 *
 * The library ships its own legend, but its labels ("Heaviest (>70%)") name a
 * percentage without saying of what, which is the one thing that has to be
 * said: a frame's bucket is its own time as a share of the *hottest frame's*
 * own time in this one graph, not of the profile and not of its parent. That is
 * why a field of green around a single red box is the usual shape, and reading
 * it as "almost nothing is hot" is reading it right.
 */
export const FLAME_BUCKETS = [
  ["heaviest", "> 70%"],
  ["heavy", "40\u201370%"],
  ["moderate", "20\u201340%"],
  ["light", "< 20%"],
  ["none", "none"],
] as const;

/** `what` names the figure the colour is of, in the surface's own words. */
export function FlameLegend({ what }: { what: string }) {
  return (
    <div className="flame-legend">
      <span className="flame-legend-lead">Colour is {what}, as a share of the hottest frame&rsquo;s:</span>
      {FLAME_BUCKETS.map(([bucket, label]) => (
        <span key={bucket} className="flame-legend-item">
          <span className="flame-legend-swatch" data-bucket={bucket} />
          {label}
        </span>
      ))}
    </div>
  );
}

/**
 * The two cuts of the same subtree, as a pair of buttons. Shared by the flame
 * graph and the call tree so the one toggle reads the same wherever it appears.
 */
export function TreeModeToggle({ label, mode, onChange }: { label: string; mode: TreeMode; onChange: (mode: TreeMode) => void }) {
  return (
    <div className="timeline-controls">
      <span className="explore-path-label">{label}</span>
      {([["full", "Everything"], ["focused", "Your code only"]] as const).map(([value, text]) => (
        <button
          key={value}
          type="button"
          className={value === mode ? "timeline-zoom is-current" : "timeline-zoom"}
          aria-pressed={value === mode}
          onClick={() => onChange(value)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}
