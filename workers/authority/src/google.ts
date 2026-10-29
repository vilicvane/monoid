import {createLocalJWKSet, errors, jwtVerify, type JSONWebKeySet} from 'jose';
import {createSession, type AuthEnv} from './auth.js';
import {HttpError} from './http.js';
import {warnTokenResponse} from './oauth-diagnostics.js';

type IdentityCheck =
  | 'signature'
  | 'issuer'
  | 'audience'
  | 'expiry'
  | 'nonce'
  | 'claims';

export async function googleIdentity(
  code: string,
  verifier: string,
  nonce: string,
  env: AuthEnv,
  fetcher: typeof fetch,
) {
  const response = await fetcher('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${env.AUTHORITY_URL}/auth/google/callback`,
    }),
    redirect: 'manual',
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    await warnTokenResponse('google', response, [
      code,
      verifier,
      env.GOOGLE_CLIENT_SECRET,
    ]);
    throw new HttpError(502, 'google_authorization_failed');
  }
  const result = await response.json<{id_token?: string}>();
  if (!result.id_token) throw new HttpError(502, 'google_authorization_failed');
  const keys = await fetcher('https://www.googleapis.com/oauth2/v3/certs', {
    redirect: 'manual',
    signal: AbortSignal.timeout(10000),
  });
  if (!keys.ok) throw new HttpError(502, 'google_unavailable');
  const jwks = await keys.json<JSONWebKeySet>();
  let check: IdentityCheck = 'signature';
  try {
    const {payload} = await jwtVerify(
      result.id_token,
      createLocalJWKSet(jwks),
      {
        issuer: 'https://accounts.google.com',
        audience: env.GOOGLE_CLIENT_ID,
        algorithms: ['RS256'],
        requiredClaims: ['sub', 'exp', 'iat', 'nonce'],
        currentDate: new Date(Date.now()),
      },
    );
    check = 'nonce';
    if (payload.nonce !== nonce) throw new Error('Invalid Google nonce');
    check = 'audience';
    if (
      (Array.isArray(payload.aud) && payload.aud.length > 1 && !payload.azp) ||
      (payload.azp !== undefined && payload.azp !== env.GOOGLE_CLIENT_ID)
    )
      throw new Error('Invalid Google audience');
    check = 'claims';
    if (
      !payload.sub ||
      payload.sub.length > 255 ||
      payload.iat! > Date.now() / 1000
    )
      throw new Error('Invalid Google claims');
    const displayName =
      payload.email_verified === true &&
      typeof payload.email === 'string' &&
      payload.email
        ? payload.email
        : typeof payload.name === 'string' && payload.name
          ? payload.name
          : 'Google account';
    return createSession(
      {source: 'google', id: payload.sub, displayName},
      payload.exp! * 1000,
    );
  } catch (error) {
    if (error instanceof errors.JWTExpired) check = 'expiry';
    else if (error instanceof errors.JWTClaimValidationFailed) {
      switch (error.claim) {
        case 'iss':
          check = 'issuer';
          break;
        case 'aud':
          check = 'audience';
          break;
        case 'exp':
          check = 'expiry';
          break;
        case 'nonce':
          check = 'nonce';
          break;
        default:
          check = 'claims';
      }
    } else if (error instanceof errors.JWTInvalid) check = 'claims';
    console.warn('[oidc] ' + JSON.stringify({provider: 'google', check}));
    throw new HttpError(400, 'invalid_google_identity');
  }
}
