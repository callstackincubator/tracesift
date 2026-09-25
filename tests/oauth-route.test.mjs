import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GET, POST } from '../src/app/api/model/oauth/route.ts';
import { PUT as PUT_MODEL } from '../src/app/api/model/route.ts';

test('OAuth route rejects malformed input and reveals no provider errors', async () => {
  const badType = await POST(new Request('http://localhost/api/model/oauth', { method: 'POST', body: '{}' }));
  assert.equal(badType.status, 415);
  const invalidJson = await POST(new Request('http://localhost/api/model/oauth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' }));
  assert.equal(invalidJson.status, 400);
  const badAction = await POST(new Request('http://localhost/api/model/oauth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'start', provider: 'openai' }) }));
  assert.equal(badAction.status, 400);
  const missing = await GET(new Request('http://localhost/api/model/oauth?attemptId=not-a-real-attempt'));
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('cache-control'), 'no-store');
  assert(!JSON.stringify(await missing.json()).includes('token'));
  const invalidModel = await PUT_MODEL(new Request('http://localhost/api/model', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: 'null' }));
  assert.equal(invalidModel.status, 400);
});
