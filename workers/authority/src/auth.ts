import type {Session} from './domain.js';
import {randomToken, tokenHash} from './encoding.js';
import {body, HttpError, json, string} from './http.js';
import {openSession, sealSession} from './session.js';
import {reownIdentity, type ReownEnv} from './reown.js';
import type {AuthorityState} from './state.js';

export interface AuthEnv extends ReownEnv {
  AUTHORITY_URL: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  APP_REDIRECT_URIS: string;
  APP_ORIGINS: string;
  BUNDLE_MASTER_KEY: string;
  AUTHORITY_STATE: DurableObjectNamespace<AuthorityState>;
}

const SESSION_TTL = 15 * 60 * 1000;

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

  const saved = await stateStore(env).get(`session:${await tokenHash(token)}`);
  if (!saved) throw new HttpError(401, 'unauthorized');

  const session = await openSession<Session>(saved, env.BUNDLE_MASTER_KEY);
  await validateSession(session, env, fetcher);
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
  if (session.expiresAt <= Date.now()) throw new HttpError(401, 'unauthorized');
  const verified = await reownIdentity(session.reownToken, env, fetcher);
  if (verified.account.id !== session.account.id)
    throw new HttpError(401, 'reown_identity_changed');
  session.account = verified.account;
  session.wallet = verified.wallet;
}

export async function issueSession(
  session: Session,
  env: AuthEnv,
): Promise<Response> {
  const token = randomToken();
  const expiresIn = Math.floor((session.expiresAt - Date.now()) / 1000);
  if (expiresIn <= 0) throw new HttpError(401, 'unauthorized');
  await stateStore(env).put(
    `session:${await tokenHash(token)}`,
    await sealSession(session, env.BUNDLE_MASTER_KEY),
    '',
    session.expiresAt,
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
  return issueSession(await createReownSession(token, env, fetcher), env);
}

export async function createReownSession(
  token: string,
  env: AuthEnv,
  fetcher: typeof fetch,
): Promise<Session> {
  const verified = await reownIdentity(token, env, fetcher);
  return {
    account: verified.account,
    wallet: verified.wallet,
    reownToken: token,
    expiresAt: Math.min(verified.expiresAt, Date.now() + SESSION_TTL),
  };
}
