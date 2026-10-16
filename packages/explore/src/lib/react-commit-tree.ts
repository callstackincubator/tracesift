/**
 * A React DevTools profiling export, read as a tree of named components with
 * per-commit timings.
 *
 * The existing React path hands the export to `agent-react-devtools`, which
 * reduces it to a bounded evidence payload sized to fit a prompt: the fifty
 * longest commits, ten components each, aggregates capped at fifteen rows. Those
 * caps are a property of the prompt, not of the data, and a deterministic engine
 * has no prompt — so this module reads the export directly and keeps all of it.
 *
 * What the export actually carries, per root:
 *
 * - `operations`, one entry per commit: the mount/unmount/reorder log the
 *   DevTools frontend replays to maintain its component tree, with a string
 *   table holding every display name. Replaying it is the only way to resolve a
 *   fiber id to a name; `snapshots` alone leaves the hottest components
 *   unnamed, because a component mounted *during* the recording is not in it.
 * - `commitData[]`, per commit: `fiberActualDurations` (inclusive) and
 *   `fiberSelfDurations` per fiber, `changeDescriptions` (why each component
 *   rendered), `updaters` (who scheduled the update), `timestamp`, `duration`,
 *   and — carried by no part of the current pipeline — `effectDuration`,
 *   `passiveEffectDuration` and `priorityLevel`.
 *
 * Nothing here is inferred. Every field on a `ReactCommit` is read or summed
 * from the export, which is the same contract `call-tree.ts` holds on the CPU
 * side.
 */

/**
 * React DevTools' `ElementType`. Only the values this module needs to tell a
 * component from the machinery around it are named; the rest stay numeric.
 */
const ELEMENT_TYPE_ROOT = 11;

/** `operations` op codes, as the DevTools frontend's own reducer reads them. */
const OP_ADD = 1;
const OP_REMOVE = 2;
const OP_REORDER_CHILDREN = 3;
const OP_UPDATE_TREE_BASE_DURATION = 4;
const OP_UPDATE_ERRORS_OR_WARNINGS = 5;
const OP_REMOVE_ROOT = 6;
const OP_SET_SUBTREE_MODE = 7;

/**
 * Ancestors kept on a rendered fiber's path.
 *
 * Wide, because this is the raw chain and the card narrows it: a React tree is
 * 130 wrappers deep at the leaves, and compacting here — before the
 * reconciler's own wrappers are dropped — spends the whole budget on
 * `Context.Provider` and leaves `… (130 omitted)` where the screen's name
 * should be.
 */
const MAX_PATH_NAMES = 40;

/**
 * Why React rendered a component, as recorded — never guessed.
 *
 * `unknown` is load-bearing: `changeDescriptions` is null for every commit
 * unless the recording was made with "Record why each component rendered"
 * enabled, which `sample-profiles/react/react-profile-2.json` was not. A rule
 * that reads a missing record as "nothing changed" would report a wasted-render
 * finding on every component in such a profile, so the two are kept apart.
 */
export type ReactRenderCause =
  | "first-mount"
  | "state"
  | "hooks"
  | "props"
  | "context"
  | "nothing-changed"
  | "unknown";

export interface ReactFiber {
  id: number;
  /** As recorded, including any wrapper: `Forget(MerchantLeaderboard)`, `Memo(StaticContainer)`. */
  name: string;
  /** The same name with React's own wrappers peeled off, for display and for name tests. */
  displayName: string;
  key: string | null;
  elementType: number;
  parentId: number;
  /** React Compiler compiled this component. A memoized component that still re-renders is its own finding. */
  compiledWithForget: boolean;
  /** `./explore-list.tsx`, when the recorded name carried one. */
  sourceHint: string | null;
  hocDisplayNames: string[] | null;
}

