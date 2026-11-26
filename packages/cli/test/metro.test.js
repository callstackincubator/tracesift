import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { defaultMetroOrigin, describeMetroTarget, metroTargets, parseMetroOrigin, selectMetroTarget } from '../src/metro.js';

async function fakeMetro(t, handler) {
  const server = createServer((request, response) => handler(request, response, `http://127.0.0.1:${server.address().port}`));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

function json(body, status = 200) {
  return (request, response) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
}

function entry(port, overrides = {}) {
  return { id: 'a', title: 'App', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/inspector/debug?device=a`, ...overrides };
}

function portOf(origin) {
  return new URL(origin).port;
}

function target(overrides = {}) {
  return { id: 't1', title: 'App', webSocketDebuggerUrl: 'ws://127.0.0.1:8081/x', supportsMultipleDebuggers: false, ...overrides };
}

test('a well-formed target parses, resolves its URL and clamps fields', async (t) => {
  const long = 'x'.repeat(600);
  const origin = await fakeMetro(t, (req, res, base) =>
    json([
      entry(portOf(base), {
        id: 'one',
        title: long,
        appId: 'com.app',
        deviceName: 'iPhone 17 Pro',
        vm: 'Hermes',
        reactNative: { logicalDeviceId: long, capabilities: { supportsMultipleDebuggers: true } },
      }),
    ])(req, res),
  );
  const targets = await metroTargets(origin);
  assert.equal(targets.length, 1);
  const [found] = targets;
  assert.equal(found.id, 'one');
  assert.equal(found.title.length, 512);
  assert.equal(found.deviceId.length, 512);
  assert.equal(found.appId, 'com.app');
  assert.equal(found.vm, 'Hermes');
  assert.equal(found.supportsMultipleDebuggers, true);
  assert.equal(found.webSocketDebuggerUrl, `ws://127.0.0.1:${portOf(origin)}/inspector/debug?device=a`);
});

test('targets with unsafe or foreign debugger URLs are dropped', async (t) => {
  const origin = await fakeMetro(t, (req, res, base) => {
    const p = portOf(base);
    json([
      entry(p, { id: 'good' }),
      entry(p, { id: 'port', webSocketDebuggerUrl: 'ws://127.0.0.1:1/x' }),
      entry(p, { id: 'host', webSocketDebuggerUrl: `ws://10.0.0.5:${p}/x` }),
      entry(p, { id: 'wss', webSocketDebuggerUrl: `wss://127.0.0.1:${p}/x` }),
      entry(p, { id: 'http', webSocketDebuggerUrl: `http://127.0.0.1:${p}/x` }),
      entry(p, { id: 'user', webSocketDebuggerUrl: `ws://user:pass@127.0.0.1:${p}/x` }),
      entry(p, { id: 'hash', webSocketDebuggerUrl: `ws://127.0.0.1:${p}/x#frag` }),
      { title: 'noid', webSocketDebuggerUrl: `ws://127.0.0.1:${p}/x` },
      { id: 'nows', title: 'nows' },
    ])(req, res);
  });
  assert.deepEqual(
    (await metroTargets(origin)).map((item) => item.id),
    ['good'],
  );
});

test('an oversized body is rejected', async (t) => {
  const origin = await fakeMetro(t, json(JSON.stringify([{ id: 'x'.repeat(1024 * 1024 + 10) }])));
  await assert.rejects(metroTargets(origin), { message: 'Metro returned too many targets.' });
});

test('a non-Metro answer is reported as such', async (t) => {
  const missing = await fakeMetro(t, json({}, 404));
  await assert.rejects(metroTargets(missing), (error) => {
    assert.match(error.message, new RegExp(`^${missing.replace(/\./g, '\\.')} answered, but it is not a Metro server`));
    return true;
  });
  const object = await fakeMetro(t, json({ nope: true }));
  await assert.rejects(metroTargets(object), /is not a Metro server/);
});

test('a closed port reports that no Metro server is listening', async (t) => {
  const origin = await fakeMetro(t, json([]));
  const port = portOf(origin);
  const closed = await new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port: free } = probe.address();
      probe.close(() => resolve(free));
    });
  });
  assert.notEqual(String(closed), port);
  await assert.rejects(metroTargets(`http://127.0.0.1:${closed}`), (error) => {
    assert.match(error.message, new RegExp(`^No Metro server is listening on http://127\\.0\\.0\\.1:${closed}\\. Start it with`));
    return true;
  });
});

