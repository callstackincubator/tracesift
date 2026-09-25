import { OAuthError, cancelOAuth, getOAuthAttempt, inputOAuth, logoutOAuth, startOAuth } from '@callstack/tracesift/oauth';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store' };

export async function GET(request: Request): Promise<Response> {
  const id = new URL(request.url).searchParams.get('attemptId');
  if (!id) return Response.json({ error: 'Missing attemptId.' }, { status: 400, headers });
  try { return Response.json(getOAuthAttempt(id), { headers }); }
  catch (error) { return Response.json({ error: error instanceof OAuthError ? error.message : 'Could not read sign-in status.' }, { status: error instanceof OAuthError ? error.status : 500, headers }); }
}

export async function POST(request: Request): Promise<Response> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return Response.json({ error: 'Expected JSON.' }, { status: 415, headers });
  let body: { action?: unknown; provider?: unknown; method?: unknown; attemptId?: unknown; value?: unknown };
  try { body = await request.json(); }
  catch { return Response.json({ error: 'Expected a JSON body.' }, { status: 400, headers }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return Response.json({ error: 'Invalid sign-in request.' }, { status: 400, headers });
  try {
    if (body.action === 'start' && typeof body.provider === 'string' && (body.method === undefined || typeof body.method === 'string')) return Response.json(await startOAuth(body.provider, body.method ?? 'browser'), { headers });
    if (body.action === 'input' && typeof body.attemptId === 'string') return Response.json(inputOAuth(body.attemptId, body.value), { headers });
    if (body.action === 'cancel' && typeof body.attemptId === 'string') return Response.json(cancelOAuth(body.attemptId), { headers });
    if (body.action === 'logout' && typeof body.provider === 'string') return Response.json(await logoutOAuth(body.provider), { headers });
    return Response.json({ error: 'Invalid sign-in request.' }, { status: 400, headers });
  } catch (error) {
    return Response.json({ error: error instanceof OAuthError ? error.message : 'Could not complete sign-in action.' }, { status: error instanceof OAuthError ? error.status : 500, headers });
  }
}
