import {
  type AuthEnv,
  createReownSession,
  issueSession,
  signInMethod,
  signInProvider,
  stateStore,
  validateSession,
} from './auth.js';
import type {Session} from './domain.js';
import {decode, randomToken, tokenHash} from './encoding.js';
import {
  body,
  bytes,
  HttpError,
  json,
  redirect,
  requireValue,
  string,
} from './http.js';

interface LoginRequest {
  redirectUri: string;
  state: string;
  challenge: string;
  expiresAt: number;
}

interface BrowserLogin extends LoginRequest {
  browserHash: string;
}

const LOGIN_TTL = 10 * 60 * 1000;
const CODE_TTL = 60 * 1000;

function opaque(value: unknown): string {
  bytes(value, 32);
  return value as string;
}

function callbackUri(value: unknown, env: AuthEnv): string {
  const uri = string(value, 512);
  const allowed = JSON.parse(env.APP_REDIRECT_URIS) as string[];
  requireValue(allowed.includes(uri), 'redirect_not_allowed');

  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new HttpError(400, 'redirect_not_allowed');
  }
  requireValue(
    !parsed.hash && !parsed.username && !parsed.password && !parsed.search,
    'redirect_not_allowed',
  );
  return uri;
}

function cookieName(flow: string, env: AuthEnv): string {
  const secure = new URL(env.AUTHORITY_URL).protocol === 'https:';
  return `${secure ? '__Host-' : ''}monoid-login-${flow}`;
}