export interface ReactRenderedFiber {
  id: number;
  name: string;
  displayName: string;
  elementType: number;
  compiledWithForget: boolean;
  /** Time in this component alone. The only figure a finding may be attributed to. */
  selfMs: number;
  /** Time in this component and everything it rendered. Overlaps every ancestor, so it never sums. */
  actualMs: number;
  cause: ReactRenderCause;
  changedProps: string[];
  changedHooks: string[];
  sourceHint: string | null;
  /**
   * The fiber above this one, as the replay last recorded it. 0 at a root.
   *
   * `path` says where a component sits in words; this says it in identities,
   * which is what a drill-down needs to nest one rendered fiber under another.
   */
  parentId: number;
  /** Root to this component, wrappers included, compacted to `MAX_PATH_NAMES`. */
  path: string[];
}

export interface ReactCommit {
  rootId: number;
  commitIndex: number;
  timestampMs: number;
  /** Render phase only, as React measured it. */
  durationMs: number;
  /** Layout effects. Not part of `durationMs`, and discarded by the current pipeline. */
  effectDurationMs: number;
  /** Passive effects. A commit that is cheap to render and expensive to commit is a different bug. */
  passiveEffectDurationMs: number;
  priority: string | null;
  /** The components that scheduled this update, by name. Empty when not recorded. */
  updaters: string[];
  /** Every fiber React re-rendered in this commit, ranked by self time. */
  fibers: ReactRenderedFiber[];
  /** Summed self time. At most `durationMs`; the difference is reconciler and commit work. */
  summedSelfMs: number;
  /** True when no commit in this recording recorded why its components rendered. */
  causesRecorded: boolean;
}

export interface ReactRecording {
  rootId: number;
  rootName: string | null;
  commits: ReactCommit[];
  /** Commit render durations in recorded order, for the strip a reader scrubs. */
  commitDurations: number[];
  totalRenderMs: number;
  peakCommitMs: number;
  /** Fibers whose mount predates the recording, so `operations` never named them. */
  unnamedFiberCount: number;
  causesRecorded: boolean;
  /**
   * Every fiber the replay resolved, by id — the whole tree, not just the part
   * that rendered.
   *
   * A rendered fiber's parent did not necessarily render itself, so a view that
   * nests rendered fibers under one another has to be able to walk through the
   * ones that did not. A `Map` is deliberate: this index is for the process
   * that parsed the export and is not part of what a record stores, and
   * `JSON.stringify` drops it rather than doubling the payload.
   */
  fiberIndex: ReadonlyMap<number, ReactFiber>;
}

export class ReactCommitTreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReactCommitTreeError";
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * Peel React's own wrappers off a recorded name.
 *
 * `Forget(HeavyActivityHeatmap)` and `HeavyActivityHeatmap` are the same
 * component, and the saved analysis in `sample-analyses.ts` names it without
 * the wrapper — so a card that prints the raw name reads as a different finding
 * than the one it replaces. The wrapper itself is not lost: it is the reason
 * `compiledWithForget` is on the fiber.
 */
export function unwrapComponentName(name: string): string {
  return splitSourceHint(unwrapWrappers(name)).displayName;
}

/** The wrappers alone, leaving any module path the name carries in place. */
export function unwrapWrappers(name: string): string {
  let current = name;
  for (let depth = 0; depth < 4; depth += 1) {
    const match = /^(?:Forget|Memo|ForwardRef|Anonymous)\((.+)\)$/.exec(current);
    if (!match) break;
    current = match[1];
  }
  return current;
}

/**
 * A module path, where the recorded name happens to carry one.
 *
 * `buildReactFixPrompt` tells a developer's agent that "no source path or
 * render trigger was recorded", and for a React export that is true of the
 * format — but not always of the names in it. React Compiler and the metro
 * transform record components as `ExploreListScreen(./explore-list.tsx)`, and
 * that parenthesised half is the file a reader has to open. It is the one
 * source location a React profile ever yields, so it is pulled out as its own
 * field rather than left inside a display name.
 *
 * Deliberately narrow: only a parenthesised tail that looks like a relative or
 * absolute module path with a JS or TS extension. `Route(explore-details)` is a
 * route key, not a file, and must not come back as one.
 */
