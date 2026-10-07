/**
 * Whether a frame's recorded position is worth printing beside its name.
 *
 * `nodeLocation` answers a narrower question — the shortest string that still
 * identifies where a frame is — and on a bundled build that string is a chunk
 * and an offset, `8339.bundle.js:1:92293`. Printing it beside every name was
 * the wrong trade: on a minified profile that is a build artefact on forty
 * rows, and for all but a handful of them the name was already the better key.
 * An agent holding the codebase greps `getReportSections`; the chunk cannot be
 * opened, says nothing the name search would not, and is different after the
 * next build. In the UI it is worse than useless, because the row labels it
 * `file`.
 *
 * It is not noise everywhere, which is why this is not a test on the URL. A
 * position is the only thing separating `(anonymous)` from `(anonymous)`, or
 * `t.A` from `t.A`, and the only thing separating a profile's two `compute`
 * frames — same name, same caller chain, two different functions. So a source
 * path is shown whole, and a build artefact is shown exactly where the name
 * does not stand on its own: a name that says nothing by itself, or a name
 * recorded at more than one position.
 *
 * Ambiguity is counted over a whole card rather than per section or per row,
 * so a frame reads the same in the hand-off, the culprit table and the tree,
 * and a reader can match one to another.
 */

import { isMeaningfulName } from "./frame-names.ts";
import { isSourceLabel } from "./source-location.ts";

/**
 * Minified identifiers the name tiers let through. `MINIFIED` in
 * `frame-names.ts` guards card titles, where one or two characters is the whole
 * question; a bundle also produces `t.A`, `n.Z` and `eK.H` — mangled member
 * paths long enough to pass that test and still naming nothing a developer can
 * search for. `eK.useMemo` is not matched: the part that identifies it survived
 * minification.
 */
const MANGLED = /^(?:[_$A-Za-z][_$A-Za-z0-9]?\.)*[_$A-Za-z][_$A-Za-z0-9]?$/;

/** A name that locates the frame by itself, needing no position beside it. */
export function namesItself(name: string): boolean {
  return isMeaningfulName(name) && !MANGLED.test(name);
}

export interface FrameLocations {
  /** The position to show for this frame, or nothing when its name suffices. */
  shown: (name: string, location: string | undefined) => string | undefined;
  /** Whether `shown` has returned a build artefact, which a hand-off explains. */
  showedArtefact: () => boolean;
}

interface NamedFrame {
  name: string;
  location?: string;
}

interface FrameTree extends NamedFrame {
  children: readonly FrameTree[];
}

export function frameLocations(frames: Iterable<NamedFrame>): FrameLocations {
  const positions = new Map<string, Set<string>>();
  for (const frame of frames) {
    if (!frame.location) continue;
    const seen = positions.get(frame.name);
    if (seen) seen.add(frame.location);
    else positions.set(frame.name, new Set([frame.location]));
  }

  let showedArtefact = false;
  return {
    shown: (name, location) => {
      if (!location) return undefined;
      if (isSourceLabel(location)) return location;
      if (namesItself(name) && (positions.get(name)?.size ?? 0) < 2) return undefined;
      showedArtefact = true;
      return location;
    },
    showedArtefact: () => showedArtefact,
  };
}

function* treeFrames(root: FrameTree): Generator<NamedFrame> {
  const pending: FrameTree[] = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    yield node;
    for (const child of node.children) pending.push(child);
  }
}

/** Every frame a task card can name, which is the scope its positions are judged over. */
export function taskCardLocations(card: {
  boundaryFrames: readonly NamedFrame[];
  culprits: readonly NamedFrame[];
  tree: FrameTree;
}): FrameLocations {
  return frameLocations([...card.boundaryFrames, ...card.culprits, ...treeFrames(card.tree)]);
}

/** The same scope for the node-descent engine's card, whose frames sit in different fields. */
export function profileCardLocations(card: {
  title: string;
  location?: string;
  children: readonly FrameTree[];
  highlights: readonly NamedFrame[];
  repeated: readonly NamedFrame[];
}): FrameLocations {
  return frameLocations([
    { name: card.title, location: card.location },
    ...card.highlights,
    ...card.repeated,
    ...card.children.flatMap((child) => [...treeFrames(child)]),
  ]);
}
