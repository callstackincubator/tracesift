/**
 * The data an Explore view is opened with.
 *
 * Nothing here says where the data came from. The Next app hands these over
 * after reading `localStorage` or fetching `/api/task-card`; the plugin hands
 * them over from the hand-off its own server exposes. The views are given a
 * value and render it, which is the whole of the contract between the two
 * hosts.
 */

import type { ProfileCard } from "./lib/profile-cards.ts";
import type { TaskCard } from "./lib/task-cards.ts";
import type { ReactCard } from "./lib/react-cards.ts";
import type { ReactExplore } from "./lib/react-explore.ts";

/** One node-descent card and its subtree. The legacy `?c=` drill-down. */
export interface CardHandoff {
  analysisId: string;
  totalMs: number;
  callCountIsExact: boolean;
  profileTitle?: string;
  card: ProfileCard;
}

/**
 * One task, opened on one frame inside it.
 *
 * A task card carries the task's call tree whole, which is megabytes on a long
 * task, so this is fetched rather than passed through storage.
 */
export interface TaskHandoff {
  analysisId: string;
  totalMs: number;
  profileTitle?: string;
  card: TaskCard;
}

/**
 * One React recording, with every commit the strip draws.
 *
 * `commit` is `<rootId>.<commitIndex>` rather than a card id, because the strip
 * reaches every commit and most of them never produced a card.
 */
export interface ReactExploreHandoff {
  analysisId: string;
  profileTitle?: string;
  explore: ReactExplore;
  /** The cards, so the drill-down can name the commits that produced one. */
  cards: ReactCard[];
}
