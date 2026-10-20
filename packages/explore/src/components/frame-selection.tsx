"use client";

/**
 * Picking frames out of the four task views, so a host can ask about them.
 *
 * Focus and selection are different things and stay separate. Focus is which
 * frame the view is rooted at: exactly one, and moving it re-roots all four
 * views. A selection is a set the reader is assembling, it survives moving the
 * focus, and it is what a host turns into a question. Keeping the two apart is
 * what lets a reader pick four frames on the timeline, then open the call tree
 * on one of them and still see the other three ringed there.
 *
 * One identity serves every view because all four already address a frame the
 * same way: a `TaskTreeNode.id`, the dotted sibling path over the merged call
 * tree. A timeline box carries the node it came from as `nodeId`, a culprit
 * names its heaviest node, a flame box takes its `id` straight from the tree,
 * so one set of ids lights up all four.
 *
 * The host owns the state and the affordance. `enabled` is the host's own
 * toggle — the views have no switch of their own, because a host with no use for
 * selection should not show one — and `selectedNodeIds` is read straight back,
 * so a host that holds them in its router, its store or nowhere at all is the
 * only difference between one consumer and another.
 */
export interface FrameSelection {
  /** Whether frames can be picked right now. False leaves every view exactly as it was. */
  enabled: boolean;
  /** The picked frames, as `TaskTreeNode.id`s, in the order the reader chose them. */
  selectedNodeIds: readonly string[];
  /**
   * A frame was clicked while `enabled`. The view does not move the focus for
   * it: the host adds or removes the id and reports the new set back through
   * `selectedNodeIds`, which is what keeps all four views in step.
   */
  onToggleSelection: (nodeId: string) => void;
}

/** Whether clicking a frame picks it rather than navigating to it. */
export function picking(selection: FrameSelection | undefined): boolean {
  return selection?.enabled === true;
}

/** Whether this id is in the selection. An absent selection picks nothing. */
export function isSelected(selection: FrameSelection | undefined, nodeId: string): boolean {
  return selection?.selectedNodeIds.includes(nodeId) === true;
}

/**
 * Which of the reader's picks this frame is, counting from one, or nothing when
 * it is not one of them.
 *
 * The order is the order they chose rather than the order any view draws frames
 * in, so one frame carries the same number on the timeline, in the tree, among
 * the culprits and in the graph, and a host that lists them in a prompt can
 * number that list to match what the reader saw.
 */
export function pickNumber(selection: FrameSelection | undefined, nodeId: string): number | undefined {
  const at = selection?.selectedNodeIds.indexOf(nodeId) ?? -1;
  return at < 0 ? undefined : at + 1;
}

/**
 * Whether a name can be picked at all.
 *
 * Every task's tree starts at a synthetic `(root)` that is a join point rather
 * than a call: it is the one row the timeline never draws, the top box of the
 * flame graph, and the top row of the call tree, so it is clickable while
 * picking and would otherwise be sent to the chat as a frame that costs nothing
 * and appears in no hand-off a service writes.
 */
export function isPickableName(name: string): boolean {
  return name !== "(root)";
}

/** The class a picked frame's row or box carries; nothing when it is not picked. */
export function pickedClass(selection: FrameSelection | undefined, nodeId: string): string | undefined {
  return isSelected(selection, nodeId) ? "is-picked" : undefined;
}

/**
 * The number of the pick this frame is.
 *
 * A ring says a frame was chosen; a number says which one, which is the only
 * thing that distinguishes four of them once they are spread across two tabs.
 * Every view draws the same pill so a reader learns it in one place.
 */
export function PickTick({ selection, nodeId }: { selection: FrameSelection | undefined; nodeId: string }) {
  const at = pickNumber(selection, nodeId);
  return at === undefined ? null : <span className="explore-picked-tick" aria-hidden="true">{at}</span>;
}

/**
 * The id a picked React component carries.
 *
 * A task frame is addressed by one id across all four of its views because the
 * merged call tree gives it one. A React recording has no such tree: a fiber id
 * is unique inside its root and nowhere else, and the same component rendered in
 * forty commits is forty fibers that may or may not share a number. So the id a
 * pick is held by names the commit as well — `<rootId>.<commitIndex>.<fiberId>`,
 * the commit key the explorer already keeps in its address bar with the fiber
 * appended.
 *
 * Naming the commit is what lets a selection outlive the commit picker. A reader
 * works a cascade by stepping through commits, and the question they are
 * assembling is usually "these components, in these commits"; a per-commit set
 * would empty itself under exactly the navigation the reading is made of.
 */
export function reactNodeKey(commit: { rootId: number; commitIndex: number }, fiberId: number): string {
  return `${commit.rootId}.${commit.commitIndex}.${fiberId}`;
}

/**
 * The commit a picked component belongs to, or nothing when the id names no
 * commit at all.
 *
 * The host resolves picks against a recording it holds, and a pick made three
 * commits ago has to find its way back to the commit that explains it.
 */
export function reactNodeKeyParts(key: string): { rootId: number; commitIndex: number; fiberId: number } | undefined {
  const parts = key.split(".");
  if (parts.length !== 3) return undefined;
  const [rootId, commitIndex, fiberId] = parts.map(Number);
  if (![rootId, commitIndex, fiberId].every(Number.isInteger)) return undefined;
  return { rootId: rootId!, commitIndex: commitIndex!, fiberId: fiberId! };
}
