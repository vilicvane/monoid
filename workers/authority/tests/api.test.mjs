import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createECDH} from 'node:crypto';
import {createHandler} from '../.bld/api.js';
import {tokenHash} from '../.bld/encoding.js';
import {cryptoState, database} from './helpers.mjs';

async function setup(context) {
  const store = database(context);
  const stub = {
    ...cryptoState(),
    put: (...args) => store.put(...args),
    get: key => store.get(key, Date.now()),
    take: (key, proof) => store.take(key, proof, Date.now()),
    remove: key => store.remove(key),
    group: (...args) => store.group(...args),
    groups: (...args) => store.groups(...args),
    namespace: (...args) => store.namespace(...args),
    namespaces: items =>
      items.map(item =>
        store.namespace({source: item.source, id: item.id}, item.displayName),
      ),
  };
  const env = {
    AUTHORITY_URL: 'https://www.monoid.app/api/authority',
    REOWN_PROJECT_ID: 'test-project',
    REOWN_AUTH_ORIGINS: '["https://www.monoid.app"]',
    APP_ORIGINS: '[]',
    APP_REDIRECT_URIS: '["monoid://authority/callback"]',
    GITHUB_CLIENT_ID: 'client',
    GITHUB_CLIENT_SECRET: 'test-secret',
    AUTHORITY_STATE: {getByName: () => stub},
    REQUEST_LIMIT: {limit: async () => ({success: true})},
  };
  const upstream = {
    reownStatus: 200,
    role: 'admin',
    claims: {
      projectIdKey: env.REOWN_PROJECT_ID,
      profileUuid: '11111111-1111-4111-8111-111111111111',
      exp: Math.floor(Date.now() / 1000) + 3600,
      uri: 'https://www.monoid.app',
      domain: 'www.monoid.app',
      address: '0x' + 'Ab'.repeat(20),
      chainNamespace: 'eip155',
    },
  };
  const fetcher = async (url, init) => {
    url = new URL(url);
    assert.equal(init.redirect, 'manual');
    if (url.hostname === 'api.web3modal.org') {
      assert.equal(url.pathname, '/auth/v1/me');
      assert.equal(url.searchParams.get('projectId'), env.REOWN_PROJECT_ID);
      assert.equal(url.searchParams.get('st'), 'appkit');
      assert.equal(url.searchParams.get('sv'), 'html-ethers-1.8.24');
      assert.equal(init.headers.Authorization, 'Bearer provider-token');
      return Response.json(upstream.claims, {status: upstream.reownStatus});
    }
    if (url.pathname === '/login/oauth/access_token') {
      assert.equal(init.body.get('client_secret'), 'test-secret');
      assert.equal(init.body.get('code_verifier').length, 43);
      return Response.json({
        access_token: 'github-token',
        token_type: 'bearer',
      });
    }
    if (url.pathname === '/user')
      return Response.json({id: 7, login: 'owner', type: 'User'});
    if (url.pathname === '/user/memberships/orgs')
      return Response.json([
        {
          state: 'active',
          role: upstream.role,
          organization: {id: 42, login: 'team'},
        },
      ]);
    throw new Error(`Unexpected URL ${url}`);
  };
  const handler = createHandler(fetcher);
  const call = (path, input, token, headers = {}) =>
    handler(
      new Request(env.AUTHORITY_URL + path, {
        method: input === undefined ? 'GET' : 'POST',
        headers: {
          ...(input === undefined ? {} : {'Content-Type': 'application/json'}),
          ...(token ? {Authorization: `Bearer ${token}`} : {}),
          ...headers,
        },
        body: input === undefined ? undefined : JSON.stringify(input),
      }),
      env,
    );
  const login = async () => {
    const response = await call('/auth/reown', {token: 'provider-token'});
    assert.equal(response.status, 200);
    return response.json();
  };
  return {env, upstream, call, login, store, stub};
}

