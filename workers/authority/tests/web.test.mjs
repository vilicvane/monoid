import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {createWebHandler} from '../.bld/web.js';
import {cryptoState} from './helpers.mjs';

test('custom domain serves root API and login assets without the development prefix', async () => {
  const requests = [];
  const stub = cryptoState();
  const env = {
    AUTHORITY_STATE: {getByName: () => stub},
    AUTHORITY_URL: 'https://authority.monoid.app',
    APP_ORIGINS: '[]',
    REQUEST_LIMIT: {limit: async () => ({success: true})},
    ASSETS: {
      fetch: async request => {
        requests.push(new URL(request.url).pathname);
        return new Response('asset');
      },
    },
  };
  const handler = createWebHandler();
  const call = path => handler(new Request(env.AUTHORITY_URL + path), env);
  for (const method of ['GET', 'HEAD']) {
    const root = await handler(
      new Request(env.AUTHORITY_URL + '/?flow=discarded', {method}),
      env,
    );
    assert.equal(root.status, 200);
    assert.equal(root.headers.get('Location'), null);
    assert.equal(root.headers.get('Cache-Control'), 'no-store');
    assert.equal(root.headers.get('Referrer-Policy'), 'no-referrer');
    assert.equal(await root.text(), method === 'HEAD' ? '' : 'asset');
  }
  assert.equal((await call('/login')).status, 200);
  assert.equal((await call('/assets/login.js')).status, 200);
  assert.deepEqual(requests, [
    '/home.html',
    '/home.html',
    '/index.html',
    '/assets/login.js',
  ]);

  const metadata = await call('/v1/metadata');
  assert.equal(metadata.status, 200);
  assert.equal((await metadata.json()).time.protocol, 'monoid-authority-time');
  for (const path of ['/api/authority/login', '/api/authority/v1/metadata'])
    assert.equal((await call(path)).status, 404);
  assert.equal(requests.length, 4);
});

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
  for (const suffix of ['', '/']) {
    const root = await handler(new Request(env.AUTHORITY_URL + suffix), env);
    assert.equal(root.status, 200);
    assert.equal(root.headers.get('Location'), null);
    assert.equal(root.headers.get('Cache-Control'), 'no-store');
  }
  requests.length = 0;
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

test('public home and policies are HTML without authentication, scripts or redirects', async () => {
  for (const prefix of ['', '/api/authority']) {
    const env = {
      AUTHORITY_URL: 'https://authority.monoid.app' + prefix,
      ASSETS: {
        fetch: async request => {
          const url = new URL(request.url);
          assert.equal(url.search, '');
          return new Response(
            await readFile(
              new URL('../web' + url.pathname, import.meta.url),
              'utf8',
            ),
            {
              headers: {'Content-Type': 'text/html; charset=utf-8'},
            },
          );
        },
      },
    };
    const handler = createWebHandler();
    for (const path of ['/', '/privacy', '/terms']) {
      const response = await handler(
        new Request(env.AUTHORITY_URL + path + '?flow=private-flow-query'),
        env,
      );
      assert.equal(response.status, 200);
      assert.match(response.headers.get('Content-Type'), /text\/html/);
      assert.equal(response.headers.get('Location'), null);
      assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');
      assert.match(
        response.headers.get('Content-Security-Policy'),
        /default-src 'none'/,
      );
      assert.doesNotMatch(
        response.headers.get('Content-Security-Policy'),
        /unsafe-inline|https:/,
      );
      const html = await response.text();
      assert.match(html, /href="%BASE_URL%privacy"/);
      assert.match(html, /href="%BASE_URL%terms"/);
      assert.doesNotMatch(html, /<script|<button|<form|private-flow-query/);
      assert.match(html, /Monoid Authority/);
    }
  }
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
