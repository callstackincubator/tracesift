/**
 * A task's cost as parts of a whole, at two levels.
 *
 * The card used to render its culprits as a list of rows, each with its own bar
 * measured against the task. That answers "how big is this one function" eight
 * times over and never answers the question a reader actually opens a card
 * with, which is how the 3227 ms was *divided*. Eight bars against a common
 * baseline share no visual whole, so the fact that they account for a third of
 * the task between them was left for the reader to add up.
 *
 * Replacing those rows with one divided bar made the arithmetic visible and
 * exposed the real problem with ranking a card by self time: on the local
 * trace's 3227 ms task the eight heaviest culprits are 30% of it, the whole
 * 60-frame list is 61%, and the residual is 500 distinct frames at a median of
 * 1.2 ms each. A single grey band holding 70% of a task is honest and useless.
 *
 * So the top level divides the task by **boundary frame** — the outermost frame
 * of your own on each branch, which is the feature the work belongs to. Those
 * cover 63% of the same task in eight slices, and the two residuals say
 * something specific rather than "everything else": features too small to draw,
 * and time that never reached your code at all. Opening a slice divides that
 * one feature by **self time**, which is where "what do I change" lives.
 *
 * Both levels are honest partitions, which is what makes them drawable as parts
 * of a whole:
 *
 * - Boundary frames are an antichain — the search stops at the first frame of
 *   yours on a branch, so none is an ancestor of another and their inclusive
 *   times cannot overlap. They sum to at most the task.
 * - Self time is a partition by construction: every sample's weight belongs to
 *   exactly one frame, and summed over a subtree it equals that subtree's
 *   inclusive total exactly. So a drill-down's slices sum to the slice it
 *   opened.
 *
 * Inclusive time could not be drawn this way at any level — a caller and its
 * callee both claim the same milliseconds, so the parts would sum past the
 * whole.
 */

import type { BoundaryCulprit, BoundaryFrame, TaskCard } from "./task-cards.ts";

/**
 * Slices a chart carries before it folds the tail away. The eighth is where a
 * stacked bar runs out of room for a distinguishable fill and a treemap runs
 * out of room for a label; it is also what the server ships at either level.
 */
export const CHART_SLICES = 8;

/**
 * A slice below this much of its level is narrower than its own 2px gap, so it
 * reads as a seam between its neighbours rather than as a part. They fold into
 * the level's residual, which is where the reader's eye goes for "and the rest".
 */
const MIN_SLICE_SHARE = 0.005;

/**
 * What a slice stands for. Only `boundary` and `culprit` are frames that ran;
 * the other three are the residuals that make a level add up to its whole, and
 * each one is a different statement about where the unnamed time went.
 */
export type SliceKind =
  /** A feature of yours: the outermost frame of your own on its branch. */
  | "boundary"
  /** A function whose own body burned the time, inside the feature being opened. */
  | "culprit"
  /** Features too small to draw, or past the eight the server ships. */
  | "tail"
  /** Framework and engine the whole way down — no frame of yours on the stack. */
  | "outside"
  /** Inside one feature: the frames too small to draw a slice for. */
  | "rest";

export interface ContributionSlice {
  /** Stable across renders — a node id, or the residual's kind. */
  key: string;
  kind: SliceKind;
  name: string;
  /** Share of this level's whole, 0-1. The width or area the slice is drawn at. */
  share: number;
  /** The figure the slice is drawn by: inclusive time at the top level, self time inside a feature. */
  ms: number;
  /**
   * Which categorical slot paints this slice, counting from 0, or -1 for a
   * residual. Fixed by the slice's own place in the ranking, never by how many
   * slices survived the fold, so a colour means one frame rather than one
   * position.
   */
  colorIndex: number;
  /** The feature this slice is, when it is one — and what opening it divides. */
  boundary?: BoundaryFrame;
  /** The function this slice is, when it is one. */
  culprit?: BoundaryCulprit;
  /** How many frames the `tail` slice stands for. */
  tailCount?: number;
}

const round1 = (value: number) => Math.round(value * 10) / 10;

/** A residual, or nothing when it is too thin to draw. */
function residual(
  kind: SliceKind,
  name: string,
  ms: number,
  whole: number,
  extra: Partial<ContributionSlice> = {},
): ContributionSlice | undefined {
  if (whole <= 0 || ms / whole < MIN_SLICE_SHARE) return undefined;
  return { key: kind, kind, name, share: ms / whole, ms: round1(ms), colorIndex: -1, ...extra };
}

/**
 * The task divided by feature: one slice per boundary frame, then the two
 * residuals.
 *
 * The residuals are slices rather than footnotes because they are the same kind
 * of claim as the others — this much of the task went here — and because a bar
 * that stops at 63% with no mark for the rest invites the reader to read 63% as
 * the whole.
 */
