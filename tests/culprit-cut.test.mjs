import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyByRule } from '../packages/explore/src/lib/frame-classes.ts';
import { isShownFrame, OWN_CODE_CLASSES, SHOWN_CLASSES } from '../packages/explore/src/lib/task-timeline.ts';

const DRAWN = new Set(SHOWN_CLASSES);
const OWN = new Set(OWN_CODE_CLASSES);

const frame = (functionName, url) => ({ functionName, url, scriptId: '1', lineNumber: 0, columnNumber: 0 });
const shown = (name, url, kept) => isShownFrame(name, classifyByRule(frame(name, url)), kept);

const ROOT = '/Users/dev/social-app';

/**
 * The eight rows a symbolicated React Native recording put in front of a
 * reader who had asked for their own code. Every one of them is a dependency
 * the toggle is supposed to be hiding.
 */
const DEPENDENCIES = [
  ['loadModuleImplementation', `${ROOT}/node_modules/@expo/cli/build/metro-require/require.js`],
  ['computeFullKey', `${ROOT}/node_modules/react-refresh/cjs/react-refresh-runtime.development.js`],
  ['metroRequire', `${ROOT}/node_modules/@expo/cli/build/metro-require/require.js`],
  ['_receiveSignal', `${ROOT}/node_modules/react-native/Libraries/Pressability/Pressability.js`],
  ['onResponderRelease', `${ROOT}/node_modules/react-native/Libraries/Pressability/Pressability.js`],
  ['guardedLoadModule', `${ROOT}/node_modules/@expo/cli/build/metro-require/require.js`],
  ['(anonymous)', `${ROOT}/node_modules/react-refresh/cjs/react-refresh-runtime.development.js`],
  ['collectCustomHooksForSignature', `${ROOT}/node_modules/react-refresh/cjs/react-refresh-runtime.development.js`],
];

test('a dependency is not the reader’s code, however ordinary its name reads', () => {
  for (const [name, url] of DEPENDENCIES) {
    assert.equal(classifyByRule(frame(name, url)), 'library', name);
    assert.equal(shown(name, url, OWN), false, `${name} is hidden from the culprit table`);
    // The chart keeps it, and has to: dropping a box moves every box above it.
    assert.equal(shown(name, url, DRAWN), true, `${name} is still drawn on the chart`);
  }
});

test('the two cuts differ only over dependencies', () => {
  assert.deepEqual([...OWN_CODE_CLASSES], ['app', 'anonymous']);
  assert.deepEqual(SHOWN_CLASSES.filter((cls) => !OWN.has(cls)), ['library']);
});

test('what the reader came for survives the narrower cut', () => {
  // Their own file.
  assert.equal(shown('OpenCameraBtn', `${ROOT}/src/view/com/composer/photos/OpenCameraBtn.tsx`, OWN), true);
  // A nameless frame with no URL is as likely to be their arrow function as
  // anyone's, so the table would rather show one too many than hide theirs.
  assert.equal(shown('(anonymous)', '', OWN), true);
  assert.equal(shown('Function call', '', OWN), true);
  // A built-in that names itself is a call the product made at a cost it
  // controls — `isShownFrame` keeps it past either set.
  assert.equal(shown('intlDateTimeFormatFormat', '', OWN), true);
  // React's own internals go, under both cuts.
  assert.equal(shown('commitPassiveMountOnFiber', `${ROOT}/node_modules/react-native/Libraries/Renderer/implementations/ReactFabric-dev.js`, OWN), false);
  assert.equal(shown('(idle)', '', OWN), false);
});
