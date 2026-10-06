/**
 * Handing one card to the drill-down tab.
 *
 * A node-descent card carries its own truncated subtree, so the new tab needs
 * no server round trip for one and the analysis record stays where it is.
 * `sessionStorage` is the right lifetime — the data should not outlive the browsing session —
 * but a tab opened with `window.open` does not reliably inherit it in every
 * browser, so the same payload is mirrored to `localStorage` and deleted as
 * soon as the drill-down has read it. A task card is far too large for that —
 * it ships the task's call tree whole — so it is fetched instead; see
 * `taskExploreHref`.
 */

import type { ProfileCard } from "./profile-cards";
import type { TaskCard } from "./task-cards";
import type { ReactCard } from "./react-cards";
import type { ReactExplore } from "./react-explore";

export interface CardHandoff {
  analysisId: string;
  totalMs: number;
  callCountIsExact: boolean;
  profileTitle?: string;
  card: ProfileCard;
}

export interface TaskHandoff {
  analysisId: string;
  totalMs: number;
  profileTitle?: string;
  card: TaskCard;
}

export function cardHandoffKey(analysisId: string, cardId: string): string {
  return `tracesift:card:${analysisId}:${cardId}`;
}

function store(key: string, payload: unknown): void {
  const serialized = JSON.stringify(payload);
  for (const target of [globalThis.sessionStorage, globalThis.localStorage]) {
    try { target?.setItem(key, serialized); } catch { /* a full or blocked store is not worth failing the click over */ }
  }
}

function read<T>(key: string): T | null {
  for (const target of [globalThis.sessionStorage, globalThis.localStorage]) {
    let raw: string | null = null;
    try { raw = target?.getItem(key) ?? null; } catch { continue; }
    if (!raw) continue;
    // The mirror exists only to survive the hop between tabs.
    try { globalThis.localStorage?.removeItem(key); } catch { /* nothing to clean up */ }
    try { return JSON.parse(raw) as T; } catch { return null; }
  }
  return null;
}

export function storeCardForExplore(handoff: CardHandoff): string {
  store(cardHandoffKey(handoff.analysisId, handoff.card.id), handoff);
  return `/explore?a=${encodeURIComponent(handoff.analysisId)}&c=${encodeURIComponent(handoff.card.id)}`;
}

export function readCardHandoff(analysisId: string, cardId: string): CardHandoff | null {
  return read<CardHandoff>(cardHandoffKey(analysisId, cardId));
}

/**
 * Explore is handed the whole task and opened on one frame inside it. Dropping
 * `focus` shows the task entire, which is what a click on the card header
 * means; passing one opens on that frame with its ancestors folded away,
 * because the top of a task is a wall of scheduler and reconciler frames and
 * rooting the first screen there is useless.
 *
 * Nothing is stored on the way out: a task card carries the task's whole call
 * tree, which is megabytes on a long task and does not fit in `sessionStorage`.
 * The new tab fetches it from `/api/task-card` instead.
 */
export function taskExploreHref(analysisId: string, taskIndex: number, focusNodeId?: string): string {
  const focus = focusNodeId ? `&focus=${encodeURIComponent(focusNodeId)}` : "";
  return `/explore?a=${encodeURIComponent(analysisId)}&task=${taskIndex}${focus}`;
}

export async function fetchTaskHandoff(analysisId: string, taskIndex: number): Promise<TaskHandoff> {
  const response = await fetch(`/api/task-card?a=${encodeURIComponent(analysisId)}&task=${taskIndex}`);
  const body = (await response.json()) as Partial<TaskHandoff> & { error?: string };
  if (!response.ok || !body.card) {
    throw new Error(body.error ?? "That task could not be loaded.");
  }
  return body as TaskHandoff;
}

export interface ReactExploreHandoff {
  analysisId: string;
  profileTitle?: string;
  explore: ReactExplore;
  /** The cards, so the drill-down can name the commits that produced one. */
  cards: ReactCard[];
}

/**
 * The React drill-down opens on one commit of a recording it holds whole.
 *
 * `commit` is `<rootId>.<commitIndex>` rather than a card id, because the strip
 * can reach every commit in the recording and most of them never produced a
 * card. Nothing is stored on the way out; see `/api/react-commit`.
 */
export function reactExploreHref(analysisId: string, rootId: number, commitIndex: number): string {
  return `/explore?a=${encodeURIComponent(analysisId)}&commit=${rootId}.${commitIndex}`;
}

export async function fetchReactExplore(analysisId: string): Promise<ReactExploreHandoff> {
  const response = await fetch(`/api/react-commit?a=${encodeURIComponent(analysisId)}`);
  const body = (await response.json()) as Partial<ReactExploreHandoff> & { error?: string };
  if (!response.ok || !body.explore) {
    throw new Error(body.error ?? "That recording could not be loaded.");
  }
  return body as ReactExploreHandoff;
}
