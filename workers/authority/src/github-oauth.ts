import {createSession, type AuthEnv} from './auth.js';
import {githubAccount} from './github.js';
import {HttpError} from './http.js';
import {warnTokenError, warnTokenResponse} from './oauth-diagnostics.js';

export async function githubIdentity(
  code: string,
  verifier: string,
  env: AuthEnv,
  fetcher: typeof fetch,
) {
  const response = await fetcher(
    'https://github.com/login/oauth/access_token',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code,
        code_verifier: verifier,
        redirect_uri: `${env.AUTHORITY_URL}/auth/github/callback`,
      }),
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
    },
  );
  if (!response.ok) {
    await warnTokenResponse('github', response, [
      code,
      verifier,
      env.GITHUB_CLIENT_SECRET,
    ]);
    throw new HttpError(502, 'github_authorization_failed');
  }
  const result = await response.json<{
    access_token?: string;
    token_type?: string;
    scope?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  }>();
  if (result.error)
    warnTokenError('github', response.status, result, [
      code,
      verifier,
      env.GITHUB_CLIENT_SECRET,
    ]);
  if (
    !result.access_token ||
    result.error ||
    result.token_type?.toLowerCase() !== 'bearer' ||
    !result.scope?.split(/[ ,]+/).includes('read:org')
  )
    throw new HttpError(502, 'github_authorization_failed');
  const account = await githubAccount(result.access_token, fetcher);
  return createSession(
    account,
    typeof result.expires_in === 'number'
      ? Date.now() + result.expires_in * 1000
      : Infinity,
    result.access_token,
  );
}
