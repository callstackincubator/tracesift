import { test } from 'node:test';
import assert from 'node:assert/strict';

import { selectPageTarget } from '../src/record-session.js';

/**
 * A browser that answers `Runtime.evaluate` out of a table of what each page
 * would say about itself. `sessions` records every attach and detach, because
 * a probe that leaves a session open would go on receiving the page's events.
 */
function fakeBrowser(pages) {
  const sessions = { opened: [], closed: [] };
  let next = 0;
  const bySession = new Map();
  return {
    sessions,
    async send(method, params = {}, sessionId) {
      if (method === 'Target.attachToTarget') {
        const page = pages[params.targetId];
        if (page?.attachFails) throw new Error('target closed');
        const id = `session-${++next}`;
        sessions.opened.push(params.targetId);
        bySession.set(id, params.targetId);
        return { sessionId: id };
      }
      if (method === 'Runtime.evaluate') {
        const page = pages[bySession.get(sessionId)];
        if (page?.evaluateFails) throw new Error('execution context destroyed');
        return { result: { value: { visible: page.visible, focused: page.focused } } };
      }
      if (method === 'Target.detachFromTarget') { sessions.closed.push(params.sessionId); return {}; }
      throw new Error(`unexpected ${method}`);
    },
  };
}

const page = id => ({ targetId: id, url: `https://example.com/${id}`, type: 'page' });

test('one page is recorded without being probed at all', async () => {
  const browser = fakeBrowser({ only: { visible: true, focused: true } });
  const chosen = await selectPageTarget(browser, [page('only')]);
  assert.equal(chosen.targetId, 'only');
  assert.deepEqual(browser.sessions.opened, []);
});

test('the tab on screen is recorded, not the first one Chrome lists', async () => {
  // What a sign-in leaves behind: the consent popup Chrome opened first, and
  // the app the person came back to.
  const browser = fakeBrowser({
    popup: { visible: false, focused: false },
    app: { visible: true, focused: false },
  });
  const chosen = await selectPageTarget(browser, [page('popup'), page('app')]);
  assert.equal(chosen.targetId, 'app');
  // Every probe is closed, including the one for the page that won: the caller
  // attaches to it itself.
  assert.deepEqual(browser.sessions.opened, ['popup', 'app']);
  assert.equal(browser.sessions.closed.length, 2);
});

test('focus decides between two windows that are both showing a page', async () => {
  const browser = fakeBrowser({
    behind: { visible: true, focused: false },
    front: { visible: true, focused: true },
  });
  assert.equal((await selectPageTarget(browser, [page('behind'), page('front')])).targetId, 'front');
});

test('a tab that cannot be probed loses to one that answered, and ties keep Chrome order', async () => {
  const broken = fakeBrowser({
    silent: { evaluateFails: true },
    app: { visible: false, focused: false },
  });
  assert.equal((await selectPageTarget(broken, [page('silent'), page('app')])).targetId, 'app');

  // Nothing tells these apart, so the browser's own order still decides rather
  // than the recording landing on an arbitrary tab.
  const tied = fakeBrowser({ first: { visible: true, focused: false }, second: { visible: true, focused: false } });
  assert.equal((await selectPageTarget(tied, [page('first'), page('second')])).targetId, 'first');
});

test('a browser that answers nothing still yields a page to record', async () => {
  // Every probe failing is the old behaviour, which is the right fallback: a
  // recording of Chrome's first page beats refusing to record at all.
  const browser = fakeBrowser({ a: { attachFails: true }, b: { attachFails: true } });
  assert.equal((await selectPageTarget(browser, [page('a'), page('b')])).targetId, 'a');
  assert.deepEqual(browser.sessions.closed, []);
});
