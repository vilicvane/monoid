import {
  authenticate,
  type AuthEnv,
  issueSession,
  stateStore,
  validateSession,
  sessionToken,
} from './auth.js';
import type {Session} from './domain.js';
import {randomToken, tokenHash} from './encoding.js';
import {
  body,
  escapeHTML,
  html,
  HttpError,
  json,
  redirect,
  requireValue,
  string,
} from './http.js';
import {githubAccount} from './github.js';

interface Flow {
  challenge: string;
  redirectUri: string;
  clientState: string;
  sessionKey: string;
}

interface BrowserFlow extends Flow {
  githubVerifier: string;
}

interface Grant extends Flow {
  session: Session;
}

const LOGIN_TTL = 10 * 60 * 1000;
const CODE_TTL = 60 * 1000;

export function cookieName(env: AuthEnv): string {
  return new URL(env.AUTHORITY_URL).protocol === 'https:'
    ? '__Host-monoid-authority'
    : 'monoid-authority-dev';
}

function cookie(
  env: AuthEnv,
  value: string,
  maxAge = LOGIN_TTL / 1000,
): string {
  return `${cookieName(env)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${new URL(env.AUTHORITY_URL).protocol === 'https:' ? '; Secure' : ''}`;
}

function browserProof(request: Request, env: AuthEnv): string {
  const prefix = `${cookieName(env)}=`;
  const value = request.headers
    .get('Cookie')
    ?.split(';')
    .map(item => item.trim())
    .find(item => item.startsWith(prefix))
    ?.slice(prefix.length);
  requireValue(
    value && /^[A-Za-z0-9_-]{43}$/.test(value),
    'invalid_browser_session',
  );
  return value;
}

function requireGitHub(env: AuthEnv): void {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    throw new HttpError(503, 'github_not_configured');
  }
}

export async function startLogin(
  request: Request,
  env: AuthEnv,
  fetcher: typeof fetch,
): Promise<Response> {
  requireGitHub(env);
  await authenticate(request, env, fetcher);
  const input = await body(request);
  const redirectUri = string(input.redirectUri, 512);
  const allowed = JSON.parse(env.APP_REDIRECT_URIS) as string[];
  requireValue(allowed.includes(redirectUri), 'redirect_not_allowed');
  const uri = new URL(redirectUri);
  requireValue(!uri.hash && !uri.username && !uri.password);

  const challenge = string(input.codeChallenge, 43);
  requireValue(/^[A-Za-z0-9_-]{43}$/.test(challenge));
  const clientState = string(input.state, 128);
  requireValue(/^[A-Za-z0-9_-]{22,128}$/.test(clientState));
  const sessionKey = `session:${await tokenHash(sessionToken(request))}`;
  const flow: Flow = {challenge, redirectUri, clientState, sessionKey};
  const token = randomToken();

  await stateStore(env).put(
    `start:${await tokenHash(token)}`,
    JSON.stringify(flow),
    '',
    Date.now() + LOGIN_TTL,
  );
  return json({
    authorizationUrl: `${env.AUTHORITY_URL}/auth/github?request=${token}`,
    expiresIn: LOGIN_TTL / 1000,
  });
}

export async function authorize(
  request: Request,
  env: AuthEnv,
): Promise<Response> {
  requireGitHub(env);
  const token = string(new URL(request.url).searchParams.get('request'));
  const saved = await stateStore(env).take(
    `start:${await tokenHash(token)}`,
    '',
  );
  requireValue(saved, 'invalid_login_request');
  const flow = JSON.parse(saved) as Flow;
  const state = randomToken();
  const browser = randomToken();
  const githubVerifier = randomToken();

  await stateStore(env).put(
    `oauth:${await tokenHash(state)}`,
    JSON.stringify({...flow, githubVerifier}),
    await tokenHash(browser),
    Date.now() + LOGIN_TTL,
  );

  const url = new URL('https://github.com/login/oauth/authorize');
  url.search = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: `${env.AUTHORITY_URL}/auth/github/callback`,
    scope: 'read:org',
    state,
    code_challenge: await tokenHash(githubVerifier),
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString();

  return redirect(url.href, cookie(env, browser));
}

