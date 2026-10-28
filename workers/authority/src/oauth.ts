import {type AuthEnv, stateStore} from './auth.js';
import {
  beginAttempt,
  bindIdentity,
  browserLogin,
  opaque,
} from './browser-login.js';
import {randomToken, tokenHash} from './encoding.js';
import {body, HttpError, json, redirect, requireValue, string} from './http.js';
import {googleIdentity} from './google.js';
import {githubIdentity} from './github-oauth.js';

type Provider = 'google' | 'github';
interface OAuthAttempt {
  flow: string;
  attempt: string;
  verifier: string;
  nonce: string;
  provider: Provider;
}

export async function startOAuth(
  request: Request,
  env: AuthEnv,
  provider: Provider,
) {
  const clientId =
    provider === 'google' ? env.GOOGLE_CLIENT_ID : env.GITHUB_CLIENT_ID;
  const secret =
    provider === 'google' ? env.GOOGLE_CLIENT_SECRET : env.GITHUB_CLIENT_SECRET;
  if (!clientId || !secret)
    throw new HttpError(503, `${provider}_not_configured`);
  const input = await body(request);
  const flow = opaque(input.flow);
  const {login, attempt} = await beginAttempt(request, flow, env);
  const state = randomToken(),
    verifier = randomToken(),
    nonce = randomToken();
  await stateStore(env).put(
    `login-oauth:${await tokenHash(state)}`,
    await stateStore(env).sealSession(
      JSON.stringify({flow, attempt, verifier, nonce, provider}),
    ),
    login.browserHash,
    login.expiresAt,
  );
  const url = new URL(
    provider === 'google'
      ? 'https://accounts.google.com/o/oauth2/v2/auth'
      : 'https://github.com/login/oauth/authorize',
  );
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${env.AUTHORITY_URL}/auth/${provider}/callback`,
    response_type: 'code',
    scope: provider === 'google' ? 'openid email profile' : 'read:org',
    state,
    code_challenge: await tokenHash(verifier),
    code_challenge_method: 'S256',
    prompt: 'select_account',
    ...(provider === 'google' ? {nonce} : {}),
  }).toString();
  return json({authorizationUrl: url.href});
}

export async function oauthCallback(
  request: Request,
  env: AuthEnv,
  fetcher: typeof fetch,
  provider: Provider,
) {
  const url = new URL(request.url);
  const state = opaque(url.searchParams.get('state'));
  const key = `login-oauth:${await tokenHash(state)}`;
  const saved = await stateStore(env).get(key);
  requireValue(saved, 'invalid_oauth_state');
  const oauth = JSON.parse(
    await stateStore(env).openSession(saved),
  ) as OAuthAttempt;
  requireValue(oauth.provider === provider, 'invalid_oauth_state');
  const current = await browserLogin(request, oauth.flow, env);
  requireValue(current.login.attempt === oauth.attempt, 'login_changed');
  requireValue(
    await stateStore(env).take(key, current.proof),
    'invalid_oauth_state',
  );
  try {
    if (url.searchParams.has('error'))
      throw new HttpError(400, 'sign_in_cancelled');
    const code = string(url.searchParams.get('code'), 2048);
    const session =
      provider === 'google'
        ? await googleIdentity(code, oauth.verifier, oauth.nonce, env, fetcher)
        : await githubIdentity(code, oauth.verifier, env, fetcher);
    await bindIdentity(request, oauth.flow, oauth.attempt, env, session);
  } catch (error) {
    await bindIdentity(
      request,
      oauth.flow,
      oauth.attempt,
      env,
      undefined,
      error instanceof HttpError ? error.code : 'sign_in_failed',
    );
  }
  return redirect(`${env.AUTHORITY_URL}/login?flow=${oauth.flow}`);
}
