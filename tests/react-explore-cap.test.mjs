import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseReactExport } from '../src/lib/react-commit-tree.ts';
import { buildReactCards } from '../src/lib/react-cards.ts';
import { buildReactExplore } from '../src/lib/react-explore.ts';
import { buildManyCommits } from './react-many-commits-fixture.mjs';

const explore = (raw, budget = 16) => {
  const recordings = parseReactExport(raw);
  return buildReactExplore(recordings, buildReactCards(recordings, budget));
};

const COUNT = 5_200;
const PAST_CAP = 5_100;
// Past the cap and nowhere near the busiest commits, so nothing keeps it.
const QUIET_PAST_CAP = COUNT - 1;

test('a recording past the strip cap draws some commits and counts the rest', () => {
  // Said plainly before the interesting case, because the case below only means
  // something if the cap really bit here.
  const set = explore(buildManyCommits({ count: COUNT, slowAt: [PAST_CAP] }));
  assert.ok(COUNT > 5_000, 'more commits than the strip keeps');
  assert.ok(set.omittedCommitCount > 0, 'the cap did bite');
  assert.equal(set.commits.some((commit) => commit.commitIndex === QUIET_PAST_CAP), false,
    'a quiet commit past the cap is dropped');
});

test('a commit past the strip cap that produced a card is still there to open', () => {
  // The cards rank the busiest commits in the whole recording, so a render storm
  // late in a long session produces cards whose commits sit past the cap. A
  // card's link names its commit; drop that commit from the strip and the view
  // cannot find the key, falls back to the longest one it still holds, and opens
  // a different commit under the heading of the one that was asked for.
  const slowAt = [PAST_CAP, PAST_CAP + 1, PAST_CAP + 2];
  const recordings = parseReactExport(buildManyCommits({ count: COUNT, slowAt }));
  const cards = buildReactCards(recordings, 16);
  const set = buildReactExplore(recordings, cards);

  const carded = cards.cards.filter((card) => card.commitIndex >= PAST_CAP);
  assert.ok(carded.length > 0, 'the fixture produced cards past the cap');
  for (const card of carded) {
    const commit = set.commits.find((entry) => entry.commitIndex === card.commitIndex);
    assert.ok(commit, `commit ${card.commitIndex} has a card and must be on the strip`);
    assert.equal(commit.cardId, card.id, 'and it is still the commit that card describes');
    assert.equal(commit.treeDropped, false, 'and it opens a tree rather than an empty panel');
  }

  // The cap still means something: it is the quiet commits that were dropped,
  // fewer of them by exactly the number of cards kept.
  assert.equal(set.commits.length + set.omittedCommitCount, COUNT, 'every commit is drawn or counted');
  assert.ok(set.omittedCommitCount < COUNT - 5_000, 'the kept cards came out of the dropped tail');

  // Recorded order is what makes the strip a clock, and a kept tail is spliced
  // into the middle of it rather than appended after it.
  const starts = set.commits.map((commit) => commit.startMs);
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b), 'the strip stays in recorded order');
});
