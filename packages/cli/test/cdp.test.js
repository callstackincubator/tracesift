import { test } from 'node:test';
import assert from 'node:assert/strict';

import { connectCdp, readProtocolStream } from '../src/cdp.js';

/** A WebSocket stand-in that records what the client sends and replays replies. */
function fakeSocket() {
  const handlers = new Map();
  const sent = [];
  return {
    readyState: 0,
    sent,
    addEventListener(type, handler, options) {
      const list = handlers.get(type) ?? [];
      list.push({ handler, once: Boolean(options?.once) });
      handlers.set(type, list);
    },
    responder: null,
    send(data) {
      const message = JSON.parse(data);
      sent.push(message);
      // Reply on a later turn, as a real socket would, and only to what was
      // actually asked: guessing ids makes the test race the client.
      if (this.responder) queueMicrotask(() => this.reply({ id: message.id, ...this.responder(message) }));
    },
    close() { this.readyState = 3; },
    emit(type, event) {
      const list = handlers.get(type) ?? [];
      handlers.set(type, list.filter((entry) => !entry.once));
      for (const { handler } of list) handler(event);
    },
    open() { this.readyState = 1; this.emit('open', {}); },
    reply(message) { this.emit('message', { data: JSON.stringify(message) }); },
  };
}

async function connected() {
  const socket = fakeSocket();
  const pending = connectCdp('ws://127.0.0.1:0/devtools/browser/x', { createSocket: () => socket });
  socket.open();
  return { socket, cdp: await pending };
}

test('a command resolves with the result that carries its id', async () => {
  const { socket, cdp } = await connected();
  const first = cdp.send('Target.getTargets');
  const second = cdp.send('Page.enable', {}, 'SESSION-1');

  assert.deepEqual(socket.sent[0], { id: 1, method: 'Target.getTargets', params: {} });
  assert.deepEqual(socket.sent[1], { id: 2, method: 'Page.enable', params: {}, sessionId: 'SESSION-1' });

  // Replies arrive out of order; each must reach its own caller.
  socket.reply({ id: 2, result: { ok: true } });
  socket.reply({ id: 1, result: { targetInfos: [] } });
  assert.deepEqual(await second, { ok: true });
  assert.deepEqual(await first, { targetInfos: [] });
});

test('a protocol error rejects with the method that failed', async () => {
  const { socket, cdp } = await connected();
  const pending = cdp.send('Tracing.start');
  socket.reply({ id: 1, error: { message: 'Tracing is already started' } });
  await assert.rejects(pending, /Tracing\.start failed: Tracing is already started/);
});

test('events reach listeners with their session, and unsubscribing stops them', async () => {
  const { socket, cdp } = await connected();
  const seen = [];
  const off = cdp.on((method, params, sessionId) => seen.push([method, params.scriptId, sessionId]));

  socket.reply({ method: 'Debugger.scriptParsed', params: { scriptId: '7' }, sessionId: 'CHILD-1' });
  socket.reply({ method: 'Tracing.bufferUsage', params: { percentFull: 0.5 } });
  off();
  socket.reply({ method: 'Debugger.scriptParsed', params: { scriptId: '8' } });

  assert.deepEqual(seen, [['Debugger.scriptParsed', '7', 'CHILD-1'], ['Tracing.bufferUsage', undefined, undefined]]);
});

test('a listener that throws does not stop the others', async () => {
  const { socket, cdp } = await connected();
  const seen = [];
  cdp.on(() => { throw new Error('listener blew up'); });
  cdp.on((method) => seen.push(method));
  socket.reply({ method: 'Tracing.tracingComplete', params: {} });
  assert.deepEqual(seen, ['Tracing.tracingComplete']);
});

test('a dropped connection rejects everything still in flight', async () => {
  const { socket, cdp } = await connected();
  const pending = cdp.send('Tracing.end');
  socket.emit('close', { code: 1006, reason: 'abnormal closure' });
  await assert.rejects(pending, /abnormal closure \(code 1006\)/);
  await assert.rejects(cdp.send('Tracing.end'), /abnormal closure/);
  assert.equal(cdp.closed, true);
});

test('connecting fails when Chrome closes the socket instead of opening it', async () => {
  const socket = fakeSocket();
  const pending = connectCdp('ws://127.0.0.1:0/x', { createSocket: () => socket });
  socket.emit('close', { code: 1002, reason: 'protocol error' });
  await assert.rejects(pending, /refused the debugging connection: protocol error/);
});

test('a stream is read to EOF and closed, decoding base64 chunks', async () => {
  const { socket, cdp } = await connected();
  const reads = [
    { data: Buffer.from('{"traceEvents":[').toString('base64'), base64Encoded: true, eof: false },
    { data: '{"name":"A"}]}', eof: true },
  ];
  socket.responder = (message) => ({ result: message.method === 'IO.read' ? reads.shift() : {} });

  const chunks = [];
  await readProtocolStream(cdp, 'HANDLE-1', { onChunk: (bytes) => { chunks.push(Buffer.from(bytes).toString('utf8')); } });

  assert.equal(chunks.join(''), '{"traceEvents":[{"name":"A"}]}');
  assert.deepEqual(socket.sent.at(-1), { id: 3, method: 'IO.close', params: { handle: 'HANDLE-1' } });
});

test('a stream read without onChunk returns its text', async () => {
  const { socket, cdp } = await connected();
  socket.responder = (message) => ({ result: message.method === 'IO.read' ? { data: '{"version":3}', eof: true } : {} });
  assert.equal(await readProtocolStream(cdp, 'HANDLE-3'), '{"version":3}');
});

test('a stream that outgrows its limit is rejected and still closed', async () => {
  const { socket, cdp } = await connected();
  socket.responder = (message) => ({ result: message.method === 'IO.read' ? { data: 'far too much data', eof: false } : {} });
  await assert.rejects(readProtocolStream(cdp, 'HANDLE-2', { limitBytes: 4 }), /exceeded its retention limit/);
  assert.equal(socket.sent.at(-1).method, 'IO.close');
});
