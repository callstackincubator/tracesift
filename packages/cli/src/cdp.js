const CONNECT_TIMEOUT_MS = 15_000;
const COMMAND_TIMEOUT_MS = 30_000;

/** @typedef {{ sessionId?: string }} CdpSession */

function closeReason(event) {
  return event?.reason ? `${event.reason} (code ${event.code})` : `code ${event?.code ?? 'unknown'}`;
}

/**
 * A minimal Chrome DevTools Protocol client over Node's global WebSocket.
 *
 * Flattened sessions are the only mode used here: every command carries the
 * session it belongs to, so one socket drives the browser target and each
 * attached page, worker and frame without nesting.
 *
 * `label` names whatever is on the other end in the connection errors. The
 * React Native inspector is not a browser, and telling its user that "Chrome
 * closed the debugging connection" sends them looking for a Chrome.
 *
 * @param {string} url
 * @param {{ createSocket?: (url: string) => WebSocket, label?: string }} [options]
 */
export async function connectCdp(url, { createSocket = (target) => new WebSocket(target), label = 'Chrome' } = {}) {
  const socket = createSocket(url);
  const pending = new Map();
  const listeners = new Set();
  let nextId = 1;
  let shutdown = null;

  const rejectAll = (error) => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };

  socket.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)); }
    catch { return; }
    if (message.id !== undefined) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) {
        // Keep the protocol code alongside the text: -32601 is how a runtime
        // says it has never heard of a domain, which is the difference between
        // "record with something else" and "this version wants the older call".
        const failure = new Error(`${waiter.method} failed: ${message.error.message || `${label} rejected the command.`}`);
        failure.cdpCode = message.error.code;
        waiter.reject(failure);
      }
      else waiter.resolve(message.result ?? {});
      return;
    }
    if (typeof message.method !== 'string') return;
    // A listener throwing must not take down the socket; the recorder reports
    // its own failures through the capture state instead.
    for (const listener of listeners) {
      try { listener(message.method, message.params ?? {}, message.sessionId); }
      catch { /* ignore */ }
    }
  });

  socket.addEventListener('close', (event) => {
    shutdown ??= new Error(`${label} closed the debugging connection: ${closeReason(event)}`);
    rejectAll(shutdown);
  });
  socket.addEventListener('error', () => {
    shutdown ??= new Error(`The ${label} debugging connection failed.`);
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} did not accept a debugging connection in time.`)), CONNECT_TIMEOUT_MS);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('close', (event) => { clearTimeout(timer); reject(new Error(`${label} refused the debugging connection: ${closeReason(event)}`)); }, { once: true });
  });

  return {
    /**
     * @param {string} method
     * @param {Record<string, unknown>} [params]
     * @param {string} [sessionId] omit to address the browser target itself
     */
    send(method, params = {}, sessionId) {
      if (shutdown) return Promise.reject(shutdown);
      const id = nextId++;
      const payload = { id, method, params, ...(sessionId ? { sessionId } : {}) };
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} did not complete in time.`));
        }, COMMAND_TIMEOUT_MS);
        pending.set(id, {
          method,
          resolve: (value) => { clearTimeout(timer); resolve(value); },
          reject: (error) => { clearTimeout(timer); reject(error); },
        });
        try { socket.send(JSON.stringify(payload)); }
        catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
      });
    },
    /** @param {(method: string, params: Record<string, any>, sessionId?: string) => void} listener */
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get closed() { return Boolean(shutdown) || socket.readyState > 1; },
    close() {
      shutdown ??= new Error(`The ${label} debugging connection was closed.`);
      rejectAll(shutdown);
      try { socket.close(); } catch { /* already gone */ }
    },
  };
}

/**
 * Read a stream handle returned by a CDP command to completion.
 *
 * @param {{ send: Function }} cdp
 * @param {string} handle
 * @param {{ sessionId?: string, size?: number, onChunk?: (bytes: Uint8Array) => Promise<void> }} options
 * @returns {Promise<string | undefined>} concatenated text when no onChunk is given
 */
export async function readProtocolStream(cdp, handle, options = {}) {
  const { sessionId, size = 512 * 1024, onChunk, limitBytes } = options;
  const parts = [];
  let total = 0;
  try {
    for (;;) {
      const result = await cdp.send('IO.read', { handle, size }, sessionId);
      const text = typeof result.data === 'string' ? result.data : '';
      const bytes = result.base64Encoded ? Buffer.from(text, 'base64') : Buffer.from(text, 'utf8');
      total += bytes.byteLength;
      if (limitBytes && total > limitBytes) throw new Error('Stream exceeded its retention limit.');
      if (bytes.byteLength > 0) {
        // Push only after the consumer acknowledges the previous chunk so a
        // fast stream cannot queue an unbounded amount of trace data.
        if (onChunk) await onChunk(bytes);
        else parts.push(bytes);
      }
      if (result.eof) break;
    }
  } finally {
    await cdp.send('IO.close', { handle }, sessionId).catch(() => undefined);
  }
  return onChunk ? undefined : Buffer.concat(parts).toString('utf8');
}
