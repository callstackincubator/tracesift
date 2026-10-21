/**
 * A recording whose kept stack changes between every sample, run through the
 * timeline.
 *
 * This is the shape that defeats the chart's guard: consecutive samples sharing
 * no frame means no call stays open, so every sample opens a fresh box per
 * frame rather than extending the one already drawn. Two hundred thousand
 * samples of a twenty-deep stack is four million boxes — the workload behind
 * the cap. Spawning it as a child lets the test bound the heap, which is the
 * only way to tell a guard that holds from one that trims the finished array
 * after paying for all of it.
 *
 * Printed as JSON so the assertions can be about the chart and not about the
 * cost of building it: the same numbers must come back whatever the cap decides
 * to draw.
 */
import { buildCallTree } from '../src/lib/call-tree.ts';
import { buildTaskTimeline } from '../src/lib/task-timeline.ts';

const classes = {
  classOf: (frame) => (frame.url.startsWith('app/') ? 'app' : 'framework'),
  degraded: false, resolvedByModel: 0,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0 },
};

/** `branches` disjoint chains of `depth` frames, all the product's own code. */
function chains(branches, depth) {
  const node = (id, name, url) => ({
    id, children: [], callFrame: { functionName: name, scriptId: '1', url, lineNumber: 0, columnNumber: 0 },
  });
  const nodes = [node(0, '(root)', '')];
  const leaves = [];
  let next = 1;
  for (let b = 0; b < branches; b += 1) {
    let previous = 0;
    for (let d = 0; d < depth; d += 1) {
      nodes.push(node(next, `branch${b}Frame${d}`, `app/branch${b}frame${d}.js`));
      nodes[previous].children.push(next);
      previous = next;
      next += 1;
    }
    leaves.push(previous);
  }
  return { nodes, leaves };
}

export function churnTimeline(samples, branches, depth) {
  const { nodes, leaves } = chains(branches, depth);
  const listed = Array.from({ length: samples }, (_, index) => leaves[index % branches]);
  const tree = buildCallTree(
    { nodes, samples: listed, timeDeltas: listed.map(() => 1000), startTime: 0, endTime: samples * 1000 },
    samples,
    { trackSamples: true },
  );
  return buildTaskTimeline(tree.sampleNodes, listed.map(() => 1), classes, samples);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [samples, branches, depth] = [200_000, 8, 20];
  const timeline = churnTimeline(samples, branches, depth);
  process.stdout.write(JSON.stringify({
    boxes: timeline.boxes.length,
    omitted: timeline.omittedBoxCount,
    omittedMs: timeline.omittedBoxMs,
    coveredMs: timeline.coveredMs,
    durationMs: timeline.durationMs,
    rows: timeline.rows,
    keptUnder: samples * depth,
    peakMb: Math.round(process.memoryUsage().heapUsed / 1048576),
  }));
}