test('remote identity verification fails closed for project, expiry, origin, missing profile and provider denial', async context => {
  const f = await setup(context);
  for (const [field, value] of [
    ['projectIdKey', 'other'],
    ['exp', 1],
    ['uri', 'https://evil.example'],
    ['profileUuid', undefined],
  ]) {
    const before = f.upstream.claims[field];
    f.upstream.claims[field] = value;
    assert.equal(
      (await f.call('/auth/reown', {token: 'provider-token'})).status,
      401,
    );
    f.upstream.claims[field] = before;
  }
  f.upstream.reownStatus = 401;
  assert.equal(
    (await f.call('/auth/reown', {token: 'provider-token'})).status,
    401,
  );
});

test('provider request rejection is distinguished from an invalid login credential', async context => {
  const f = await setup(context);
  const session = await f.login();
  for (const [upstreamStatus, status, error] of [
    [401, 401, 'reown_reauthentication_required'],
    [403, 502, 'reown_verification_rejected'],
  ]) {
    f.upstream.reownStatus = upstreamStatus;
    const login = await f.call('/auth/reown', {token: 'provider-token'});
    assert.equal(login.status, status);
    assert.deepEqual(await login.json(), {error});
    const existing = await f.call('/v1/me', undefined, session.accessToken);
    assert.equal(existing.status, status);
    assert.deepEqual(await existing.json(), {error});
  }
  f.upstream.reownStatus = 200;
  assert.equal(
    (await f.call('/v1/me', undefined, session.accessToken)).status,
    200,
  );
});

