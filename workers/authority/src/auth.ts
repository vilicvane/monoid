import type {Account, Session} from './domain.js';
import {randomToken, tokenHash} from './encoding.js';
import {HttpError, json} from './http.js';
import {SESSION_IDLE_TTL} from './session.js';
import type {AuthorityState} from './state.js';

export interface AuthEnv {
  AUTHORITY_URL: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  WALLETCONNECT_PROJECT_ID: string;
  ETHEREUM_RPC_URL: string;
  APP_REDIRECT_URIS: string;
  APP_ORIGINS: string;
  AUTHORITY_STATE: DurableObjectNamespace<AuthorityState>;
}

export const SESSION_TTL = 15 * 60 * 1000;
export const stateStore = (env: AuthEnv) =>
  env.AUTHORITY_STATE.getByName('authority');

export function sessionToken(request: Request): string {
  const token = request.headers
    .get('Authorization')
    ?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  if (!token) throw new HttpError(401, 'unauthorized');
  return token;
}

export function validateSession(session: Session): void {
  if (
    !Number.isFinite(session.absoluteExpiresAt) ||
    session.absoluteExpiresAt <= Date.now() ||
    !['google', 'github-user', 'wallet'].includes(session.account?.source)
  )
    throw new HttpError(401, 'unauthorized');
}

export async function authenticate(
  request: Request,
  env: AuthEnv,
): Promise<Session> {
  const key = `session:${await tokenHash(sessionToken(request))}`;
  const saved = await stateStore(env).get(key);
  if (!saved) throw new HttpError(401, 'unauthorized');
  const session = JSON.parse(
    await stateStore(env).openSession(saved),
  ) as Session;
  validateSession(session);
  if (!(await stateStore(env).touchSession(key, session.absoluteExpiresAt)))
    throw new HttpError(401, 'unauthorized');
  return session;
}

export async function logout(
  request: Request,
  env: AuthEnv,
): Promise<Response> {
  await stateStore(env).remove(
    `session:${await tokenHash(sessionToken(request))}`,
  );
  return new Response(null, {status: 204});
}

export function createSession(
  account: Account,
  providerExpiry = Infinity,
  githubToken?: string,
): Session {
  return {
    account,
    absoluteExpiresAt: Math.min(providerExpiry, Date.now() + SESSION_TTL),
    ...(githubToken ? {githubToken} : {}),
  };
}

export async function issueSession(
  session: Session,
  env: AuthEnv,
): Promise<Response> {
  validateSession(session);
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
