import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHandler} from '../.bld/api.js';
import {randomToken, tokenHash} from '../.bld/encoding.js';
import {database} from './helpers.mjs';

function setup(context) {
  const store = database(context);
  const env = {
    AUTHORITY_URL: 'https://www.monoid.app/api/authority',
    REOWN_PROJECT_ID: 'test-project',
    REOWN_AUTH_ORIGINS: '["https://www.monoid.app"]',
    APP_ORIGINS: '["capacitor://localhost"]',
    APP_REDIRECT_URIS:
      '["app.monoid://authority/callback","app.monoid://other/callback"]',
    BUNDLE_MASTER_KEY: Buffer.alloc(32, 7).toString('base64url'),
    AUTHORITY_STATE: {
      getByName: () => ({
        put: (...args) => store.put(...args),
        get: key => store.get(key, Date.now()),
        take: (key, proof) => store.take(key, proof, Date.now()),
      }),
    },
    REQUEST_LIMIT: {limit: async () => ({success: true})},
  };
  const upstream = {status: 200, calls: 0};
  const handler = createHandler(async (url, init) => {
    assert.equal(new URL(url).pathname, '/auth/v1/me');
    assert.equal(init.headers.Authorization, 'Bearer provider-token');
    ++upstream.calls;
    return Response.json(
      {
        projectIdKey: env.REOWN_PROJECT_ID,
        profileUuid: '11111111-1111-4111-8111-111111111111',
        exp: Math.floor(Date.now() / 1000) + 3600,
        uri: 'https://www.monoid.app/api/authority/login',
        domain: 'www.monoid.app',
        address: '0x' + 'ab'.repeat(20),
        chainNamespace: 'eip155',
      },
      {status: upstream.status},
    );
  });
  const call = (path, input, headers = {}) =>
    handler(
      new Request(env.AUTHORITY_URL + path, {
        method: input === undefined ? 'GET' : 'POST',
        headers: {
          ...(input === undefined ? {} : {'Content-Type': 'application/json'}),
          ...headers,
        },
        body: input === undefined ? undefined : JSON.stringify(input),
      }),
      env,
    );
  const start = async () => {
    const verifier = randomToken();
    const input = {
      redirectUri: 'app.monoid://authority/callback',
      state: randomToken(),
      codeChallenge: await tokenHash(verifier),
      codeChallengeMethod: 'S256',
    };
    const response = await call('/auth/login/start', input, {
      Origin: 'capacitor://localhost',
    });
    assert.equal(response.status, 200);
    const {authorizationUrl, expiresIn} = await response.json();
    assert.equal(expiresIn, 600);
    const path = authorizationUrl.slice(env.AUTHORITY_URL.length);
    const authorized = await call(path);
    assert.equal(authorized.status, 303);
    const location = new URL(authorized.headers.get('Location'));
    assert.equal(location.pathname, '/api/authority/login');
    const flow = location.searchParams.get('flow');
    const fullCookie = authorized.headers.get('Set-Cookie');
    const headers = {
      Cookie: fullCookie.split(';')[0],
      Origin: 'https://www.monoid.app',
    };
    return {input, verifier, path, flow, headers, fullCookie};
  };
  const finish = async flow => {
    const response = await call(
      '/auth/login/complete',
      {flow: flow.flow, token: 'provider-token'},
      flow.headers,
    );
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(Object.keys(result), ['redirectUrl']);
    assert.equal(JSON.stringify(result).includes('provider-token'), false);
    const target = new URL(result.redirectUrl);
    assert.equal(target.searchParams.get('state'), flow.input.state);
    assert.deepEqual([...target.searchParams.keys()].sort(), ['code', 'state']);
    assert.equal(
      response.headers.get('Set-Cookie').includes('Max-Age=0'),
      true,
    );
    return target.searchParams.get('code');
  };
  return {env, store, upstream, call, start, finish};
}

test('hosted login binds browser, exact redirect and PKCE; exchange is single-use', async context => {
  const f = setup(context);
  const flow = await f.start();
  assert.match(flow.fullCookie, /^__Host-monoid-login-/);
  for (const flag of ['Path=/', 'HttpOnly', 'SameSite=Lax', 'Secure'])
    assert.equal(flow.fullCookie.includes(flag), true);
  assert.equal((await f.call(flow.path)).status, 400);
  assert.equal(
    (await f.call('/auth/login/context?flow=' + flow.flow)).status,
    400,
  );
  const browserContext = await f.call(
    '/auth/login/context?flow=' + flow.flow,
    undefined,
    flow.headers,
  );
  assert.equal(browserContext.status, 200);
  assert.deepEqual(Object.keys(await browserContext.json()).sort(), [
    'expiresAt',
    'projectId',
  ]);
  assert.equal(browserContext.headers.get('Cache-Control'), 'no-store');
  assert.equal(browserContext.headers.get('Referrer-Policy'), 'no-referrer');

  const code = await f.finish(flow);
  assert.equal(
    (
      await f.call(
        '/auth/login/context?flow=' + flow.flow,
        undefined,
        flow.headers,
      )
    ).status,
    400,
  );
  const exchange = {
    code,
    codeVerifier: flow.verifier,
    redirectUri: flow.input.redirectUri,
  };
  for (const wrong of [
    {...exchange, codeVerifier: randomToken()},
    {...exchange, redirectUri: 'app.monoid://other/callback'},
    {...exchange, redirectUri: 'app.monoid://authority/callback?evil=1'},
  ])
    assert.equal((await f.call('/auth/login/token', wrong)).status, 400);

  const responses = await Promise.all([
    f.call('/auth/login/token', exchange),
    f.call('/auth/login/token', exchange),
  ]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 400]);
  const session = await responses.find(r => r.status === 200).json();
  assert.equal(session.tokenType, 'Bearer');
  assert.match(session.accessToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(session.account.id.startsWith('test-project:'), true);
  assert.equal(JSON.stringify(session).includes('provider-token'), false);
  assert.equal(f.upstream.calls, 2);
  assert.equal(
    (
      await f.call('/v1/me', undefined, {
        Authorization: `Bearer ${session.accessToken}`,
      })
    ).status,
    200,
  );
});