test('personal issuance isolates owners, enforces immutable policy and revalidates provider', async context => {
  const f = await setup(context);
  const session = await f.login();
  assert.equal(JSON.stringify(session).includes('provider-token'), false);
  const key = createECDH('prime256v1');
  key.generateKeys();
  const input = {
    owner: {source: 'reown', id: session.account.id},
    groupName: 'family',
    allowPeerExtension: false,
    recipientPublicKey: key.getPublicKey().toString('base64url'),
  };
  assert.equal(
    (await f.call('/v1/bundle', input, session.accessToken)).status,
    200,
  );
  assert.equal(
    (
      await f.call(
        '/v1/bundle',
        {...input, allowPeerExtension: true},
        session.accessToken,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await f.call(
        '/v1/bundle',
        {...input, owner: {source: 'reown', id: 'someone-else'}},
        session.accessToken,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.call(
        '/v1/bundle',
        {
          ...input,
          recipientPublicKey: Buffer.alloc(65, 4).toString('base64url'),
        },
        session.accessToken,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await f.call(
        '/v1/bundle',
        {...input, owner: {source: 'github-organization', id: '42'}},
        session.accessToken,
      )
    ).status,
    403,
  );
  f.upstream.reownStatus = 401;
  assert.equal(
    (await f.call('/v1/me', undefined, session.accessToken)).status,
    401,
  );
  assert.equal(
    (await f.call('/auth/logout', {}, session.accessToken)).status,
    204,
  );
  f.upstream.reownStatus = 200;
  assert.equal(
    (await f.call('/v1/me', undefined, session.accessToken)).status,
    401,
  );
});

test('GitHub connection binds browser and PKCE, rotates session, rejects replay and live org demotion', async context => {
  const f = await setup(context);
  const session = await f.login();
  const verifier = 'a'.repeat(43);
  const input = {
    codeChallenge: await tokenHash(verifier),
    state: 'b'.repeat(32),
    redirectUri: 'monoid://authority/callback',
  };
  assert.equal((await f.call('/auth/github/start', input)).status, 401);
  const started = await (
    await f.call('/auth/github/start', input, session.accessToken)
  ).json();
  const authorized = await f.call(
    started.authorizationUrl.slice(f.env.AUTHORITY_URL.length),
  );
  assert.equal(authorized.status, 303);
  const cookie = authorized.headers.get('Set-Cookie').split(';')[0];
  const provider = new URL(authorized.headers.get('Location'));
  const callback =
    '/auth/github/callback?code=test&state=' +
    provider.searchParams.get('state');
  assert.equal((await f.call(callback)).status, 400);
  const returned = await f.call(callback, undefined, undefined, {
    Cookie: cookie,
  });
  assert.equal(returned.status, 200);
  const html = await returned.text();
  const approval = html.match(/approval=([A-Za-z0-9_-]+)/)[1];
  const path = '/auth/approve?approval=' + approval;
  assert.equal(
    (
      await f.call(path, {}, undefined, {
        Cookie: cookie,
        Origin: 'https://evil.example',
      })
    ).status,
    403,
  );
  const approved = await f.call(path, {}, undefined, {
    Cookie: cookie,
    Origin: 'https://www.monoid.app',
  });
  assert.equal(approved.status, 303);
  const target = new URL(approved.headers.get('Location'));
  assert.equal(target.searchParams.get('state'), input.state);
  const code = target.searchParams.get('code');
  assert.equal(
    (await f.call('/auth/token', {code, codeVerifier: 'c'.repeat(43)})).status,
    400,
  );
  const exchanges = await Promise.all([
    f.call('/auth/token', {code, codeVerifier: verifier}),
    f.call('/auth/token', {code, codeVerifier: verifier}),
  ]);
  assert.deepEqual(exchanges.map(r => r.status).sort(), [200, 400]);
  const linked = await exchanges.find(r => r.status === 200).json();
  assert.equal(linked.account.id, session.account.id);
  assert.equal(JSON.stringify(linked).includes('github-token'), false);
  assert.equal(
    (await f.call('/v1/me', undefined, session.accessToken)).status,
    401,
  );
  const owner = {source: 'github-organization', id: '42'};
  const available = await (
    await f.call('/v1/namespaces', undefined, linked.accessToken)
  ).json();
  assert.deepEqual(
    available.namespaces.map(n => n.source),
    ['reown', 'wallet', 'github-user', 'github-organization'],
  );
  assert.equal(
    (
      await f.call(
        '/v1/namespaces/name',
        {owner: {source: 'github-user', id: '7'}, displayName: 'My GitHub'},
        linked.accessToken,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await f.call(
        '/v1/namespaces/name',
        {owner: {source: 'github-user', id: '8'}, displayName: 'Other'},
        linked.accessToken,
      )
    ).status,
    403,
  );
  assert.equal(
    (await f.call('/v1/groups/list', {owner}, linked.accessToken)).status,
    200,
  );
  f.upstream.role = 'member';
  assert.equal(
    (
      await f.call(
        '/v1/namespaces/name',
        {owner, displayName: 'No longer owner'},
        linked.accessToken,
      )
    ).status,
    403,
  );
  assert.equal(
    (await f.call('/v1/groups/list', {owner}, linked.accessToken)).status,
    403,
  );
});

test('public time and metadata, CORS, body bounds and rate limiting', async context => {
  const f = await setup(context);
  const metadataResponse = await f.call('/v1/metadata');
  assert.equal(metadataResponse.status, 200);
  const metadata = await metadataResponse.json();
  assert.deepEqual(metadata.time, {
    protocol: 'monoid-authority-time',
    version: 1,
    algorithm: 'ecdsa-p256-sha256-p1363',
  });
  assert.equal('timeCardSupport' in metadata, false);
  const response = await f.call('/v1/time', {
    challenge: Buffer.alloc(32, 9).toString('base64url'),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal((await f.call('/v1/time', {challenge: 'short'})).status, 400);
  assert.equal(
    (await f.call('/v1/time', {challenge: 'x'.repeat(5000)})).status,
    413,
  );
  assert.equal(
    (
      await f.call('/v1/metadata', undefined, undefined, {
        Origin: 'https://evil.example',
      })
    ).status,
    403,
  );
  // A wildcard opens the API to any origin, but not browser approval.
  f.env.APP_ORIGINS = '["*"]';
  const open = await f.call('/v1/metadata', undefined, undefined, {
    Origin: 'http://100.64.0.1:8100',
  });
  assert.equal(open.status, 200);
  assert.equal(
    open.headers.get('Access-Control-Allow-Origin'),
    'http://100.64.0.1:8100',
  );
  const approval = await f.call('/auth/approve?approval=x', {}, undefined, {
    Origin: 'https://evil.example',
  });
  assert.equal(approval.status, 400);
  assert.deepEqual(await approval.json(), {error: 'invalid_origin'});
  f.env.REQUEST_LIMIT.limit = async () => ({success: false});
  const limited = await f.call('/v1/metadata');
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('Retry-After'), '60');
});

test('namespace names are mutable metadata; source and permanent ID isolate roots', async context => {
  const f = await setup(context);
  const session = await f.login();
  const namespaces = await (
    await f.call('/v1/namespaces', undefined, session.accessToken)
  ).json();
  assert.deepEqual(
    namespaces.namespaces.map(n => n.source),
    ['reown', 'wallet'],
  );
  const personal = namespaces.namespaces[0];
  const wallet = namespaces.namespaces[1];
  assert.equal(wallet.id, 'eip155:0x' + 'ab'.repeat(20));
  const recipient = createECDH('prime256v1');
  recipient.generateKeys();
  const input = {
    owner: personal,
    groupName: 'family',
    allowPeerExtension: false,
    recipientPublicKey: recipient.getPublicKey().toString('base64url'),
  };
  const before = await (
    await f.call('/v1/bundle', input, session.accessToken)
  ).json();
  const rename = await f.call(
    '/v1/namespaces/name',
    {owner: personal, displayName: 'My Family'},
    session.accessToken,
  );
  assert.equal(rename.status, 200);
  assert.equal((await rename.json()).namespace.id, personal.id);
  const after = await (
    await f.call(
      '/v1/bundle',
      {...input, owner: {...personal, displayName: 'untrusted'}},
      session.accessToken,
    )
  ).json();
  assert.equal(after.bundle, before.bundle);
  assert.equal(after.owner.displayName, 'My Family');
  assert.equal(
    (
      await f.call(
        '/v1/bundle',
        {...input, allowPeerExtension: true},
        session.accessToken,
      )
    ).status,
    409,
  );
  await f.call(
    '/v1/namespaces/name',
    {owner: wallet, displayName: 'My Family'},
    session.accessToken,
  );
  const walletBundle = await (
    await f.call('/v1/bundle', {...input, owner: wallet}, session.accessToken)
  ).json();
  assert.notEqual(walletBundle.bundle, before.bundle);
  assert.equal(
    (
      await f.call(
        '/v1/namespaces/name',
        {owner: {...personal, id: 'other'}, displayName: 'Hijack'},
        session.accessToken,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.call(
        '/v1/namespaces/name',
        {owner: {source: 'email', id: 'me@example.com'}, displayName: 'Mine'},
        session.accessToken,
      )
    ).status,
    400,
  );
  f.upstream.claims.address = '0x' + 'cd'.repeat(20);
  assert.equal(
    (await f.call('/v1/bundle', {...input, owner: wallet}, session.accessToken))
      .status,
    403,
  );
  // Losing wallet metadata must never authorize the previous wallet via profile ID.
  delete f.upstream.claims.chainNamespace;
  assert.equal(
    (await f.call('/v1/bundle', {...input, owner: wallet}, session.accessToken))
      .status,
    403,
  );
});

test('provider failure during GitHub exchange preserves the existing Authority session', async context => {
  const f = await setup(context);
  const signedIn = await f.login();
  const sessionKey = `session:${await tokenHash(signedIn.accessToken)}`;
  const session = JSON.parse(
    await f.stub.openSession(f.store.get(sessionKey, Date.now())),
  );
  const code = 'd'.repeat(43);
  const verifier = 'e'.repeat(43);
  f.store.put(
    `code:${await tokenHash(code)}`,
    await f.stub.sealSession(JSON.stringify({session, sessionKey})),
    await tokenHash(verifier),
    Date.now() + 60000,
  );
  f.upstream.reownStatus = 503;
  assert.equal(
    (await f.call('/auth/token', {code, codeVerifier: verifier})).status,
    502,
  );
  f.upstream.reownStatus = 200;
  assert.equal(
    (await f.call('/v1/me', undefined, signedIn.accessToken)).status,
    200,
  );
  assert.equal(
    (await f.call('/auth/token', {code, codeVerifier: verifier})).status,
    400,
  );
});
