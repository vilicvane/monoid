import {createHandler, type Env} from './api.js';

export interface WebEnv extends Env {
  ASSETS: Fetcher;
}

// Wallet UI resources receive only the origin, never flow/OAuth parameters.
// API and redirect responses retain no-referrer.
const LOGIN_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' https: data: blob:",
  "connect-src 'self' https://*.reown.com https://*.walletconnect.org https://*.walletconnect.com https://*.web3modal.org https://*.web3modal.com wss://*.walletconnect.org wss://*.walletconnect.com",
  'frame-src https://*.walletconnect.org https://*.walletconnect.com https://*.reown.com',
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

export function createWebHandler(fetcher: typeof fetch = fetch) {
  const api = createHandler(fetcher);
  return async (request: Request, env: WebEnv): Promise<Response> => {
    const url = new URL(request.url);
    const base = new URL(env.AUTHORITY_URL);
    const prefix = base.pathname.replace(/\/$/, '');
    const path = url.pathname.slice(prefix.length);
    const atBase = url.pathname === prefix || url.pathname === `${prefix}/`;
    if (
      url.origin !== base.origin ||
      !['GET', 'HEAD'].includes(request.method) ||
      (!atBase &&
        (!url.pathname.startsWith(`${prefix}/`) ||
          (path !== '/login' && !path.startsWith('/assets/'))))
    )
      return api(request, env);

    let response: Response;
    if (atBase) {
      response = new Response(null, {
        status: 302,
        headers: {Location: `${prefix}/login`},
      });
    } else {
      const assetUrl = new URL(url);
      assetUrl.pathname = path === '/login' ? '/index.html' : path;
      assetUrl.search = '';
      const asset = await env.ASSETS.fetch(new Request(assetUrl, request));
      response = new Response(asset.body, asset);
    }
    response.headers.set('Referrer-Policy', atBase ? 'no-referrer' : 'origin');
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('Content-Security-Policy', LOGIN_CSP);
    if (atBase || path === '/login')
      response.headers.set('Cache-Control', 'no-store');
    return response;
  };
}
