import {createHandler, type Env} from './api.js';

export interface WebEnv extends Env {
  ASSETS: Fetcher;
}

// AppKit's auth iframe requires an origin Referer. Keep that policy scoped to
// the login UI; API and redirect responses retain no-referrer.
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
    const path = url.pathname.slice(base.pathname.length);
    if (
      url.origin !== base.origin ||
      !url.pathname.startsWith(`${base.pathname}/`) ||
      !['GET', 'HEAD'].includes(request.method) ||
      (path !== '/login' && !path.startsWith('/assets/'))
    )
      return api(request, env);

    const assetUrl = new URL(url);
    assetUrl.pathname = path === '/login' ? '/index.html' : path;
    assetUrl.search = '';
    const asset = await env.ASSETS.fetch(new Request(assetUrl, request));
    const response = new Response(asset.body, asset);
    response.headers.set('Referrer-Policy', 'origin');
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('Content-Security-Policy', LOGIN_CSP);
    if (path === '/login') response.headers.set('Cache-Control', 'no-store');
    return response;
  };
}
