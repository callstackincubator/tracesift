/**
 * A DevTools profiling export built by hand.
 *
 * Shared by the card tests and the drill-down tests, because both need shapes
 * the two checked-in samples do not contain — a wide cascade, a wasted
 * re-render, a render storm, a commit whose parent bailed out — and a fixture
 * built twice drifts.
 */

export function encodeStrings(names) {
  const words = [];
  for (const name of names) {
    words.push(name.length, ...[...name].map((character) => character.codePointAt(0)));
  }
  return words;
}

export function buildExport({ components, commits, rootId = 1 }) {
  const strings = components.map((component) => component.name);
  const table = encodeStrings(strings);
  const operations = [
    1, rootId, table.length, ...table,
    1, rootId, 11, 0, 0, 0, 0,
    ...components.flatMap((component, index) => [
      1, component.id, component.type ?? 5, component.parentId ?? rootId, 0, index + 1, 0,
    ]),
  ];
  return {
    version: 5,
    dataForRoots: [{
      rootID: rootId,
      displayName: 'main(RootComponent)',
      initialTreeBaseDurations: [],
      snapshots: [],
      // One log per commit; everything mounts in the first.
      operations: commits.map((_, index) => (index === 0 ? operations : [1, rootId, 0])),
      commitData: commits.map((commit) => ({
        duration: commit.duration,
        timestamp: commit.timestamp ?? 0,
        effectDuration: commit.effectDuration ?? 0,
        passiveEffectDuration: commit.passiveEffectDuration ?? 0,
        priorityLevel: commit.priority ?? 'Normal',
        updaters: (commit.updaters ?? []).map((displayName) => ({ displayName, id: 2, key: null, type: 5, hocDisplayNames: null, compiledWithForget: false })),
        fiberActualDurations: commit.fibers.map(([id, self]) => [id, self]),
        fiberSelfDurations: commit.fibers.map(([id, self]) => [id, self]),
        changeDescriptions: commit.causes === null ? null : commit.fibers.map(([id]) => [id, commit.causes?.[id] ?? {
          context: false, didHooksChange: false, isFirstMount: false, props: [], state: null, hooks: [],
        }]),
      })),
    }],
  };
}

