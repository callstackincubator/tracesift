import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compactLocation, isReadableSourcePath, isSourceLabel } from '../src/lib/source-location.ts';

test('a path a developer can open is printed whole', () => {
  assert.ok(isReadableSourcePath('src/screens/Search.tsx'));
  assert.equal(compactLocation('src/screens/Search.tsx', 10, 3), 'src/screens/Search.tsx:11:4');
  assert.equal(compactLocation('/Users/me/app/src/lib/merge.ts', 0, 0), '/Users/me/app/src/lib/merge.ts:1:1');
});

test('a bundle URL keeps the chunk and the position, and loses the rest', () => {
  // The origin repeats on every line of every stack and the content hash
  // changes with each build: neither tells one frame from another.
  assert.equal(
    compactLocation('https://new.expensify.com/vendors-0776745712aedaa7.bundle.js', 188, 701930),
    'vendors.bundle.js:189:701931',
  );
  assert.equal(compactLocation('https://new.expensify.com/84-742925c3ed128d3a.bundle.js', 4, 0), '84.bundle.js:5:1');
  assert.equal(compactLocation('https://x.test/assets/index-D4ePk8xy.js', 0, 0), 'index.js:1:1');
  assert.equal(compactLocation('https://x.test/a/b/app.js?v=2', 0, 0), 'app.js:1:1');
});

test('a hash is only stripped where there is a stem left behind it', () => {
  // `base64url` is the file's name, not a fingerprint appended to one.
  assert.equal(compactLocation('https://x.test/base64url.js', 0, 0), 'base64url.js:1:1');
  assert.equal(compactLocation('https://x.test/d3.min.js', 0, 0), 'd3.min.js:1:1');
});

test('a frame with no position is named without one', () => {
  assert.equal(compactLocation('native date.js', -1, -1), 'native date.js');
  assert.ok(!isReadableSourcePath('native date.js'), 'a built-in is not a file to open');
});

test('a compacted chunk label is never read as a file to open', () => {
  // A numbered chunk is what code splitting emits, and `isReadableSourcePath`
  // accepts it: its scheme test needs a letter first, so the digits walk past.
  // That mistake is the reason `isSourceLabel` exists, so it is pinned here.
  assert.ok(isReadableSourcePath('8339.bundle.js:1:92293'), 'the whole-URL test cannot judge a compacted label');
  assert.ok(!isSourceLabel('8339.bundle.js:1:92293'));
  assert.ok(!isSourceLabel('main.bundle.js:91:1'));
  assert.ok(!isSourceLabel('vendors.bundle.js:189:846776'));
  assert.ok(!isSourceLabel('index.a1b2c3d4.js:1:1'));
});

test('a path a developer can open survives compaction as one', () => {
  assert.ok(isSourceLabel('src/screens/Search.tsx:12:1'));
  assert.ok(isSourceLabel('app/lib/format.js:13:1'));
  assert.ok(isSourceLabel('/workspace/src/explore.tsx:10:2'));
  assert.ok(isSourceLabel(String.raw`C:\src\explore.tsx:10:2`));
  // `prompt-data.ts` parses a label and tests the path without its position.
  // No bundler emits these extensions, so a bare name carrying one is source.
  assert.ok(isSourceLabel('explore.tsx'));
  assert.ok(!isSourceLabel('bundle.js'));
  // A bare file name followed by a position reads as a URL scheme to the
  // whole-URL test, and has since before this rule existed.
  assert.ok(!isReadableSourcePath('Search.tsx:12:1'), 'pre-existing: the stem is taken for a scheme');
});
