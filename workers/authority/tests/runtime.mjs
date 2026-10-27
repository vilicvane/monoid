import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Miniflare, convertV4MiniflareOptions} from 'miniflare';
import {createECDH} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, dirname, join} from 'node:path';
import {randomToken, tokenHash} from '../.bld/encoding.js';

const project = 'runtime-test';
const base = 'https://authority.monoid.app';

async function removePersistence(root) {
  assert.equal(dirname(root), tmpdir());
  assert.equal(basename(root).startsWith('monoid-authority-runtime-'), true);
  await rm(root, {recursive: true, force: true});
}

function options(resourcePersistencePath, script) {
  return {
    ...convertV4MiniflareOptions({
      name: 'authority-test',
      modules: true,
      ...(script ? {script} : {scriptPath: '.wrangler/test/worker.js'}),
      compatibilityDate: '2026-10-19',
      durableObjects: {
        AUTHORITY_STATE: {className: 'AuthorityState', useSQLite: true},
      },
      ratelimits: {
        REQUEST_LIMIT: {namespace_id: '1002', simple: {limit: 30, period: 60}},
      },
      bindings: {
        AUTHORITY_URL: 'https://authority.monoid.app',
        APP_ORIGINS: '[]',
        APP_REDIRECT_URIS: '["app.monoid://authority/callback"]',
        REOWN_PROJECT_ID: project,
        REOWN_AUTH_ORIGINS: '["https://authority.monoid.app"]',
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
          uri: 'https://authority.monoid.app/login',
          domain: 'authority.monoid.app',
          address: '0x' + 'ab'.repeat(20),
          chainNamespace: 'eip155',
          email: 'verified@example.com',
        });
      },
    }),
    // V5's persistence option must not pass through the V4 adapter.
    resourcePersistencePath,
  };
}