export function splitSourceHint(name: string): { displayName: string; sourceHint: string | null } {
  const match = /^(.+?)\((\.{0,2}\/[^()]+\.[cm]?[jt]sx?)\)$/.exec(name);
  return match ? { displayName: match[1], sourceHint: match[2] } : { displayName: name, sourceHint: null };
}

/**
 * A changed hook, as something a reader can read.
 *
 * `changeDescriptions.hooks` holds each changed hook's *index* in the
 * component's hook list — `[1]`, `[1, 2]` — because the export carries no hook
 * names. Printed bare it reads as a name, and `a hook changed: 1` looks like a
 * hook called "1". The index is still worth keeping: it is countable, and it
 * tells a reader which `useState`/`useMemo` call in the component to look at.
 */
export function hookLabel(hook: string): string {
  return /^\d+$/.test(hook) ? `#${hook}` : hook;
}

function decodeString(words: number[]): string {
  // Chunked, because a long display name would otherwise spread the whole table
  // across one `String.fromCodePoint` call's argument list.
  let out = "";
  for (let index = 0; index < words.length; index += 1024) {
    out += String.fromCodePoint(...words.slice(index, index + 1024));
  }
  return out;
}

/**
 * Replay one commit's operations into the cumulative fiber map.
 *
 * Removals are recorded but not applied: a fiber that unmounted mid-recording
 * is still named by the commit that rendered it, and DevTools never reuses an
 * id, so keeping the entry cannot collide. Ancestry is therefore the last one
 * recorded for a fiber, which differs from its ancestry at an earlier commit
 * only when a subtree was moved — a reorder of position, never of parentage.
 */
function replayOperations(operations: number[], fibers: Map<number, ReactFiber>): void {
  let index = 2;
  const tableSize = operations[index];
  index += 1;
  const strings: (string | null)[] = [null];
  const tableEnd = index + tableSize;
  while (index < tableEnd) {
    const length = operations[index];
    index += 1;
    strings.push(decodeString(operations.slice(index, index + length)));
    index += length;
  }

  while (index < operations.length) {
    const op = operations[index];
    index += 1;
    if (op === OP_ADD) {
      const id = operations[index];
      const elementType = operations[index + 1];
      index += 2;
      if (elementType === ELEMENT_TYPE_ROOT) {
        // isStrictModeCompliant, supportsProfiling, supportsStrictMode, hasOwnerMetadata.
        index += 4;
        fibers.set(id, {
          id, name: "(root)", displayName: "(root)", key: null, sourceHint: null,
          elementType, parentId: 0, compiledWithForget: false, hocDisplayNames: null,
        });
        continue;
      }
      const parentId = operations[index];
      const nameId = operations[index + 2];
      const keyId = operations[index + 3];
      index += 4;
      const name = strings[nameId] ?? `#${id}`;
      fibers.set(id, {
        id, name, displayName: unwrapComponentName(name),
        sourceHint: splitSourceHint(unwrapWrappers(name)).sourceHint,
        key: strings[keyId] ?? null, elementType, parentId,
        compiledWithForget: name.startsWith("Forget("),
        hocDisplayNames: null,
      });
      continue;
    }
    if (op === OP_REMOVE) { index += 1 + operations[index]; continue; }
    if (op === OP_REORDER_CHILDREN) { index += 2 + operations[index + 1]; continue; }
    if (op === OP_UPDATE_TREE_BASE_DURATION) { index += 2; continue; }
    if (op === OP_UPDATE_ERRORS_OR_WARNINGS) { index += 3; continue; }
    if (op === OP_REMOVE_ROOT) { continue; }
    if (op === OP_SET_SUBTREE_MODE) { index += 2; continue; }
    // An op this module does not know is an export from a newer bridge protocol.
    // Stopping leaves every name resolved so far intact, which is strictly
    // better than walking a misaligned cursor and inventing fibers.
    throw new ReactCommitTreeError(`Unknown React operation code ${op}; this export needs a newer reader.`);
  }
}

