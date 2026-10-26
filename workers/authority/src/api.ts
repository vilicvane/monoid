import {
  authenticate,
  type AuthEnv,
  logout,
  reownLogin,
  stateStore,
} from './auth.js';
import {
  authorizeBrowserLogin,
  browserLoginContext,
  cancelBrowserLogin,
  completeBrowserLogin,
  exchangeBrowserLogin,
  startBrowserLogin,
} from './browser-login.js';
import {
  approve,
  authorize,
  exchange,
  githubCallback,
  startLogin,
} from './github-oauth.js';
import {body, bytes, HttpError, json, requireValue} from './http.js';
import {organizations} from './github.js';
import {groupName} from './names.js';
import {authorizeOwner, identities} from './identities.js';

export interface Env extends AuthEnv {
  REQUEST_LIMIT: RateLimit;
}

export function createHandler(fetcher: typeof fetch = fetch) {
  return async (request: Request, env: Env): Promise<Response> => {
    const origin = request.headers.get('Origin');
    let allowed = false;
    let response: Response;

    try {
      const allowedOrigins = JSON.parse(env.APP_ORIGINS) as string[];
      const base = new URL(env.AUTHORITY_URL);
      // "*" opens the API to any origin; browser login and approval endpoints
      // still require the Authority's own origin.
      allowed =
        !origin ||
        origin === base.origin ||
        allowedOrigins.includes('*') ||
        allowedOrigins.includes(origin);
      if (!allowed) throw new HttpError(403, 'origin_not_allowed');

      if (request.method === 'OPTIONS') {
        response = new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Authorization, Content-Type',
            'Access-Control-Max-Age': '600',
          },
        });
      } else {
        const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
        if (!(await env.REQUEST_LIMIT.limit({key: ip})).success) {
          throw new HttpError(429, 'rate_limited');
        }

        const url = new URL(request.url);
        requireValue(url.origin === base.origin, 'invalid_authority_origin');
        const prefix = base.pathname.replace(/\/$/, '');
        const path = url.pathname.startsWith(`${prefix}/`)
          ? url.pathname.slice(prefix.length)
          : '';
        const route = `${request.method} ${path}`;

        const resolveOwner = async (
          input: unknown,
          session: Awaited<ReturnType<typeof authenticate>>,
        ) => {
          const verified = await authorizeOwner(input, session, fetcher);
          return stateStore(env).namespace(
            {source: verified.source, id: verified.id},
            verified.displayName,
          );
        };

        switch (route) {
          case 'GET /v1/metadata':
            response = json(await stateStore(env).metadata());
            break;
          case 'POST /auth/reown':
            response = await reownLogin(request, env, fetcher);
            break;
          case 'POST /auth/login/start':
            response = await startBrowserLogin(request, env);
            break;
          case 'GET /auth/login':
            response = await authorizeBrowserLogin(request, env);
            break;
          case 'GET /auth/login/context':
            response = await browserLoginContext(request, env);
            break;
          case 'POST /auth/login/complete':
            response = await completeBrowserLogin(request, env, fetcher);
            break;
          case 'POST /auth/login/cancel':
            response = await cancelBrowserLogin(request, env);
            break;
          case 'POST /auth/login/token':
            response = await exchangeBrowserLogin(request, env, fetcher);
            break;
          case 'POST /auth/github/start':
            response = await startLogin(request, env, fetcher);
            break;
          case 'GET /auth/github':
            response = await authorize(request, env);
            break;
          case 'GET /auth/github/callback':
            response = await githubCallback(request, env, fetcher);
            break;
          case 'POST /auth/approve':
            response = await approve(request, env);
            break;
          case 'POST /auth/token':
            response = await exchange(request, env, fetcher);
            break;
          case 'POST /auth/logout':
            response = await logout(request, env);
            break;
          case 'GET /v1/me': {
            const session = await authenticate(request, env, fetcher);
            response = json({account: session.account});
            break;
          }
          case 'GET /v1/organizations': {
            const session = await authenticate(request, env, fetcher);
            response = json({
              organizations: await organizations(session, fetcher),
            });
            break;
          }
          case 'GET /v1/namespaces': {
            const session = await authenticate(request, env, fetcher);
            response = json({
              namespaces: await stateStore(env).namespaces(
                await identities(session, fetcher),
              ),
            });
            break;
          }
          case 'POST /v1/namespaces/name': {
            const session = await authenticate(request, env, fetcher);
            const input = await body(request);
            const owner = await resolveOwner(input.owner, session);
            response = json({
              namespace: await stateStore(env).namespace(
                {source: owner.source, id: owner.id},
                owner.displayName,
                groupName(input.displayName),
              ),
            });
            break;
          }
          case 'POST /v1/groups/list': {
            const session = await authenticate(request, env, fetcher);
            const input = await body(request);
            const owner = await resolveOwner(input.owner, session);
            const after =
              input.after === undefined ? '' : groupName(input.after);
            const groups = await stateStore(env).groups(owner, after);
            response = json({
              owner,
              groups,
              next: groups.length === 100 ? groups[99].name : null,
            });
            break;
          }
          case 'POST /v1/time': {
            const input = await body(request);
            const challenge = bytes(input.challenge, 32);
            response = json(await stateStore(env).issueTime(challenge));
            break;
          }
          case 'POST /v1/bundle': {
            const session = await authenticate(request, env, fetcher);
            if (
              !(
                await env.REQUEST_LIMIT.limit({
                  key: `bundle:${session.account.id}`,
                })
              ).success
            )
              throw new HttpError(429, 'rate_limited');

            const input = await body(request);
            const name = groupName(input.groupName);
            const recipient = bytes(input.recipientPublicKey, 65);
            requireValue(
              recipient[0] === 4 &&
                typeof input.allowPeerExtension === 'boolean',
            );

            try {
              await crypto.subtle.importKey(
                'raw',
                recipient,
                {name: 'ECDH', namedCurve: 'P-256'},
                false,
                [],
              );
            } catch {
              throw new HttpError(400, 'invalid_public_key');
            }

            const owner = await resolveOwner(input.owner, session);
            const group = await stateStore(env).group(
              owner,
              name,
              input.allowPeerExtension,
            );
            if (group!.allowPeerExtension !== input.allowPeerExtension)
              throw new HttpError(409, 'bundle_policy_conflict');

            response = json(
              await stateStore(env).issueBundle(
                owner,
                name,
                group!.allowPeerExtension,
                recipient,
              ),
            );
            break;
          }
          default:
            throw new HttpError(404, 'not_found');
        }
      }
    } catch (error) {
      // Do not log provider responses, OAuth codes, sessions or key material.
      response =
        error instanceof HttpError
          ? json({error: error.code}, error.status)
          : json({error: 'internal_error'}, 500);
      if (response.status === 429) response.headers.set('Retry-After', '60');
    }

    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('Referrer-Policy', 'no-referrer');
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set(
      'Content-Security-Policy',
      "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    response.headers.set('Vary', 'Origin');
    if (origin && allowed)
      response.headers.set('Access-Control-Allow-Origin', origin);

    return response;
  };
}
