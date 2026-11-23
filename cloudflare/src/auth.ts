/**
 * Constant-time SHA-256 Bearer token verification safe for Cloudflare Workers.
 */
export async function constantTimeBearerEquals(
  authHeader: string | null | undefined,
  expectedSecret: string | undefined
): Promise<boolean> {
  if (!authHeader || !expectedSecret) {
    return false;
  }

  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  if (!match) {
    return false;
  }

  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(match[1])),
    crypto.subtle.digest('SHA-256', encoder.encode(expectedSecret)),
  ]);

  const provided = new Uint8Array(providedHash);
  const expected = new Uint8Array(expectedHash);

  let diff = 0;
  for (let i = 0; i < provided.length; i++) {
    diff |= provided[i] ^ expected[i];
  }
  return diff === 0;
}

export async function requireInternalAuth(
  request: Request,
  expectedSecret: string | undefined
): Promise<Response | null> {
  const authorized = await constantTimeBearerEquals(
    request.headers.get('authorization'),
    expectedSecret
  );
  if (!authorized) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}
