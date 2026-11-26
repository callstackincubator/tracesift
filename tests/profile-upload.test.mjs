import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

import { decompressedProfile, ProfileUploadError } from '../src/lib/profile-upload.ts';

const document = JSON.stringify({ metadata: { enhancedTraceVersion: 1 }, traceEvents: [{ name: 'RunTask' }] });

function upload(bytes, name) {
  return new File([new Uint8Array(bytes)], name);
}

test('a gzipped trace is inflated and loses its .gz suffix', async () => {
  const file = upload(gzipSync(Buffer.from(document)), 'trace.json.gz');
  const plain = await decompressedProfile(file);
  assert.equal(plain.name, 'trace.json');
  assert.equal(await plain.text(), document);
});

test('a plain JSON upload is handed back untouched', async () => {
  const file = upload(Buffer.from(document), 'trace.json');
  assert.equal(await decompressedProfile(file), file);
});

test('content decides, not the extension', async () => {
  // A trace someone renamed still opens, and a plain file named .gz is left
  // alone rather than failing to decompress.
  const renamed = upload(gzipSync(Buffer.from(document)), 'trace');
  assert.equal(await (await decompressedProfile(renamed)).text(), document);

  const mislabelled = upload(Buffer.from(document), 'trace.json.gz');
  assert.equal(await (await decompressedProfile(mislabelled)).text(), document);
});

test('a truncated gzip member is reported as a bad upload, not a crash', async () => {
  const whole = gzipSync(Buffer.from(document));
  const file = upload(whole.subarray(0, whole.length - 5), 'trace.json.gz');
  await assert.rejects(decompressedProfile(file), (error) => {
    assert.ok(error instanceof ProfileUploadError);
    assert.equal(error.status, 400);
    return true;
  });
});

test('a trace that inflates past the upload ceiling is refused', async () => {
  process.env.TRACE_SIFT_MAX_UPLOAD_MB = '1';
  try {
    const big = JSON.stringify({ traceEvents: new Array(400_000).fill({ name: 'RunTask', ph: 'X' }) });
    assert.ok(big.length > 1024 * 1024);
    const file = upload(gzipSync(Buffer.from(big)), 'trace.json.gz');
    await assert.rejects(decompressedProfile(file), (error) => {
      assert.ok(error instanceof ProfileUploadError);
      assert.equal(error.status, 413);
      return true;
    });
  } finally {
    delete process.env.TRACE_SIFT_MAX_UPLOAD_MB;
  }
});

test('an empty upload is not mistaken for gzip', async () => {
  const file = upload(Buffer.alloc(0), 'trace.json');
  assert.equal(await decompressedProfile(file), file);
});
