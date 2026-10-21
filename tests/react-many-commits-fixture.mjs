/**
 * A DevTools profiling export with more commits than the drill-down keeps.
 *
 * One component, re-rendered once per commit, and only the commits named in
 * `slowAt` cost anything. The encoding is `buildExport`'s — this is the same
 * operation block, written `count` times rather than spelled out for four
 * commits — because a recording past the strip cap is the shape no checked-in
 * sample reaches, and a fixture built twice drifts.
 */
import { encodeStrings } from './react-export-fixture.mjs';

export function buildManyCommits({
  count,
  slowAt = [],
  name = 'Screen(./screen.tsx)',
  componentId = 2,
  slowDuration = 400,
  quietDuration = 1,
}) {
  const slow = new Set(slowAt);
  const table = encodeStrings([name]);
  const createTree = [
    1, 1, table.length, ...table,
    1, 1, 11, 0, 0, 0, 0,
    1, componentId, 5, 1, 0, 1, 0,
  ];
  return {
    version: 5,
    dataForRoots: [{
      rootID: 1,
      displayName: 'main(RootComponent)',
      initialTreeBaseDurations: [],
      snapshots: [],
      // Everything mounts in the first block; every later commit re-renders the
      // same one component and changes nothing about the tree.
      operations: Array.from({ length: count }, (_, index) => (index === 0 ? createTree : [1, 1, 0])),
      commitData: Array.from({ length: count }, (_, index) => {
        const duration = slow.has(index) ? slowDuration : quietDuration;
        return {
          duration,
          timestamp: index,
          effectDuration: 0,
          passiveEffectDuration: 0,
          priorityLevel: 'Normal',
          updaters: [{ displayName: 'Screen', id: componentId, key: null, type: 5, hocDisplayNames: null, compiledWithForget: false }],
          fiberActualDurations: [[componentId, duration]],
          fiberSelfDurations: [[componentId, duration]],
          changeDescriptions: null,
        };
      }),
    }],
  };
}
