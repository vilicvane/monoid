import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Miniflare, convertV4MiniflareOptions} from 'miniflare';
import {createECDH} from 'node:crypto';
import {keyEnv} from './helpers.mjs';
import {randomToken, tokenHash} from '../.bld/encoding.js';

test('workerd executes signing, HPKE and SQLite Durable Object session RPC', async context => {
  const project = 'runtime-test';
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      name: 'authority-test',
      modules: true,
      scriptPath: '.wrangler/test/worker.js',
      compatibilityDate: '2026-10-19',
      durableObjects: {
        AUTHORITY_STATE: {className: 'AuthorityState', useSQLite: true},
      },
      ratelimits: {
        REQUEST_LIMIT: {namespace_id: '1002', simple: {limit: 30, period: 60}},
      },
      bindings: {
        ...(await keyEnv()),
        AUTHORITY_URL: 'https://www.monoid.app/api/authority',
        APP_ORIGINS: '[]',
        APP_REDIRECT_URIS: '["app.monoid://authority/callback"]',
        REOWN_PROJECT_ID: project,
        REOWN_AUTH_ORIGINS: '["https://www.monoid.app"]',
      },
      outboundService: request => {
        const url = new URL(request.url);
        assert.equal(url.hostname, 'api.web3modal.org');
        assert.equal(url.pathname, '/auth/v1/me');
        assert.equal(url.searchParams.get('projectId'), project);
        assert.equal(url.searchParams.get('st'), 'appkit');
        assert.equal(url.searchParams.get('sv'), 'html-ethers-1.8.24');
        assert.equal(request.headers.get('Authorization'), 'Bearer test-token');
        return Response.json({
          projectIdKey: project,
          profileUuid: '11111111-1111-4111-8111-111111111111',
          exp: Math.floor(Date.now() / 1000) + 3600,
          uri: 'https://www.monoid.app',
          domain: 'www.monoid.app',
          address: '0x123',
        });
      },
    }),
  );
  context.after(() => mf.dispose());
  const call = (path, body, token, headers = {}) =>
    mf.dispatchFetch('https://www.monoid.app/api/authority' + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? {Authorization: `Bearer ${token}`} : {}),
        ...headers,
      },
      body: JSON.stringify(body),
    });
  assert.equal(
    (
      await call('/v1/time', {
        challenge: Buffer.alloc(32, 1).toString('base64url'),
      })
    ).status,
    200,
  );
  const login = await call('/auth/reown', {token: 'test-token'});
  assert.equal(login.status, 200, await login.clone().text());
  const session = await login.json();
  const recipient = createECDH('prime256v1');
  recipient.generateKeys();
  const input = {
    owner: {source: 'reown', id: session.account.id},
    groupName: 'family',
    allowPeerExtension: false,
    recipientPublicKey: recipient.getPublicKey().toString('base64url'),
  };
  const issued = await call('/v1/bundle', input, session.accessToken);
  assert.equal(issued.status, 200, await issued.clone().text());
  const original = await issued.clone().json();
  const renamed = await call(
    '/v1/namespaces/name',
    {owner: input.owner, displayName: 'Local family'},
    session.accessToken,
  );
  assert.equal(renamed.status, 200);
  const afterRename = await (
    await call('/v1/bundle', input, session.accessToken)
  ).json();
  assert.equal(afterRename.bundle, original.bundle);
  assert.equal(afterRename.owner.displayName, 'Local family');
  assert.equal(
    Buffer.from((await issued.json()).data, 'base64url').length,
    182,
  );
  assert.equal(
    (
      await call(
        '/v1/bundle',
        {...input, allowPeerExtension: true},
        session.accessToken,
      )
    ).status,
    409,
  );
  assert.equal(
    (await call('/auth/logout', {}, session.accessToken)).status,
    204,
  );
  assert.equal(
    (await call('/v1/bundle', input, session.accessToken)).status,
    401,
  );

  const redirectUri = 'app.monoid://authority/callback';
  const verifier = randomToken();
  const state = randomToken();
  const start = await call('/auth/login/start', {
    redirectUri,
    state,
    codeChallenge: await tokenHash(verifier),
    codeChallengeMethod: 'S256',
  });
  assert.equal(start.status, 200);
  const authorized = await mf.dispatchFetch(
    (await start.json()).authorizationUrl,
    {redirect: 'manual'},
  );
  assert.equal(authorized.status, 303);
  const flow = new URL(authorized.headers.get('Location')).searchParams.get(
    'flow',
  );
  const completed = await call(
    '/auth/login/complete',
    {flow, token: 'test-token'},
    undefined,
    {
      Cookie: authorized.headers.get('Set-Cookie').split(';')[0],
      Origin: 'https://www.monoid.app',
    },
  );
  assert.equal(completed.status, 200, await completed.clone().text());
  const callback = new URL((await completed.json()).redirectUrl);
  assert.equal(callback.searchParams.get('state'), state);
  const grant = {
    code: callback.searchParams.get('code'),
    codeVerifier: verifier,
    redirectUri,
  };
  const exchanges = await Promise.all([
    call('/auth/login/token', grant),
    call('/auth/login/token', grant),
  ]);
  assert.deepEqual(
    exchanges.map(response => response.status).sort(),
    [200, 400],
  );
  const hostedSession = await exchanges
    .find(response => response.status === 200)
    .json();
  assert.equal(
    (await call('/v1/bundle', input, hostedSession.accessToken)).status,
    200,
  );
});