/**
 * The recorded reason, in the order a reader acts on it.
 *
 * State and hooks outrank props because they name the component as the origin
 * of the update rather than as its recipient, and context outranks nothing
 * precisely because a context-driven render is the one a reader cannot see in
 * the component's own props.
 */
function renderCause(description: unknown): ReactRenderCause {
  if (!isObject(description)) return "unknown";
  if (description.isFirstMount === true) return "first-mount";
  const props = Array.isArray(description.props) ? (description.props as string[]) : [];
  const hooks = Array.isArray(description.hooks) ? description.hooks.map(String) : [];
  if (Array.isArray(description.state) ? description.state.length > 0 : description.state === true) return "state";
  if (description.didHooksChange === true || hooks.length > 0) return "hooks";
  if (props.length > 0) return "props";
  if (description.context === true || (Array.isArray(description.context) && description.context.length > 0)) return "context";
  return "nothing-changed";
}

function fiberPath(id: number, fibers: Map<number, ReactFiber>): string[] {
  const names: string[] = [];
  const seen = new Set<number>();
  for (let current = id; current && !seen.has(current); current = fibers.get(current)?.parentId ?? 0) {
    seen.add(current);
    const fiber = fibers.get(current);
    if (!fiber) { names.unshift(`#${current}`); break; }
    if (fiber.elementType !== ELEMENT_TYPE_ROOT) names.unshift(fiber.name);
  }
  // The ancestors nearest the cost, which are the ones that explain where it
  // sits. The root end of a React path is the app shell on every component.
  return names.length <= MAX_PATH_NAMES ? names : names.slice(-MAX_PATH_NAMES);
}

