/**
 * A React commit's cost as parts of a whole.
 *
 * The React counterpart of `contribution.ts`, and it exists for the reason that
 * one does: the card used to draw its components as a list of rows, each with
 * its own bar measured against the commit. Eight bars against a common baseline
 * share no visual whole, so a reader could see that `MerchantLeaderboard` was
 * 52% of the commit and still had to add up for themselves that the two named
 * components were 88% of it and that the rest was the reconciler.
 *
 * One level, not two. A commit has no second level of measurement to open into:
 * React reports a self time per fiber and nothing about what ran inside one, so
 * the equivalent of the task chart's drill-down does not exist in the export.
 * What a component's slice opens is the commit in Explore.
 *
 * The level is an honest partition, which is what makes it drawable as parts of
 * a whole. Self time inside a commit belongs to exactly one fiber, every fiber
 * is either a culprit or in the tail, and the card measures the reconciler's
 * own share as whatever the fibers did not claim:
 *
 *     sum(culprit.selfMs) + culpritTailMs + unattributedMs === durationMs
 *
 * Inclusive time could not be drawn this way — a parent and its child both
 * claim the same milliseconds, so the parts would sum past the commit.
 */

import { CHART_SLICES, MIN_SLICE_SHARE } from "./contribution.ts";
import type { ReactCard, ReactCardCulprit } from "./react-cards.ts";

/**
 * What a slice stands for. Only `component` is a fiber that rendered; the other
 * two are the residuals that make the commit add up, and each is a different
 * statement about where the unnamed time went.
 */
export type ReactSliceKind =
  /** One component's own render time. */
  | "component"
  /** Components too small to draw, or past the eight the chart holds. */
  | "tail"
  /** React itself: walking the tree and committing it, inside no component's body. */
  | "outside";

export interface ReactSlice {
  /** Stable across renders — a component id, or the residual's kind. */
  key: string;
  kind: ReactSliceKind;
  name: string;
  /** Share of the commit, 0-1. The width or area the slice is drawn at. */
  share: number;
  /** The component's own render time, or the residual's. */
  ms: number;
  /**
   * Which categorical slot paints this slice, counting from 0, or -1 for a
   * residual. Fixed by the slice's own place in the ranking, never by how many
   * slices survived the fold, so a colour means one component rather than one
   * position.
   */
  colorIndex: number;
  /** The component this slice is, when it is one. */
  culprit?: ReactCardCulprit;
  /** How many components the `tail` slice stands for. */
  tailCount?: number;
}

const round1 = (value: number) => Math.round(value * 10) / 10;

/**
 * The commit divided by component, then the two residuals.
 *
 * The residuals are slices rather than footnotes because they are the same kind
 * of claim as the others — this much of the commit went here — and because a
 * bar that stops at 88% with no mark for the rest invites the reader to read
 * 88% as the whole. They were footnotes on this card once, and were cut for
 * being arithmetic about time nobody could act on; as slices they are the two
 * answers to the question the drawing itself raises.
 */
export function reactCommitSlices(card: ReactCard): ReactSlice[] {
  const duration = card.durationMs;
  if (duration <= 0) return [];

  const slices: ReactSlice[] = [];
  let shownMs = 0;
  // `colorIndex` counts the components offered a slot, not the ones that took
  // one: a component folded into the tail must not shift the colour of the one
  // below it, or the palette would change with the fold.
  for (const [index, culprit] of card.culprits.slice(0, CHART_SLICES).entries()) {
    const share = culprit.selfMs / duration;
    if (share < MIN_SLICE_SHARE) continue;
    shownMs += culprit.selfMs;
    slices.push({
      key: culprit.componentId,
      kind: "component",
      name: culprit.component,
      share,
      ms: culprit.selfMs,
      colorIndex: index,
      culprit,
    });
  }

  // Culprits folded by the share floor or by the eight-slot cap are already
  // outside the drawing, so the tail is the difference between every component
  // the card measured and the ones drawn — whatever folded them.
  const culpritMs = card.culprits.reduce((sum, culprit) => sum + culprit.selfMs, 0);
  const tailMs = card.culpritTailMs + Math.max(0, culpritMs - shownMs);
  const tailCount = card.culpritTailCount + (card.culprits.length - slices.length);
  if (tailCount > 0 && tailMs / duration >= MIN_SLICE_SHARE) {
    slices.push({
      key: "tail",
      kind: "tail",
      name: tailCount === 1 ? "1 smaller component" : `${tailCount} smaller components`,
      share: tailMs / duration,
      ms: round1(tailMs),
      colorIndex: -1,
      tailCount,
    });
  }

  if (card.unattributedMs / duration >= MIN_SLICE_SHARE) {
    slices.push({
      key: "outside",
      kind: "outside",
      name: "React itself, no component",
      share: card.unattributedMs / duration,
      ms: card.unattributedMs,
      colorIndex: -1,
    });
  }

  return slices;
}
