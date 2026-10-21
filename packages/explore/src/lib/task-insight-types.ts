/**
 * The model's reading of one task, as the cards carry it.
 *
 * This is a copy of the `TaskInsight` declared in the app's `lib/task-insight.ts`.
 * The app remains the writer of that field; this package only reads it, and the
 * two shapes are kept in step by hand.
 *
 * The copy exists to sever a type-only import. `lib/task-insight.ts` runs model
 * inference, so it imports the agent SDK and `node:*` through `lib/analysis.ts`.
 * A type-only import is erased from the emitted JavaScript but not from the
 * emitted declarations, so importing the original here would put `node:*` into
 * the package's `.d.ts` files — and into the module graph of anything that
 * bundles this package for a browser.
 */
export interface TaskInsight {
  /** Replaces the card's measured headline. What went wrong, in one line. */
  title: string;
  /** Short, technical bullets: what the issue is, where it originates, what to look at. */
  findings: string[];
}