test('workerd keeps generated keys, group roots and sessions across a complete restart', async context => {
  const root = await mkdtemp(join(tmpdir(), 'monoid-authority-runtime-'));
  let mf = new Miniflare(options(root));
  context.after(async () => {
    await mf.dispose();
    await removePersistence(root);
  });
  const call = (path, body, token, headers = {}) =>
    mf.dispatchFetch(base + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? {Authorization: `Bearer ${token}`} : {}),
        ...headers,
      },
      body: JSON.stringify(body),
    });
  const firstRequests = await Promise.all(
    Array.from({length: 5}, () => mf.dispatchFetch(base + '/v1/metadata')),
  );
  const metadata = await Promise.all(firstRequests.map(r => r.json()));
  for (const value of metadata)
    assert.equal(value.publicKey, metadata[0].publicKey);
  assert.deepEqual(Object.keys(metadata[0]).sort(), [
    'bundle',
    'publicKey',
    'time',
  ]);
  const challenge = Buffer.alloc(32, 1).toString('base64url');
  const signed = await call('/v1/time', {challenge});
  assert.equal(signed.status, 200);
  assert.equal((await signed.json()).publicKey, metadata[0].publicKey);
  const namespace = await mf.getDurableObjectNamespace('AUTHORITY_STATE');
  const stub = namespace.getByName('authority');
  assert.equal(await stub.get('authority-keys:v1'), null);
  assert.equal(await stub.take('authority-keys:v1', ''), null);
  for (const path of ['/v1/keys', '/v1/keys/export', '/v1/keys/rotate'])
    assert.equal((await call(path, {})).status, 404);
  const login = await call('/auth/reown', {
    token: 'test-token',
    method: 'wallet',
  });
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

  await mf.dispose();
  mf = new Miniflare(options(root));
  const restored = await (await mf.dispatchFetch(base + '/v1/metadata')).json();
  assert.deepEqual(restored, metadata[0]);
  const afterRestart = await call('/v1/bundle', input, session.accessToken);
  assert.equal(afterRestart.status, 200, await afterRestart.clone().text());
  const restoredBundle = await afterRestart.json();
  assert.equal(restoredBundle.bundle, original.bundle);
  assert.equal(restoredBundle.publicKey, original.publicKey);
  assert.equal(restoredBundle.owner.displayName, 'Local family');
  const afterRestartTime = await call('/v1/time', {challenge});
  const proof = await afterRestartTime.json();
  const publicKey = await crypto.subtle.importKey(
    'raw',
    Buffer.from(restored.publicKey, 'base64url'),
    {name: 'ECDSA', namedCurve: 'P-256'},
    false,
    ['verify'],
  );
  assert.equal(
    await crypto.subtle.verify(
      {name: 'ECDSA', hash: 'SHA-256'},
      publicKey,
      Buffer.from(proof.signature, 'base64url'),
      Buffer.concat([
        Buffer.from('Monoid Authority Time'),
        Buffer.from(proof.data, 'base64url'),
      ]),
    ),
    true,
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
  assert.equal(new URL(authorized.headers.get('Location')).pathname, '/login');
  const flow = new URL(authorized.headers.get('Location')).searchParams.get(
    'flow',
  );
  const completed = await call(
    '/auth/login/complete',
    {flow, token: 'test-token', method: 'wallet'},
    undefined,
    {
      Cookie: authorized.headers.get('Set-Cookie').split(';')[0],
      Origin: 'https://authority.monoid.app',
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

for (const method of ['wallet', 'email', 'social']) {
  test(`workerd persists hosted ${method} method and enforces wallet eligibility after restart`, async context => {
    const root = await mkdtemp(join(tmpdir(), 'monoid-authority-runtime-'));
    let mf = new Miniflare(options(root));
    context.after(async () => {
      await mf.dispose();
      await removePersistence(root);
    });
    const call = (path, body, headers = {}) =>
      mf.dispatchFetch(base + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {'Content-Type': 'application/json', ...headers},
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const verifier = randomToken();
    const redirectUri = 'app.monoid://authority/callback';
    const start = await call('/auth/login/start', {
      redirectUri,
      state: randomToken(),
      codeChallenge: await tokenHash(verifier),
      codeChallengeMethod: 'S256',
    });
    const authorized = await mf.dispatchFetch(
      (await start.json()).authorizationUrl,
      {redirect: 'manual'},
    );
    const flow = new URL(authorized.headers.get('Location')).searchParams.get(
      'flow',
    );
    const browserHeaders = {
      Origin: base,
      Cookie: authorized.headers.get('Set-Cookie').split(';')[0],
    };
    const invalid = await call(
      '/auth/login/complete',
      {flow, token: 'test-token', method: {kind: method}},
      browserHeaders,
    );
    assert.equal(invalid.status, 400);
    const complete = await call(
      '/auth/login/complete',
      {
        flow,
        token: 'test-token',
        method,
        ...(method === 'social' ? {provider: 'github'} : {}),
      },
      browserHeaders,
    );
    assert.equal(complete.status, 200);
    const code = new URL((await complete.json()).redirectUrl).searchParams.get(
      'code',
    );
    // The pending code contains the method too, independently of the browser.
    await mf.dispose();
    mf = new Miniflare(options(root));
    const exchanged = await call('/auth/login/token', {
      code,
      codeVerifier: verifier,
      redirectUri,
    });
    assert.equal(exchanged.status, 200);
    const session = await exchanged.json();
    assert.ok(session.expiresIn > 0 && session.expiresIn <= 300);
    const account = {
      id: `${project}:11111111-1111-4111-8111-111111111111`,
      login: '0x' + 'ab'.repeat(20),
      email: 'verified@example.com',
      method,
      ...(method === 'social' ? {provider: 'github'} : {}),
    };
    assert.deepEqual(session.account, account);
    await mf.dispose();
    mf = new Miniflare(options(root));
    const headers = {Authorization: `Bearer ${session.accessToken}`};
    assert.deepEqual(await (await call('/v1/me', undefined, headers)).json(), {
      account,
    });
    const {namespaces} = await (
      await call('/v1/namespaces', undefined, headers)
    ).json();
    assert.deepEqual(
      namespaces.map(item => item.source),
      method === 'wallet' ? ['reown', 'wallet'] : ['reown'],
    );
    const owner = {source: 'wallet', id: `eip155:${account.login}`};
    const recipient = createECDH('prime256v1');
    recipient.generateKeys();
    for (const [path, body] of [
      ['/v1/groups/list', {owner}],
      ['/v1/namespaces/name', {owner, displayName: 'Wallet'}],
      [
        '/v1/bundle',
        {
          owner,
          groupName: 'family',
          allowPeerExtension: false,
          recipientPublicKey: recipient.getPublicKey().toString('base64url'),
        },
      ],
    ]) {
      const response = await call(path, body, headers);
      assert.equal(
        response.status,
        method === 'wallet' ? 200 : 403,
        await response.clone().text(),
      );
    }
  });
}

test('workerd never renews an idle-expired, capped or revoked session', async context => {
  const root = await mkdtemp(join(tmpdir(), 'monoid-authority-runtime-'));
  const mf = new Miniflare(options(root));
  context.after(async () => {
    await mf.dispose();
    await removePersistence(root);
  });
  const response = await mf.dispatchFetch(base + '/auth/reown', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({token: 'test-token', method: 'email'}),
  });
  assert.equal(response.status, 200);
  const session = await response.json();
  assert.ok(session.expiresIn > 0 && session.expiresIn <= 300);
  const stub = (
    await mf.getDurableObjectNamespace('AUTHORITY_STATE')
  ).getByName('authority');
  const key = `session:${await tokenHash(session.accessToken)}`;
  const saved = await stub.get(key);
  const cap = JSON.parse(await stub.openSession(saved)).absoluteExpiresAt;
  assert.equal(await stub.touchSession(key, cap), true);
  assert.equal(await stub.touchSession(key, Date.now() - 1), false);
  const headers = {Authorization: `Bearer ${session.accessToken}`};
  assert.equal(
    (await mf.dispatchFetch(base + '/v1/me', {headers})).status,
    200,
  );
  await stub.remove(key);
  await stub.put(key, saved, '', Date.now() - 1);
  assert.equal(await stub.touchSession(key, cap), false);
  assert.equal(
    (await mf.dispatchFetch(base + '/v1/me', {headers})).status,
    401,
  );
  await stub.remove(key);
  assert.equal(await stub.touchSession(key, cap), false);
  assert.equal(await stub.get(key), null);
});

test('first internal key generation retires old credentials once while retaining group policy', async context => {
  const root = await mkdtemp(join(tmpdir(), 'monoid-authority-runtime-'));
  // Test-only previous deployment: data exists, but there is no internal key.
  // This fixture cannot be bundled into the production entrypoint.
  const legacy = `
    import {DurableObject} from 'cloudflare:workers';
    export class AuthorityState extends DurableObject {
      async seed() {
        const sql = this.ctx.storage.sql;
        sql.exec("CREATE TABLE records (key TEXT PRIMARY KEY, value TEXT NOT NULL, proof TEXT NOT NULL, expires INTEGER NOT NULL)");
        sql.exec("CREATE TABLE groups (owner_source TEXT NOT NULL, owner_id TEXT NOT NULL, name TEXT NOT NULL, allow_peer_extension INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (owner_source, owner_id, name))");
        sql.exec("CREATE TABLE namespace_names (source TEXT NOT NULL, id TEXT NOT NULL, display_name TEXT NOT NULL, PRIMARY KEY (source, id))");
        sql.exec("INSERT INTO records VALUES (?, ?, ?, ?)", "session:retired", "old-ciphertext", "", Date.now() + 3600000);
        sql.exec("INSERT INTO records VALUES (?, ?, ?, ?)", "login-code:retired", "old-grant", "", Date.now() + 60000);
        sql.exec("INSERT INTO groups VALUES (?, ?, ?, ?, ?)", "github", "7", "retained", 0, 123);
        sql.exec("INSERT INTO namespace_names VALUES (?, ?, ?)", "github", "7", "Existing name");
      }
    }
    export default { async fetch(request, env) {
      await env.AUTHORITY_STATE.getByName('authority').seed();
      return new Response('seeded');
    }};
  `;
  let mf = new Miniflare(options(root, legacy));
  context.after(async () => {
    await mf.dispose();
    await removePersistence(root);
  });
  assert.equal((await mf.dispatchFetch(base)).status, 200);
  await mf.dispose();
  mf = new Miniflare(options(root));
  const namespace = await mf.getDurableObjectNamespace('AUTHORITY_STATE');
  const stub = namespace.getByName('authority');
  const metadata = await stub.metadata();
  const publicKey = metadata.publicKey;
  assert.equal(Buffer.from(publicKey, 'base64url').length, 65);
  for (const key of [
    'session:retired',
    'login-code:retired',
    'authority-keys:v1',
  ])
    assert.equal(await stub.get(key), null);
  const owner = {source: 'github', id: '7'};
  const retained = await stub.group(owner, 'retained', true);
  assert.equal(retained.name, 'retained');
  assert.equal(retained.allowPeerExtension, false);
  assert.equal(retained.createdAt, 123);
  assert.equal(
    (await stub.namespace(owner, 'Provider name')).displayName,
    'Existing name',
  );
  await stub.put('current-record', 'survives-restart', '', Date.now() + 60000);
  await mf.dispose();
  mf = new Miniflare(options(root));
  const restarted = (
    await mf.getDurableObjectNamespace('AUTHORITY_STATE')
  ).getByName('authority');
  assert.equal((await restarted.metadata()).publicKey, publicKey);
  assert.equal(await restarted.get('current-record'), 'survives-restart');
});