test('selectMetroTarget returns a single target', () => {
  const only = target();
  assert.equal(selectMetroTarget([only]), only);
});

test('selectMetroTarget honours each selector', () => {
  const a = target({ id: 'a', title: 'Alpha', appId: 'com.alpha', deviceName: 'iPhone', deviceId: '1' });
  const b = target({ id: 'b', title: 'Beta', appId: 'com.beta', deviceName: 'Pixel', deviceId: '2' });
  assert.equal(selectMetroTarget([a, b], { targetId: 'b' }), b);
  assert.equal(selectMetroTarget([a, b], { app: 'com.alpha' }), a);
  assert.equal(selectMetroTarget([a, b], { app: 'BETA' }), b);
  assert.equal(selectMetroTarget([a, b], { device: 'pixel' }), b);
  assert.throws(() => selectMetroTarget([a, b], { app: 'nope' }), {
    message: 'No app connected to Metro matches --app nope. Run `tracesift record targets --platform rn` to see what is connected.',
  });
  assert.throws(() => selectMetroTarget([a, b], { targetId: 'z', app: 'nope' }), /--target-id z\./);
});

test('selectMetroTarget skips JavaScriptCore targets unless everything is one', () => {
  const hermes = target({ id: 'h', appId: 'h', vm: 'Hermes' });
  const jsc = target({ id: 'j', appId: 'j', vm: 'JavaScriptCore' });
  assert.equal(selectMetroTarget([jsc, hermes]), hermes);
  assert.throws(() => selectMetroTarget([jsc]), /JavaScriptCore, which has no sampling profiler/);
});

test('selectMetroTarget keeps the newest of duplicate connections', () => {
  const old = target({ id: 'old', appId: 'com.a', deviceId: 'd' });
  const fresh = target({ id: 'new', appId: 'com.a', deviceId: 'd' });
  assert.equal(selectMetroTarget([old, fresh]), fresh);
});

test('selectMetroTarget asks to choose between distinct apps', () => {
  const a = target({ id: 'a', title: 'Alpha', appId: 'com.alpha', vm: 'Hermes', deviceName: 'iPhone' });
  const b = target({ id: 'b', title: 'Beta', appId: 'com.beta' });
  assert.throws(
    () => selectMetroTarget([a, b]),
    (error) => {
      assert.equal(
        error.message,
        ['Metro has 2 connected apps. Choose one with --app, --device or --target-id:', '  Alpha (Hermes) — iPhone — --target-id a', '  Beta — --target-id b'].join('\n'),
      );
      return true;
    },
  );
});

test('selectMetroTarget explains an empty target list', () => {
  assert.throws(() => selectMetroTarget([], { origin: 'http://127.0.0.1:8081' }), /^Error: Metro is running on http:\/\/127\.0\.0\.1:8081, but no app is connected to it\./);
});

test('describeMetroTarget falls back through appId and id', () => {
  assert.equal(describeMetroTarget({ id: 'i', appId: 'com.x', title: '' }), 'com.x');
  assert.equal(describeMetroTarget({ id: 'i', title: '' }), 'i');
});

test('parseMetroOrigin accepts a bare host and rejects remote hosts', () => {
  assert.equal(parseMetroOrigin('localhost:8081').href, 'http://localhost:8081/');
  assert.throws(() => parseMetroOrigin('https://example.com'), {
    message: 'Metro URL must point at localhost; example.com is not a loopback address.',
  });
  assert.throws(() => parseMetroOrigin('ftp://localhost'), { message: 'Metro URL must be an http or https address.' });
});

test('defaultMetroOrigin honours RCT_METRO_PORT', (t) => {
  const previous = process.env.RCT_METRO_PORT;
  t.after(() => {
    if (previous === undefined) delete process.env.RCT_METRO_PORT;
    else process.env.RCT_METRO_PORT = previous;
  });
  process.env.RCT_METRO_PORT = '8090';
  assert.equal(defaultMetroOrigin(), 'http://127.0.0.1:8090');
  process.env.RCT_METRO_PORT = '99999';
  assert.equal(defaultMetroOrigin(), 'http://127.0.0.1:8081');
});
