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

const PUBLIC_PAGES: Record<string, string> = {
  '': '/home.html',
  '/': '/home.html',
  '/privacy': '/privacy.html',
  '/terms': '/terms.html',
};

const PUBLIC_CSP = [
  "default-src 'none'",
  "style-src 'self'",
  "font-src 'self' data:",
  "img-src 'self' data:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export function createWebHandler(fetcher: typeof fetch = fetch) {
  const api = createHandler(fetcher);
  return async (request: Request, env: WebEnv): Promise<Response> => {
    const url = new URL(request.url);
    const base = new URL(env.AUTHORITY_URL);
    const prefix = base.pathname.replace(/\/$/, '');
    const path = url.pathname.slice(prefix.length);
    const atBase = url.pathname === prefix || url.pathname === `${prefix}/`;
    const publicPage = Object.hasOwn(PUBLIC_PAGES, path)
      ? PUBLIC_PAGES[path]
      : undefined;
    if (
      url.origin !== base.origin ||
      !['GET', 'HEAD'].includes(request.method) ||
      (!atBase &&
        (!url.pathname.startsWith(`${prefix}/`) ||
          (!publicPage && path !== '/login' && !path.startsWith('/assets/'))))
    )
      return api(request, env);

    const assetUrl = new URL(url);
    assetUrl.pathname =
      publicPage ?? (path === '/login' ? '/index.html' : path);
    assetUrl.search = '';
    const asset = await env.ASSETS.fetch(new Request(assetUrl, request));
    const response = new Response(
      request.method === 'HEAD' ? null : asset.body,
      asset,
    );
    response.headers.set(
      'Referrer-Policy',
      publicPage ? 'no-referrer' : 'origin',
    );
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set(
      'Content-Security-Policy',
      publicPage ? PUBLIC_CSP : LOGIN_CSP,
    );
    if (publicPage || path === '/login')
      response.headers.set('Cache-Control', 'no-store');
    return response;
  };
}
