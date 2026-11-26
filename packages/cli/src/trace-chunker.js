/**
 * Serialise parsed trace events into the byte shape a record sink expects.
 *
 * The React Native path receives events as objects from `Tracing.dataCollected`
 * rather than as a byte stream from `IO.read`, so this rebuilds the
 * `{"traceEvents":[...]}` document and hands it to `sink.chunk` in bounded
 * pieces. Chunk boundaries fall at arbitrary byte offsets, even mid-string or
 * mid-escape. That is fine: both sinks are pure byte pipes (the ingest sink
 * POSTs each chunk, the local sink appends it to the spool) and only the
 * reassembled whole is ever parsed.
 *
 * @param {{ chunk(bytes: Uint8Array): Promise<void> }} sink
 * @param {{ maxBytes?: number }} [options] `maxBytes` mirrors MAX_UPLOAD_BYTES
 *   in record-session.js, which keeps each ingest POST under the route's cap.
 */
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
