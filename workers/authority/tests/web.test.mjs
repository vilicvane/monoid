import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createWebHandler} from '../.bld/web.js';

test('hosted login assets never receive the browser flow query and use scoped security headers', async () => {
  const requests = [];
  const env = {
    AUTHORITY_URL: 'https://www.monoid.app/api/authority',
    ASSETS: {
      fetch: async request => {
        requests.push(request);
        return new Response('<!doctype html>', {
          headers: {
            'Content-Type': 'text/html',
            'Cache-Control': 'public,max-age=3600',
          },
        });
      },
    },
  };
  const handler = createWebHandler();
  const page = await handler(
    new Request(`${env.AUTHORITY_URL}/login?flow=private-flow`),
    env,
  );
  assert.equal(new URL(requests[0].url).pathname, '/index.html');
  assert.equal(new URL(requests[0].url).search, '');
  assert.equal(page.headers.get('Cache-Control'), 'no-store');
  assert.equal(page.headers.get('Referrer-Policy'), 'origin');
  assert.equal(page.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.match(
    page.headers.get('Content-Security-Policy'),
    /frame-ancestors 'none'/,
  );
  assert.match(
    page.headers.get('Content-Security-Policy'),
    /script-src 'self'/,
  );
  const asset = await handler(
    new Request(`${env.AUTHORITY_URL}/assets/login.js?flow=private-flow`),
    env,
  );
  assert.equal(new URL(requests[1].url).pathname, '/assets/login.js');
  assert.equal(new URL(requests[1].url).search, '');
  assert.equal(asset.headers.get('Cache-Control'), 'public,max-age=3600');
});

test('asset routing cannot swallow API requests or requests to an untrusted host', async () => {
  let assetCalls = 0;
  const env = {
    AUTHORITY_URL: 'https://www.monoid.app/api/authority',
    APP_ORIGINS: '[]',
    REQUEST_LIMIT: {limit: async () => ({success: true})},
    ASSETS: {
      fetch: async () => {
        ++assetCalls;
        return new Response('asset');
      },
    },
  };
  const handler = createWebHandler();
  const api = await handler(
    new Request(`${env.AUTHORITY_URL}/auth/missing`),
    env,
  );
  assert.equal(api.status, 404);
  assert.equal(api.headers.get('Referrer-Policy'), 'no-referrer');
  assert.match(
    api.headers.get('Content-Security-Policy'),
    /default-src 'none'/,
  );
  const wrongHost = await handler(
    new Request('https://evil.example/api/authority/login'),
    env,
  );
  assert.equal(wrongHost.status, 400);
  const wrongBase = await handler(
    new Request('https://www.monoid.app/api/authority-other/login'),
    env,
  );
  assert.equal(wrongBase.status, 404);
  const post = await handler(
    new Request(`${env.AUTHORITY_URL}/login`, {method: 'POST'}),
    env,
  );
  assert.equal(post.status, 404);
  assert.equal(assetCalls, 0);
});
