import assert from 'node:assert/strict';
import test from 'node:test';

import { frameLocations, namesItself, taskCardLocations } from '../src/lib/frame-location.ts';

test('a path a developer can open is always shown', () => {
  const locations = frameLocations([{ name: 'buildReport', location: 'src/report.ts:12:1' }]);
  assert.equal(locations.shown('buildReport', 'src/report.ts:12:1'), 'src/report.ts:12:1');
  assert.equal(locations.showedArtefact(), false, 'a source path is not a build artefact');
});

test('a chunk offset is dropped where the name already locates the frame', () => {
  // `getReportSections` is what an agent greps for; the chunk cannot be opened,
  // adds nothing to the search, and is different after the next build.
  const locations = frameLocations([{ name: 'getReportSections', location: '8339.bundle.js:1:92293' }]);
  assert.equal(locations.shown('getReportSections', '8339.bundle.js:1:92293'), undefined);
  assert.equal(locations.showedArtefact(), false);
});

test('a name that says nothing by itself keeps its position', () => {
  const locations = frameLocations([
    { name: '(anonymous)', location: 'vendors.bundle.js:192:8489' },
    { name: 't.A', location: 'main.bundle.js:31:1485926' },
    { name: 'l', location: '84.bundle.js:5:865740' },
  ]);
  assert.equal(locations.shown('(anonymous)', 'vendors.bundle.js:192:8489'), 'vendors.bundle.js:192:8489');
  assert.equal(locations.shown('t.A', 'main.bundle.js:31:1485926'), 'main.bundle.js:31:1485926');
  assert.equal(locations.shown('l', '84.bundle.js:5:865740'), '84.bundle.js:5:865740');
  assert.equal(locations.showedArtefact(), true, 'the caveat explaining a chunk offset is earned');
});

test('a mangled member path is not saved by its length', () => {
  // `MINIFIED` in frame-names.ts tests one or two characters, which `t.A` and
  // `n.Z` pass while naming nothing a developer can search for.
  assert.equal(namesItself('t.A'), false);
  assert.equal(namesItself('n.Z'), false);
  assert.equal(namesItself('eK.H'), false);
  // The part that identifies this one survived minification.
  assert.equal(namesItself('eK.useMemo'), true);
  assert.equal(namesItself('getReportSections'), true);
});

test('one name recorded at two positions keeps both', () => {
  // Two different functions minification left sharing a name. Dropping these
  // leaves two identical rows, and on the trace this was written for the two
  // `compute` frames shared a caller chain as well.
  const frames = [
    { name: 'compute', location: 'main.bundle.js:2:114192' },
    { name: 'compute', location: 'main.bundle.js:2:125173' },
    { name: 'flushRecompute', location: 'main.bundle.js:2:128778' },
  ];
  const locations = frameLocations(frames);
  assert.equal(locations.shown('compute', 'main.bundle.js:2:114192'), 'main.bundle.js:2:114192');
  assert.equal(locations.shown('compute', 'main.bundle.js:2:125173'), 'main.bundle.js:2:125173');
  assert.equal(locations.shown('flushRecompute', 'main.bundle.js:2:128778'), undefined);
});

test('ambiguity is judged over the whole card, not the section being drawn', () => {
  // Otherwise a frame reads one way in the culprit table and another in the
  // tree, and a reader cannot match the two.
  const card = {
    boundaryFrames: [{ name: 'Search_Search', location: '84.bundle.js:5:1181995' }],
    culprits: [{ name: 'compute', location: 'main.bundle.js:2:114192' }],
    tree: {
      name: '(root)',
      children: [{ name: 'compute', location: 'main.bundle.js:2:125173', children: [] }],
    },
  };
  const locations = taskCardLocations(card);
  assert.equal(locations.shown('compute', 'main.bundle.js:2:114192'), 'main.bundle.js:2:114192');
  assert.equal(locations.shown('Search_Search', '84.bundle.js:5:1181995'), undefined);
});

test('a frame with no recorded position asks for nothing', () => {
  const locations = frameLocations([{ name: 'put' }]);
  assert.equal(locations.shown('put', undefined), undefined);
});