test('hosted login rejects weak requests and browser CSRF without burning the flow', async context => {
  const f = setup(context);
  const flow = await f.start();
  for (const patch of [
    {redirectUri: 'https://evil.example/callback'},
    {codeChallengeMethod: 'plain'},
    {codeChallenge: 'x'.repeat(43)},
    {state: 'short'},
    {state: 'x'.repeat(23)},
  ])
    assert.equal(
      (await f.call('/auth/login/start', {...flow.input, ...patch})).status,
      400,
    );

  for (const headers of [
    {},
    {Cookie: flow.headers.Cookie},
    {...flow.headers, Origin: 'capacitor://localhost'},
    {...flow.headers, Origin: 'https://evil.example'},
    {
      ...flow.headers,
      Cookie: flow.headers.Cookie.replace(/=.*/, '=' + randomToken()),
    },
  ]) {
    const response = await f.call(
      '/auth/login/complete',
      {flow: flow.flow, token: 'provider-token'},
      headers,
    );
    assert.ok([400, 403].includes(response.status));
  }
  assert.equal(f.upstream.calls, 0);
  await f.finish(flow);
});

test('racing completions issue only one code; cancellation is bound to the original browser', async context => {
  const f = setup(context);
  const first = await f.start();
  const second = await f.start();
  assert.notEqual(
    first.headers.Cookie.split('=')[0],
    second.headers.Cookie.split('=')[0],
  );
  assert.equal(
    (await f.call('/auth/login/cancel', {flow: first.flow}, second.headers))
      .status,
    400,
  );
  const cancelled = await f.call(
    '/auth/login/cancel',
    {flow: first.flow},
    first.headers,
  );
  assert.equal(cancelled.status, 200);
  const target = new URL((await cancelled.json()).redirectUrl);
  assert.equal(target.searchParams.get('error'), 'access_denied');
  assert.equal(target.searchParams.get('state'), first.input.state);
  assert.equal(
    (
      await f.call(
        '/auth/login/complete',
        {flow: first.flow, token: 'provider-token'},
        first.headers,
      )
    ).status,
    400,
  );

  const responses = await Promise.all([
    f.call(
      '/auth/login/complete',
      {flow: second.flow, token: 'provider-token'},
      second.headers,
    ),
    f.call(
      '/auth/login/complete',
      {flow: second.flow, token: 'provider-token'},
      second.headers,
    ),
  ]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 400]);
});

test('expiry and provider failures fail closed; unverified browser login remains retryable', async context => {
  const f = setup(context);
  const now = Date.now();
  const expiredFlow = await f.start();
  const flow = await f.start();
  f.upstream.status = 503;
  assert.equal(
    (
      await f.call(
        '/auth/login/complete',
        {flow: flow.flow, token: 'provider-token'},
        flow.headers,
      )
    ).status,
    502,
  );
  f.upstream.status = 200;
  const code = await f.finish(flow);
  let clock = now + 61 * 1000;
  context.mock.method(Date, 'now', () => clock);
  assert.equal(
    (
      await f.call('/auth/login/token', {
        code,
        codeVerifier: flow.verifier,
        redirectUri: flow.input.redirectUri,
      })
    ).status,
    400,
  );
  clock = now + 11 * 60 * 1000;
  assert.equal(
    (
      await f.call(
        '/auth/login/context?flow=' + expiredFlow.flow,
        undefined,
        expiredFlow.headers,
      )
    ).status,
    400,
  );
});

test('a provider revoked before exchange cannot become an Authority session', async context => {
  const f = setup(context);
  const flow = await f.start();
  const code = await f.finish(flow);
  f.upstream.status = 401;
  const input = {
    code,
    codeVerifier: flow.verifier,
    redirectUri: flow.input.redirectUri,
  };
  assert.equal((await f.call('/auth/login/token', input)).status, 401);
  f.upstream.status = 200;
  assert.equal((await f.call('/auth/login/token', input)).status, 400);
});