function cookie(flow: string, value: string, env: AuthEnv, maxAge: number) {
  const secure = new URL(env.AUTHORITY_URL).protocol === 'https:';
  return `${cookieName(flow, env)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function requireBrowserOrigin(request: Request, env: AuthEnv): void {
  if (request.headers.get('Origin') !== new URL(env.AUTHORITY_URL).origin)
    throw new HttpError(403, 'invalid_origin');
}

async function browserLogin(request: Request, flow: string, env: AuthEnv) {
  const prefix = `${cookieName(flow, env)}=`;
  const browser = request.headers
    .get('Cookie')
    ?.split(';')
    .map(item => item.trim())
    .find(item => item.startsWith(prefix))
    ?.slice(prefix.length);
  requireValue(browser, 'invalid_browser_session');
  opaque(browser);

  const key = `login-flow:${await tokenHash(flow)}`;
  const saved = await stateStore(env).get(key);
  requireValue(saved, 'invalid_login_request');
  const login = JSON.parse(saved) as BrowserLogin;
  const proof = await tokenHash(browser);
  requireValue(proof === login.browserHash, 'invalid_browser_session');
  return {login, key, proof};
}

export async function startBrowserLogin(request: Request, env: AuthEnv) {
  if (!env.REOWN_PROJECT_ID) throw new HttpError(503, 'reown_not_configured');
  const input = await body(request);
  const redirectUri = callbackUri(input.redirectUri, env);
  requireValue(input.codeChallengeMethod === 'S256', 'invalid_pkce');
  const challenge = opaque(input.codeChallenge);
  const state = string(input.state, 128);
  try {
    requireValue(decode(state).length >= 16, 'invalid_state');
  } catch {
    throw new HttpError(400, 'invalid_state');
  }

  const expiresAt = Date.now() + LOGIN_TTL;
  const login: LoginRequest = {redirectUri, state, challenge, expiresAt};
  const token = randomToken();
  await stateStore(env).put(
    `login-start:${await tokenHash(token)}`,
    JSON.stringify(login),
    '',
    expiresAt,
  );
  return json({
    authorizationUrl: `${env.AUTHORITY_URL}/auth/login?request=${token}`,
    expiresIn: LOGIN_TTL / 1000,
  });
}

export async function authorizeBrowserLogin(request: Request, env: AuthEnv) {
  const token = opaque(new URL(request.url).searchParams.get('request'));
  const saved = await stateStore(env).take(
    `login-start:${await tokenHash(token)}`,
    '',
  );
  requireValue(saved, 'invalid_login_request');
  const login = JSON.parse(saved) as LoginRequest;
  const flow = randomToken();
  const browser = randomToken();
  const browserHash = await tokenHash(browser);
  await stateStore(env).put(
    `login-flow:${await tokenHash(flow)}`,
    JSON.stringify({...login, browserHash}),
    browserHash,
    login.expiresAt,
  );
  return redirect(
    `${env.AUTHORITY_URL}/login?flow=${flow}`,
    cookie(
      flow,
      browser,
      env,
      Math.ceil((login.expiresAt - Date.now()) / 1000),
    ),
  );
}

export async function browserLoginContext(request: Request, env: AuthEnv) {
  const flow = opaque(new URL(request.url).searchParams.get('flow'));
  const {login} = await browserLogin(request, flow, env);
  return json({projectId: env.REOWN_PROJECT_ID, expiresAt: login.expiresAt});
}

function appCallback(login: LoginRequest, values: Record<string, string>) {
  const target = new URL(login.redirectUri);
  target.search = new URLSearchParams({
    ...values,
    state: login.state,
  }).toString();
  return target.href;
}

// Include the exact redirect in the atomic proof check so an invalid redirect
// cannot consume a code, even if the caller knows its PKCE verifier.
const grantProof = (challenge: string, redirectUri: string) =>
  tokenHash(JSON.stringify([challenge, redirectUri]));

export async function completeBrowserLogin(
  request: Request,
  env: AuthEnv,
  fetcher: typeof fetch,
) {
  requireBrowserOrigin(request, env);
  const input = await body(request);
  requireValue(
    Object.keys(input).every(key =>
      ['flow', 'token', 'method', 'provider'].includes(key),
    ),
    'invalid_login_request',
  );
  const method = signInMethod(input.method);
  const provider = signInProvider(method, input.provider);
  const flow = opaque(input.flow);
  const {login, key, proof} = await browserLogin(request, flow, env);
  const token = string(input.token, 3072);
  const session = await createReownSession(
    token,
    method,
    env,
    fetcher,
    provider,
  );
  // Provider failures leave the browser flow available for a deliberate retry.
  // Only one racing completion/cancellation can acquire the verified flow.
  requireValue(await stateStore(env).take(key, proof), 'invalid_login_request');

  const code = randomToken();
  await stateStore(env).put(
    `login-code:${await tokenHash(code)}`,
    await stateStore(env).sealSession(JSON.stringify(session)),
    await grantProof(login.challenge, login.redirectUri),
    Math.min(session.absoluteExpiresAt, Date.now() + CODE_TTL),
  );
  const response = json({redirectUrl: appCallback(login, {code})});
  response.headers.set('Set-Cookie', cookie(flow, '', env, 0));
  return response;
}

export async function cancelBrowserLogin(request: Request, env: AuthEnv) {
  requireBrowserOrigin(request, env);
  const input = await body(request);
  const flow = opaque(input.flow);
  const {login, key, proof} = await browserLogin(request, flow, env);
  requireValue(await stateStore(env).take(key, proof), 'invalid_login_request');
  const response = json({
    redirectUrl: appCallback(login, {error: 'access_denied'}),
  });
  response.headers.set('Set-Cookie', cookie(flow, '', env, 0));
  return response;
}

export async function exchangeBrowserLogin(
  request: Request,
  env: AuthEnv,
  fetcher: typeof fetch,
) {
  const input = await body(request);
  const code = opaque(input.code);
  const verifier = string(input.codeVerifier, 128);
  requireValue(/^[A-Za-z0-9._~-]{43,128}$/.test(verifier), 'invalid_pkce');
  const redirectUri = callbackUri(input.redirectUri, env);
  const saved = await stateStore(env).take(
    `login-code:${await tokenHash(code)}`,
    await grantProof(await tokenHash(verifier), redirectUri),
  );
  requireValue(saved, 'invalid_grant');
  const session = JSON.parse(
    await stateStore(env).openSession(saved),
  ) as Session;
  await validateSession(session, env, fetcher);
  return issueSession(session, env);
}