export async function githubCallback(
  request: Request,
  env: AuthEnv,
  fetcher: typeof fetch,
): Promise<Response> {
  requireGitHub(env);
  const url = new URL(request.url);
  const browser = browserProof(request, env);
  const state = string(url.searchParams.get('state'));
  const saved = await stateStore(env).take(
    `oauth:${await tokenHash(state)}`,
    await tokenHash(browser),
  );
  requireValue(saved, 'invalid_oauth_state');

  if (url.searchParams.has('error')) {
    return html(
      '<!doctype html><meta charset="utf-8"><title>Monoid</title><p>Sign-in cancelled. Return to Monoid and try again.</p>',
    );
  }

  const flow = JSON.parse(saved) as BrowserFlow;
  const code = string(url.searchParams.get('code'), 512);
  const tokenResponse = await fetcher(
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
        redirect_uri: `${env.AUTHORITY_URL}/auth/github/callback`,
        code_verifier: flow.githubVerifier,
      }),
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
    },
  );
  if (!tokenResponse.ok) throw new HttpError(502, 'github_unavailable');

  const result = await tokenResponse.json<{
    access_token?: string;
    token_type?: string;
    error?: string;
  }>();
  if (
    !result.access_token ||
    result.error ||
    result.token_type?.toLowerCase() !== 'bearer'
  ) {
    throw new HttpError(502, 'github_authorization_failed');
  }

  const user = await githubAccount(result.access_token, fetcher);
  // Retain only encrypted, short-lived provider credentials for live org checks.
  const existing = await stateStore(env).get(flow.sessionKey);
  if (!existing) throw new HttpError(401, 'unauthorized');
  const session = JSON.parse(
    await stateStore(env).openSession(existing),
  ) as Session;
  const grant: Grant = {
    challenge: flow.challenge,
    redirectUri: flow.redirectUri,
    clientState: flow.clientState,
    sessionKey: flow.sessionKey,
    session: {...session, github: {account: user, token: result.access_token}},
  };
  const approval = randomToken();
  await stateStore(env).put(
    `approve:${await tokenHash(approval)}`,
    await stateStore(env).sealSession(JSON.stringify(grant)),
    await tokenHash(browser),
    Date.now() + LOGIN_TTL,
  );

  return html(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Connect GitHub to Monoid</title><h1>Connect GitHub</h1><p>Connect <strong>${escapeHTML(user.login)}</strong> to your Monoid session to use organizations you own?</p><p>Continue only if you started this connection in Monoid.</p><form method="post" action="${escapeHTML(env.AUTHORITY_URL)}/auth/approve?approval=${approval}"><button type="submit">Connect GitHub</button></form></html>`,
  );
}

export async function approve(
  request: Request,
  env: AuthEnv,
): Promise<Response> {
  requireValue(
    request.headers.get('Origin') === new URL(env.AUTHORITY_URL).origin,
    'invalid_origin',
  );
  const browser = browserProof(request, env);
  const approval = string(new URL(request.url).searchParams.get('approval'));
  const saved = await stateStore(env).take(
    `approve:${await tokenHash(approval)}`,
    await tokenHash(browser),
  );
  requireValue(saved, 'invalid_approval');
  const grant = JSON.parse(await stateStore(env).openSession(saved)) as Grant;
  if (!(await stateStore(env).get(grant.sessionKey)))
    throw new HttpError(401, 'unauthorized');
  const code = randomToken();
  await stateStore(env).put(
    `code:${await tokenHash(code)}`,
    await stateStore(env).sealSession(
      JSON.stringify({session: grant.session, sessionKey: grant.sessionKey}),
    ),
    grant.challenge,
    Date.now() + CODE_TTL,
  );

  const target = new URL(grant.redirectUri);
  target.searchParams.set('code', code);
  target.searchParams.set('state', grant.clientState);
  return redirect(target.href, cookie(env, '', 0));
}

export async function exchange(
  request: Request,
  env: AuthEnv,
  fetcher: typeof fetch,
): Promise<Response> {
  const input = await body(request);
  const code = string(input.code);
  const verifier = string(input.codeVerifier, 128);
  requireValue(/^[A-Za-z0-9._~-]{43,128}$/.test(verifier));
  const saved = await stateStore(env).take(
    `code:${await tokenHash(code)}`,
    await tokenHash(verifier),
  );
  requireValue(saved, 'invalid_grant');

  const {session, sessionKey} = JSON.parse(
    await stateStore(env).openSession(saved),
  ) as {
    session: Session;
    sessionKey: string;
  };
  await validateSession(session, env, fetcher);
  if (!(await stateStore(env).take(sessionKey, '')))
    throw new HttpError(401, 'unauthorized');
  return issueSession(session, env);
}