export function taskBreakdownSlices(card: TaskCard): ContributionSlice[] {
  const duration = card.durationMs;
  if (duration <= 0) return [];

  const slices: ContributionSlice[] = [];
  let shownMs = 0;
  // Capped here as well as on the server: there are `CHART_SLICES` palette
  // slots, and a ninth slice would ask for a colour that does not exist and be
  // painted with nothing. A saved analysis outlives the constant that produced
  // it, so the view cannot assume the server's cap was this one.
  //
  // `colorIndex` counts the frames offered a slot, not the ones that took one:
  // a frame folded into the tail must not shift the colour of the frame below
  // it, or the palette would change with the fold.
  for (const [index, boundary] of card.boundaryFrames.slice(0, CHART_SLICES).entries()) {
    const share = boundary.totalMs / duration;
    if (share < MIN_SLICE_SHARE) continue;
    shownMs += boundary.totalMs;
    slices.push({
      key: boundary.nodeId,
      kind: "boundary",
      name: boundary.name,
      share,
      ms: boundary.totalMs,
      colorIndex: index,
      boundary,
    });
  }

  // Frames folded by the share floor above are already counted in the server's
  // tail, so the two cannot be added — the difference between what the task was
  // and what is drawn is the tail, whatever folded it.
  const drawnBoundaryMs = card.boundaryFrames.reduce((sum, frame) => sum + frame.totalMs, 0);
  const tailMs = card.boundaryTailMs + Math.max(0, drawnBoundaryMs - shownMs);
  const tailCount = card.boundaryTailCount + (card.boundaryFrames.length - slices.length);
  const tail = residual(
    "tail",
    tailCount === 1 ? "1 smaller entry point" : `${tailCount} smaller entry points`,
    tailMs,
    duration,
    { tailCount },
  );
  if (tail && tailCount > 0) slices.push(tail);

  const outside = residual("outside", "never entered your code", card.outsideBoundariesMs, duration);
  if (outside) slices.push(outside);
  return slices;
}

/**
 * One feature divided by what burned its time: its culprits by self time, then
 * whatever is spread too thin to draw.
 *
 * The whole here is the feature's inclusive time, not the task's, because the
 * question at this level is how `Search_Search` spent its 562 ms — a slice
 * measured against the task again would redraw the slice the reader just
 * opened, at a ninth of the width.
 */
export function boundaryDrillSlices(boundary: BoundaryFrame): ContributionSlice[] {
  const whole = boundary.totalMs;
  if (whole <= 0) return [];

  const slices: ContributionSlice[] = [];
  let named = 0;
  // Capped for the same reason as the level above; what is cut lands in the
  // residual below, which is measured as whatever the slices did not claim.
  for (const [index, culprit] of boundary.culprits.slice(0, CHART_SLICES).entries()) {
    const share = culprit.selfMs / whole;
    if (share < MIN_SLICE_SHARE) continue;
    named += culprit.selfMs;
    slices.push({
      key: culprit.nodeId,
      kind: "culprit",
      name: culprit.name,
      share,
      ms: culprit.selfMs,
      colorIndex: index,
      culprit,
    });
  }

  const rest = residual("rest", "spread too thin to draw", Math.max(0, whole - named), whole);
  if (rest) slices.push(rest);
  return slices;
}

export interface TreemapRect {
  /** Fractions of the container's width and height, 0-1, so CSS can use percentages. */
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Squarified treemap layout: areas proportional to `values`, tiles as near
 * square as the values allow.
 *
 * The naive alternative — slice-and-dice, one cut per value — produces slivers
 * a label cannot sit in as soon as the values are skewed, and a task's frames
 * are always skewed. This is Bruls, Huizing and van Wijk's algorithm: fill the
 * free rectangle's shorter side with a row, admitting values into that row
 * while doing so improves the row's worst aspect ratio, then recurse on what is
 * left.
 *
 * `aspect` is the container's height over its width. Returned rects are
 * normalised back to 0-1 on both axes, so the caller can position them as
 * percentages without knowing the pixel size.
 */
export function squarify(values: readonly number[], aspect: number): TreemapRect[] {
  const empty = { x: 0, y: 0, w: 0, h: 0 };
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total <= 0 || aspect <= 0) return values.map(() => empty);

  // Laid out in a container one unit wide and `aspect` tall, so an area is
  // comparable with a length and the aspect ratios below are the real ones.
  const areas = values.map((value) => (value / total) * aspect);
  const out: TreemapRect[] = values.map(() => empty);

  let free = { x: 0, y: 0, w: 1, h: aspect };
  let index = 0;
  while (index < areas.length) {
    const short = Math.min(free.w, free.h);
    const row: number[] = [];
    let rowArea = 0;
    let worst = Infinity;
    while (index + row.length < areas.length) {
      const next = areas[index + row.length];
      const ratio = worstRatio([...row, next], short, rowArea + next);
      if (row.length > 0 && ratio > worst) break;
      row.push(next);
      rowArea += next;
      worst = ratio;
    }

    // The row is laid along the shorter side; its thickness is whatever makes
    // its area come out right, which is what keeps the areas exact.
    const thickness = rowArea / short;
    const alongWidth = free.w <= free.h;
    let offset = 0;
    for (const area of row) {
      const length = area / thickness;
      out[index++] = alongWidth
        ? { x: free.x + offset, y: free.y / aspect, w: length, h: thickness / aspect }
        : { x: free.x, y: (free.y + offset) / aspect, w: thickness, h: length / aspect };
      offset += length;
    }
    free = alongWidth
      ? { x: free.x, y: free.y + thickness, w: free.w, h: free.h - thickness }
      : { x: free.x + thickness, y: free.y, w: free.w - thickness, h: free.h };
  }
  return out;
}

/** The worst aspect ratio in a row of `areas` laid across `short`, 1 being square. */
function worstRatio(areas: readonly number[], short: number, sum: number): number {
  const thickness = sum / short;
  let worst = 1;
  for (const area of areas) {
    const length = area / thickness;
    worst = Math.max(worst, thickness / length, length / thickness);
  }
  return worst;
}
