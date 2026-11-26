/** Serialise parsed trace events into the byte shape a record sink expects. */
export function createTraceEventWriter(sink, { maxBytes = 192 * 1024 } = {}) {
  /** @type {string[]} */
  let parts = [];
  let bufferedBytes = 0;
  let opened = false;
  let ended = false;
  let eventCount = 0;

  const buffer = (text) => {
    parts.push(text);
    bufferedBytes += Buffer.byteLength(text, 'utf8');
  };

  // Awaited, never queued: a fast producer must wait on the sink so unbounded
  // data cannot pile up behind a slow upload or disk write.
  const flush = async () => {
    if (bufferedBytes === 0) return;
    const bytes = Buffer.from(parts.join(''), 'utf8');
    parts = [];
    bufferedBytes = 0;
    await sink.chunk(bytes);
  };

  const open = () => {
    if (opened) return;
    opened = true;
    buffer('{"traceEvents":[');
  };

  return {
    /** @param {Record<string, unknown>[]} events */
    async write(events) {
      if (ended) throw new Error('Cannot write trace events after end().');
      open();
      for (const event of events) {
        buffer(eventCount > 0 ? `,${JSON.stringify(event)}` : JSON.stringify(event));
        eventCount += 1;
        // Per event rather than per batch, so one huge dataCollected payload
        // still reaches the sink in bounded chunks.
        if (bufferedBytes >= maxBytes) await flush();
      }
    },

    async end() {
      if (ended) return;
      ended = true;
      open();
      buffer(']}');
      await flush();
    },

    get eventCount() {
      return eventCount;
    },
  };
}
