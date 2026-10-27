import {
  isSocialProvider,
  type Session,
  type SignInMethod,
  type SocialProvider,
} from './domain.js';
import {randomToken, tokenHash} from './encoding.js';
import {body, HttpError, json, requireValue, string} from './http.js';
import {reownIdentity, type ReownEnv} from './reown.js';
import {SESSION_IDLE_TTL} from './session.js';
import type {AuthorityState} from './state.js';

export interface AuthEnv extends ReownEnv {
  AUTHORITY_URL: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  APP_REDIRECT_URIS: string;
  APP_ORIGINS: string;
  AUTHORITY_STATE: DurableObjectNamespace<AuthorityState>;
}

const SESSION_TTL = 15 * 60 * 1000;

export function signInMethod(value: unknown): SignInMethod {
  requireValue(
    value === 'wallet' || value === 'email' || value === 'social',
    'invalid_sign_in_method',
  );
  return value as SignInMethod;
}

export function signInProvider(
  method: SignInMethod,
  value: unknown,
): SocialProvider | undefined {
  requireValue(
    method === 'social' ? isSocialProvider(value) : value === undefined,
    'invalid_sign_in_provider',
  );
  return value as SocialProvider | undefined;
}

export const stateStore = (env: AuthEnv) =>
  env.AUTHORITY_STATE.getByName('authority');

export function sessionToken(request: Request): string {
  const token = request.headers
    .get('Authorization')
    ?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  if (!token) throw new HttpError(401, 'unauthorized');
  return token;
}

export async function authenticate(
  request: Request,
  env: AuthEnv,
  fetcher: typeof fetch,
): Promise<Session> {
  const token = sessionToken(request);
  const key = `session:${await tokenHash(token)}`;
  const saved = await stateStore(env).get(key);
  if (!saved) throw new HttpError(401, 'unauthorized');

  const session = JSON.parse(
    await stateStore(env).openSession(saved),
  ) as Session;
  await validateSession(session, env, fetcher);
  // A concurrent logout or expiry wins over a slow upstream verification.
  if (!(await stateStore(env).touchSession(key, session.absoluteExpiresAt)))
    throw new HttpError(401, 'unauthorized');
  return session;
}

export async function logout(
  request: Request,
  env: AuthEnv,
): Promise<Response> {
  const token = sessionToken(request);
  await stateStore(env).remove(`session:${await tokenHash(token)}`);
  return new Response(null, {status: 204});
}

export async function validateSession(
  session: Session,
  env: AuthEnv,
  fetcher: typeof fetch,
): Promise<void> {
  // Older sessions have no idle policy and must authenticate again.
  if (
    !Number.isFinite(session.absoluteExpiresAt) ||
    session.absoluteExpiresAt <= Date.now()
  )
    throw new HttpError(401, 'unauthorized');
  const method = session.account.method;
  const provider = session.account.provider;
  // Sessions predating method metadata must sign in again; never infer wallet.
  if (method !== 'wallet' && method !== 'email' && method !== 'social')
    throw new HttpError(401, 'reown_reauthentication_required');
  if (
    method === 'social' ? !isSocialProvider(provider) : provider !== undefined
  )
    throw new HttpError(401, 'reown_reauthentication_required');
  const verified = await reownIdentity(session.reownToken, env, fetcher);
  if (verified.account.id !== session.account.id)
    throw new HttpError(401, 'reown_identity_changed');
  session.account = {
    ...verified.account,
    method,
    ...(provider ? {provider} : {}),
  };
  session.wallet = method === 'wallet' ? verified.wallet : undefined;
  session.absoluteExpiresAt = Math.min(
    session.absoluteExpiresAt,
    verified.expiresAt,
  );
}

export async function issueSession(
  session: Session,
  env: AuthEnv,
): Promise<Response> {
  const token = randomToken();
  const now = Date.now();
  const expiresAt = Math.min(session.absoluteExpiresAt, now + SESSION_IDLE_TTL);
  const expiresIn = Math.floor((expiresAt - now) / 1000);
  if (expiresIn <= 0) throw new HttpError(401, 'unauthorized');
  await stateStore(env).put(
    `session:${await tokenHash(token)}`,
    await stateStore(env).sealSession(JSON.stringify(session)),
    '',
    expiresAt,
  );
  return json({
    accessToken: token,
    tokenType: 'Bearer',
    expiresIn,
    account: session.account,
  });
}

export async function reownLogin(
  request: Request,
  env: AuthEnv,
  fetcher: typeof fetch,
): Promise<Response> {
  const input = await body(request);
  const token = string(input.token, 3072);
  const method = signInMethod(input.method);
  const provider = signInProvider(method, input.provider);
  return issueSession(
    await createReownSession(token, method, env, fetcher, provider),
    env,
  );
}

export async function createReownSession(
  token: string,
  method: SignInMethod,
  env: AuthEnv,
  fetcher: typeof fetch,
  provider?: SocialProvider,
): Promise<Session> {
  const verified = await reownIdentity(token, env, fetcher);
  return {
    account: {...verified.account, method, ...(provider ? {provider} : {})},
    wallet: method === 'wallet' ? verified.wallet : undefined,
    reownToken: token,
    absoluteExpiresAt: Math.min(verified.expiresAt, Date.now() + SESSION_TTL),
  };
}