/** One root of a DevTools export, read whole. */
function readRoot(raw: Record<string, unknown>): ReactRecording {
  const rootId = isFiniteNumber(raw.rootID) ? raw.rootID : 0;
  const operations = Array.isArray(raw.operations) ? raw.operations : [];
  const commitData = Array.isArray(raw.commitData) ? raw.commitData : [];
  const fibers = new Map<number, ReactFiber>();

  // `snapshots` first: it names everything mounted before profiling began, and
  // the replay below overwrites those entries with whatever it records itself.
  if (Array.isArray(raw.snapshots)) {
    for (const entry of raw.snapshots) {
      if (!Array.isArray(entry) || !isFiniteNumber(entry[0]) || !isObject(entry[1])) continue;
      const node = entry[1];
      const name = typeof node.displayName === "string" ? node.displayName : null;
      const elementType = isFiniteNumber(node.type) ? node.type : 9;
      fibers.set(entry[0], {
        id: entry[0],
        name: name ?? (elementType === ELEMENT_TYPE_ROOT ? "(root)" : `#${entry[0]}`),
        displayName: unwrapComponentName(name ?? `#${entry[0]}`),
        sourceHint: name ? splitSourceHint(unwrapWrappers(name)).sourceHint : null,
        key: typeof node.key === "string" ? node.key : null,
        elementType,
        parentId: 0,
        compiledWithForget: node.compiledWithForget === true,
        hocDisplayNames: Array.isArray(node.hocDisplayNames) ? (node.hocDisplayNames as string[]) : null,
      });
    }
    // Parentage, which `snapshots` states as children rather than as a parent.
    for (const entry of raw.snapshots) {
      if (!Array.isArray(entry) || !isObject(entry[1]) || !Array.isArray(entry[1].children)) continue;
      for (const child of entry[1].children as unknown[]) {
        const fiber = isFiniteNumber(child) ? fibers.get(child) : undefined;
        if (fiber) fiber.parentId = entry[0] as number;
      }
    }
  }

  const commits: ReactCommit[] = [];
  const causesRecorded = commitData.some((commit) => isObject(commit) && Array.isArray(commit.changeDescriptions));
  const unnamed = new Set<number>();

  for (const [commitIndex, commit] of commitData.entries()) {
    // The log for commit N describes the tree React built in commit N, so it is
    // replayed before that commit's timings are read.
    if (Array.isArray(operations[commitIndex])) replayOperations(operations[commitIndex] as number[], fibers);
    if (!isObject(commit)) continue;

    const selfDurations = new Map<number, number>(
      (Array.isArray(commit.fiberSelfDurations) ? commit.fiberSelfDurations : [])
        .filter((pair): pair is [number, number] => Array.isArray(pair) && isFiniteNumber(pair[0]) && isFiniteNumber(pair[1])),
    );
    const actualDurations = (Array.isArray(commit.fiberActualDurations) ? commit.fiberActualDurations : [])
      .filter((pair): pair is [number, number] => Array.isArray(pair) && isFiniteNumber(pair[0]) && isFiniteNumber(pair[1]));
    const causes = new Map<number, unknown>();
    if (Array.isArray(commit.changeDescriptions)) {
      for (const pair of commit.changeDescriptions) {
        if (Array.isArray(pair) && isFiniteNumber(pair[0])) causes.set(pair[0], pair[1]);
      }
    }

    const rendered: ReactRenderedFiber[] = actualDurations.map(([id, actualMs]) => {
      const fiber = fibers.get(id);
      if (!fiber) unnamed.add(id);
      const description = causes.get(id);
      const changedProps = isObject(description) && Array.isArray(description.props) ? (description.props as string[]) : [];
      const changedHooks = isObject(description) && Array.isArray(description.hooks)
        ? (description.hooks as unknown[]).map(String) : [];
      return {
        id,
        name: fiber?.name ?? `#${id}`,
        displayName: fiber?.displayName ?? `#${id}`,
        elementType: fiber?.elementType ?? 9,
        compiledWithForget: fiber?.compiledWithForget ?? false,
        selfMs: selfDurations.get(id) ?? 0,
        actualMs,
        cause: renderCause(description),
        changedProps,
        changedHooks,
        sourceHint: fiber?.sourceHint ?? null,
        parentId: fiber?.parentId ?? 0,
        path: fiberPath(id, fibers),
      };
    }).sort((a, b) => b.selfMs - a.selfMs || b.actualMs - a.actualMs || a.id - b.id);

    commits.push({
      rootId,
      commitIndex,
      timestampMs: isFiniteNumber(commit.timestamp) ? commit.timestamp : 0,
      durationMs: isFiniteNumber(commit.duration) ? commit.duration : 0,
      effectDurationMs: isFiniteNumber(commit.effectDuration) ? commit.effectDuration : 0,
      passiveEffectDurationMs: isFiniteNumber(commit.passiveEffectDuration) ? commit.passiveEffectDuration : 0,
      priority: typeof commit.priorityLevel === "string" ? commit.priorityLevel : null,
      updaters: (Array.isArray(commit.updaters) ? commit.updaters : [])
        .map((updater) => (isObject(updater) && typeof updater.displayName === "string" ? updater.displayName : null))
        .filter((name): name is string => Boolean(name)),
      fibers: rendered,
      summedSelfMs: rendered.reduce((total, fiber) => total + fiber.selfMs, 0),
      causesRecorded: causes.size > 0,
    });
  }

  const durations = commits.map((commit) => commit.durationMs);
  return {
    rootId,
    rootName: typeof raw.displayName === "string" ? raw.displayName : null,
    commits,
    commitDurations: durations,
    totalRenderMs: durations.reduce((a, b) => a + b, 0),
    peakCommitMs: durations.reduce((max, value) => Math.max(max, value), 0),
    unnamedFiberCount: unnamed.size,
    causesRecorded,
    fiberIndex: fibers,
  };
}

export function parseReactExport(raw: unknown): ReactRecording[] {
  if (!isObject(raw) || !Array.isArray(raw.dataForRoots)) {
    throw new ReactCommitTreeError("This file is not a React DevTools profiling export.");
  }
  const roots = raw.dataForRoots.filter(isObject);
  if (roots.length === 0) throw new ReactCommitTreeError("The export contains no profiled React roots.");
  return roots.map(readRoot);
}
